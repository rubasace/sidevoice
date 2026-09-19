"""The room: one shared conversation, many browsers connected to it at once.

Room state is what everyone in the room shares — which conversation is selected,
the durable journal, the assistant's utterances and any audio the room paid a
provider to synthesize. Client state is what belongs to one browser alone: its
socket, its microphone turn, its transcription runtime, its playback queue, its
karaoke, its output device and its own latency trace.

Starting to speak is room-wide, because it makes the agent's previous answer
stale for everybody. Stopping the audio is local, because it only says what one
listener wants to hear. See `docs/MULTI_CLIENT_ROOM.md`.
"""
import asyncio
import json
import uuid
from collections import deque

from fastapi import HTTPException
from pipecat.frames.frames import InterruptionFrame

from .latency import CallLatency
from .pipeline_frames import PresentationBoundary, PresentationSpeech
from .synthesis_cache import SynthesisCache

# A client's own playback verdict, past which no later event of its own may move it.
CLIENT_TERMINAL = {'interrupted', 'failed', 'disconnected', 'playback_finished'}
# What the journal row says about an utterance: the furthest any listener got.
RANK = {'disconnected': 1, 'failed': 2, 'interrupted': 3, 'queued': 4,
        'waiting_for_turn': 5, 'waiting_for_pause': 5, 'synthesizing': 6,
        'playing': 7, 'playback_finished': 8}


class Utterance:
    """One assistant reply. The text and the epoch are the room's; playback is each client's."""

    def __init__(self, id, text, *, language=None, thread_id=None, revision=0, row_id=None):
        self.id, self.text, self.language = id, text, language
        self.thread_id, self.revision = thread_id, revision
        self.row_id = row_id
        self.clients = {}       # client id -> {'status': ..., 'reason': ...}
        self.published = None   # last (status, reason) written to the journal

    def _best(self):
        if not self.clients:
            return {'status': 'queued', 'reason': None}
        return max(self.clients.values(), key=lambda entry: RANK.get(entry['status'], 0))

    @property
    def status(self):
        return self._best()['status']

    @property
    def reason(self):
        return self._best()['reason']

    def result(self, session_id=None):
        return {'status': self.status, 'utterance_id': self.id,
                'session_id': session_id, 'revision': self.revision}

    def view(self, client_id):
        """What one browser is entitled to know about this utterance: its own playback."""
        entry = self.clients.get(client_id)
        return {'utterance_id': self.id, 'revision': self.revision, 'session_id': client_id,
                'status': entry['status'] if entry else 'queued'}

    def snapshot(self):
        return {'utterance_id': self.id, 'revision': self.revision, 'thread_id': self.thread_id,
                'status': self.status,
                'clients': {cid: entry['status'] for cid, entry in self.clients.items()}}


