"""Which engine turns the microphone into text, and the credential it needs.

The catalogue is data, not a hard-coded switch: a provider names its models but a
model id the catalogue has not heard of is still accepted, so a newer one works
without a release. Credentials live apart from the preferences, are never read
back out of the room, and a provider that has none falls back to the local model
with a stated reason instead of failing silently mid-sentence.
"""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CREDENTIALS = Path(os.getenv('VOICE_STT_CREDENTIALS_FILE', str(ROOT / '.voice-poc/stt-credentials.json')))

# `models` are suggestions for the settings list; any non-empty id is accepted.
CATALOG = {
    'providers': [
        {
            'id': 'local',
            'label': 'Whisper local (CPU)',
            'needs_key': False,
            'note': 'Corre en la máquina de la sala. No sale audio de ella; es más lento y menos preciso.',
            'default_model': 'base',
            'models': [
                {'id': 'tiny', 'label': 'tiny · el más rápido, el menos preciso'},
                {'id': 'base', 'label': 'base · equilibrio por defecto'},
                {'id': 'small', 'label': 'small · más preciso, más lento'},
                {'id': 'medium', 'label': 'medium · preciso, notablemente más lento en CPU'},
                {'id': 'turbo', 'label': 'turbo · mejor equilibrio calidad/velocidad; GPU recomendada'},
                {'id': 'large-v3', 'label': 'large-v3 · máxima calidad Whisper, poco práctico sin GPU'},
            ],
        },
        {
            'id': 'openai',
            'label': 'OpenAI',
            'needs_key': True,
            'note': 'El audio de tus intervenciones se envía a OpenAI para transcribirlo.',
            'default_model': 'gpt-4o-transcribe',
            'models': [
                {'id': 'gpt-4o-transcribe', 'label': 'gpt-4o-transcribe · recomendado'},
                {'id': 'gpt-4o-mini-transcribe', 'label': 'gpt-4o-mini-transcribe · más barato'},
                {'id': 'gpt-transcribe', 'label': 'gpt-transcribe'},
                {'id': 'whisper-1', 'label': 'whisper-1 · el clásico'},
            ],
        },
    ],
}
PROVIDERS = {item['id']: item for item in CATALOG['providers']}


def _read():
    try:
        stored = json.loads(CREDENTIALS.read_text())
        return stored if isinstance(stored, dict) else {}
    except (OSError, ValueError):
        return {}


def stored_key(provider):
    value = _read().get(provider)
    return value if isinstance(value, str) and value.strip() else None


def environment_key(config=None):
    """The pre-existing way of supplying the OpenAI key; still honoured."""
    source = config if config is not None else os.environ
    value = (source.get('VOICE_STT_API_KEY') or '').strip()
    return value or None


def save_key(provider, key):
    if provider not in PROVIDERS or not PROVIDERS[provider]['needs_key']:
        raise ValueError('Ese proveedor no usa clave')
    key = (key or '').strip()
    if not key:
        raise ValueError('La clave está vacía')
    stored = _read()
    stored[provider] = key
    CREDENTIALS.parent.mkdir(parents=True, exist_ok=True)
    temporary = CREDENTIALS.with_suffix('.tmp')
    temporary.write_text(json.dumps(stored), encoding='utf8')
    temporary.chmod(0o600)
    temporary.replace(CREDENTIALS)


def clear_key(provider):
    stored = _read()
    if stored.pop(provider, None) is None:
        return
    CREDENTIALS.parent.mkdir(parents=True, exist_ok=True)
    temporary = CREDENTIALS.with_suffix('.tmp')
    temporary.write_text(json.dumps(stored), encoding='utf8')
    temporary.chmod(0o600)
    temporary.replace(CREDENTIALS)


def credential_state(config=None):
    """What the room will tell the browser: whether a key exists and where it came from.

    The key itself never leaves the room; only its last four characters, so a
    person can tell which one is installed without it being readable.
    """
    state = {}
    for provider in PROVIDERS.values():
        if not provider['needs_key']:
            continue
        key = stored_key(provider['id'])
        source = 'stored' if key else None
        if not key and provider['id'] == 'openai':
            key = environment_key(config)
            source = 'environment' if key else None
        state[provider['id']] = {'configured': bool(key), 'source': source,
                                 'hint': ('…' + key[-4:]) if key else None}
    return state


def resolve(settings, config=None):
    """The engine a call would use right now, and why.

    `auto` keeps the room's original behaviour: OpenAI when a key is available,
    the local model otherwise.
    """
    requested = getattr(settings, 'stt_provider', 'auto') or 'auto'
    available = bool(stored_key('openai') or environment_key(config))
    if requested == 'auto':
        provider = 'openai' if available else 'local'
        reason = 'auto_key' if available else 'auto_no_key'
    elif requested == 'openai' and not available:
        provider, reason = 'local', 'openai_without_key'
    else:
        provider, reason = requested, 'explicit'
    model = (getattr(settings, 'stt_model', '') or '').strip()
    if not model or provider != requested:
        model = PROVIDERS[provider]['default_model']
    runtime = ({
        'local': {
            'engine': 'faster-whisper',
            'location': 'local',
            'device': 'cpu',
            'compute_type': 'int8',
        },
        'openai': {
            'engine': 'OpenAI API',
            'location': 'remote',
            'device': 'cloud',
            'compute_type': None,
        },
    })[provider]
    return {'provider': provider, 'model': model, 'reason': reason, **runtime}


def build(settings, config=None):
    """Create the STT service for a call, plus the resolution that produced it."""
    from pipecat.transcriptions.language import Language
    choice = resolve(settings, config)
    language = None if settings.stt_language == 'auto' else Language(settings.stt_language)
    if choice['provider'] == 'openai':
        from speech_filter import FilteredOpenAISTTService
        key = stored_key('openai') or environment_key(config)
        service = FilteredOpenAISTTService(api_key=key, settings=FilteredOpenAISTTService.Settings(
            model=choice['model'], language=language, prompt=settings.stt_context or None))
    else:
        from pipecat.services.whisper.stt import WhisperSTTService
        # faster-whisper needs a language; auto-detection is not offered locally.
        service = WhisperSTTService(device='cpu', compute_type='int8', settings=WhisperSTTService.Settings(
            model=choice['model'], language=language or Language.ES))
    return service, choice


async def verify(provider, key):
    """Check a key before storing it, so a typo is caught here and not mid-conversation."""
    if provider != 'openai':
        return
    import aiohttp
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as http:
            async with http.get('https://api.openai.com/v1/models',
                                headers={'Authorization': 'Bearer ' + key}) as response:
                if response.status == 401:
                    raise ValueError('OpenAI rechazó la clave.')
                if response.status >= 400:
                    raise ValueError(f'OpenAI respondió {response.status} al comprobar la clave.')
    except ValueError:
        raise
    except Exception as error:
        raise ValueError('No se pudo comprobar la clave con OpenAI: ' + type(error).__name__) from error
