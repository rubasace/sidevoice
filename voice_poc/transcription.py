"""Speech-to-text catalogue for browser-local and OpenAI cloud transcription."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CREDENTIALS = Path(os.getenv('VOICE_STT_CREDENTIALS_FILE', str(ROOT / '.voice-poc/stt-credentials.json')))

BROWSER_MODELS = [
    {'id': 'onnx-community/whisper-tiny', 'label': 'Whisper tiny',
     'description': 'Más rápido y ligero; recomendado para conversación y móvil.',
     'devices': ['webgpu', 'wasm']},
    {'id': 'onnx-community/whisper-base', 'label': 'Whisper base',
     'description': 'Más preciso, con mayor descarga y latencia.',
     'devices': ['webgpu', 'wasm']},
    {'id': 'onnx-community/whisper-small', 'label': 'Whisper small',
     'description': 'Mejor calidad multilingüe. Aproximadamente 285 MiB en Q4; requiere WebGPU.',
     'devices': ['webgpu']},
    {'id': 'onnx-community/whisper-large-v3-turbo', 'label': 'Whisper large v3 turbo',
     'description': 'Máxima calidad local disponible. Aproximadamente 538 MiB cuantizado; requiere WebGPU con fp16.',
     'devices': ['webgpu']},
]
OPENAI_MODELS = [
    {'id': 'gpt-4o-transcribe', 'label': 'gpt-4o-transcribe · recomendado'},
    {'id': 'gpt-4o-mini-transcribe', 'label': 'gpt-4o-mini-transcribe · más rápido y barato'},
    {'id': 'gpt-transcribe', 'label': 'gpt-transcribe'},
    {'id': 'whisper-1', 'label': 'whisper-1 · clásico'},
]
CATALOG = {
    'providers': [
        {'id': 'browser', 'label': 'En este navegador', 'needs_key': False,
         'note': 'El audio no sale del dispositivo. WebGPU usa la GPU; CPU usa WebAssembly.',
         'default_model': 'onnx-community/whisper-tiny', 'models': BROWSER_MODELS},
        {'id': 'openai', 'label': 'OpenAI', 'needs_key': True,
         'note': 'El audio de tus intervenciones se envía a OpenAI para transcribirlo.',
         'default_model': 'gpt-4o-transcribe', 'models': OPENAI_MODELS},
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
    provider = getattr(settings, 'stt_provider', 'browser') or 'browser'
    if provider not in PROVIDERS:
        provider = 'browser'
    model = (getattr(settings, 'stt_model', '') or '').strip()
    known = {item['id'] for item in PROVIDERS[provider]['models']}
    if not model or model not in known:
        model = PROVIDERS[provider]['default_model']
    if provider == 'browser':
        return {'provider': provider, 'model': model, 'reason': 'explicit',
                'engine': 'Transformers.js · Whisper', 'location': 'browser',
                'device': getattr(settings, 'stt_device', 'auto'),
                'compute_type': 'fp32 (WebGPU) / q8 (WASM)'}
    key = stored_key('openai') or environment_key(config)
    return {'provider': provider, 'model': model,
            'reason': 'explicit' if key else 'missing_key',
            'engine': 'OpenAI API', 'location': 'remote', 'device': 'cloud',
            'compute_type': None, 'available': bool(key)}


def build(settings, config=None):
    from pipecat.transcriptions.language import Language
    choice = resolve(settings, config)
    if choice['provider'] != 'openai':
        raise ValueError('La transcripción del navegador no se construye en el servidor.')
    key = stored_key('openai') or environment_key(config)
    if not key:
        raise ValueError('OpenAI necesita una clave de API antes de conectar.')
    from speech_filter import FilteredOpenAISTTService
    language = None if settings.stt_language == 'auto' else Language(settings.stt_language)
    service = FilteredOpenAISTTService(api_key=key, settings=FilteredOpenAISTTService.Settings(
        model=choice['model'], language=language, prompt=settings.stt_context or None))
    return service, choice


async def verify(provider, key):
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
