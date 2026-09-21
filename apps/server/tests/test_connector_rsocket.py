"""`/api/connectors/rsocket`: the same control plane, reached the other way.

The connector these tests speak with is rsocket-py's own frame code over a Starlette test
socket — so what is being checked is the route, the routing and the outcomes, not a second
copy of the client. That the real Node connector understands these same bytes is what
`test_connector_interop.py` proves, and the byte vectors in the connector's own suite pin.
"""
import gc
import json
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from datetime import timedelta
from pathlib import Path

from fastapi import FastAPI
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from rsocket.error_codes import ErrorCode
from rsocket.extensions.helpers import authenticate_simple, composite, route as route_metadata
from rsocket.extensions.mimetypes import WellKnownMimeTypes
from rsocket.frame import ErrorFrame, KeepAliveFrame, RequestFireAndForgetFrame, parse_or_ignore
from rsocket.frame_builders import to_keepalive_frame, to_request_response_frame, to_setup_frame
from rsocket.payload import Payload

from sidevoice.connector_control import PROTOCOL, mount_connector_control
from sidevoice.room_history import RoomHistory
from test_connector_control import FakeHub

JSON_MIME = WellKnownMimeTypes.APPLICATION_JSON.value.name
COMPOSITE_MIME = WellKnownMimeTypes.MESSAGE_RSOCKET_COMPOSITE_METADATA.value.name


class Connector:
    """One connector, by hand: SETUP, then requests on odd streams and answers wherever they land."""

    def __init__(self, socket):
        self.socket, self.stream_id, self.unsolicited = socket, -1, []

    def setup(self, connector_id, token, protocol=PROTOCOL, host='laptop'):
        frame = to_setup_frame(Payload(json.dumps({'protocol': protocol, 'host': host, 'version': '0.4.3'}).encode(),
                                       composite(authenticate_simple(connector_id, token))),
                               JSON_MIME, COMPOSITE_MIME, timedelta(milliseconds=15_000), timedelta(milliseconds=45_000))
        self.socket.send_bytes(frame.serialize())

    def next_stream(self):
        self.stream_id += 2
        return self.stream_id

    def send(self, route, data):
        # Built by hand rather than with the library's builder, which wants a running event loop to
        # hold the "it was sent" future this test has no use for.
        frame, payload = RequestFireAndForgetFrame(), self.payload(route, data)
        frame.stream_id, frame.data, frame.metadata = self.next_stream(), payload.data, payload.metadata
        self.socket.send_bytes(frame.serialize())

    def request(self, route, data):
        stream_id = self.next_stream()
        self.socket.send_bytes(to_request_response_frame(stream_id, self.payload(route, data)).serialize())
        return self.await_stream(stream_id)

    def keepalive(self):
        self.socket.send_bytes(to_keepalive_frame(b'').serialize())

    def await_stream(self, stream_id):
        """The answer to one request. Anything else that arrives first is kept, not dropped."""
        while True:
            frame = self.read()
            if frame.stream_id != stream_id:
                self.unsolicited.append(frame)
                continue
            if isinstance(frame, ErrorFrame):
                raise RSocketRefusal(frame.error_code, frame.data.decode())
            return json.loads(frame.data.decode() or '{}')

    def read(self):
        return parse_or_ignore(self.socket.receive_bytes())

    @staticmethod
    def payload(route, data):
        return Payload(json.dumps(data).encode(), composite(route_metadata(route)))


class RSocketRefusal(Exception):
    def __init__(self, code, detail):
        super().__init__(detail)
        self.code, self.detail = code, detail


class RSocketRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.journal = RoomHistory(Path(self.temp.name) / 'room.sqlite3')
        self.hub = FakeHub(self.journal)
        self.app = FastAPI()
        self.control = mount_connector_control(self.app, self.hub, heartbeat_seconds=30)
        self.connector_id, self.token = self.journal.redeem_pairing_code(self.journal.create_pairing_code())

    @contextmanager
    def room(self):
        """Every connector goes before the room does: a socket still open when the app shuts down
        leaves its handler waiting for a frame that will never come."""
        with TestClient(self.app) as client, ExitStack() as connectors:
            yield client, connectors

    def connect(self, client, connectors, connector_id=None, token=None, protocol=PROTOCOL):
        socket = connectors.enter_context(client.websocket_connect('/api/connectors/rsocket'))
        connector = Connector(socket)
        connector.setup(connector_id or self.connector_id, token or self.token, protocol)
        return connector

    def test_the_room_welcomes_a_connector_whose_credential_it_believes(self):
        with self.room() as (client, connectors):
            connector = self.connect(client, connectors)
            self.assertEqual(connector.request('connector.hello', {'protocol': PROTOCOL, 'host': 'laptop'}),
                             {'protocol': PROTOCOL, 'heartbeat_seconds': 30})
            self.assertIn(self.connector_id, self.control.peers)
            # The room's own page sees it connected, the same way the WebSocket link is seen.
            listed = client.get('/api/connectors', headers={'Origin': 'http://testserver'}).json()
            self.assertEqual([c['connected'] for c in listed['connectors']], [True])

    def test_a_credential_the_room_does_not_believe_never_gets_past_setup(self):
        for bad in ({'token': 'wrong'}, {'connector_id': 'someone-else'}):
            with self.subTest(**bad), self.room() as (client, connectors):
                connector = self.connect(client, connectors, connector_id=bad.get('connector_id'), token=bad.get('token'))
                refusal = connector.read()
                self.assertIsInstance(refusal, ErrorFrame)
                self.assertEqual(refusal.error_code, ErrorCode.REJECTED_SETUP)
                self.assertEqual(refusal.stream_id, 0)
                self.assertEqual(refusal.data.decode(), 'Unknown connector or token')
                self.assertEqual(self.control.peers, {}, 'nothing is attached for a connector the room refused')
                with self.assertRaises(WebSocketDisconnect):
                    connector.read()   # and the socket goes, after the reason is on the wire

    def test_a_connector_that_speaks_another_protocol_is_told_which_one_this_room_speaks(self):
        with self.room() as (client, connectors):
            connector = self.connect(client, connectors, protocol=99)
            refusal = connector.read()
            self.assertEqual(refusal.error_code, ErrorCode.REJECTED_SETUP)
            self.assertEqual(refusal.data.decode(), f'Unsupported protocol; server speaks {PROTOCOL}')

    def test_every_route_reaches_the_control_plane_the_websocket_link_reaches(self):
        with self.room() as (client, connectors):
            connector = self.connect(client, connectors)
            connector.request('connector.hello', {})

            registered = connector.request('binding.register', {
                'client_ref': 'r1', 'harness': 'claude', 'thread': 'sess-1', 'title': 'Trabajo',
                'capabilities': {'deliver': 'supported'}, 'engine': {'model': 'claude-opus-5'}})
            self.assertEqual(registered['thread'], 'sess-1')
            self.assertEqual(registered['client_ref'], 'r1')
            binding_id = registered['binding_id']
            self.assertTrue(self.control.is_live(binding_id))
            participant = self.control.participants()[0]
            self.assertEqual(participant['engine'], {'model': 'claude-opus-5'})
            self.assertEqual(participant['capabilities']['deliver'], 'supported')

            published = connector.request('speech.publish', {
                'event_id': 'e1', 'binding_id': binding_id, 'session_id': 'call', 'revision': 3, 'text': 'Hola', 'language': 'es'})
            self.assertEqual(published['status'], 'queued')
            self.assertEqual((self.hub.published[0].thread_id, self.hub.published[0].revision), ('sess-1', 3))

            # Fire-and-forget routes say nothing back; what they did shows in the room.
            connector.send('input.working', {'binding_id': binding_id, 'working': True,
                                             'turn_id': 't1', 'turn_phase': 'start', 'session_id': 'call', 'revision': 3})
            row = self.journal.put(id='call:user-turn:m1', thread='sess-1', role='user', text='hola', name='Tú',
                                   session='call', revision=1, status='sending',
                                   payload={'message_id': 'm1', 'session_id': 'call', 'revision': 1})
            connector.send('input.read', {'binding_id': binding_id, 'message_id': 'm1', 'session_id': 'call', 'revision': 1})
            connector.send('binding.unregister', {'binding_id': binding_id})
            connector.keepalive()
            connector.request('connector.hello', {})   # a round trip, so everything before it has been handled

            self.assertEqual(self.hub.working, [('sess-1', True, {'turn_id': 't1', 'turn_phase': 'start', 'session_id': 'call', 'revision': 3})])
            self.assertEqual(self.journal.get(row['id'])['status'], 'read')
            self.assertFalse(self.control.is_live(binding_id))

    def test_a_registration_the_room_refuses_is_an_error_on_that_stream_and_nothing_else(self):
        with self.room() as (client, connectors):
            connector = self.connect(client, connectors)
            connector.request('connector.hello', {})
            with self.assertRaises(RSocketRefusal) as refused:
                connector.request('binding.register', {'client_ref': 'r1', 'harness': 'claude', 'thread': 'bad thread!'})
            self.assertEqual(refused.exception.code, ErrorCode.APPLICATION_ERROR)
            self.assertEqual(refused.exception.detail, 'Invalid conversation identifier')
            # The connection survives it: only that request failed.
            self.assertEqual(connector.request('binding.register', {'client_ref': 'r2', 'harness': 'claude', 'thread': 'sess-2'})['thread'], 'sess-2')

    def test_speech_from_a_binding_this_connector_does_not_hold_is_refused_without_reaching_the_room(self):
        with self.room() as (client, connectors):
            connector = self.connect(client, connectors)
            connector.request('connector.hello', {})
            refused = connector.request('speech.publish', {'event_id': 'e1', 'binding_id': 'not-mine', 'text': 'Hola'})
            self.assertEqual((refused['status'], refused['error']), ('rejected', 'Unknown binding'))
            self.assertEqual(self.hub.published, [])

    def test_a_newer_connection_from_the_same_connector_wins_and_the_older_one_goes(self):
        with self.room() as (client, connectors):
            first = self.connect(client, connectors)
            first.request('connector.hello', {})
            second = self.connect(client, connectors)
            second.request('connector.hello', {})
            with self.assertRaises(WebSocketDisconnect):
                for _ in range(3):
                    first.read()
            self.assertIn(self.connector_id, self.control.peers, 'the newer one is still the connector')

    def test_a_connector_that_goes_silent_is_let_go_after_the_misses_the_old_link_allows(self):
        # RSocket keepalive is the client's to schedule, so a room that hears nothing has to ask.
        self.control.heartbeat_seconds = .05
        with self.room() as (client, connectors):
            connector = self.connect(client, connectors)
            connector.request('connector.hello', {})
            asked = 0
            with self.assertRaises(WebSocketDisconnect):
                for _ in range(20):
                    frame = connector.read()
                    if isinstance(frame, KeepAliveFrame) and frame.flags_respond:
                        asked += 1
            self.assertGreaterEqual(asked, 1, 'the room asked before it gave up')

    def test_the_room_answers_a_keepalive_it_is_asked_to_answer(self):
        with self.room() as (client, connectors):
            connector = self.connect(client, connectors)
            connector.request('connector.hello', {})
            connector.keepalive()
            answer = connector.read()
            self.assertEqual(answer.stream_id, 0)
            self.assertFalse(answer.flags_respond, 'answered once, never bounced back and forth')


