"""The settings a device brings to the room, and their defaults. The room keeps none of them.

Every browser stores its own configuration and sends it when it connects; the
server validates it, uses it for that call, and forgets it with the call.
"""
import json
from typing import ClassVar, Literal
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from .paths import BROWSER_AUDIO_ROOT

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

class LanguageSettings(BaseModel):
    model_config = ConfigDict(extra='ignore')
    ui_language: Literal['es', 'en'] = 'es'
    tts_execution: Literal['browser'] = 'browser'
    tts_device: Literal['auto', 'webgpu', 'wasm'] = 'auto'
    default_model: str = Field(default='kokoro', min_length=1, max_length=120)
    spanish_model: str = Field(default='inherit', min_length=1, max_length=120)
    english_model: str = Field(default='inherit', min_length=1, max_length=120)
    default_voice: str = 'ef_dora'
    language_overrides: dict[str, LanguageVoice] = Field(default_factory=dict)
    # Small local Whisper models flip languages on mixed speech; detection is opt-in.
    stt_language: Literal['auto', 'es', 'en', 'fr', 'it', 'pt', 'hi'] = 'es'
    stt_context: str = ''
    stt_provider: Literal['browser', 'openai'] = 'browser'
    stt_device: Literal['auto', 'webgpu', 'wasm'] = 'auto'
    stt_model: str = Field(default='onnx-community/whisper-tiny', min_length=1, max_length=120)
    spanish_voice: Literal['inherit', 'ef_dora', 'em_alex', 'em_santa'] = 'ef_dora'
    english_voice: Literal['inherit', 'af_heart', 'af_bella', 'bf_emma', 'bm_george'] = 'af_heart'
    default_tts_language: Literal['es', 'en', 'fr', 'it', 'pt', 'hi'] = 'es'
    tts_speed: float = Field(default=1.0, ge=0.5, le=2.0)
    audio_grace_seconds: float = Field(default=2.0, ge=0, le=10)
    # How far back a browser that comes back is played what it never heard (0 is off). This is a
    # preference a person perceives and chooses — how much of the last minutes they want repeated in
    # the car — so it belongs to the device, unlike the detector's tuning, which is the room's.
    replay_on_return_seconds: float = Field(default=120, ge=0, le=3600)
    # Microphone defaults for a device that sends none of its own (see MicSettings).
    turn_end_mode: Literal['timer', 'smart_turn'] = 'smart_turn'
    user_speech_timeout: float = Field(default=2.5, ge=0.5, le=15)
    smart_turn_min_silence: float = Field(default=0.6, ge=0.1, le=3)
    smart_turn_max_silence: float = Field(default=3.0, ge=0.5, le=15)
    vad_confidence: float = Field(default=0.6, ge=0.1, le=1)
    vad_min_volume: float = Field(default=0.35, ge=0, le=1)
    # How long the detector must hear voice before it opens a turn (and interrupts a reply). 80 ms opened turns
    # on 96 ms blips while the room's own voice left a car speaker (2026-09-19); the audio before the onset is kept.
    # Half a second held the blips off but made interrupting feel heavy from a moving car, so 0.4 (2026-09-20).
    vad_start_secs: float = Field(default=0.4, ge=0.05, le=1)


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
    """The room's defaults: what a device that saved nothing gets."""
    return LanguageSettings()


def settings_from(data):
    """A device's settings as it sent them, or the defaults and the reason they were not accepted."""
    if not isinstance(data, dict) or not data:
        return LanguageSettings(), None
    # With OpenAI transcription the local runtime fields mean nothing; a page whose device select was hidden
    # sent '' for stt_device (2026-09-19) and lost every setting to the defaults, and its turns with them.
    if data.get('stt_provider') == 'openai' and data.get('stt_device') not in ('auto', 'webgpu', 'wasm'):
        data = {**data, 'stt_device': 'auto'}
    try:
        return LanguageSettings.model_validate(data), None
    except ValidationError as error:
        return LanguageSettings(), 'Ajustes del dispositivo no válidos; se usan los valores por defecto: ' + '; '.join(
            '.'.join(str(part) for part in item.get('loc', ('?',))) + ' ' + item.get('msg', '') for item in error.errors()[:3])


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


class MicSettings(BaseModel):
    """How one device's microphone turns are detected. The room keeps defaults; each browser may send its own."""
    model_config = ConfigDict(extra='ignore')
    turn_end_mode: Literal['timer', 'smart_turn'] = 'smart_turn'
    user_speech_timeout: float = Field(default=2.5, ge=0.5, le=15)
    # Smart-turn is only asked after this much silence: too early and a breath ends the turn.
    smart_turn_min_silence: float = Field(default=0.6, ge=0.1, le=3)
    smart_turn_max_silence: float = Field(default=3.0, ge=0.5, le=15)
    vad_confidence: float = Field(default=0.6, ge=0.1, le=1)
    vad_min_volume: float = Field(default=0.35, ge=0, le=1)
    # How long the detector must hear voice before it opens a turn (and interrupts a reply). 80 ms opened turns
    # on 96 ms blips while the room's own voice left a car speaker (2026-09-19); the audio before the onset is kept.
    # Half a second held the blips off but made interrupting feel heavy from a moving car, so 0.4 (2026-09-20).
    vad_start_secs: float = Field(default=0.4, ge=0.05, le=1)

    # What a browser may override. The detector's fine tuning is deliberately not here: nobody can hear the
    # difference between 0.2 s and 0.5 s of onset, but getting it wrong makes the room interrupt itself, and
    # the fix has to reach every device at once. What a person perceives and chooses stays with the device.
    FIELDS: ClassVar[tuple[str, ...]] = ('turn_end_mode', 'user_speech_timeout', 'smart_turn_min_silence', 'smart_turn_max_silence')
    ROOM_ONLY: ClassVar[tuple[str, ...]] = ('vad_confidence', 'vad_min_volume', 'vad_start_secs')


def mic_settings(settings, overrides=None):
    """The room's defaults, overridden by what the device sent when it can be trusted.

    Returns (settings, problem): an invalid override falls back to the room's
    defaults and says why, so a browser never silently gets a pipeline it did
    not ask for.
    """
    base = MicSettings(**{key: getattr(settings, key) for key in MicSettings.FIELDS + MicSettings.ROOM_ONLY})
    if not isinstance(overrides, dict) or not overrides:
        return base, None
    merged = {**base.model_dump(), **{key: value for key, value in overrides.items() if key in MicSettings.FIELDS}}
    try:
        return MicSettings.model_validate(merged), None
    except ValidationError as error:
        return base, 'Ajustes de micrófono no válidos; se usan los de la sala: ' + '; '.join(
            str(item.get('loc', ('?',))[0]) + ' ' + item.get('msg', '') for item in error.errors())
