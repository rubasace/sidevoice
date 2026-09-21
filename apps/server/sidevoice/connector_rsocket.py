"""The connector link over RSocket: `/api/connectors/rsocket`.

Same control plane as `/api/connectors/ws`, same frames, same JSON — what changes is who
owns the request/response bookkeeping. A delivery is a request whose answer comes back on
its own stream, so no event id has to be matched by hand; a rejected registration is an
ERROR on that stream, not a second frame type; a bad credential never gets past SETUP.

rsocket-py ships WebSocket transports for aiohttp, quart and `websockets`, and a `fastapi`
extra that pulls FastAPI in only for its HTTP/3 transport: there is no Starlette one, so
`StarletteWebsocketTransport` below is it, modelled on the library's `quart_websocket.py`.
"""
import asyncio
import json

from fastapi import WebSocket, WebSocketDisconnect
from loguru import logger

from rsocket.extensions.authentication import AuthenticationSimple
from rsocket.extensions.authentication_content import AuthenticationContent
from rsocket.extensions.composite_metadata import CompositeMetadata
from rsocket.extensions.helpers import composite, route as route_metadata
from rsocket.extensions.mimetypes import WellKnownMimeTypes
from rsocket.frame_builders import to_keepalive_frame
from rsocket.helpers import wrap_transport_exception
from rsocket.payload import Payload
from rsocket.routing.request_router import RequestRouter
from rsocket.routing.routing_request_handler import RoutingRequestHandler
from rsocket.rsocket_server import RSocketServer
from rsocket.transports.abstract_messaging import AbstractMessagingTransport

from .connector_control import ConnectorPeer, HEARTBEAT_MISSES, PROTOCOL

DATA_ENCODING = WellKnownMimeTypes.APPLICATION_JSON
METADATA_ENCODING = WellKnownMimeTypes.MESSAGE_RSOCKET_COMPOSITE_METADATA


def payload_of(frame):
    """A room frame as an RSocket payload: the route carries the `type`, the data is the rest."""
    kind = frame['type']
    body = {key: value for key, value in frame.items() if key != 'type'}
    return kind, Payload(json.dumps(body).encode(), composite(route_metadata(kind)))


def body_of(payload):
    """The JSON object a payload carries. An empty payload is an empty object, never a failure."""
    if not payload or not payload.data:
        return {}
    decoded = json.loads(payload.data.decode())
    return decoded if isinstance(decoded, dict) else {}


def reply(frame):
    """A room frame as the answer on an open stream: the route already named it, so the `type`
    would only be said twice."""
    return Payload(json.dumps({key: value for key, value in frame.items() if key != 'type'}).encode())


class StarletteWebsocketTransport(AbstractMessagingTransport):
    """One RSocket frame per WebSocket message, so nothing carries a length prefix."""

    def __init__(self, websocket: WebSocket):
        super().__init__()
        self.websocket = websocket
        self.heard = False          # Any frame at all proves the connector is still there.
        self._close_code = None
        self._closed = False

    async def handle_incoming(self):
        """Runs until the connector goes away; that is what keeps the route's handler alive."""
        try:
            while True:
                data = await self.websocket.receive_bytes()
                if not data:
                    continue
                self.heard = True
                async for frame in self._frame_parser.receive_data(data, 0):
                    self._incoming_frame_queue.put_nowait(frame)
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        except (KeyError, TypeError, RuntimeError) as error:
            logger.debug('Connector RSocket transport ended: {}', type(error).__name__)

    async def send_frame(self, frame):
        with wrap_transport_exception():
            await self.websocket.send_bytes(frame.serialize())

    async def close(self):
        await self.shutdown(1000)

    def close_when_flushed(self, code):
        """Close, but not before whatever is already queued is on the wire — a refused SETUP is an
        ERROR frame the connector must be able to read before the socket disappears."""
        self._close_code = code

    async def on_send_queue_empty(self):
        if self._close_code is not None:
            await self.shutdown(self._close_code)

    async def shutdown(self, code):
        if self._closed:
            return
        self._closed = True
        try:
            await self.websocket.close(code=code)
        except Exception:
            pass


class RSocketPeer(ConnectorPeer):
    """The control plane's view of one connector reached over RSocket."""

    def __init__(self, session):
        self.session = session

    async def send(self, frame):
        _, payload = payload_of(frame)
        await self.session.server.fire_and_forget(payload)

    async def request(self, frame):
        _, payload = payload_of(frame)
        return asyncio.ensure_future(self.answer(frame, self.session.server.request_response(payload)))

    @staticmethod
    async def answer(frame, pending):
        """The room already knows which event it asked about — the stream is the correlation — so the
        connector says only how it went, and the answer is put back together here."""
        return {'event_id': frame.get('event_id'), **body_of(await pending)}

    async def disconnect(self):
        if self.session.transport is not None:   # a session that already ended has nothing to close
            await self.session.transport.shutdown(1000)


