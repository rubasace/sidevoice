import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from room_history import RoomHistory
from connector_control import ConnectorControl, PROTOCOL


class FakeSocket:
    def __init__(self, incoming=()):
        self.sent = []; self.incoming = list(incoming); self.closed = None; self.accepted = False
    async def accept(self): self.accepted = True
    async def send_json(self, frame): self.sent.append(frame)
    async def receive_json(self):
        if not self.incoming:
            await asyncio.sleep(3600)
        item = self.incoming.pop(0)
        if isinstance(item, Exception): raise item
        return item
    async def close(self, code=1000): self.closed = code


class FakeHub:
    def __init__(self, journal):
        self.journal = journal; self.activated = []; self.published = []; self.receipts = []
    async def activate(self, target): self.activated.append(target)
    async def publish(self, speech): self.published.append(speech); return {'status': 'queued', 'text_saved': True, 'utterance_id': speech.utterance_id}
    def delivery_status(self, row_id, status): self.receipts.append((row_id, status))


class ControlPlaneTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.journal = RoomHistory(Path(self.temp.name) / 'room.sqlite3')
        self.hub = FakeHub(self.journal)
        self.control = ConnectorControl(self.journal, self.hub, heartbeat_seconds=0.05)
        self.connector_id, self.token = self.journal.redeem_pairing_code(self.journal.create_pairing_code())

    async def asyncTearDown(self):
        self.temp.cleanup()

    def queue_input(self, thread, text, message_id='m1'):
        return self.journal.put(id='call:user-turn:' + message_id, thread=thread, role='user', text=text, name='Tú', session='call', revision=1,
                                status='pending', payload={'thread_id': thread, 'text': text, 'message_id': message_id, 'session_id': 'call', 'revision': 1})

    async def run_connection(self, frames):
        socket = FakeSocket(frames)
        task = asyncio.create_task(self.control.connect(socket))
        await asyncio.sleep(.05)
        return socket, task

    async def test_pairing_is_one_time_and_credentials_are_checked(self):
        code = self.journal.create_pairing_code()
        first = self.journal.redeem_pairing_code(code)
        self.assertIsNotNone(first)
        self.assertIsNone(self.journal.redeem_pairing_code(code))
        self.assertIsNone(self.journal.redeem_pairing_code('NOPE'))
        self.assertTrue(self.journal.authenticate_connector(*first))
        self.assertFalse(self.journal.authenticate_connector(first[0], 'wrong'))
        self.journal.revoke_connector(first[0])
        self.assertFalse(self.journal.authenticate_connector(*first))

    async def test_hello_must_authenticate_and_match_protocol(self):
        bad, task = await self.run_connection([{'type': 'connector.hello', 'protocol': PROTOCOL, 'connector_id': self.connector_id, 'token': 'wrong'}])
        await task
        self.assertEqual(bad.closed, 1008); self.assertEqual(bad.sent, [])
        old, task = await self.run_connection([{'type': 'connector.hello', 'protocol': 99, 'connector_id': self.connector_id, 'token': self.token}])
        await task
        self.assertEqual(old.closed, 1008); self.assertEqual(old.sent[0]['type'], 'connector.error')

    async def test_register_mints_id_focuses_room_and_rejects_foreign_reuse(self):
        socket, task = await self.run_connection([
            {'type': 'connector.hello', 'protocol': PROTOCOL, 'connector_id': self.connector_id, 'token': self.token},
            {'type': 'binding.register', 'client_ref': 'r1', 'harness': 'claude', 'thread': 'sess-1', 'title': 'Trabajo'},
            {'type': 'binding.register', 'client_ref': 'r2', 'harness': 'claude', 'thread': 'sess-1', 'binding_id': 'not-mine'},
            {'type': 'binding.register', 'client_ref': 'r3', 'harness': 'claude', 'thread': 'bad thread!'},
        ])
        kinds = [f['type'] for f in socket.sent]
        self.assertEqual(kinds[:2], ['connector.welcome', 'binding.registered'])
        registered = socket.sent[1]
        self.assertEqual(registered['client_ref'], 'r1'); self.assertEqual(registered['thread'], 'sess-1')
        self.assertTrue(self.control.is_live(registered['binding_id']))
        self.assertEqual(self.hub.activated, [{'thread_id': 'sess-1', 'title': 'Trabajo'}])
        self.assertEqual([f['client_ref'] for f in socket.sent if f['type'] == 'binding.rejected'], ['r2', 'r3'])
        self.assertEqual(self.journal.binding_for_thread('sess-1')['id'], registered['binding_id'])
        task.cancel(); await asyncio.gather(task, return_exceptions=True)

    async def test_delivery_is_one_at_a_time_acknowledged_by_owner_and_retried_on_failure(self):
        binding = self.journal.register_binding(self.connector_id, harness='claude', thread='sess-1')
        socket = FakeSocket(); self.control.sockets[self.connector_id] = socket; self.control.live[binding['id']] = self.connector_id
        self.queue_input('sess-1', 'primero', 'm1'); self.queue_input('sess-1', 'segundo', 'm2')
        await self.control.tick()
        self.assertEqual([f['text'] for f in socket.sent], ['primero'])
        self.assertEqual(socket.sent[0]['message_id'], 'm1')
        await self.control.tick()
        self.assertEqual(len(socket.sent), 1)
        event = socket.sent[0]['event_id']
        await self.control.acknowledge('someone-else', {'event_id': event, 'status': 'accepted'})
        self.assertEqual(self.journal.get(event)['status'], 'sending')
        await self.control.acknowledge(self.connector_id, {'event_id': event, 'status': 'failed'})
        row = self.journal.get(event)
        self.assertEqual((row['status'], row['attempts']), ('pending', 1))
        self.assertGreater(row['next_attempt'], int(time.time()))  # backed off, not hammered
        await self.control.tick(now=time.time() + 100)
        self.assertEqual([f['text'] for f in socket.sent], ['primero', 'primero'])
        await self.control.acknowledge(self.connector_id, {'event_id': socket.sent[1]['event_id'], 'status': 'accepted'})
        self.assertEqual(self.journal.get(event)['status'], 'delivered')
        self.assertIn((event, 'delivered'), self.hub.receipts)
        await self.control.tick(now=time.time() + 100)
        self.assertEqual([f['text'] for f in socket.sent][-1], 'segundo')

    async def test_ack_timeout_and_disconnect_return_deliveries_to_the_queue(self):
        binding = self.journal.register_binding(self.connector_id, harness='claude', thread='sess-1')
        socket = FakeSocket(); self.control.sockets[self.connector_id] = socket; self.control.live[binding['id']] = self.connector_id
        self.control.ack_timeout = 1
        self.queue_input('sess-1', 'hola')
        await self.control.tick(now=1000)
        await self.control.tick(now=1002)  # ack never came
        self.assertEqual(self.journal.get(socket.sent[0]['event_id'])['status'], 'pending')
        self.assertEqual(self.control.inflight, {})

    async def test_speech_lands_in_room_only_from_owning_connector(self):
        binding = self.journal.register_binding(self.connector_id, harness='claude', thread='sess-1')
        socket = FakeSocket(); self.control.live[binding['id']] = self.connector_id
        await self.control.speech(self.connector_id, socket, {'event_id': 'e1', 'binding_id': binding['id'], 'session_id': 'call', 'revision': 3, 'text': 'Hola', 'language': 'es'})
        self.assertEqual(socket.sent[-1]['status'], 'queued'); self.assertEqual(socket.sent[-1]['event_id'], 'e1')
        self.assertEqual((self.hub.published[0].thread_id, self.hub.published[0].revision), ('sess-1', 3))
        await self.control.speech('intruder', socket, {'event_id': 'e2', 'binding_id': binding['id'], 'session_id': 'call', 'revision': 3, 'text': 'Hola'})
        self.assertEqual(socket.sent[-1]['status'], 'rejected'); self.assertEqual(len(self.hub.published), 1)

    async def test_heartbeat_detects_a_dead_connector_and_frees_its_bindings(self):
        binding = self.journal.register_binding(self.connector_id, harness='claude', thread='sess-1')
        socket, task = await self.run_connection([
            {'type': 'connector.hello', 'protocol': PROTOCOL, 'connector_id': self.connector_id, 'token': self.token},
            {'type': 'binding.register', 'client_ref': 'r1', 'harness': 'claude', 'thread': 'sess-1', 'binding_id': binding['id']},
        ])
        self.assertTrue(self.control.is_live(binding['id']))
        await asyncio.wait_for(task, timeout=2)
        self.assertEqual(socket.closed, 1001)
        self.assertEqual([f['type'] for f in socket.sent if f['type'] == 'heartbeat'][:1], ['heartbeat'])
        self.assertFalse(self.control.is_live(binding['id']))
        self.assertNotIn(self.connector_id, self.control.sockets)

    async def test_newer_connection_from_same_connector_wins(self):
        first, t1 = await self.run_connection([{'type': 'connector.hello', 'protocol': PROTOCOL, 'connector_id': self.connector_id, 'token': self.token}])
        second, t2 = await self.run_connection([{'type': 'connector.hello', 'protocol': PROTOCOL, 'connector_id': self.connector_id, 'token': self.token}])
        self.assertIs(self.control.sockets[self.connector_id], second)
        self.assertEqual(first.closed, 1000)
        for t in (t1, t2): t.cancel()
        await asyncio.gather(t1, t2, return_exceptions=True)
