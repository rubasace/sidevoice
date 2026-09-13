"""Controls for this voice frontend only; never changes global Codex settings."""
import json
import os
from pathlib import Path
import uuid
from fastapi import HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
PREFERENCES = ROOT / '.voice-poc' / 'preferences.json'
FALLBACK_MODELS = ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-6-astra', 'gpt-5.5']


def available_models():
    cache = Path(os.getenv('CODEX_HOME', str(Path.home() / '.codex'))) / 'models_cache.json'
    try:
        models = json.loads(cache.read_text())['models']
        result = [{'id': m['slug'], 'name': m.get('display_name', m['slug'])}
                  for m in models if m.get('visibility') == 'list']
        if result:
            return result
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return [{'id': m, 'name': m} for m in FALLBACK_MODELS]


class VoiceControls:
    def __init__(self):
        self.sessions = {}
        self.default_model = 'gpt-5.6-terra'
        try:
            selected = json.loads(PREFERENCES.read_text())['model']
            if selected in {m['id'] for m in available_models()}:
                self.default_model = selected
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def register(self, agent, session_id=None):
        session_id = session_id or str(uuid.uuid4())
        self.sessions[session_id] = agent
        return session_id

    def snapshot(self):
        return {'models': available_models(), 'default_model': self.default_model,
                'ice_servers': json.loads(os.getenv('PIPECAT_ICE_SERVERS', '[]')),
                'sessions': [{'id': key, 'thread_id': a.thread_id,
                              'model': a.selected_model, 'active_model': a.active_model,
                              'last_model': a.last_model, 'busy': a._turn_lock.locked(),
                              'connected': a.voice_connected, 'error': a.last_error,
                              'speech_filter': getattr(a, 'filter_stats', {}),
                              'active_task': getattr(a, 'active_target', None),
                              'tts': getattr(a, 'tts_state', {})}
                             for key, a in self.sessions.items()
                             if a.voice_connected or a._turn_lock.locked()]}

    def select(self, model, session_id=None):
        if model not in {m['id'] for m in available_models()}:
            raise HTTPException(422, 'Ese modelo no figura en el catálogo local de Codex.')
        agent = None
        if session_id:
            agent = self.sessions.get(session_id)
            if agent is None or not agent.voice_connected:
                raise HTTPException(409, 'La llamada ya no está conectada. Actualiza el estado.')
        # Persist before applying so a failed save cannot report an unapplied change.
        PREFERENCES.parent.mkdir(exist_ok=True)
        tmp = PREFERENCES.with_suffix('.tmp')
        tmp.write_text(json.dumps({'model': model}))
        tmp.replace(PREFERENCES)
        self.default_model = model
        if agent:
            agent.selected_model = model
        return self.snapshot()


controls = VoiceControls()


class ModelSelection(BaseModel):
    model: str
    session_id: str | None = None


def mount_controls(app):
    @app.get('/terra', include_in_schema=False)
    @app.get('/terra/', include_in_schema=False)
    async def terra_view():
        return FileResponse(Path(__file__).with_name('terra.html'))

    @app.get('/api/terra')
    async def state():
        return controls.snapshot()

    @app.post('/api/terra/model')
    async def select(selection: ModelSelection, request: Request):
        origin = request.headers.get('origin')
        if origin and origin not in {str(request.base_url).rstrip('/'), os.getenv('VOICE_PUBLIC_ORIGIN', '').rstrip('/')}:
            raise HTTPException(403, 'El cambio debe realizarse desde esta interfaz local.')
        return controls.select(selection.model, selection.session_id)
