"""User-selected language preferences, independent of agent instructions."""
import json
import os
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
from .paths import BROWSER_AUDIO_ROOT, RUNTIME_ROOT

CATALOG = json.loads((BROWSER_AUDIO_ROOT / 'catalog.json').read_text())
LANGUAGES = {item['id']: item for item in CATALOG['languages']}
VOICES = {v[0] for item in LANGUAGES.values() for v in item['voices']}
LOCAL_MODELS = {'kokoro'}

class LanguageVoice(BaseModel):
    model_config = ConfigDict(extra='forbid')
    # Unknown cloud-model IDs are intentional: a provider can release a new
    # model before Sidevoice does.
    model: str = Field(default='inherit', min_length=1, max_length=120)
    voice: str = 'inherit'
    speed: float | None = Field(default=None, ge=0.5, le=2.0)

PATH = RUNTIME_ROOT / 'language-settings.json'

class LanguageSettings(BaseModel):
    model_config = ConfigDict(extra='forbid')
    ui_language: Literal['es', 'en'] = 'es'
    tts_execution: Literal['browser'] = 'browser'
    tts_device: Literal['auto', 'webgpu', 'wasm'] = 'auto'
    default_model: str = Field(default='kokoro', min_length=1, max_length=120)
    spanish_model: str = Field(default='inherit', min_length=1, max_length=120)
    english_model: str = Field(default='inherit', min_length=1, max_length=120)
    default_voice: str = 'ef_dora'
    language_overrides: dict[str, LanguageVoice] = Field(default_factory=dict)
    stt_language: Literal['auto', 'es', 'en', 'fr', 'it', 'pt', 'hi'] = 'auto'
    stt_context: str = ''
    stt_provider: Literal['browser', 'openai'] = 'browser'
    stt_device: Literal['auto', 'webgpu', 'wasm'] = 'auto'
    stt_model: str = Field(default='onnx-community/whisper-tiny', min_length=1, max_length=120)
    spanish_voice: Literal['inherit', 'ef_dora', 'em_alex', 'em_santa'] = 'ef_dora'
    english_voice: Literal['inherit', 'af_heart', 'af_bella', 'bf_emma', 'bm_george'] = 'af_heart'
    default_tts_language: Literal['es', 'en', 'fr', 'it', 'pt', 'hi'] = 'es'
    tts_speed: float = Field(default=1.0, ge=0.5, le=2.0)
    audio_grace_seconds: float = Field(default=2.0, ge=0, le=10)
    user_speech_timeout: float = Field(default=2.5, ge=0.5, le=15)


    @model_validator(mode='after')
    def supported_voices(self):
        if self.default_model in LOCAL_MODELS and self.default_voice not in VOICES:
            raise ValueError('Voz por defecto no compatible')
        for language, override in self.language_overrides.items():
            if language not in LANGUAGES:
                raise ValueError('Idioma no compatible')
            model = self.default_model if override.model == 'inherit' else override.model
            if (model in LOCAL_MODELS and override.voice != 'inherit'
                    and override.voice not in {v[0] for v in LANGUAGES[language]['voices']}):
                raise ValueError('La voz no corresponde al idioma')
        return self


def load_settings():
    try:
        data = json.loads(PATH.read_text())
    except (FileNotFoundError, ValueError):
        return LanguageSettings()
    # Server-local Whisper became browser-local; OpenAI remains an explicit cloud option.
    provider = data.get('stt_provider', 'browser')
    if provider in {'local', 'auto'}:
        provider = 'browser'
    if provider not in {'browser', 'openai'}:
        provider = 'browser'
    data['stt_provider'] = provider
    data['stt_device'] = data.get('stt_device', 'auto')
    if provider == 'browser':
        data['stt_model'] = {
            'tiny': 'onnx-community/whisper-tiny',
            'base': 'onnx-community/whisper-base',
            'small': 'onnx-community/whisper-small',
            'turbo': 'onnx-community/whisper-large-v3-turbo',
            'large-v3': 'onnx-community/whisper-large-v3-turbo',
        }.get(data.get('stt_model'), data.get('stt_model'))
        if data['stt_model'] not in {'onnx-community/whisper-tiny', 'onnx-community/whisper-base', 'onnx-community/whisper-small', 'onnx-community/whisper-large-v3-turbo'}:
            data['stt_model'] = 'onnx-community/whisper-tiny'
    elif not data.get('stt_model') or str(data['stt_model']).startswith('onnx-community/'):
        data['stt_model'] = 'gpt-4o-transcribe'
    return LanguageSettings.model_validate(data)


def save_settings(settings):
    PATH.parent.mkdir(parents=True, exist_ok=True)
    temp = PATH.with_suffix('.tmp')
    temp.write_text(settings.model_dump_json(indent=2))
    os.replace(temp, PATH)


def resolve_voice(settings, language=None):
    language = language or settings.default_tts_language
    if language not in LANGUAGES:
        raise ValueError('Idioma no compatible')
    override = settings.language_overrides.get(language)
    if override:
        voice, model = override.voice, override.model
    elif language in {'es', 'en'}:
        prefix = 'spanish' if language == 'es' else 'english'
        voice, model = getattr(settings, prefix + '_voice'), getattr(settings, prefix + '_model')
    else:
        voice, model = 'inherit', 'inherit'
    model = settings.default_model if model == 'inherit' else model
    if voice == 'inherit':
        voice = settings.default_voice
        if model in LOCAL_MODELS and voice not in {v[0] for v in LANGUAGES[language]['voices']}:
            voice = LANGUAGES[language]['voices'][0][0]
    return {'model': model,
            'provider': 'kokoro' if model in LOCAL_MODELS else 'elevenlabs',
            'voice': voice, 'language': language,
            'speed': override.speed if override and override.speed is not None else settings.tts_speed,
            'device': settings.tts_device}