class RoomClient:
    """One browser. Owns its microphone turn and its playback queue, and nothing else's."""

    def __init__(self, session_id, room=None, *, worker=None, tts=None, stt=None):
        self.id = session_id
        self.room = room
        self.worker, self.tts, self.stt = worker, tts, stt
        self.connected = False
        self.closed = False
        self.speaking = False
        self.error = None
        self.sent = 0
        self.last_delivery = None
        # Only used when no journal is attached; the room's outbox is the durable path.
        self.input_queue = asyncio.Queue(maxsize=32)
        self.pending = deque()
        self.active = None
        self.quiet_until = 0
        self.dispatch_timer = None
        self.audio_grace_seconds = 2.0
        # Which conversation this browser talks to is this browser's own state (issue: the room
        # used to hold one selection for everyone). The room only routes.
        self.target = {}
        self.revision = 0          # this browser's turn epoch; only its own turns and selections advance it
        self.switching = False
        self.turn_target = {}
        self.turn_revision = 0
        self.turn_binding_id = None
        self.cancelled_turn = None
        self.on_input_receipt = None
        self.on_browser_event = None
        self.mic = None            # the serializer, when a PCM socket owns this client
        self.input_stats = None    # what the browser-side transcription transport reports
        self.transcription = None  # which STT engine this client resolved to
        self.mic_settings = None   # how this device's turns are detected
        self.voice = None          # the call flow driving this client's turns, when a pipeline owns it
        self.settings = None       # what this device configured; the room keeps no copy of its own
        self.audio_health = None   # the browser's last report about its audio output
        self.latency = CallLatency(self.id)
        if room is not None:
            room.join(self)

    # ----- identity and reporting -----

    @property
    def journal(self):
        return self.room.journal if self.room else None

    @property
    def utterances(self):
        return self.room.utterances if self.room else {}

    def input_receipt(self, payload, status):
        if payload.get('session_id', self.id) == self.id:
            if status == 'pending':
                self.latency.turn(payload['thread_id'], payload['revision'], 'queued')
            elif status == 'delivered':
                self.latency.turn(payload['thread_id'], payload['revision'], 'delivery_accepted')
            elif status == 'read':
                self.latency.turn(payload['thread_id'], payload['revision'], 'read')
        if self.on_input_receipt:
            self.on_input_receipt({'revision': payload['revision'], 'history_id': payload.get('history_id'),
                                   'thread_id': payload['thread_id'],
                                   'session_id': payload.get('session_id', self.id), 'status': status})

    def identity(self):
        """What the room may say about a browser to the rest of the room."""
        return {'id': self.id, 'connected': self.connected, 'user_speaking': self.speaking,
                'turn_revision': self.turn_revision,
                'transport': (self.input_stats or {}).get('transport', 'pcm'),
                'transcription': self.transcription}

    def snapshot(self):
        return {'id': self.id, 'target': dict(self.target), 'connected': self.connected,
                'user_speaking': self.speaking, 'error': self.error, 'sent': self.sent,
                'last_delivery': self.last_delivery, 'revision': self.revision,
                'utterances': [u.view(self.id) for u in self.utterances.values() if self.id in u.clients],
                'tts': {'engine': 'Kokoro · navegador'} if self.tts is None else getattr(self.tts, 'runtime_status', {}),
                'mic': ({
                    'frames': getattr(self.mic, 'audio_frames', 0),
                    'bytes': getattr(self.mic, 'audio_bytes', 0),
                    'last_gap_ms': getattr(self.mic, 'last_audio_gap_ms', 0),
                    'max_gap_ms': getattr(self.mic, 'max_audio_gap_ms', 0),
                    'gaps_over_250ms': getattr(self.mic, 'audio_gap_count', 0),
                } if self.mic else {}) | (self.input_stats or {}) or None,
                'mic_settings': self.mic_settings,
                'transcription': self.transcription,
                'audio_health': self.audio_health,
                'speech_filter': getattr(self.stt, 'filter_stats', {})}

    # ----- input this browser produced -----

    def enqueue_input(self, text, *, target=None, revision=None, message_id=None, history_id=None):
        if target is None and self.cancelled_turn == self.turn_revision:
            return
        target = self.turn_target if target is None else target
        revision = self.turn_revision if revision is None else revision
        history_id = history_id or self.id + ':user-turn:' + str(revision)
        if not text or not text.strip():
            return
        payload = {'thread_id': target.get('thread_id'), 'text': text,
                   'message_id': message_id or str(uuid.uuid4()), 'session_id': self.id,
                   'history_id': history_id, 'revision': revision, 'binding_id': target.get('binding_id'),
                   'title': target.get('title')}
        if not payload['thread_id']:
            self.error = 'Selecciona una conversación antes de hablar.'
            self.input_receipt(payload, 'not_sent')
            return
        if self.journal:
            self.journal.put(id=history_id, thread=payload['thread_id'], role='user', text=text,
                             name='Tú', session=self.id, revision=revision, status='pending', payload=payload)
        else:
            try:
                self.input_queue.put_nowait(payload)
            except asyncio.QueueFull:
                self.error = 'Cola llena: el último mensaje no se envió.'
                self.input_receipt(payload, 'not_sent')
                return
        self.input_receipt(payload, 'pending')
        return payload

    def user_started(self):
        """This browser's microphone opened a turn; the epoch it opens is the room's."""
        self.room.begin_turn(self)

    async def finish_user_turn(self):
        self.speaking = False
        self.room.quiet(self)
        await self.room.dispatch_all()

    # ----- playback, which is this browser's alone -----

    def is_current(self, uid, revision):
        utterance = self.utterances.get(uid)
        entry = utterance.clients.get(self.id) if utterance else None
        return bool(self.connected and not self.speaking and revision == self.revision
                    and self.active == uid and entry and entry['status'] not in CLIENT_TERMINAL)

    def transition(self, uid, status, reason=None):
        utterance = self.utterances.get(uid)
        entry = utterance.clients.get(self.id) if utterance else None
        if not entry or entry['status'] in CLIENT_TERMINAL:
            return
        entry['status'], entry['reason'] = status, reason
        self.latency.status(uid, status)
        if status == 'playing':
            self.latency.mark(uid, 'playing_receipt')
        self.room.sync(utterance)

    def halt(self, status, reason=None, *, preserve_waiting=False, announce=True):
        """Drop what this browser was going to play. Only this browser's entries move."""
        if self.dispatch_timer:
            self.dispatch_timer.cancel()
            self.dispatch_timer = None
        if announce and self.on_browser_event:
            self.on_browser_event({'type': 'voice-cancel', 'data': {'session_id': self.id, 'revision': self.revision}})
        waiting = []
        for uid, utterance in self.utterances.items():
            entry = utterance.clients.get(self.id)
            if not entry:
                continue
            # A browser that renders its own audio can be handed again anything it
            # never started playing; a server-side pipeline cannot take it back.
            if preserve_waiting and (entry['status'] == 'waiting_for_turn' or self.on_browser_event
                                     and entry['status'] in {'queued', 'synthesizing', 'waiting_for_pause'}):
                utterance.revision = self.revision
                self.transition(uid, 'waiting_for_turn', 'user_speaking')
                waiting.append(uid)
            else:
                self.transition(uid, status, reason)
        self.pending.clear()
        self.pending.extend(waiting)
        self.active = None

    def disconnect(self):
        if self.room:
            self.room.leave(self)
        else:
            self.connected, self.closed = False, True

    def fail_active(self):
        """An uncertain failure in this browser: nothing is replayed, and no one else is touched."""
        for uid in list(self.utterances):
            self.transition(uid, 'failed', 'playback_failed')
        self.pending.clear()
        self.active = None

    def browser_cancelled(self, uid, revision, started):
        """This listener stopped the audio. The message stays, and the others keep playing."""
        utterance = self.utterances.get(uid)
        entry = utterance.clients.get(self.id) if utterance else None
        if not utterance or not entry or revision > utterance.revision:
            return False
        if entry['status'] in CLIENT_TERMINAL:
            return True
        if started:
            self.transition(uid, 'interrupted', 'user_interrupted')
            self.pending = deque(item for item in self.pending if item != uid)
            if self.active == uid:
                self.active = None
                if self.on_browser_event:
                    self.on_browser_event({'type': 'voice-cancel', 'data': {'session_id': self.id, 'revision': self.revision}})
        elif revision == utterance.revision:
            self.transition(uid, 'waiting_for_turn', 'user_speaking')
            if uid not in self.pending:
                self.pending.appendleft(uid)
            if self.active == uid:
                self.active = None
        # An older unplayed cancellation cannot roll back a newer dispatch.
        return True

    async def playback_finished(self, uid, revision):
        if not self.is_current(uid, revision):
            return
        # Marker passed TTS serialization and transport audio queue. This is not
        # confirmation of browser playout, device audibility, or user comprehension.
        self.transition(uid, 'playback_finished')
        self.active = None
        await self.dispatch()

    async def _dispatch_after_pause(self, delay):
        await asyncio.sleep(delay)
        self.dispatch_timer = None
        await self.dispatch()

    async def dispatch(self):
        if self.active or not self.pending or not self.connected or self.room.speaking:
            return
        remaining = self.quiet_until - asyncio.get_running_loop().time()
        if remaining > 0:
            self.transition(self.pending[0], 'waiting_for_pause', 'quiet_grace')
            if not self.dispatch_timer or self.dispatch_timer.done():
                self.dispatch_timer = asyncio.create_task(self._dispatch_after_pause(remaining))
            return
        uid = self.pending.popleft()
        self.active = uid
        utterance = self.utterances[uid]
        rev = utterance.revision
        try:
            if self.on_browser_event:
                await self.play_in_browser(utterance, rev)
                return
            await self.worker.queue_frames([
                PresentationBoundary(utterance_id=uid, revision=rev),
                PresentationSpeech(text=utterance.text, utterance_id=uid, revision=rev,
                                   language=utterance.language),
                PresentationBoundary(utterance_id=uid, revision=rev, end=True)])
        except Exception:
            self.fail_active()
            raise

    async def play_in_browser(self, utterance, rev):
        """Hand this browser the reply to play. Kokoro it renders; a paid engine the room did."""
        from .language_settings import load_settings, resolve_voice
        uid = utterance.id
        choice = resolve_voice(self.settings or load_settings(), utterance.language)
        self.transition(uid, 'synthesizing')
        self.latency.start_synthesis(uid)
        trace = self.latency.replies.get(uid)
        reply_revision = trace['reply_revision'] if trace else rev
        common = {'session_id': self.id, 'revision': rev, 'utterance_id': uid,
                  'reply_revision': reply_revision, 'thread_id': self.target.get('thread_id'),
                  'text': utterance.text, 'history_id': utterance.row_id}
        if choice['provider'] == 'kokoro':
            self.latency.mark(uid, 'audio_dispatched')
            self.on_browser_event({'type': 'voice-speech', 'data': {**common, **choice}})
            return
        try:
            audio, fresh = await self.room.shared_audio(utterance, choice)
        except ValueError as error:
            self.fail_active()
            raise HTTPException(502, str(error)) from error
        self.latency.mark(uid, 'audio_ready')
        # A listener that was handed someone else's render did not wait for the provider;
        # recording that request as its own would be a measurement it never made.
        self.latency.provider(uid, audio['timings_ms'] if fresh else {})
        self.latency.mark(uid, 'audio_dispatched')
        self.on_browser_event({'type': 'voice-speech-audio', 'data': {
            **common, **choice, **audio,
            'timings_ms': audio['timings_ms'] if fresh else {}, 'shared': not fresh}})