class DeliveryOverRSocketTests(unittest.IsolatedAsyncioTestCase):
    """The room asking, rather than being asked: a delivery is a request whose answer is the
    acknowledgement, so nothing has to be matched back by event id."""

    async def asyncSetUp(self):
        from sidevoice.connector_rsocket import RSocketPeer
        from sidevoice.connector_control import ConnectorControl
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.journal = RoomHistory(Path(self.temp.name) / 'room.sqlite3')
        self.hub = FakeHub(self.journal)
        self.control = ConnectorControl(self.journal, self.hub)
        self.connector_id, _ = self.journal.redeem_pairing_code(self.journal.create_pairing_code())
        self.asked = []
        self.peer = RSocketPeer(self)
        self.server = self          # the peer reaches its session's `server`; here that is this test

    # ----- standing in for one RSocket connection -----
    def request_response(self, payload):
        import asyncio
        from sidevoice.connector_rsocket import body_of
        from rsocket.extensions.helpers import require_route
        from rsocket.extensions.composite_metadata import CompositeMetadata
        metadata = CompositeMetadata(); metadata.parse(payload.metadata)
        self.asked.append((require_route(metadata), body_of(payload)))
        self.answer = asyncio.get_running_loop().create_future()
        return self.answer

    async def fire_and_forget(self, payload):
        from sidevoice.connector_rsocket import body_of
        from rsocket.extensions.helpers import require_route
        from rsocket.extensions.composite_metadata import CompositeMetadata
        metadata = CompositeMetadata(); metadata.parse(payload.metadata)
        self.asked.append((require_route(metadata), body_of(payload)))

    async def test_a_delivery_is_settled_by_the_answer_to_its_own_request(self):
        import asyncio
        binding = self.journal.register_binding(self.connector_id, harness='claude', thread='sess-1')
        self.control.peers[self.connector_id] = self.peer
        self.control.live[binding['id']] = self.connector_id
        row = self.journal.put(id='call:user-turn:m1', thread='sess-1', role='user', text='hola', name='Tú',
                               session='call', revision=1, status='pending',
                               payload={'message_id': 'm1', 'session_id': 'call', 'revision': 1})
        await self.control.tick()
        self.assertEqual(self.asked[0][0], 'input.deliver')
        self.assertEqual(self.asked[0][1]['text'], 'hola')
        self.assertEqual(self.journal.get(row['id'])['status'], 'sending')

        self.answer.set_result(Payload(json.dumps({'status': 'accepted', 'detail': 'written'}).encode()))
        await asyncio.sleep(.05)
        self.assertEqual(self.journal.get(row['id'])['status'], 'delivered',
                         'the room fills in which event it asked about; the connector only says how it went')
        self.assertEqual(self.control.inflight, {})

    async def test_what_the_room_tells_a_connector_without_waiting_goes_out_as_fire_and_forget(self):
        binding = self.journal.register_binding(self.connector_id, harness='claude', thread='sess-1')
        self.control.peers[self.connector_id] = self.peer
        self.control.live[binding['id']] = self.connector_id
        await self.control.close_binding(self.journal.binding(binding['id']))
        self.assertEqual(self.asked[0][0], 'binding.close')
        self.assertEqual(self.asked[0][1]['reason'], 'closed_from_room')


def tearDownModule():
    """Give back what this module borrowed, here, where nothing is being timed.

    Serving a room, spawning connectors and opening sockets leaves thousands of objects that only
    the cyclic collector can reclaim, and a full collection over this suite's heap costs about a
    tenth of a second. Left for the interpreter to schedule, that cost lands wherever the threshold
    happens to fall — which is somebody else's test, and the reason this module used to make one of
    them fail roughly two runs in three. Reclaiming it at this boundary costs the same tenth of a
    second and spends it on the tests that made the garbage.
    """
    gc.collect()
