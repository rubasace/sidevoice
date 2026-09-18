"""The room's HTTP and pipeline surface. No LLM or task operator lives here.

The room model itself is `room.py`; this module exposes it to the browser and to
the connector control plane, and holds the pipeline processors that a client
whose audio is rendered server-side needs.
"""
import os
import re
import uuid
from urllib.parse import urlsplit

from .room_history import RoomHistory
from .paths import BROWSER_AUDIO_DIST, BROWSER_AUDIO_ROOT, RUNTIME_ROOT, WEB_DIST
from .pipeline_frames import PresentationBoundary, PresentationSpeech
from .room import Room, RoomClient, binding  # noqa: F401 — RoomClient is re-exported for app.py
from fastapi import HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from pipecat.frames.frames import LLMContextFrame, TTSAudioRawFrame, ErrorFrame
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection

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


class NoInference(FrameProcessor):
    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if not isinstance(frame, LLMContextFrame):
            await self.push_frame(frame, direction)


class PresentationGate(FrameProcessor):
    """Last epoch check before TTS; queued stale requests never synthesize."""
    client = None

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if self.client and direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, (PresentationSpeech, PresentationBoundary)):
                if not self.client.is_current(frame.utterance_id, frame.revision):
                    return
                if isinstance(frame, PresentationSpeech):
                    if hasattr(self.client.tts, 'select_language'):
                        self.client.tts.select_language(frame.language)
                    self.client.transition(frame.utterance_id, 'synthesizing')
        if self.client and isinstance(frame, ErrorFrame):
            self.client.fail_active()
        await self.push_frame(frame, direction)


class PresentationPlayback(FrameProcessor):
    """Observe ordered transport output, never silence timeout or 'heard'."""
    client = None
    current = None

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if self.client and direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, PresentationBoundary):
                if not frame.end:
                    self.current = (frame.utterance_id, frame.revision)
                else:
                    await self.client.playback_finished(frame.utterance_id, frame.revision)
                    if self.current == (frame.utterance_id, frame.revision):
                        self.current = None
            elif isinstance(frame, TTSAudioRawFrame) and self.current:
                uid, rev = self.current
                if self.client.is_current(uid, rev):
                    self.client.transition(uid, 'playing')
        await self.push_frame(frame, direction)


