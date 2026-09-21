"""Control plane for outbound connectors: pairing, presence, delivery and speech intake.

It knows nothing about Claude, Codex or browser audio. A connector pairs once,
authenticates each connection, registers a binding per conversation it serves,
receives the room's queued input for those bindings and returns exact-event
acknowledgements; speech it publishes lands in the room like any other.
The room's journal is the only delivery state; nothing here is a second outbox.

What carries the frames is not this module's business: it talks to a *peer* — one
connector, reachable — and two transports implement it. `/api/connectors/ws` is the
hand-rolled protocol below; `/api/connectors/rsocket` is RSocket, in `connector_rsocket`.
"""
import asyncio
import json
import re
import time
import uuid
from fastapi import HTTPException, Request, WebSocket, WebSocketDisconnect
from loguru import logger
from pydantic import BaseModel, Field

from .telemetry import redelivered

PROTOCOL = 1
HEARTBEAT_SECONDS = 15.0
HEARTBEAT_MISSES = 2
ACK_TIMEOUT_SECONDS = 60.0
LINKS = ('rsocket', 'ws')   # What `/api/connectors/<link>` this room serves, best first.
THREAD_PATTERN = re.compile(r'^[A-Za-z0-9._:-]{1,200}$')
HARNESS_CAPABILITIES = ('deliver', 'inspectInbound', 'working', 'endOfTurn', 'sessionIdentity')
CAPABILITY_STATES = {'supported', 'unsupported'}


def engine_of(value):
    """Which model answers this conversation, as its harness read it from its own launch line. Absent
    rather than guessed: no model is asked to say what it is."""
    if not isinstance(value, dict):
        return None
    kept = {key: str(value[key])[:60] for key in ('model', 'effort', 'thinking') if value.get(key)}
    return kept or None


def harness_capabilities(value):
    """Normalize the wire declaration. Missing and invalid values stay unknown, never false."""
    declared = value if isinstance(value, dict) else {}
    return {name: declared.get(name) if declared.get(name) in CAPABILITY_STATES else 'unknown'
            for name in HARNESS_CAPABILITIES}


class ConnectorPeer:
    """One connector, reachable — whatever carries the frames.

    `send` is fire-and-forget. `request` puts the frame on the wire — raising if it cannot — and
    returns a future for that connector's answer to *this* frame: over RSocket the reply on the
    same stream, over the hand-rolled protocol a later message matched back by event id.
    Sending and answering are two moments because the room acts on each: a frame that never left
    goes back in the outbox at once, while an answer may take as long as the harness takes.
    """

    async def send(self, frame):
        raise NotImplementedError

    async def request(self, frame):
        raise NotImplementedError

    async def disconnect(self):
        """A newer connection from the same connector won: let this one go."""


class WebSocketPeer(ConnectorPeer):
    """The hand-rolled protocol: one JSON object per message, in both directions."""

    def __init__(self, socket):
        self.socket, self.waiting = socket, {}

    async def send(self, frame):
        await self.socket.send_json(frame)

    async def request(self, frame):
        """Only `input.deliver` is asked this way, and its answer is the `input.ack` carrying the
        same event id. Nothing here times out: the room's own inflight clock already does, and it
        cancels this wait when it gives up."""
        waiter = asyncio.get_running_loop().create_future()
        self.waiting[frame['event_id']] = waiter
        try:
            await self.socket.send_json(frame)
        except Exception:
            self.waiting.pop(frame['event_id'], None)
            raise
        return asyncio.ensure_future(self.answer(frame['event_id'], waiter))

    async def answer(self, event_id, waiter):
        try:
            return await waiter
        finally:
            self.waiting.pop(event_id, None)

    def settle(self, frame):
        """An `input.ack` arrived. True when it answered a delivery this connection is waiting for."""
        waiter = self.waiting.pop(frame.get('event_id'), None)
        if waiter is None or waiter.done():
            return False
        waiter.set_result(frame)
        return True

    async def disconnect(self):
        try:
            await self.socket.close(code=1000)
        except Exception:
            pass


