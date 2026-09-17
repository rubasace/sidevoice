"""Audio presentation for an existing task. No LLM or task operator lives here."""
import asyncio
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit
import uuid
from dataclasses import dataclass
from collections import deque
from room_history import RoomHistory
from latency import CallLatency
from fastapi import HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from pipecat.frames.frames import LLMContextFrame, TTSSpeakFrame, DataFrame, TTSAudioRawFrame, ErrorFrame, InterruptionFrame
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection

ROOT = Path(__file__).resolve().parent.parent
BINDING = Path(os.getenv('VOICE_PRESENTATION_BINDING_FILE', str(ROOT / '.voice-poc/presentation.json')))
THREAD_PATTERN = re.compile(r'^[A-Za-z0-9._:-]{1,200}$')


def require_same_origin(request):
    """Browser-only endpoints: the Origin's host must be this room's host (scheme-agnostic, so a
    TLS proxy in front is fine), or the configured public origin. Non-browser callers send no Origin."""
    origin = request.headers.get('origin')
    if not origin:
        return
    public = os.getenv('VOICE_PUBLIC_ORIGIN', '').rstrip('/')
    try:
        origin_host = urlsplit(origin).netloc.lower()
    except ValueError:
        origin_host = ''
    if (public and origin.rstrip('/') == public) or (origin_host and origin_host in {
            request.headers.get('host', '').lower(), request.url.netloc.lower()}):
        return
    raise HTTPException(403, 'Usa la sala desde su propia dirección.')


def binding():
    try:
        data = json.loads(BINDING.read_text())
        return {key: data.get(key) for key in ('thread_id', 'title', 'binding_id')}
    except (OSError, ValueError, KeyError):
        return None


class NoInference(FrameProcessor):
    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if not isinstance(frame, LLMContextFrame):
            await self.push_frame(frame, direction)


@dataclass
class PresentationSpeech(TTSSpeakFrame):
    utterance_id: str = ''
    revision: int = 0
    language: str | None = None


@dataclass
class PresentationBoundary(DataFrame):
    utterance_id: str = ''
    revision: int = 0
    end: bool = False


class PresentationGate(FrameProcessor):
    """Last epoch check before TTS; queued stale requests never synthesize."""
    call = None

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if self.call and direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, (PresentationSpeech, PresentationBoundary)):
                if not self.call.is_current(frame.utterance_id, frame.revision):
                    return
                if isinstance(frame, PresentationSpeech):
                    if hasattr(self.call.tts, 'select_language'):
                        self.call.tts.select_language(frame.language)
                    self.call.transition(frame.utterance_id, 'synthesizing')
        if self.call and isinstance(frame, ErrorFrame):
            self.call.fail_active()
        await self.push_frame(frame, direction)


class PresentationPlayback(FrameProcessor):
    """Observe ordered transport output, never silence timeout or 'heard'."""
    call = None
    current = None

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if self.call and direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, PresentationBoundary):
                if not frame.end:
                    self.current = (frame.utterance_id, frame.revision)
                else:
                    await self.call.playback_finished(frame.utterance_id, frame.revision)
                    if self.current == (frame.utterance_id, frame.revision):
                        self.current = None
            elif isinstance(frame, TTSAudioRawFrame) and self.current:
                uid, rev = self.current
                if self.call.is_current(uid, rev):
                    self.call.transition(uid, 'playing')
        await self.push_frame(frame, direction)


