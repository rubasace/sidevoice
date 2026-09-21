"""The real connector against the real room, over each link, and the numbers that compare them.

Everything else in either suite tests one side against a stand-in. This one starts the room on
a loopback port, spawns `packages/connector/connector.mjs` as the machine would, and drives it
through the same local socket a façade uses: joining, delivery and its acknowledgement, speech,
the read receipt a harness's own transcript produces, a conversation the room closes, a lost
connection that re-registers, and speech queued while there was no room to take it.

The same run happens over `rsocket` and over `ws`, and prints two latencies for each — which is
what #66 asks for before anything is decided about the browser link.
"""
import asyncio
import json
import os
import shutil
import socket
import statistics
import sys
import tempfile
import time
import unittest
from pathlib import Path

import uvicorn
from fastapi import FastAPI

from sidevoice.connector_control import mount_connector_control
from sidevoice.room_history import RoomHistory
from test_connector_control import FakeHub

REPOSITORY = Path(__file__).resolve().parents[3]
CONNECTOR = REPOSITORY / 'packages' / 'connector' / 'connector.mjs'
NODE = shutil.which('node')
LINKS = ('rsocket', 'ws')
DELIVERIES = 5          # enough for a median that is not one sample's bad luck


async def until(check, timeout=15.0, every=.002):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if asyncio.iscoroutine(value):
            value = await value
        if value:
            return value
        await asyncio.sleep(every)
    raise AssertionError('timed out waiting')


def free_port():
    """A port to hold for the whole run, so the room can be stopped and started again on it."""
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


class Facade:
    """A conversation's side of the connector: newline-delimited JSON over its local socket."""

    def __init__(self, reader, writer):
        self.reader, self.writer, self.serial, self.waiting = reader, writer, 0, {}
        self.pump = asyncio.create_task(self.receive())

    @classmethod
    async def attach(cls, path):
        reader, writer = await asyncio.open_unix_connection(path)
        return cls(reader, writer)

    async def receive(self):
        while line := await self.reader.readline():
            reply = json.loads(line)
            waiter = self.waiting.pop(reply.get('id'), None)
            if waiter and not waiter.done():
                waiter.set_result(reply)

    async def call(self, method, **params):
        self.serial += 1
        waiter = asyncio.get_running_loop().create_future()
        self.waiting[self.serial] = waiter
        self.writer.write((json.dumps({'id': self.serial, 'method': method, 'params': params}) + '\n').encode())
        await self.writer.drain()
        reply = await asyncio.wait_for(waiter, timeout=20)
        if not reply.get('ok'):
            raise AssertionError(f'{method} failed: {reply.get("error")}')
        return reply['result']

    async def close(self):
        self.pump.cancel()
        self.writer.close()


class Inbox:
    """Claude Code's session inbox, as far as the connector can tell: a socket that takes the
    lines and says nothing, which is exactly what the real one does."""

    def __init__(self, path):
        self.path, self.received, self.server = path, [], None

    async def start(self):
        self.server = await asyncio.start_unix_server(self.serve, path=self.path)
        return self

    async def serve(self, reader, writer):
        while line := await reader.readline():
            self.received.append(json.loads(line))

    async def stop(self):
        self.server.close()


class Room:
    """The room on a loopback port, stoppable and startable again on the same one."""

    def __init__(self, app, port):
        self.app, self.port, self.server, self.task = app, port, None, None

    async def start(self):
        config = uvicorn.Config(self.app, host='127.0.0.1', port=self.port, log_level='error')
        self.server = uvicorn.Server(config)
        self.task = asyncio.create_task(self.server.serve())
        await until(lambda: self.server.started, timeout=20)

    async def stop(self):
        self.server.should_exit = True
        await asyncio.wait_for(self.task, timeout=20)