class ConnectorHandler(RoutingRequestHandler):
    """Routes to the same `ConnectorControl` methods the WebSocket link calls, and authenticates
    the whole connection once, in SETUP, rather than once per request."""

    def __init__(self, session):
        super().__init__(session.router())
        self.session = session

    async def on_setup(self, data_encoding, metadata_encoding, payload):
        await super().on_setup(data_encoding, metadata_encoding, payload)
        await self.session.authenticate(payload)

    async def on_close(self, rsocket, exception=None):
        await self.session.forget()


class ConnectorSession:
    """One connection: the socket, the RSocket server over it, and the connector it turned out
    to belong to once SETUP was read."""

    def __init__(self, control, websocket: WebSocket):
        self.control, self.websocket = control, websocket
        self.connector_id, self.peer = None, None
        self.transport = self.server = self.probe_task = None

    # ----- the connection -----

    async def run(self):
        await self.websocket.accept()
        self.transport = StarletteWebsocketTransport(self.websocket)
        self.server = RSocketServer(self.transport,
                                    handler_factory=lambda: ConnectorHandler(self),
                                    data_encoding=DATA_ENCODING,
                                    metadata_encoding=METADATA_ENCODING)
        try:
            await self.transport.handle_incoming()
        finally:
            if self.probe_task:
                self.probe_task.cancel()
            await self.forget()
            await self.server.close()
            self.release()

    def release(self):
        """A finished connection refers to itself through its server, its handler, its routes and its
        peer, so nothing about it is freed until a full collection comes round — and on a room that
        has served many connectors, that is a lot of dead graph waiting for one. Letting go of the
        ends here turns the loop into a tree that goes as soon as this call returns."""
        self.server = self.peer = self.transport = self.probe_task = None

    async def authenticate(self, payload):
        """SETUP decides everything: who this is, whether the room believes them, and whether the
        two sides speak the same protocol. Anything wrong here is REJECTED_SETUP and no socket."""
        metadata = CompositeMetadata()
        metadata.parse(payload.metadata or b'')
        credential = next((item.authentication for item in metadata.items
                           if isinstance(item, AuthenticationContent)), None)
        if not isinstance(credential, AuthenticationSimple):
            self.transport.close_when_flushed(1008)
            raise ValueError('Connector credential missing from setup')
        connector_id, token = credential.username.decode(), credential.password.decode()
        if not self.control.journal.authenticate_connector(connector_id, token):
            self.transport.close_when_flushed(1008)
            raise ValueError('Unknown connector or token')
        if body_of(payload).get('protocol') != PROTOCOL:
            self.transport.close_when_flushed(1008)
            raise ValueError(f'Unsupported protocol; server speaks {PROTOCOL}')
        self.connector_id, self.peer = connector_id, RSocketPeer(self)
        await self.control.attach(connector_id, self.peer)
        self.probe_task = asyncio.create_task(self.probe())

    async def forget(self):
        if self.peer is not None:
            self.control.detach(self.connector_id, self.peer)

    async def probe(self):
        """RSocket keepalive is the client's to schedule, so a room that hears nothing asks — and
        gives up after the same number of misses the WebSocket link allows."""
        missed, asked = 0, False
        try:
            while True:
                self.transport.heard = False
                await asyncio.sleep(self.control.heartbeat_seconds)
                if self.transport.heard:
                    missed, asked = 0, False
                    continue
                if asked:
                    missed += 1
                if missed >= HEARTBEAT_MISSES:
                    logger.info('Connector {} stopped answering; closing', self.connector_id)
                    await self.transport.shutdown(1001)
                    return
                asked = True
                self.server.send_frame(to_keepalive_frame(b''))
        except asyncio.CancelledError:
            raise

    # ----- what the connector may ask for -----

    def router(self):
        router = RequestRouter()
        control = self.control

        def mine(payload):
            """No route runs for a connection that has not said who it is."""
            if self.connector_id is None:
                raise ValueError('Setup has not authenticated this connection')
            return body_of(payload)

        @router.response('connector.hello')
        async def hello(payload: Payload):
            mine(payload)
            return reply({'type': 'connector.welcome', 'protocol': PROTOCOL,
                          'heartbeat_seconds': control.heartbeat_seconds})

        @router.response('binding.register')
        async def register(payload: Payload):
            return reply(await control.register(self.connector_id, mine(payload)))

        @router.fire_and_forget('binding.unregister')
        async def unregister(payload: Payload):
            await control.unregister(self.connector_id, mine(payload))

        @router.response('speech.publish')
        async def speech(payload: Payload):
            return reply(await control.speech(self.connector_id, mine(payload)))

        @router.fire_and_forget('input.working')
        async def working(payload: Payload):
            await control.working(self.connector_id, mine(payload))

        @router.fire_and_forget('input.read')
        async def read(payload: Payload):
            await control.read(self.connector_id, mine(payload))

        return router


def mount_connector_rsocket(app, control):
    @app.websocket('/api/connectors/rsocket')
    async def connector_rsocket(websocket: WebSocket):
        await ConnectorSession(control, websocket).run()