class PairingRequest(BaseModel):
    code: str = Field(min_length=4, max_length=32)
    host: str = Field(default='', max_length=200)


class ConnectorControl:
    def __init__(self, journal, hub, *, heartbeat_seconds=HEARTBEAT_SECONDS, ack_timeout=ACK_TIMEOUT_SECONDS):
        self.journal, self.hub = journal, hub
        self.peers = {}      # connector_id -> ConnectorPeer, one per live connection
        self.live = {}       # binding_id -> connector_id, only while that connector is connected
        self.inflight = {}   # binding_id -> (event_id, started_at, task): one delivery at a time per binding
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
        return self.live.get(binding_id) in self.peers

    async def attach(self, connector_id, peer):
        """This connection now speaks for that connector; a newer one from the same connector wins."""
        previous = self.peers.get(connector_id)
        self.peers[connector_id] = peer
        if previous is not None and previous is not peer:
            await previous.disconnect()

    def detach(self, connector_id, peer):
        """That connection is gone. Its bindings stop being live and whatever was in flight goes back
        into the room's outbox, to be delivered again when the connector returns."""
        if not connector_id or self.peers.get(connector_id) is not peer:
            return
        del self.peers[connector_id]
        for binding_id in [b for b, c in self.live.items() if c == connector_id]:
            del self.live[binding_id]
            inflight = self.drop_inflight(binding_id)
            if inflight:
                self.journal.defer(inflight[0], immediate=True)

    def drop_inflight(self, binding_id):
        """Forget the delivery in flight for this binding and stop waiting for its acknowledgement —
        unless it is that very wait asking, which would be cancelling the ground under itself."""
        entry = self.inflight.pop(binding_id, None)
        if entry and entry[2] is not None and entry[2] is not asyncio.current_task():
            entry[2].cancel()
        return entry

    def participants(self):
        return [{**binding, 'capabilities': harness_capabilities(binding.get('capabilities')),
                 'connected': self.is_live(binding['id'])} for binding in self.journal.bindings()]

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
        for binding_id, (event_id, started, _) in list(self.inflight.items()):
            if now - started > self.ack_timeout:
                self.drop_inflight(binding_id)
                self.journal.defer(event_id)
        for row in self.journal.pending(now):
            binding = self.journal.binding_for_thread(row['thread'])
            if not binding or binding['id'] in self.inflight:
                continue
            connector_id = self.live.get(binding['id']) or ''
            peer = self.peers.get(connector_id)
            if peer is None:
                continue
            payload = json.loads(row['payload'] or '{}')
            frame = {'type': 'input.deliver', 'event_id': row['id'], 'binding_id': binding['id'],
                     'thread': row['thread'], 'text': row['text'],
                     'channel': payload.get('channel', 'voice'), 'session_id': payload.get('session_id'),
                     'revision': payload.get('revision'), 'message_id': payload.get('message_id')}
            self.journal.update(row['id'], 'sending')
            self.inflight[binding['id']] = (row['id'], now, None)
            try:
                answer = await peer.request(frame)
            except Exception:
                self.inflight.pop(binding['id'], None)
                self.journal.defer(row['id'], immediate=True)
                redelivered(row['thread'], binding.get('harness'))
                continue
            if self.inflight.get(binding['id'], (None,))[0] != row['id']:
                answer.cancel()   # the connection went while the frame was on its way out; it has already been put back
                continue
            self.inflight[binding['id']] = (row['id'], now,
                                            asyncio.create_task(self.settle(connector_id, binding, row['id'], answer)))

    async def settle(self, connector_id, binding, event_id, answer):
        """Waits for one delivery's acknowledgement. Which of the two transports carries it is the
        peer's business; what it means is read in one place, and a connection that dies before
        answering puts the event back where the next connector will find it."""
        try:
            acknowledgement = await answer
        except asyncio.CancelledError:
            raise
        except Exception:
            entry = self.inflight.get(binding['id'])
            if entry and entry[0] == event_id:
                self.inflight.pop(binding['id'], None)
                self.journal.defer(event_id, immediate=True)
                redelivered(binding['thread'], binding.get('harness'))
            return
        if acknowledgement:
            await self.acknowledge(connector_id, acknowledgement)

    async def acknowledge(self, connector_id, message):
        event_id, status = message.get('event_id'), message.get('status')
        for binding_id, (inflight_event, _, _) in list(self.inflight.items()):
            if inflight_event != event_id:
                continue
            if self.live.get(binding_id) != connector_id:
                return  # Not this connector's delivery: ignore, never let a stranger settle it.
            self.drop_inflight(binding_id)
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
                redelivered((row or {}).get('thread'), (self.journal.binding(binding_id) or {}).get('harness'))
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

    async def working(self, connector_id, message):
        """The harness itself says whether that conversation is busy. The room shows it while it lasts."""
        binding = self.journal.binding(message.get('binding_id'))
        if (not binding or self.live.get(binding['id']) != connector_id
                or not isinstance(message.get('working'), bool)):
            return
        metadata = {}
        turn_id, turn_phase = message.get('turn_id'), message.get('turn_phase')
        if isinstance(turn_id, str) and turn_id and turn_phase in {'start', 'end'}:
            metadata.update(turn_id=turn_id, turn_phase=turn_phase)
            session_id, revision = message.get('session_id'), message.get('revision')
            if isinstance(session_id, str) and session_id and type(revision) is int and revision >= 0:
                metadata.update(session_id=session_id, revision=revision)
        self.hub.conversation_working(binding['thread'], message['working'], **metadata)

    # ----- bindings and speech -----

    async def register(self, connector_id, message):
        """Returns the `binding.registered` frame, or raises ValueError with the reason it was refused —
        a rejection each transport says in its own words."""
        client_ref = message.get('client_ref')
        thread = message.get('thread')
        if not isinstance(thread, str) or not THREAD_PATTERN.match(thread):
            raise ValueError('Invalid conversation identifier')
        inbound = message.get('inbound') if isinstance(message.get('inbound'), dict) else None
        binding = self.journal.register_binding(connector_id, harness=str(message.get('harness') or 'unknown')[:40],
                                                thread=thread, title=(message.get('title') or None) and str(message['title'])[:200],
                                                binding_id=message.get('binding_id'), inbound=inbound,
                                                capabilities=harness_capabilities(message.get('capabilities')),
                                                engine=engine_of(message.get('engine')))
        self.live[binding['id']] = connector_id
        self.hub.clear_conversation_working(binding['thread'])
        # A conversation joining the room selects itself for nobody: which conversation a browser
        # talks to is that browser's choice (and the reason a call must never jump on a connect).
        return {'type': 'binding.registered', 'client_ref': client_ref, 'binding_id': binding['id'], 'thread': binding['thread']}

    async def close_binding(self, record):
        """The user closed this conversation's voice from the room: its connector forgets the binding."""
        connector_id = self.live.pop(record['id'], None)
        self.journal.deactivate_binding(record['connector'], record['id'])
        self.drop_inflight(record['id'])
        self.hub.clear_conversation_working(record['thread'])
        peer = self.peers.get(connector_id or '')
        if peer is not None:
            try:
                await peer.send({'type': 'binding.close', 'binding_id': record['id'], 'thread': record['thread'],
                                 'reason': 'closed_from_room'})
            except Exception:
                pass

    async def unregister(self, connector_id, message):
        binding_id = message.get('binding_id')
        if self.live.get(binding_id) == connector_id:
            record = self.journal.binding(binding_id)
            del self.live[binding_id]
            self.journal.deactivate_binding(connector_id, binding_id)
            if record:
                self.hub.clear_conversation_working(record['thread'])
            inflight = self.drop_inflight(binding_id)
            if inflight:
                self.journal.defer(inflight[0], immediate=True)

    async def speech(self, connector_id, message):
        """Returns the `speech.published` frame. A refusal is that same frame with a status, not an
        error: the connector's outbox must be able to stop holding what the room will never take."""
        from .presentation import Speech
        reply = {'type': 'speech.published', 'event_id': message.get('event_id')}
        binding = self.journal.binding(message.get('binding_id'))
        if not binding or self.live.get(binding['id']) != connector_id:
            return {**reply, 'status': 'rejected', 'error': 'Unknown binding'}
        try:
            speech = Speech(thread_id=binding['thread'], session_id=str(message.get('session_id') or ''),
                            revision=int(message.get('revision') or 0), text=str(message.get('text') or ''),
                            utterance_id=str(message.get('utterance_id') or uuid.uuid4()), language=message.get('language'))
            return {**reply, **await self.hub.publish(speech)}
        except HTTPException as error:
            return {**reply, 'status': 'rejected', 'error': str(error.detail)}
        except Exception as error:
            return {**reply, 'status': 'rejected', 'error': str(error) or type(error).__name__}

    # ----- one connection -----

    async def connect(self, socket: WebSocket):
        await socket.accept()
        connector_id, peer = None, WebSocketPeer(socket)
        try:
            hello = await asyncio.wait_for(socket.receive_json(), timeout=10)
            if hello.get('type') != 'connector.hello' or not self.journal.authenticate_connector(hello.get('connector_id'), hello.get('token')):
                await socket.close(code=1008); return
            if hello.get('protocol') != PROTOCOL:
                await socket.send_json({'type': 'connector.error', 'error': f'Unsupported protocol; server speaks {PROTOCOL}'})
                await socket.close(code=1008); return
            connector_id = hello['connector_id']
            await self.attach(connector_id, peer)
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
                    try:
                        await socket.send_json(await self.register(connector_id, message))
                    except ValueError as error:
                        await socket.send_json({'type': 'binding.rejected', 'client_ref': message.get('client_ref'), 'error': str(error)})
                elif kind == 'binding.unregister':
                    await self.unregister(connector_id, message)
                elif kind == 'speech.publish':
                    await socket.send_json(await self.speech(connector_id, message))
                elif kind == 'input.ack':
                    # The delivery that is waiting settles it; an acknowledgement nobody is waiting for
                    # (a connection that came back, say) is still worth reading once.
                    if not peer.settle(message):
                        await self.acknowledge(connector_id, message)
                elif kind == 'input.working':
                    await self.working(connector_id, message)
                elif kind == 'input.read':
                    await self.read(connector_id, message)
        except (WebSocketDisconnect, asyncio.TimeoutError, ValueError, RuntimeError):
            pass
        finally:
            self.detach(connector_id, peer)


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

    from .presentation import require_same_origin as browser_only, require_room_page
    from .connector_rsocket import mount_connector_rsocket

    @app.websocket('/api/connectors/ws')
    async def connector_socket(websocket: WebSocket):
        await control.connect(websocket)

    mount_connector_rsocket(app, control)

    @app.post('/api/connectors/pairing-code')
    async def pairing_code(request: Request):
        # Only the page in the room asks for a code, and it shows it to the person: never a client.
        require_room_page(request)
        return {'code': hub.journal.create_pairing_code(), 'expires_in': 600}

    @app.post('/api/connectors/pair')
    async def pair(payload: PairingRequest):
        credential = hub.journal.redeem_pairing_code(payload.code, payload.host)
        if credential is None:
            raise HTTPException(403, 'Código de emparejamiento inválido o caducado.')
        # The links this room serves, best first: the machine picks one here, once, and stores it.
        return {'connector_id': credential[0], 'token': credential[1], 'protocol': PROTOCOL, 'links': list(LINKS)}

    @app.get('/api/connectors')
    async def connectors(request: Request):
        browser_only(request)
        return {'connectors': [{**c, 'connected': c['id'] in control.peers} for c in hub.journal.paired_connectors()],
                'bindings': control.participants()}

    return control