class PresentationCall:
    def __init__(self, session_id, target, worker, tts, stt):
        self.id, self.target, self.worker = session_id, target, worker
        self.tts, self.stt = tts, stt
        self.connected = False
        self.closed = False
        self.speaking = False
        self.error = None
        self.sent = 0
        self.last_delivery = None
        self.input_queue = asyncio.Queue(maxsize=32)
        self.utterances = {}
        self.revision = 0
        self.pending = deque()
        self.active = None
        self.quiet_until = 0
        self.dispatch_timer = None
        self.audio_grace_seconds = 2.0
        self.turn_target = dict(target)
        self.turn_revision = 0
        self.journal = None
        self.turn_binding_id = target.get("binding_id")
        self.switching = False
        self.on_input_receipt = None
        self.browser_audio = False
        self.on_browser_event = None
        self.mic = None  # Set to the serializer when a browser call owns this one.
        self.transcription = None  # Which STT engine this call resolved to.
        self.latency = CallLatency(self.id)

    def input_receipt(self, payload, status):
        if payload.get('session_id', self.id) == self.id:
            if status == 'pending':
                self.latency.turn(payload['thread_id'], payload['revision'], 'queued')
            elif status == 'delivered':
                self.latency.turn(payload['thread_id'], payload['revision'], 'delivery_accepted')
        if self.on_input_receipt:
            self.on_input_receipt({"revision": payload["revision"], "history_id": payload.get("history_id"),
                                   "thread_id": payload["thread_id"], "session_id": payload.get("session_id", self.id), "status": status})

    def snapshot(self):
        return {'id': self.id, 'target': self.target, 'connected': self.connected,
                'user_speaking': self.speaking, 'error': self.error, 'sent': self.sent,
                'last_delivery': self.last_delivery, 'revision': self.revision,
                'utterances': [dict(v['result']) for v in self.utterances.values()],
                'tts': {'engine': 'Kokoro · navegador'} if self.browser_audio else getattr(self.tts, 'runtime_status', {}),
                'mic': getattr(self, 'input_stats', None) or ({
                    'frames': getattr(self.mic, 'audio_frames', 0),
                    'bytes': getattr(self.mic, 'audio_bytes', 0),
                    'last_gap_ms': getattr(self.mic, 'last_audio_gap_ms', 0),
                    'max_gap_ms': getattr(self.mic, 'max_audio_gap_ms', 0),
                    'gaps_over_250ms': getattr(self.mic, 'audio_gap_count', 0),
                } if self.mic else None),
                'transcription': self.transcription,
                'speech_filter': getattr(self.stt, 'filter_stats', {})}

    def enqueue_input(self, text, *, target=None, revision=None, message_id=None, history_id=None):
        if target is None and getattr(self, 'cancelled_turn', None) == self.turn_revision:
            return
        target = self.turn_target if target is None else target
        revision = self.turn_revision if revision is None else revision
        history_id = history_id or self.id+':user-turn:'+str(revision)
        if not target.get('thread_id') or not text or not text.strip():
            return
        payload = {'thread_id': target['thread_id'], 'text': text,
                   'message_id': message_id or str(uuid.uuid4()), 'session_id': self.id,
                   'history_id': history_id, 'revision': revision, 'binding_id': target.get('binding_id'),
                   'title': target.get('title')}
        if self.journal:
            self.journal.put(id=history_id,
                thread=payload['thread_id'], role='user', text=text, name='Tú',
                session=self.id, revision=revision, status='pending', payload=payload)
        else:
            try:
                self.input_queue.put_nowait(payload)
            except asyncio.QueueFull:
                self.error = 'Cola llena: el último mensaje no se envió.'
                self.input_receipt(payload, 'not_sent')
                return
        self.input_receipt(payload, 'pending')
        return payload

    def is_current(self, uid, revision):
        return (self.connected and not self.speaking and revision == self.revision
                and self.active == uid and uid in self.utterances and self.utterances[uid]['result']['status']
                not in {'interrupted', 'failed', 'disconnected', 'playback_finished'})

    def transition(self, uid, status, reason=None):
        entry = self.utterances.get(uid)
        if entry and entry['result']['status'] not in {'interrupted', 'failed', 'disconnected', 'playback_finished'}:
            entry['result']['status'] = status
            self.latency.status(uid, status)
            if status == 'playing':
                self.latency.mark(uid, 'playing_receipt')
            if self.journal:
                self.journal.update(self.id+':voice:'+uid, status, reason)

    def user_started(self):
        self.revision += 1
        self.speaking = True
        self.turn_target = dict(self.target)
        self.turn_revision = self.revision
        self.turn_binding_id = self.target.get("binding_id")
        self.invalidate('interrupted', 'user_interrupted', preserve_waiting=True)

    def invalidate(self, status, reason=None, preserve_waiting=False):
        if self.dispatch_timer:
            self.dispatch_timer.cancel()
            self.dispatch_timer = None
        if self.browser_audio and self.on_browser_event:
            self.on_browser_event({"type": "voice-cancel", "data": {"session_id": self.id, "revision": self.revision}})
        waiting = []
        for uid, entry in self.utterances.items():
            if preserve_waiting and (entry['result']['status'] == 'waiting_for_turn' or
                                     self.browser_audio and entry['result']['status'] in {'queued', 'synthesizing', 'waiting_for_pause'}):
                entry['result']['revision'] = self.revision
                self.transition(uid, 'waiting_for_turn', 'user_speaking')
                waiting.append(uid)
            else:
                self.transition(uid, status, reason)
        self.pending.clear()
        self.pending.extend(waiting)
        self.active = None

    def disconnect(self):
        self.connected = False
        self.closed = True
        self.invalidate('disconnected', 'call_ended')

    def fail_active(self):
        if self.active:
            self.transition(self.active, 'failed', 'playback_failed')
        # Do not automatically replay or advance after an uncertain pipeline failure.
        self.pending.clear()
        for uid in self.utterances:
            self.transition(uid, 'failed', 'playback_failed')
        self.active = None

    def browser_cancelled(self, uid, revision, started):
        entry = self.utterances.get(uid)
        if not entry or revision > entry['result']['revision']:
            return False
        if entry['result']['status'] in {'interrupted', 'failed', 'disconnected', 'playback_finished'}:
            return True
        if started:
            self.transition(uid, 'interrupted', 'user_interrupted')
            self.pending = deque(item for item in self.pending if item != uid)
            if self.active == uid:
                self.active = None
                if self.on_browser_event:
                    self.on_browser_event({'type': 'voice-cancel', 'data': {'session_id': self.id, 'revision': self.revision}})
        elif revision == entry['result']['revision']:
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
        await self._dispatch()

    async def finish_user_turn(self):
        self.speaking = False
        self.quiet_until = asyncio.get_running_loop().time() + self.audio_grace_seconds
        await self._dispatch()

    async def _dispatch_after_pause(self, delay):
        await asyncio.sleep(delay)
        self.dispatch_timer = None
        await self._dispatch()

    async def _dispatch(self):
        if self.active or not self.pending or not self.connected or self.speaking:
            return
        remaining = self.quiet_until - asyncio.get_running_loop().time()
        if remaining > 0:
            self.transition(self.pending[0], 'waiting_for_pause', 'quiet_grace')
            if not self.dispatch_timer or self.dispatch_timer.done():
                self.dispatch_timer = asyncio.create_task(self._dispatch_after_pause(remaining))
            return
        uid = self.pending.popleft()
        self.active = uid
        entry = self.utterances[uid]
        rev = entry['result']['revision']
        try:
            if self.browser_audio:
                from language_settings import load_settings, resolve_voice
                choice = resolve_voice(load_settings(), entry.get('language'))
                self.transition(uid, 'synthesizing')
                self.latency.start_synthesis(uid)
                trace = self.latency.replies.get(uid)
                reply_revision = trace['reply_revision'] if trace else rev
                if choice['provider'] == 'kokoro':
                    self.latency.mark(uid, 'audio_dispatched')
                    self.on_browser_event({'type': 'voice-speech', 'data': {
                        'session_id': self.id, 'revision': rev, 'utterance_id': uid,
                        'reply_revision': reply_revision,
                        'thread_id': self.target.get('thread_id'), 'text': entry['text'], **choice}})
                    return
                import synthesis
                try:
                    audio = await synthesis.synthesize(entry['text'], model=choice['model'],
                                                       voice=choice['voice'], speed=choice['speed'],
                                                       with_timestamps=True)
                except ValueError as error:
                    self.fail_active()
                    raise HTTPException(502, str(error)) from error
                self.latency.mark(uid, 'audio_ready')
                self.latency.provider(uid, audio.get('timings_ms'))
                self.latency.mark(uid, 'audio_dispatched')
                self.on_browser_event({'type': 'voice-speech-audio', 'data': {
                    'reply_revision': reply_revision,
                    'session_id': self.id, 'revision': rev, 'utterance_id': uid,
                    'thread_id': self.target.get('thread_id'), 'text': entry['text'],
                    **choice, **audio}})
                return
            await self.worker.queue_frames([
                PresentationBoundary(utterance_id=uid, revision=rev),
                PresentationSpeech(text=entry['text'], utterance_id=uid, revision=rev, language=entry.get('language')),
                PresentationBoundary(utterance_id=uid, revision=rev, end=True)])
        except Exception:
            self.fail_active()
            raise

    async def speak(self, text, utterance_id, session_id, revision, language=None, wait_for_quiet=False):
        if session_id != self.id:
            raise HTTPException(409, 'La llamada cambió; esta respuesta pertenece a otra sesión.')
        previous = self.utterances.get(utterance_id)
        if previous:
            if (previous['text'], previous['result']['revision'], previous.get('language')) != (text, revision, language):
                raise HTTPException(409, 'utterance_id ya usado con otro contenido.')
            return dict(previous['result'])
        if revision != self.revision:
            raise HTTPException(409, 'Respuesta obsoleta: el usuario ya inició otro turno.')
        if not self.connected or self.switching:
            raise HTTPException(409, 'No hay llamada conectada; no se guarda audio para más tarde.')
        if self.speaking and not wait_for_quiet:
            raise HTTPException(409, 'El usuario está hablando. Espera su mensaje antes de responder.')
        if len(self.pending) >= 16 or len(self.utterances) >= 2048:
            raise HTTPException(429, 'Cola o historial de locuciones lleno.')
        result = {'status': 'waiting_for_turn' if self.speaking else 'queued', 'utterance_id': utterance_id, 'session_id': self.id,
                  'revision': revision}
        self.utterances[utterance_id] = {'text': text, 'result': result, 'language': language}
        self.pending.append(utterance_id)
        await self._dispatch()
        return dict(result)


