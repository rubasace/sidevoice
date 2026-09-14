import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import language_settings
from speech_filter import FilteredOpenAISTTService

class PreferencesTest(unittest.TestCase):
    def test_preferences_persist_and_select_native_voice(self):
        with tempfile.TemporaryDirectory() as root, patch.object(language_settings,'PATH',Path(root)/'settings.json'):
            self.assertEqual(language_settings.load_settings().stt_language,'auto')
            language_settings.save_settings(language_settings.LanguageSettings(english_voice='bf_emma',spanish_voice='em_alex',tts_speed=1.2))
            saved=language_settings.load_settings()
            en=language_settings.resolve_voice(saved,'en')
            self.assertEqual(en['speed'],1.2)
            self.assertEqual((en['voice'],en['voice'][0]),('bf_emma','b'))
            es=language_settings.resolve_voice(saved,'es')
            self.assertEqual((es['voice'],es['voice'][0]),('em_alex','e'))

class AutoLanguageTest(unittest.IsolatedAsyncioTestCase):
    async def test_auto_omits_language_and_prompt(self):
        stt=FilteredOpenAISTTService(api_key='test',speech_gate=object(),settings=FilteredOpenAISTTService.Settings(model='gpt-4o-transcribe',language=None,prompt=None))
        create=AsyncMock(return_value=SimpleNamespace(text='Hello'))
        stt._client=SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create)))
        await stt._request_transcription(b'audio')
        self.assertNotIn('language',create.call_args.kwargs)
        self.assertNotIn('prompt',create.call_args.kwargs)
        self.assertEqual(create.call_args.kwargs['include'],['logprobs'])

class VoiceResolutionTest(unittest.TestCase):
    def test_default_and_language_override(self):
        p=language_settings.LanguageSettings(default_voice='af_bella',spanish_voice='inherit',english_voice='inherit',tts_speed=1.5)
        self.assertEqual(language_settings.resolve_voice(p,'en')['voice'],'af_bella')
        self.assertEqual(language_settings.resolve_voice(p,'es')['voice'],'ef_dora')
        p.spanish_voice='em_alex'
        self.assertEqual(language_settings.resolve_voice(p,'es')['voice'],'em_alex')
        self.assertEqual(language_settings.resolve_voice(p,'es')['speed'],1.5)

    def test_catalog_languages_resolve_and_cross_language_voice_is_rejected(self):
        from pydantic import ValidationError
        for language, item in language_settings.LANGUAGES.items():
            p=language_settings.LanguageSettings(language_overrides={language:{'voice':'inherit'}})
            voice=language_settings.resolve_voice(p,language)['voice']
            self.assertIn(voice, {v[0] for v in item['voices']})
        with self.assertRaises(ValidationError):
            language_settings.LanguageSettings(language_overrides={'fr':{'voice':'ef_dora'}})

    def test_speed_override_and_reset(self):
        p=language_settings.LanguageSettings(tts_speed=1.5,language_overrides={'en':{'speed':0.85}})
        self.assertEqual(language_settings.resolve_voice(p,'en')['speed'],0.85)
        self.assertEqual(language_settings.resolve_voice(p,'es')['speed'],1.5)
        p.language_overrides['en'].speed=None
        self.assertEqual(language_settings.resolve_voice(p,'en')['speed'],1.5)