@unittest.skipIf(NODE is None, 'node is not on PATH')
class ConnectorInteropTests(unittest.IsolatedAsyncioTestCase):
    maxDiff = None

    async def test_the_same_connector_does_the_same_work_over_each_link(self):
        numbers = {}
        for link in LINKS:
            with self.subTest(link=link):
                numbers[link] = await self.exercise(link)
        report(numbers)
        for link in LINKS:
            self.assertGreater(numbers[link]['delivery_to_ack'], 0)
            self.assertGreater(numbers[link]['disconnect_to_registered'], 0)

    async def exercise(self, link):
        def step(name):
            if os.environ.get('SIDEVOICE_INTEROP_TRACE'):
                print(f'  [{link}] {name}', file=sys.stderr, flush=True)

        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        data, claude = root / 'sidevoice', root / 'claude'
        (data).mkdir(); (claude / 'sessions').mkdir(parents=True)
        (claude / 'projects' / '-home-someone-project').mkdir(parents=True)

        journal = RoomHistory(root / 'room.json')
        hub = FakeHub(journal)
        app = FastAPI()
        control = mount_connector_control(app, hub, heartbeat_seconds=5)
        connector_id, token = journal.redeem_pairing_code(journal.create_pairing_code())

        # Every delivery is timed from the frame leaving the room to the connector's answer arriving.
        acknowledged, settle = [], control.settle

        async def timed(connector, binding, event_id, answer):
            started = time.perf_counter()
            try:
                return await settle(connector, binding, event_id, answer)
            finally:
                acknowledged.append((time.perf_counter() - started) * 1000)
        control.settle = timed

        port = free_port()
        room = Room(app, port)
        await room.start()

        (data / 'credentials.json').write_text(json.dumps({
            'url': f'ws://127.0.0.1:{port}/api/connectors/{link}',
            'connector_id': connector_id, 'token': token, 'protocol': 1, 'link': link}))

        inbox = await Inbox(str(data / 'inbox.sock')).start()
        transcript = claude / 'projects' / '-home-someone-project' / 'sess-claude.jsonl'
        registry = claude / 'sessions' / '4242.json'
        registry.write_text(json.dumps({'sessionId': 'sess-claude', 'pid': 4242, 'status': 'idle'}))
        transcript.write_text('')

        connector = await asyncio.create_subprocess_exec(
            NODE, str(CONNECTOR),
            env={**os.environ, 'SIDEVOICE_DATA_DIR': str(data), 'SIDEVOICE_CONNECTOR_IDLE_MS': '120000',
                 'CLAUDE_CONFIG_DIR': str(claude), 'SIDEVOICE_WORK_POLL_MS': '30',
                 'SIDEVOICE_WORK_ANNOUNCE_MS': '5000'},
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)

        async def finish():
            if connector.returncode is None:
                connector.terminate()
                await asyncio.wait_for(connector.wait(), timeout=10)
            await inbox.stop()
            await room.stop()
        self.addAsyncCleanup(finish)

        socket_path = data / 'connector.sock'
        try:
            await until(socket_path.exists, timeout=20)
            facade = await Facade.attach(str(socket_path))
            self.addAsyncCleanup(facade.close)

            # ----- joining -----
            delivered = []
            harness = await start_harness(delivered)
            self.addAsyncCleanup(stop_harness, harness)
            step('joining')
            joined = await facade.call('register', client_ref='thread-1', harness='http', thread='thread-1',
                                       title='Interop', engine={'model': 'claude-opus-5'},
                                       delivery={'kind': 'http', 'url': harness['url'], 'thread': 'thread-1'})
            self.assertFalse(joined['binding_id'].startswith('local-'), 'the room minted the id')
            self.assertTrue(joined['connected'])
            binding = journal.binding_for_thread('thread-1')
            self.assertTrue(control.is_live(binding['id']))
            self.assertEqual(journal.bindings()[0]['engine'], {'model': 'claude-opus-5'})

            # ----- delivery and its acknowledgement -----
            step('deliveries')
            for index in range(DELIVERIES):
                row = queue_input(journal, 'thread-1', f'mensaje {index}', f'm{index}')
                await until(lambda row=row: journal.get(row['id'])['status'] == 'delivered')
            self.assertEqual([event['text'] for event in delivered], [f'mensaje {i}' for i in range(DELIVERIES)])
            self.assertEqual(len(acknowledged), DELIVERIES)

            # ----- speech -----
            step('speech')
            published = await facade.call('publish', client_ref='thread-1', session_id='call', revision=1,
                                          text='Ya está', language='es')
            self.assertEqual(published['status'], 'queued')
            await until(lambda: [speech.text for speech in hub.published] == ['Ya está'])

            # ----- the read receipt, from what the harness itself writes -----
            step('read receipt')
            claude_binding = await facade.call('register', client_ref='sess-claude', harness='claude', thread='sess-claude',
                                               title='Claude', delivery={'kind': 'claude-uds', 'socket': inbox.path, 'token': 'tok'})
            read_row = queue_input(journal, 'sess-claude', 'hola desde la sala', 'm-read')
            await until(lambda: any(line.get('type') == 'user' for line in inbox.received), timeout=20)
            posted = next(line for line in inbox.received if line['type'] == 'user')['message']['content']
            self.assertIn('hola desde la sala', posted)
            self.assertEqual(journal.get(read_row['id'])['status'], 'sending', 'nothing is claimed before the session takes it')
            with transcript.open('a') as lines:
                lines.write(json.dumps({'type': 'user', 'promptId': 'p-1', 'message': {'role': 'user', 'content': posted}}) + '\n')
            await until(lambda: journal.get(read_row['id'])['status'] == 'read', timeout=20)

            # ----- the room closes a conversation's voice -----
            step('closing from the room')
            await control.close_binding(journal.binding(claude_binding['binding_id']))

            async def told():
                return 'sess-claude' in (await facade.call('status'))['closed_by_room']
            await until(told)

            # ----- a connection that goes, and comes back knowing what it is for -----
            step('reconnect')
            was = journal.binding_for_thread('thread-1')['id']
            journal.deactivate_binding(connector_id, was)   # as a room that restarted would have forgotten it
            control.live.pop(was, None)
            started = time.perf_counter()
            await control.peers[connector_id].disconnect()
            def live_again():
                record = journal.binding_for_thread('thread-1')
                return bool(record) and control.is_live(record['id'])
            await until(live_again, timeout=30)
            reconnected = (time.perf_counter() - started) * 1000
            self.assertEqual((await facade.call('status'))['link'], link)

            # ----- speech said while there was no room to take it -----
            step('outbox')
            await room.stop()

            async def roomless():
                return not (await facade.call('status'))['connected']
            await until(roomless, timeout=20)
            queued = await facade.call('publish', client_ref='thread-1', session_id='call', revision=2,
                                       text='Dicho sin sala', language='es')
            self.assertEqual(queued['status'], 'queued')
            self.assertEqual(json.loads((data / 'outbox.json').read_text())[0]['text'], 'Dicho sin sala')
            await room.start()
            await until(lambda: 'Dicho sin sala' in [speech.text for speech in hub.published], timeout=30)
            await until(lambda: json.loads((data / 'outbox.json').read_text()) == [], timeout=10)

            return {'delivery_to_ack': statistics.median(acknowledged), 'disconnect_to_registered': reconnected}
        except Exception:
            log = data / 'connector.log'
            if log.exists():
                print(f'\n--- connector log ({link}) ---\n{log.read_text()}', file=sys.stderr)
            raise