class PresentationHub:
    def __init__(self):
        self.call = None
        self.activation_lock = asyncio.Lock()
        self.journal = RoomHistory(ROOT / '.voice-poc/room-history.sqlite3')
        self.control = None  # The connector control plane drains the journal; set when mounted.

    async def start(self):
        self.journal.recover()

    async def stop(self):
        pass

    def delivery_status(self, row_id, status):
        # Receipts for the browser: delivered means the harness accepted it, never that a human read it.
        row = self.journal.get(row_id)
        if not row or not self.call or not self.call.connected:
            return
        payload = json.loads(row['payload'] or '{}')
        self.call.input_receipt(payload, status)
        if status == 'delivered' and self.call.target.get('thread_id') == payload.get('thread_id'):
            self.call.sent += 1

    async def publish(self, payload):
        call = self.call
        uid = payload.session_id+':voice:'+payload.utterance_id
        # Store the conversational text even if its audio epoch has expired.
        name = (call.target.get('title') if call and call.target.get('thread_id') == payload.thread_id else None) or 'Conversación'
        record = self.journal.put(id=uid, thread=payload.thread_id, role='assistant',
            text=payload.text, name=name, session=payload.session_id,
            revision=payload.revision, status='text_only', language=payload.language)
        if record.get('_existing'):
            return {'status': record['status'], 'text_saved': True, 'utterance_id': payload.utterance_id}
        if call and payload.session_id == call.id:
            call.latency.reply(payload.utterance_id, payload.thread_id, payload.revision)
        reason = None
        if payload.thread_id in self.journal.closed_channels():
            reason = 'channel_closed'
        elif not call or not call.connected:
            reason = 'call_ended'
        elif call.id != payload.session_id:
            reason = 'session_changed'
        elif call.target.get('thread_id') != payload.thread_id or call.switching:
            reason = 'focus_changed'
        elif payload.revision != call.revision:
            reason = 'newer_turn' if call.turn_revision > payload.revision else 'focus_changed'
        elif call.speaking:
            reason = 'user_speaking'
        may_wait = reason in {'newer_turn', 'user_speaking'}
        if reason and not may_wait:
            self.journal.update(uid, 'text_only', reason)
            return {'status': 'text_only', 'text_saved': True, 'reason': reason}
        try:
            result = await call.speak(payload.text, payload.utterance_id, payload.session_id,
                                      call.revision if may_wait else payload.revision, payload.language,
                                      wait_for_quiet=may_wait)
        except HTTPException as error:
            if error.status_code not in {409, 429}:
                raise
            reason = 'expired_audio_turn' if error.status_code == 409 else 'queue_full'
            self.journal.update(uid, 'text_only', reason)
            return {'status': 'text_only', 'text_saved': True, 'reason': reason}
        self.journal.update(uid, result['status'], {'waiting_for_turn':'user_speaking', 'waiting_for_pause':'quiet_grace'}.get(result['status']))
        if call and payload.session_id == call.id:
            call.latency.status(payload.utterance_id, result['status'])
        return {**result, 'text_saved': True}

    async def send_text(self, text, session_id, thread_id, binding_id, message_id):
        call = self.call
        uid = session_id+':user-text:'+message_id
        previous = self.journal.get(uid)
        if previous:
            if previous['text'] != text or previous['thread'] != thread_id:
                raise HTTPException(409, 'El identificador ya corresponde a otro mensaje.')
            return {'accepted': True, 'id': uid, 'revision': previous['revision']}
        if (not call or not call.connected or call.id != session_id
                or call.target.get('thread_id') != thread_id
                or call.target.get('binding_id') != binding_id):
            raise HTTPException(409, 'La conexión o conversación cambió. El texto no se envió.')
        if not text.strip():
            raise HTTPException(422, 'Escribe un mensaje.')
        # Typed submissions get their own turn without changing an ongoing mic turn.
        call.revision += 1
        call.invalidate('interrupted', 'user_interrupted', preserve_waiting=True)
        call.enqueue_input(text, target=dict(call.target), revision=call.revision,
                           message_id=message_id, history_id=uid)
        if not call.speaking:
            call.quiet_until = asyncio.get_running_loop().time() + call.audio_grace_seconds
        await call._dispatch()
        return {'accepted': True, 'id': uid, 'revision': call.revision}

    async def close_channel(self, thread_id):
        async with self.activation_lock:
            previous = self.journal.closed_channels().get(thread_id)
            if previous:
                return {'status': 'closed', 'notification_id': previous}
            message_id = str(uuid.uuid4())
            uid = 'channel-close:'+message_id
            call = self.call
            session = call.id if call else 'room-control'
            revision = call.revision if call else 0
            text = ('He cerrado el canal de voz de esta tarea desde la sala. '
                    'Continúa solo por escrito y deja de publicar respuestas por voz hasta que '
                    'te pida explícitamente activar la voz de nuevo. No detengas el trabajo. '
                    'No actives la voz para confirmar este mensaje.')
            payload = {'channel': 'room-control', 'thread_id': thread_id, 'text': text,
                       'message_id': message_id, 'session_id': session, 'revision': revision,
                       'history_id': uid}
            self.journal.put(id=uid, thread=thread_id, role='user', text=text, name='Tú',
                             session=session, revision=revision, status='pending', payload=payload)
            self.journal.close_channel(thread_id, uid)
            if call and call.turn_target.get('thread_id') == thread_id:
                call.cancelled_turn = call.turn_revision
            if (binding() or {}).get('thread_id') == thread_id:
                await self._activate({})
            return {'status': 'closed', 'notification_id': uid}

    async def activate(self, target):
        async with self.activation_lock:
            return await self._activate(target)

    async def _activate(self, target):
        if target.get('thread_id'):
            self.journal.open_channel(target['thread_id'])
        current = binding()
        if current and current.get('thread_id') == target.get('thread_id') and (not target.get('title') or current.get('title') == target.get('title')):
            return {"status": "already_active", "binding": current}
        new = {key: target.get(key) for key in ("thread_id", "title")}
        new["binding_id"] = str(uuid.uuid4())
        BINDING.parent.mkdir(parents=True, exist_ok=True)
        temporary = BINDING.with_name(BINDING.name + "." + new["binding_id"] + ".tmp")
        temporary.write_text(json.dumps(new))
        try:
            old = self.call
            if old and not old.closed:
                old.switching = True
                old.revision += 1
                old.invalidate('interrupted', 'focus_changed')
                # Browser-only calls have no audio pipeline; invalidation above is sufficient.
                if old.worker is not None:
                    await old.worker.queue_frame(InterruptionFrame())
                else:
                    old.speaking = False
            temporary.replace(BINDING)
            if old and not old.closed:
                old.target = new
                old.sent = 0
                old.last_delivery = None
                old.error = None
        finally:
            if self.call:
                self.call.switching = False
            temporary.unlink(missing_ok=True)
        return {"status": "activated", "binding": new}

    def attach(self, call):
        if self.call and not self.call.closed:
            raise RuntimeError('Ya hay una llamada de presentación conectada.')
        self.call = call
        call.journal = self.journal

    def snapshot(self):
        return {'binding': binding(), 'call': self.call.snapshot() if self.call else None,
                'closed_threads': list(self.journal.closed_channels())}


