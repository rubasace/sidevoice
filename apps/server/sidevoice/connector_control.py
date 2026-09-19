"""Control plane for outbound connectors: pairing, presence, delivery and speech intake.

It knows nothing about Claude, Codex or browser audio. A connector pairs once,
authenticates each connection, registers a binding per conversation it serves,
receives the room's queued input for those bindings and returns exact-event
acknowledgements; speech it publishes lands in the room like any other.
The room's journal is the only delivery state; nothing here is a second outbox.
"""
import asyncio
import json
import re
import time
import uuid
from fastapi import HTTPException, Request, WebSocket, WebSocketDisconnect
from loguru import logger
from pydantic import BaseModel, Field

PROTOCOL = 1
HEARTBEAT_SECONDS = 15.0
HEARTBEAT_MISSES = 2
ACK_TIMEOUT_SECONDS = 60.0
THREAD_PATTERN = re.compile(r'^[A-Za-z0-9._:-]{1,200}$')


class PairingRequest(BaseModel):
    code: str = Field(min_length=4, max_length=32)
    host: str = Field(default='', max_length=200)


class ConnectorControl:
    def __init__(self, journal, hub, *, heartbeat_seconds=HEARTBEAT_SECONDS, ack_timeout=ACK_TIMEOUT_SECONDS):
        self.journal, self.hub = journal, hub
        self.sockets = {}    # connector_id -> live WebSocket
        self.live = {}       # binding_id -> connector_id, only while that connector is connected
        self.inflight = {}   # binding_id -> (event_id, started_at): one delivery at a time per binding
        self.heartbeat_seconds, self.ack_timeout = heartbeat_seconds, ack_timeout
        self.pump_task = None

    async def start(self):
        self.pump_task = asyncio.create_task(self.pump())

    async def stop(self):
        if self.pump_task:
            self.pump_task.cancel()
            await asyncio.gather(self.pump_task, return_exceptions=True)

    # ----- presence -----

    def is_live(self, binding_id):
        return self.live.get(binding_id) in self.sockets

    def participants(self):
        return [{**binding, 'connected': self.is_live(binding['id'])} for binding in self.journal.bindings()]

    @staticmethod
    def reachability(binding):
        """Three states, because 'connected' and 'will receive what you say' are not the same thing."""
        if not binding.get('connected'):
            return {'state': 'offline',
                    'detail': 'Esa conversación no está conectada a la sala. Pídele que se conecte.'}
        inbound = binding.get('inbound')
        if isinstance(inbound, str):
            try:
                inbound = json.loads(inbound)
            except ValueError:
                inbound = None
        if isinstance(inbound, dict) and inbound.get('ok') is False:
            return {'state': 'holding',
                    'detail': inbound.get('reason') or 'Su harness retiene lo que enviamos en vez de entregarlo.',
                    'remedy': inbound.get('remedy')}
        return {'state': 'listening', 'detail': None}

    # ----- delivery: the room's outbox drains through live bindings -----

    async def pump(self):
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.warning('Connector delivery tick failed: {}', type(error).__name__)
            await asyncio.sleep(.25)

    async def tick(self, now=None):
        now = now if now is not None else time.time()
        for binding_id, (event_id, started) in list(self.inflight.items()):
            if now - started > self.ack_timeout:
                del self.inflight[binding_id]
                self.journal.defer(event_id)
        for row in self.journal.pending(now):
            binding = self.journal.binding_for_thread(row['thread'])
            if not binding or binding['id'] in self.inflight:
                continue
            socket = self.sockets.get(self.live.get(binding['id']) or '')
            if socket is None:
                continue
            payload = json.loads(row['payload'] or '{}')
            self.journal.update(row['id'], 'sending')
            self.inflight[binding['id']] = (row['id'], now)
            try:
                await socket.send_json({'type': 'input.deliver', 'event_id': row['id'], 'binding_id': binding['id'],
                                        'thread': row['thread'], 'text': row['text'],
                                        'channel': payload.get('channel', 'voice'), 'session_id': payload.get('session_id'),
                                        'revision': payload.get('revision'), 'message_id': payload.get('message_id')})
            except Exception:
                self.inflight.pop(binding['id'], None)
                self.journal.defer(row['id'], immediate=True)

    async def acknowledge(self, connector_id, message):
        event_id, status = message.get('event_id'), message.get('status')
        for binding_id, (inflight_event, _) in list(self.inflight.items()):
            if inflight_event != event_id:
                continue
            if self.live.get(binding_id) != connector_id:
                return  # Not this connector's delivery: ignore, never let a stranger settle it.
            del self.inflight[binding_id]
            row = self.journal.get(event_id)
            if row and row['status'] == 'read':
                # The conversation already admitted it (a hook said so, faster than this acknowledgement
                # came back): nothing the delivery path learns later can take the second tick away.
                return
            if status == 'accepted':
                self.journal.update(event_id, 'delivered')
                self.hub.delivery_status(event_id, 'delivered')
            elif status == 'unknown':
                # The harness offers no acknowledgement: it was written, and that is all
                # anyone knows. Retrying would duplicate without ever learning more.
                self.journal.update(event_id, 'unconfirmed', message.get('detail'))
                self.hub.delivery_status(event_id, 'unconfirmed')
            else:
                self.journal.defer(event_id)
                self.hub.delivery_status(event_id, 'pending')
            return

    async def read(self, connector_id, message):
        """A harness hook, through its connector, says the conversation admitted this message: the second tick."""
        binding = self.journal.binding(message.get('binding_id'))
        if not binding or self.live.get(binding['id']) != connector_id:
            return
        row = self.journal.find_message(message.get('message_id'))
        if not row or row['thread'] != binding['thread'] or row['role'] != 'user':
            return
        if row['status'] in {'read', 'not_sent'}:
            return
        self.journal.update(row['id'], 'read')
        self.hub.delivery_status(row['id'], 'read')

    # ----- bindings and speech -----

    async def register(self, connector_id, socket, message):
        client_ref = message.get('client_ref')
        thread = message.get('thread')
        if not isinstance(thread, str) or not THREAD_PATTERN.match(thread):
            await socket.send_json({'type': 'binding.rejected', 'client_ref': client_ref, 'error': 'Invalid conversation identifier'})
            return
        try:
            inbound = message.get('inbound') if isinstance(message.get('inbound'), dict) else None
            binding = self.journal.register_binding(connector_id, harness=str(message.get('harness') or 'unknown')[:40],
                                                    thread=thread, title=(message.get('title') or None) and str(message['title'])[:200],
                                                    binding_id=message.get('binding_id'), inbound=inbound)
        except ValueError as error:
            await socket.send_json({'type': 'binding.rejected', 'client_ref': client_ref, 'error': str(error)})
            return
        self.live[binding['id']] = connector_id
        # A conversation joining the room selects itself for nobody: which conversation a browser
        # talks to is that browser's choice (and the reason a call must never jump on a connect).
        await socket.send_json({'type': 'binding.registered', 'client_ref': client_ref, 'binding_id': binding['id'], 'thread': binding['thread']})

    async def close_binding(self, record):
        """The user closed this conversation's voice from the room: its connector forgets the binding."""
        connector_id = self.live.pop(record['id'], None)
        self.journal.deactivate_binding(record['connector'], record['id'])
        self.inflight.pop(record['id'], None)
        socket = self.sockets.get(connector_id or '')
        if socket is not None:
            try:
                await socket.send_json({'type': 'binding.close', 'binding_id': record['id'], 'thread': record['thread'],
                                        'reason': 'closed_from_room'})
            except Exception:
                pass

    async def unregister(self, connector_id, message):
        binding_id = message.get('binding_id')
        if self.live.get(binding_id) == connector_id:
            del self.live[binding_id]
            self.journal.deactivate_binding(connector_id, binding_id)
            inflight = self.inflight.pop(binding_id, None)
            if inflight:
                self.journal.defer(inflight[0], immediate=True)

    async def speech(self, connector_id, socket, message):
        from .presentation import Speech
        reply = {'type': 'speech.published', 'event_id': message.get('event_id')}
        binding = self.journal.binding(message.get('binding_id'))
        if not binding or self.live.get(binding['id']) != connector_id:
            await socket.send_json({**reply, 'status': 'rejected', 'error': 'Unknown binding'})
            return
        try:
            speech = Speech(thread_id=binding['thread'], session_id=str(message.get('session_id') or ''),
                            revision=int(message.get('revision') or 0), text=str(message.get('text') or ''),
                            utterance_id=str(message.get('utterance_id') or uuid.uuid4()), language=message.get('language'))
            result = await self.hub.publish(speech)
            await socket.send_json({**reply, **result})
        except HTTPException as error:
            await socket.send_json({**reply, 'status': 'rejected', 'error': str(error.detail)})
        except Exception as error:
            await socket.send_json({**reply, 'status': 'rejected', 'error': str(error) or type(error).__name__})

    # ----- one connection -----

    async def connect(self, socket: WebSocket):
        await socket.accept()
        connector_id = None
        try:
            hello = await asyncio.wait_for(socket.receive_json(), timeout=10)
            if hello.get('type') != 'connector.hello' or not self.journal.authenticate_connector(hello.get('connector_id'), hello.get('token')):
                await socket.close(code=1008); return
            if hello.get('protocol') != PROTOCOL:
                await socket.send_json({'type': 'connector.error', 'error': f'Unsupported protocol; server speaks {PROTOCOL}'})
                await socket.close(code=1008); return
            connector_id = hello['connector_id']
            previous = self.sockets.get(connector_id)
            self.sockets[connector_id] = socket
            if previous is not None:
                try:
                    await previous.close(code=1000)  # A newer connection from the same connector wins.
                except Exception:
                    pass
            await socket.send_json({'type': 'connector.welcome', 'protocol': PROTOCOL, 'heartbeat_seconds': self.heartbeat_seconds})
            missed, nonce = 0, None
            while True:
                try:
                    message = await asyncio.wait_for(socket.receive_json(), timeout=self.heartbeat_seconds)
                except asyncio.TimeoutError:
                    if nonce is not None:
                        missed += 1
                    if missed >= HEARTBEAT_MISSES:
                        await socket.close(code=1001); return
                    nonce = uuid.uuid4().hex
                    await socket.send_json({'type': 'heartbeat', 'nonce': nonce})
                    continue
                kind = message.get('type')
                if kind == 'heartbeat.ack':
                    if message.get('nonce') == nonce:
                        nonce, missed = None, 0
                elif kind == 'heartbeat':
                    await socket.send_json({'type': 'heartbeat.ack', 'nonce': message.get('nonce')})
                elif kind == 'binding.register':
                    await self.register(connector_id, socket, message)
                elif kind == 'binding.unregister':
                    await self.unregister(connector_id, message)
                elif kind == 'speech.publish':
                    await self.speech(connector_id, socket, message)
                elif kind == 'input.ack':
                    await self.acknowledge(connector_id, message)
                elif kind == 'input.read':
                    await self.read(connector_id, message)
        except (WebSocketDisconnect, asyncio.TimeoutError, ValueError, RuntimeError):
            pass
        finally:
            if connector_id and self.sockets.get(connector_id) is socket:
                del self.sockets[connector_id]
                for binding_id in [b for b, c in self.live.items() if c == connector_id]:
                    del self.live[binding_id]
                    inflight = self.inflight.pop(binding_id, None)
                    if inflight:
                        self.journal.defer(inflight[0], immediate=True)