def _build_info():
    from .paths import build_info
    return build_info()


class Room:
    """One conversation, one journal, one epoch — and as many browsers as people looking."""

    MAX_CLIENTS = 8
    MAX_UTTERANCES = 2048
    MAX_PENDING = 16

    def __init__(self, journal=None, assets=None):
        self.clients = {}
        self.sessions = deque(maxlen=64)   # ids we have known, so an older reply can be told apart
        self.utterances = {}
        self.audio_reports = deque(maxlen=30)   # browsers' reports about their audio output, kept past their leaving
        self.journal = journal
        self.assets = assets if assets is not None else SynthesisCache()
        self.activation_lock = asyncio.Lock()
        self.control = None   # the connector control plane drains the journal; set when mounted

    async def start(self):
        self.journal.recover()

    async def stop(self):
        pass

    # ----- membership -----

    def join(self, client):
        if client.id in self.clients:
            return client
        if len(self.clients) >= self.MAX_CLIENTS:
            raise RuntimeError('La sala ya tiene el máximo de navegadores conectados.')
        client.room = self
        self.clients[client.id] = client
        if client.id not in self.sessions:
            self.sessions.append(client.id)
        return client

    def leave(self, client):
        client.connected = False
        client.closed = True
        if self.clients.get(client.id) is client:
            del self.clients[client.id]
        # The room and every other browser survive this; the selection left with the browser that held it.
        client.halt('disconnected', 'call_ended', announce=False)

    def listeners(self):
        return [client for client in self.clients.values() if client.connected]

    @property
    def speaking(self):
        return any(client.speaking for client in self.clients.values())

    def audience(self, thread_id):
        """The connected browsers whose selected conversation is this one."""
        return [client for client in self.listeners() if thread_id and client.target.get('thread_id') == thread_id]

    # ----- a browser's turn epoch -----

    def begin_turn(self, client):
        """A browser's own turn interrupts that browser's playback and nobody else's."""
        client.revision += 1
        client.speaking = True
        client.turn_target = dict(client.target)
        client.turn_revision = client.revision
        client.turn_binding_id = client.target.get('binding_id')
        client.halt('interrupted', 'user_interrupted', preserve_waiting=True)

    def quiet(self, client):
        client.quiet_until = asyncio.get_running_loop().time() + client.audio_grace_seconds

    async def dispatch_all(self):
        await self.fan_out(self.listeners())

    async def fan_out(self, clients):
        """Every browser is dispatched at once, and a slow or broken one delays only itself.

        Dispatching concurrently is also what makes one paid render serve all of
        them: the second browser to ask finds the first one's render in flight.
        """
        outcomes = await asyncio.gather(*(client.dispatch() for client in clients), return_exceptions=True)
        for client, outcome in zip(clients, outcomes):
            if isinstance(outcome, asyncio.CancelledError):
                raise outcome
            if isinstance(outcome, BaseException):
                # That browser is already marked failed; the room and the rest carry on.
                client.error = getattr(outcome, 'detail', None) or (
                    'No se pudo reproducir el audio en este navegador: ' + type(outcome).__name__)

    def sync(self, utterance):
        status, reason = utterance.status, utterance.reason
        if (status, reason) == utterance.published:
            return
        utterance.published = (status, reason)
        if self.journal and utterance.row_id:
            self.journal.update(utterance.row_id, status, reason)

    async def shared_audio(self, utterance, choice):
        """A paid engine is billed per character: one render per utterance, reused by every listener."""
        return await self.assets.obtain(choice, utterance.text)

    # ----- what the agent publishes -----

    async def speak(self, text, utterance_id, session_id, revision, language=None,
                    wait_for_quiet=False, thread_id=None, row_id=None):
        previous = self.utterances.get(utterance_id)
        if previous:
            if (previous.text, previous.revision, previous.language) != (text, revision, language):
                raise HTTPException(409, 'utterance_id ya usado con otro contenido.')
            return previous.result(session_id)
        if session_id not in self.sessions:
            raise HTTPException(409, 'La llamada cambió; esta respuesta pertenece a otra sesión.')
        asker = self.clients.get(session_id)
        if not asker or not asker.connected or asker.switching:
            raise HTTPException(409, 'No hay llamada conectada; no se guarda audio para más tarde.')
        if revision != asker.revision:
            raise HTTPException(409, 'Respuesta obsoleta: el usuario ya inició otro turno.')
        thread_id = thread_id or asker.target.get('thread_id')
        listeners = self.audience(thread_id)
        if asker not in listeners:
            raise HTTPException(409, 'Ese navegador ya no está en esa conversación.')
        if asker.speaking and not wait_for_quiet:
            raise HTTPException(409, 'El usuario está hablando. Espera su mensaje antes de responder.')
        if len(self.utterances) >= self.MAX_UTTERANCES or any(len(c.pending) >= self.MAX_PENDING for c in listeners):
            raise HTTPException(429, 'Cola o historial de locuciones lleno.')
        utterance = Utterance(utterance_id, text, language=language, thread_id=thread_id, revision=revision,
                              row_id=row_id or (session_id + ':voice:' + utterance_id))
        for client in listeners:
            utterance.clients[client.id] = {
                'status': 'waiting_for_turn' if client.speaking else 'queued',
                'reason': 'user_speaking' if client.speaking else None}
            client.pending.append(utterance_id)
        self.utterances[utterance_id] = utterance
        # The row leaves 'text_only' as soon as it is queued, with the reason it is waiting for.
        self.sync(utterance)
        await self.fan_out(listeners)
        return utterance.result(session_id)

    async def publish(self, payload):
        row_id = payload.session_id + ':voice:' + payload.utterance_id
        # Store the conversational text even if its audio epoch has expired.
        asker = self.clients.get(payload.session_id)
        record = self.journal.binding_for_thread(payload.thread_id) if self.journal else None
        name = (record or {}).get('title') or (
            asker.target.get('title') if asker and asker.target.get('thread_id') == payload.thread_id else None) or 'Conversación'
        record = self.journal.put(id=row_id, thread=payload.thread_id, role='assistant',
                                  text=payload.text, name=name, session=payload.session_id,
                                  revision=payload.revision, status='text_only', language=payload.language)
        if record.get('_existing'):
            return {'status': record['status'], 'text_saved': True, 'utterance_id': payload.utterance_id}
        # Every browser on that conversation traces the same reply on its own clock.
        for client in self.audience(payload.thread_id):
            client.latency.reply(payload.utterance_id, payload.thread_id, payload.revision)
        reason = None
        if payload.session_id not in self.sessions:
            reason = 'session_changed'
        elif not asker or not asker.connected:
            reason = 'call_ended'
        elif asker.target.get('thread_id') != payload.thread_id or asker.switching:
            reason = 'focus_changed'
        elif payload.revision != asker.revision:
            reason = 'newer_turn' if asker.turn_revision > payload.revision else 'focus_changed'
        elif asker.speaking:
            reason = 'user_speaking'
        may_wait = reason in {'newer_turn', 'user_speaking'}
        if reason and not may_wait:
            self.journal.update(row_id, 'text_only', reason)
            return {'status': 'text_only', 'text_saved': True, 'reason': reason}
        try:
            result = await self.speak(payload.text, payload.utterance_id, payload.session_id,
                                      asker.revision if may_wait else payload.revision, payload.language,
                                      wait_for_quiet=may_wait, thread_id=payload.thread_id, row_id=row_id)
        except HTTPException as error:
            if error.status_code not in {409, 429}:
                raise
            reason = 'expired_audio_turn' if error.status_code == 409 else 'queue_full'
            self.journal.update(row_id, 'text_only', reason)
            return {'status': 'text_only', 'text_saved': True, 'reason': reason}
        # The room already wrote the row as each listener moved; do not flatten its reason here.
        return {**result, 'text_saved': True}

    # ----- what a browser sends -----

    async def send_text(self, text, session_id, thread_id, binding_id, message_id):
        row_id = session_id + ':user-text:' + message_id
        previous = self.journal.get(row_id)
        if previous:
            if previous['text'] != text or previous['thread'] != thread_id:
                raise HTTPException(409, 'El identificador ya corresponde a otro mensaje.')
            return {'accepted': True, 'id': row_id, 'revision': previous['revision']}
        client = self.clients.get(session_id)
        if (not client or not client.connected
                or client.target.get('thread_id') != thread_id
                or client.target.get('binding_id') != binding_id):
            raise HTTPException(409, 'La conexión o conversación cambió. El texto no se envió.')
        if not text.strip():
            raise HTTPException(422, 'Escribe un mensaje.')
        # A typed submission is this browser's own turn: it interrupts this browser's playback only.
        client.revision += 1
        client.halt('interrupted', 'user_interrupted', preserve_waiting=True)
        client.enqueue_input(text, target=dict(client.target), revision=client.revision,
                             message_id=message_id, history_id=row_id)
        if not client.speaking:
            self.quiet(client)
        await self.fan_out([client])
        return {'accepted': True, 'id': row_id, 'revision': client.revision}

    def delivery_status(self, row_id, status):
        # Receipts go to the browser that produced the input and to no other:
        # delivered means the harness accepted it, never that a human read it.
        row = self.journal.get(row_id)
        if not row:
            return
        payload = json.loads(row['payload'] or '{}')
        client = self.clients.get(payload.get('session_id'))
        if not client or not client.connected:
            return
        client.input_receipt(payload, status)
        if status == 'delivered' and client.target.get('thread_id') == payload.get('thread_id'):
            client.sent += 1

    # ----- which conversation the room is pointed at -----

    async def close_channel(self, thread_id):
        """Closing a conversation's voice from the room removes its binding, nothing more.

        The connector that served it is told and forgets it; the agent's next
        `voice_say` fails with that reason and it continues in writing; the room
        keeps no record, so re-enabling is just the agent joining again.
        """
        async with self.activation_lock:
            record = self.journal.binding_for_thread(thread_id)
            if record:
                if self.control:
                    await self.control.close_binding(record)
                else:
                    self.journal.deactivate_binding(record['connector'], record['id'])
            # Input still waiting for that conversation will not be delivered to a voice it no longer has.
            for row in self.journal.pending():
                if row['thread'] == thread_id:
                    self.journal.update(row['id'], 'not_sent', 'channel_closed')
            for client in list(self.clients.values()):
                if client.turn_target.get('thread_id') == thread_id:
                    client.cancelled_turn = client.turn_revision
                if client.target.get('thread_id') == thread_id:
                    await self._retarget(client, {})
            return {'status': 'closed', 'binding_id': record['id'] if record else None}

    async def select(self, session_id, thread_id, title=None):
        """One browser chooses which conversation it talks to. No other browser moves."""
        client = self.clients.get(session_id)
        if not client or not client.connected:
            raise HTTPException(409, 'Ese navegador no está en la sala.')
        async with self.activation_lock:
            current = client.target
            if current.get('thread_id') == thread_id and (not title or current.get('title') == title):
                return {'status': 'already_active', 'binding': dict(current)}
            new = await self._retarget(client, {'thread_id': thread_id, 'title': title})
            return {'status': 'activated', 'binding': new}

    async def deselect(self, session_id, binding_id):
        client = self.clients.get(session_id)
        if not client or not client.connected:
            raise HTTPException(409, 'Ese navegador no está en la sala.')
        async with self.activation_lock:
            if binding_id != client.target.get('binding_id'):
                raise HTTPException(409, 'La conversación cambió. Actualiza la sala.')
            return {'status': 'activated', 'binding': await self._retarget(client, {})}

    async def _retarget(self, client, target):
        """Move one browser to another conversation (or to none): its own playback stops, its own epoch advances."""
        new = {'thread_id': target.get('thread_id'), 'title': target.get('title'), 'binding_id': str(uuid.uuid4())}
        try:
            client.switching = True
            client.revision += 1
            client.halt('interrupted', 'focus_changed')
            if client.worker is not None:
                await client.worker.queue_frame(InterruptionFrame())
            else:
                client.speaking = False
            client.target = new
            client.sent = 0
            client.last_delivery = None
            client.error = None
        finally:
            client.switching = False
        return dict(new)

    # ----- reporting -----

    def snapshot(self, session_id=None):
        # `call` is the asking browser's own state; a page that has not joined,
        # or asks about someone else, is told about the room and nothing more.
        client = self.clients.get(session_id)
        return {'binding': (dict(client.target) if client.target.get('thread_id') else None) if client else None,
                'room': {'revision': client.revision if client else 0, 'speaking': client.speaking if client else self.speaking,
                         'switching': client.switching if client else False,
                         'clients': len(self.clients), 'audio': self.assets.stats(),
                         'utterances': [u.snapshot() for u in self.utterances.values()],
                         'audio_reports': list(self.audio_reports)[-10:],
                         **_build_info()},
                'clients': [c.identity() for c in self.clients.values()],
                'call': client.snapshot() if client else None}

    def latency_snapshot(self, session_id=None):
        client = self.clients.get(session_id)
        return client.latency.snapshot() if client else {'session_id': None, 'replies': []}