hub = PresentationHub()


class Speech(BaseModel):
    thread_id: str
    session_id: str
    revision: int = Field(ge=0)
    text: str = Field(min_length=1, max_length=6000)
    utterance_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    language: str | None = Field(default=None, pattern=r'^(es|en|fr|it|pt|hi)$')


class TextMessage(BaseModel):
    text: str = Field(min_length=1, max_length=12000)
    session_id: str
    thread_id: str
    binding_id: str
    message_id: uuid.UUID





def mount_presentation(app):
    from language_settings import LanguageSettings, load_settings, save_settings
    from contextlib import asynccontextmanager
    previous_lifespan = app.router.lifespan_context
    @asynccontextmanager
    async def room_lifespan(application):
        async with previous_lifespan(application) as state:
            await hub.start()
            try:
                yield state
            finally:
                await hub.stop()
    app.router.lifespan_context = room_lifespan
    from fastapi.staticfiles import StaticFiles
    browser_audio = Path(__file__).with_name('browser_audio') / 'dist'
    if browser_audio.exists():
        app.mount('/voice-browser', StaticFiles(directory=browser_audio, html=True), name='voice-browser')

    @app.get('/api/presentation/history')
    async def history(thread_id: str | None = None):
        return {'messages': hub.journal.history(thread_id)}

    @app.get('/api/presentation/voice-catalog')
    async def voice_catalog(request: Request):
        require_same_origin(request)
        from language_settings import CATALOG
        import synthesis
        eleven = await synthesis.catalog()
        catalog = {**CATALOG,
                   'models': [{**item, 'provider': 'kokoro'} for item in CATALOG['models']]
                             + [{**item, 'provider': 'elevenlabs'} for item in eleven['models']],
                   'providers': {'elevenlabs': eleven}}
        return catalog

    @app.get('/api/presentation/synthesis')
    async def synthesis_settings(request: Request):
        require_same_origin(request)
        import synthesis
        return {'credentials': synthesis.credential_state(), 'catalog': await synthesis.catalog()}

    @app.post('/api/presentation/synthesis/credential')
    async def synthesis_credential(payload: dict, request: Request):
        if not request.headers.get('origin'):
            raise HTTPException(403, 'Guarda la clave desde la sala, no desde un cliente externo.')
        require_same_origin(request)
        import synthesis
        try:
            key = payload.get('key')
            if key is None or not str(key).strip():
                synthesis.clear_key()
            else:
                await synthesis.verify(str(key).strip())
                synthesis.save_key(str(key))
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        return {'credentials': synthesis.credential_state(), 'catalog': await synthesis.catalog()}

    @app.post('/api/presentation/synthesis/preview')
    async def synthesis_preview(payload: dict, request: Request):
        require_same_origin(request)
        import synthesis
        try:
            return await synthesis.synthesize(str(payload.get('text') or ''),
                                             model=str(payload.get('model') or ''),
                                             voice=str(payload.get('voice') or ''),
                                             speed=float(payload.get('speed', 1)))
        except (TypeError, ValueError) as error:
            raise HTTPException(422, str(error)) from error

    @app.get('/api/presentation/transcription')
    async def transcription_settings(request: Request):
        require_same_origin(request)
        import transcription
        from language_settings import load_settings
        settings = load_settings()
        return {'catalog': transcription.CATALOG,
                'credentials': {},
                'effective': transcription.resolve(settings)}

    @app.get('/api/presentation/languages')
    async def languages():
        return load_settings().model_dump()

    @app.post('/api/presentation/languages')
    async def languages_update(payload: LanguageSettings, request: Request):
        require_same_origin(request)
        save_settings(payload)
        if hub.call:
            hub.call.audio_grace_seconds = payload.audio_grace_seconds
        return {'saved': True, 'reconnect_for_stt': True}

    @app.get('/voice/', include_in_schema=False)
    async def view():
        return FileResponse(Path(__file__).with_name('presentation.html'))

    @app.get('/voice/mic_capture.js', include_in_schema=False)
    async def mic_capture():
        return FileResponse(Path(__file__).with_name('mic_capture.js'), media_type='text/javascript')

    @app.get('/api/presentation')
    async def state():
        return hub.snapshot()

    @app.get('/api/presentation/latency')
    async def latency():
        return hub.call.latency.snapshot() if hub.call else {'session_id': None, 'replies': []}

    def available_participants():
        current = binding() or {}
        entries = hub.control.participants() if hub.control else [{**b, 'connected': False} for b in hub.journal.bindings()]
        reach = hub.control.reachability if hub.control else (lambda b: {'state': 'offline', 'detail': None})
        return [{'thread_id': b['thread'], 'title': b.get('title') or ('Conversación ' + b['thread'][:8]),
                 'harness': b.get('harness'), 'available': b['connected'],
                 'reach': reach(b),
                 'selected': b['thread'] == current.get('thread_id')} for b in entries]

    @app.get('/api/presentation/participants')
    async def participants():
                return {'participants': available_participants(), 'closed_threads': list(hub.journal.closed_channels())}

    @app.post('/api/presentation/select')
    async def select_participant(payload: dict, request: Request):
        require_same_origin(request)
        thread_id = payload.get('thread_id', '')
        if not isinstance(thread_id, str) or not THREAD_PATTERN.match(thread_id):
            raise HTTPException(400, 'Identificador de conversación inválido.')
        record = hub.journal.binding_for_thread(thread_id)
        if not record:
            raise HTTPException(409, 'Esa conversación no está conectada. Activa la voz desde su tarea.')
        return await hub.activate({'thread_id': thread_id, 'title': record.get('title')})

    @app.post('/api/presentation/cancel-input')
    async def cancel_input(payload: dict, request: Request):
        require_same_origin(request)
        call = hub.call
        if (not call or not call.connected or not call.speaking
                or payload.get('session_id') != call.id
                or payload.get('revision') != call.turn_revision):
            raise HTTPException(409, 'La intervención ya terminó; no se puede cancelar.')
        call.cancelled_turn = call.turn_revision
        if call.on_browser_event:
            call.on_browser_event({'type':'voice-user-turn', 'data':{
                'phase':'cancelled', 'revision':call.turn_revision,
                'thread_id':call.turn_target.get('thread_id')}})
        return {'status':'cancelled'}

    @app.post('/api/presentation/close')
    async def close_channel(payload: dict, request: Request):
        require_same_origin(request)
        thread_id = payload.get('thread_id', '')
        if not isinstance(thread_id, str) or not THREAD_PATTERN.match(thread_id):
            raise HTTPException(400, 'Identificador inválido.')
        if not hub.journal.binding_for_thread(thread_id) and not hub.journal.history(thread_id):
            raise HTTPException(409, 'No se encuentra esa conversación.')
        return await hub.close_channel(thread_id)

    @app.post('/api/presentation/leave')
    async def leave(payload: dict, request: Request):
        require_same_origin(request)
        # Check and mutate under the same lock as activation.
        async with hub.activation_lock:
            if payload.get('binding_id') != (binding() or {}).get('binding_id'):
                raise HTTPException(409, 'La conversación cambió. Actualiza la sala.')
            return await hub._activate({})

    @app.post('/api/presentation/text')
    async def typed_message(payload: TextMessage, request: Request):
        require_same_origin(request)
        return await hub.send_text(payload.text, payload.session_id, payload.thread_id,
                                   payload.binding_id, str(payload.message_id))

    @app.post('/api/presentation/browser-receipt')
    async def browser_receipt(payload: dict, request: Request):
        require_same_origin(request)
        call = hub.call
        uid, rev = payload.get('utterance_id'), payload.get('revision')
        if payload.get('status') in {'cancelled_unplayed', 'cancelled_playing'}:
            if (not call or not call.browser_audio or payload.get('session_id') != call.id
                    or not isinstance(rev, int) or not call.browser_cancelled(uid, rev, payload['status'] == 'cancelled_playing')):
                raise HTTPException(409, 'Locución obsoleta.')
            return {'status': payload['status']}
        if (not call or not call.browser_audio or payload.get('session_id') != call.id
                or not call.is_current(uid, rev)):
            raise HTTPException(409, 'Locución obsoleta.')
        status = payload.get('status')
        if status == 'playback_finished':
            await call.playback_finished(uid, rev)
        elif status == 'failed':
            call.error = 'Falló la voz en el navegador. Revisa la sala; no se repetirá automáticamente.'
            call.fail_active()
        elif status == 'playing':
            call.latency.browser(uid, payload.get('timings_ms'))
            call.transition(uid, status)
        else:
            raise HTTPException(400, 'Estado inválido.')
        return {'status': status}

    @app.post('/api/presentation/speak')
    async def speak(payload: Speech, request: Request):
        require_same_origin(request)
        try:
            return await hub.publish(payload)
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