def mount_connector_control(app, hub, **options):
    control = ConnectorControl(hub.journal, hub, **options)
    hub.control = control
    from contextlib import asynccontextmanager
    previous_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def control_lifespan(application):
        async with previous_lifespan(application) as state:
            await control.start()
            try:
                yield state
            finally:
                await control.stop()
    app.router.lifespan_context = control_lifespan

    from .presentation import require_same_origin as browser_only

    @app.websocket('/api/connectors/ws')
    async def connector_socket(websocket: WebSocket):
        await control.connect(websocket)

    @app.post('/api/connectors/pairing-code')
    async def pairing_code(request: Request):
        browser_only(request)
        return {'code': hub.journal.create_pairing_code(), 'expires_in': 600}

    @app.post('/api/connectors/pair')
    async def pair(payload: PairingRequest):
        credential = hub.journal.redeem_pairing_code(payload.code, payload.host)
        if credential is None:
            raise HTTPException(403, 'Código de emparejamiento inválido o caducado.')
        return {'connector_id': credential[0], 'token': credential[1], 'protocol': PROTOCOL}

    @app.get('/api/connectors')
    async def connectors(request: Request):
        browser_only(request)
        return {'connectors': [{**c, 'connected': c['id'] in control.sockets} for c in hub.journal.connectors()],
                'bindings': control.participants()}

    return control
