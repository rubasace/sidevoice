import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from sidevoice.room_history import RoomHistory
from sidevoice.connector_control import ConnectorControl, PROTOCOL


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
        self.journal = journal; self.activated = []; self.published = []; self.receipts = []; self.working = []
    async def activate(self, target): self.activated.append(target)
    def conversation_working(self, thread, working, **correlation): self.working.append((thread, working, correlation))
    def clear_conversation_working(self, thread): pass
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

    async def test_pairings_survive_a_restart_but_the_journal_does_not(self):
        from sidevoice.room_history import RoomHistory
        self.queue_input('thread-x', 'Said before the restart')
        restarted = RoomHistory(self.journal.path)
        self.assertTrue(restarted.authenticate_connector(self.connector_id, self.token))
        self.assertEqual(restarted.history(), [])
        self.assertEqual(restarted.bindings(), [])
        self.assertEqual(oct(restarted.state_path.stat().st_mode)[-3:], '600')

    async def test_a_legacy_database_is_imported_once_for_its_pairings(self):
        import sqlite3
        from sidevoice.room_history import RoomHistory
        root = Path(self.temp.name) / 'legacy'
        root.mkdir()
        db = sqlite3.connect(root / 'room-history.sqlite3')
        db.execute('CREATE TABLE connectors (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, host TEXT, created INTEGER, last_seen INTEGER, revoked INTEGER DEFAULT 0)')
        db.execute('CREATE TABLE closed_channels (thread TEXT PRIMARY KEY, notification TEXT)')
        db.execute('CREATE TABLE messages (id TEXT, text TEXT)')
        db.execute("INSERT INTO connectors VALUES ('old-connector', ?, 'laptop', 1, 2, 0)", (__import__('hashlib').sha256(b'old-token').hexdigest(),))
        db.execute("INSERT INTO messages VALUES ('m', 'a transcript that must stay where it is')")
        db.commit(); db.close()
        journal = RoomHistory(root / 'room-state.json')
        self.assertTrue(journal.authenticate_connector('old-connector', 'old-token'))
        self.assertEqual(journal.history(), [])
        self.assertTrue((root / 'room-state.json').exists())
        self.assertTrue((root / 'room-history.sqlite3').exists(), 'the old database is left for the operator to delete')

    async def test_closing_from_the_room_tells_the_connector_and_forgets_the_binding(self):
        socket, task = await self.run_connection([
            {'type': 'connector.hello', 'protocol': PROTOCOL, 'connector_id': self.connector_id, 'token': self.token},
            {'type': 'binding.register', 'client_ref': 'r1', 'harness': 'claude', 'thread': 'sess-1', 'title': 'Trabajo'},
        ])
        registered = [f for f in socket.sent if f['type'] == 'binding.registered'][0]
        await self.control.close_binding(self.journal.binding(registered['binding_id']))
        closing = [f for f in socket.sent if f['type'] == 'binding.close']
        self.assertEqual((closing[0]['binding_id'], closing[0]['thread'], closing[0]['reason']), (registered['binding_id'], 'sess-1', 'closed_from_room'))
        self.assertFalse(self.control.is_live(registered['binding_id']))
        self.assertIsNone(self.journal.binding_for_thread('sess-1'))
        # Speech from a binding the room closed is refused, so nothing is stored for it.
        socket.incoming.append({'type': 'speech.publish', 'event_id': 'sp', 'binding_id': registered['binding_id'], 'session_id': 's', 'revision': 1, 'text': 'tarde'})
        await asyncio.sleep(.1)
        rejected = [f for f in socket.sent if f['type'] == 'speech.published' and f.get('event_id') == 'sp']
        self.assertEqual(rejected[0]['status'], 'rejected')
        task.cancel(); await asyncio.gather(task, return_exceptions=True)

    async def test_a_read_receipt_marks_the_row_read_only_for_its_own_binding_and_thread(self):
        socket, task = await self.run_connection([
            {'type': 'connector.hello', 'protocol': PROTOCOL, 'connector_id': self.connector_id, 'token': self.token},
            {'type': 'binding.register', 'client_ref': 'r1', 'harness': 'claude', 'thread': 'sess-1', 'title': 'Trabajo'},
        ])
        registered = [f for f in socket.sent if f['type'] == 'binding.registered'][0]
        row = self.queue_input('sess-1', 'hola', message_id='m-read')
        self.journal.update(row['id'], 'unconfirmed')
        other = self.queue_input('sess-2', 'ajeno', message_id='m-other')
        socket.incoming.append({'type': 'input.read', 'binding_id': registered['binding_id'], 'message_id': 'm-other', 'session_id': 'call', 'revision': 1})
        socket.incoming.append({'type': 'input.read', 'binding_id': registered['binding_id'], 'message_id': 'm-read', 'session_id': 'call', 'revision': 1})
        socket.incoming.append({'type': 'input.read', 'binding_id': registered['binding_id'], 'message_id': 'm-read', 'session_id': 'call', 'revision': 1})
        await asyncio.sleep(.1)
        self.assertEqual(self.journal.get(row['id'])['status'], 'read')
        self.assertEqual(self.journal.get(other['id'])['status'], 'pending')
        self.assertEqual(self.hub.receipts.count((row['id'], 'read')), 1)
        task.cancel(); await asyncio.gather(task, return_exceptions=True)

    async def test_a_read_receipt_that_arrives_before_the_delivery_acknowledgement_is_not_downgraded(self):
        socket, task = await self.run_connection([
            {'type': 'connector.hello', 'protocol': PROTOCOL, 'connector_id': self.connector_id, 'token': self.token},
            {'type': 'binding.register', 'client_ref': 'r1', 'harness': 'claude', 'thread': 'sess-1', 'title': 'Trabajo'},
        ])
        registered = [f for f in socket.sent if f['type'] == 'binding.registered'][0]
        row = self.queue_input('sess-1', 'hola', message_id='m-fast')
        await self.control.tick()   # delivered: the row is in flight, waiting for the harness's answer
        delivered = [f for f in socket.sent if f['type'] == 'input.deliver' and f['message_id'] == 'm-fast'][0]
        self.assertEqual(self.journal.get(row['id'])['status'], 'sending')
        await self.control.read(self.connector_id, {'binding_id': registered['binding_id'], 'message_id': 'm-fast', 'session_id': 'call', 'revision': 1})
        self.assertEqual(self.journal.get(row['id'])['status'], 'read')
        await self.control.acknowledge(self.connector_id, {'event_id': delivered['event_id'], 'status': 'unknown', 'detail': 'inbox'})
        self.assertEqual(self.journal.get(row['id'])['status'], 'read', 'a late acknowledgement never takes the second tick away')
        self.assertEqual([status for (_, status) in self.hub.receipts if _ == row['id']][-1], 'read')
        task.cancel(); await asyncio.gather(task, return_exceptions=True)

    async def test_the_harness_saying_it_is_working_reaches_the_browsers_on_that_conversation(self):
        socket, task = await self.run_connection([
            {'type': 'connector.hello', 'protocol': PROTOCOL, 'connector_id': self.connector_id, 'token': self.token},
            {'type': 'binding.register', 'client_ref': 'r1', 'harness': 'claude', 'thread': 'sess-1', 'title': 'Trabajo'},
        ])
        registered = [f for f in socket.sent if f['type'] == 'binding.registered'][0]
        socket.incoming.append({'type': 'input.working', 'binding_id': registered['binding_id'], 'working': True,
                                'turn_id': 'turn-1', 'turn_phase': 'start', 'session_id': 'call', 'revision': 4})
        socket.incoming.append({'type': 'input.working', 'binding_id': registered['binding_id'], 'working': False,
                                'turn_id': 'turn-1', 'turn_phase': 'end', 'session_id': 'call', 'revision': 4})
        socket.incoming.append({'type': 'input.working', 'binding_id': registered['binding_id']})
        # A binding this connector does not hold says nothing about anyone.
        socket.incoming.append({'type': 'input.working', 'binding_id': 'someone-elses', 'working': True})
        await asyncio.sleep(.1)
        self.assertEqual(self.hub.working, [
            ('sess-1', True, {'turn_id': 'turn-1', 'turn_phase': 'start', 'session_id': 'call', 'revision': 4}),
            ('sess-1', False, {'turn_id': 'turn-1', 'turn_phase': 'end', 'session_id': 'call', 'revision': 4})])
        task.cancel(); await asyncio.gather(task, return_exceptions=True)

    async def test_binding_keeps_declared_capabilities_and_missing_ones_are_unknown(self):
        socket, task = await self.run_connection([
            {'type': 'connector.hello', 'protocol': PROTOCOL, 'connector_id': self.connector_id, 'token': self.token},
            {'type': 'binding.register', 'client_ref': 'r1', 'harness': 'codex', 'thread': 'thread-1',
             'capabilities': {'deliver': 'supported', 'working': 'unsupported', 'inspectInbound': False}},
        ])
        participant = self.control.participants()[0]
        self.assertEqual(participant['capabilities'], {
            'deliver': 'supported',
            'inspectInbound': 'unknown',
            'working': 'unsupported',
            'endOfTurn': 'unknown',
            'sessionIdentity': 'unknown',
        })
        self.assertIsNone(self.journal.binding(participant['id']).get('inbound'))
        task.cancel(); await asyncio.gather(task, return_exceptions=True)

    async def test_an_unknown_binding_id_from_its_connector_is_a_fresh_registration(self):
        binding = self.journal.register_binding(self.connector_id, harness='claude', thread='sess-1', binding_id='gone-after-restart')
        self.assertNotEqual(binding['id'], 'gone-after-restart')
        again = self.journal.register_binding(self.connector_id, harness='claude', thread='sess-1', binding_id=binding['id'])
        self.assertEqual(again['id'], binding['id'])

    async def test_hello_must_authenticate_and_match_protocol(self):
        bad, task = await self.run_connection([{'type': 'connector.hello', 'protocol': PROTOCOL, 'connector_id': self.connector_id, 'token': 'wrong'}])
        await task
        self.assertEqual(bad.closed, 1008); self.assertEqual(bad.sent, [])
        old, task = await self.run_connection([{'type': 'connector.hello', 'protocol': 99, 'connector_id': self.connector_id, 'token': self.token}])
        await task
        self.assertEqual(old.closed, 1008); self.assertEqual(old.sent[0]['type'], 'connector.error')

    async def test_register_mints_id_focuses_nobody_and_an_unknown_id_is_a_fresh_registration(self):
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
        self.assertEqual(self.hub.activated, [], 'a conversation joining selects itself for no browser')
        # An id the room does not know (it restarted) is not foreign: the same connector gets its binding back.
        reused = [f for f in socket.sent if f['type'] == 'binding.registered' and f['client_ref'] == 'r2']
        self.assertEqual(reused[0]['binding_id'], registered['binding_id'])
        self.assertEqual([f['client_ref'] for f in socket.sent if f['type'] == 'binding.rejected'], ['r3'])
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