hub = Room(RoomHistory(RUNTIME_ROOT / 'room-history.sqlite3'))


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
    from .language_settings import LanguageSettings, load_settings, save_settings
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
    if BROWSER_AUDIO_DIST.exists():
        app.mount('/voice-browser', StaticFiles(directory=BROWSER_AUDIO_DIST, html=True), name='voice-browser')
    web_assets = WEB_DIST / 'assets'
    if web_assets.exists():
        app.mount('/voice/assets', StaticFiles(directory=web_assets), name='voice-assets')

    def client_for(session_id):
        """Every browser-scoped endpoint resolves its own client, and never anyone else's."""
        client = hub.clients.get(session_id) if isinstance(session_id, str) else None
        return client if client and client.connected else None

    @app.get('/api/presentation/history')
    async def history(thread_id: str | None = None):
        return {'messages': hub.journal.history(thread_id)}

    @app.get('/api/presentation/voice-catalog')
    async def voice_catalog(request: Request):
        require_same_origin(request)
        from .language_settings import CATALOG
        from . import synthesis
        eleven = await synthesis.catalog()
        catalog = {**CATALOG,
                   'models': [{**item, 'provider': 'kokoro'} for item in CATALOG['models']]
                             + [{**item, 'provider': 'elevenlabs'} for item in eleven['models']],
                   'providers': {'elevenlabs': eleven}}
        return catalog

    @app.get('/api/presentation/synthesis')
    async def synthesis_settings(request: Request):
        require_same_origin(request)
        from . import synthesis
        return {'credentials': synthesis.credential_state(), 'catalog': await synthesis.catalog()}

    @app.post('/api/presentation/synthesis/credential')
    async def synthesis_credential(payload: dict, request: Request):
        if not request.headers.get('origin'):
            raise HTTPException(403, 'Guarda la clave desde la sala, no desde un cliente externo.')
        require_same_origin(request)
        from . import synthesis
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
        from . import synthesis
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
        from . import transcription
        from .language_settings import load_settings
        settings = load_settings()
        return {'catalog': transcription.CATALOG,
                'credentials': transcription.credential_state(),
                'effective': transcription.resolve(settings)}

    @app.get('/api/presentation/transcription/models')
    async def transcription_models(provider: str, request: Request):
        require_same_origin(request)
        from . import transcription
        try:
            return await transcription.catalog(provider)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error

    @app.post('/api/presentation/transcription/credential')
    async def transcription_credential(payload: dict, request: Request):
        if not request.headers.get('origin'):
            raise HTTPException(403, 'Guarda la clave desde la sala, no desde un cliente externo.')
        require_same_origin(request)
        from . import transcription
        provider = payload.get('provider')
        if provider not in transcription.PROVIDERS:
            raise HTTPException(400, 'Proveedor desconocido.')
        key = payload.get('key')
        try:
            if key is None or not str(key).strip():
                transcription.clear_key(provider)
            else:
                await transcription.verify(provider, str(key).strip())
                transcription.save_key(provider, str(key))
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        return {'credentials': transcription.credential_state(),
                'effective': transcription.resolve(load_settings())}

    @app.get('/api/presentation/languages')
    async def languages():
        return load_settings().model_dump()

    @app.post('/api/presentation/languages')
    async def languages_update(payload: LanguageSettings, request: Request):
        require_same_origin(request)
        save_settings(payload)
        for client in hub.clients.values():
            client.audio_grace_seconds = payload.audio_grace_seconds
        return {'saved': True, 'reconnect_for_stt': True}

    @app.get('/voice/', include_in_schema=False)
    async def view():
        index = WEB_DIST / 'index.html'
        if not index.exists():
            raise HTTPException(503, 'Construye la interfaz con npm run build.')
        return FileResponse(index)

    @app.get('/voice/mic_capture.js', include_in_schema=False)
    async def mic_capture():
        return FileResponse(BROWSER_AUDIO_ROOT / 'mic_capture.js', media_type='text/javascript')

    @app.get('/api/presentation')
    async def state(session_id: str | None = None):
        return hub.snapshot(session_id)

    @app.get('/api/presentation/latency')
    async def latency(session_id: str | None = None):
        # A latency trace is one browser's own measurements; nobody else's are returned.
        return hub.latency_snapshot(session_id)

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
        client = client_for(payload.get('session_id'))
        if not client or not client.speaking or payload.get('revision') != client.turn_revision:
            raise HTTPException(409, 'La intervención ya terminó; no se puede cancelar.')
        client.cancelled_turn = client.turn_revision
        if client.on_browser_event:
            client.on_browser_event({'type':'voice-user-turn', 'data':{
                'phase':'cancelled', 'revision':client.turn_revision,
                'thread_id':client.turn_target.get('thread_id')}})
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
        # A receipt moves the browser that sent it and nothing else in the room.
        client = client_for(payload.get('session_id'))
        uid, rev = payload.get('utterance_id'), payload.get('revision')
        if not client:
            raise HTTPException(409, 'Locución obsoleta.')
        if payload.get('status') in {'cancelled_unplayed', 'cancelled_playing'}:
            if (not isinstance(rev, int)
                    or not client.browser_cancelled(uid, rev, payload['status'] == 'cancelled_playing')):
                raise HTTPException(409, 'Locución obsoleta.')
            return {'status': payload['status']}
        if not client.is_current(uid, rev):
            raise HTTPException(409, 'Locución obsoleta.')
        status = payload.get('status')
        if status == 'playback_finished':
            await client.playback_finished(uid, rev)
        elif status == 'failed':
            client.error = 'Falló la voz en el navegador. Revisa la sala; no se repetirá automáticamente.'
            client.fail_active()
        elif status == 'playing':
            client.latency.browser(uid, payload.get('timings_ms'))
            client.transition(uid, status)
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