def queue_input(journal, thread, text, message_id):
    return journal.put(id=f'call:user-turn:{message_id}', thread=thread, role='user', text=text, name='Tú',
                       session='call', revision=1, status='pending',
                       payload={'thread_id': thread, 'text': text, 'message_id': message_id,
                                'session_id': 'call', 'revision': 1})


async def start_harness(received):
    """A conversation that takes what it is given and says so at once, so what is measured between
    the frame and its acknowledgement is the link and not somebody's inbox."""
    async def handle(reader, writer):
        request = await reader.readuntil(b'\r\n\r\n')
        length = next((int(line.split(b':')[1]) for line in request.split(b'\r\n') if line.lower().startswith(b'content-length')), 0)
        received.append(json.loads(await reader.readexactly(length)))
        writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}')
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, '127.0.0.1', 0)
    port = server.sockets[0].getsockname()[1]
    return {'server': server, 'url': f'http://127.0.0.1:{port}/presentation/message'}


async def stop_harness(harness):
    harness['server'].close()
    await harness['server'].wait_closed()


def report(numbers):
    print('\n  link      delivery → ack   disconnect → re-registered')
    for link, measured in numbers.items():
        print(f'  {link:<8}  {measured["delivery_to_ack"]:>9.1f} ms   {measured["disconnect_to_registered"]:>21.1f} ms')
    print()
