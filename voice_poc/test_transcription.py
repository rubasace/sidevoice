import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import transcription
from language_settings import LanguageSettings


class TranscriptionChoiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.patch = patch.object(transcription, 'CREDENTIALS', Path(self.temp.name) / 'stt.json')
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.addCleanup(self.temp.cleanup)

    def test_auto_follows_the_key_and_never_leaks_it(self):
        settings = LanguageSettings()
        self.assertEqual(transcription.resolve(settings, {}), {
            'provider': 'local', 'model': 'base', 'reason': 'auto_no_key',
            'engine': 'faster-whisper', 'location': 'local',
            'device': 'cpu', 'compute_type': 'int8',
        })
        transcription.save_key('openai', 'sk-secret-value-1234')
        self.assertEqual(transcription.resolve(settings, {})['provider'], 'openai')
        state = transcription.credential_state({})
        self.assertEqual(state['openai'], {'configured': True, 'source': 'stored', 'hint': '…1234'})
        self.assertNotIn('sk-secret-value-1234', repr(state))

    def test_environment_key_still_works_and_is_reported_as_such(self):
        state = transcription.credential_state({'VOICE_STT_API_KEY': 'sk-from-env-9876'})
        self.assertEqual(state['openai'], {'configured': True, 'source': 'environment', 'hint': '…9876'})
        self.assertEqual(transcription.resolve(LanguageSettings(), {'VOICE_STT_API_KEY': 'sk-x'})['provider'], 'openai')

    def test_openai_without_a_key_falls_back_and_says_why(self):
        choice = transcription.resolve(LanguageSettings(stt_provider='openai'), {})
        self.assertEqual(choice, {
            'provider': 'local', 'model': 'base', 'reason': 'openai_without_key',
            'engine': 'faster-whisper', 'location': 'local',
            'device': 'cpu', 'compute_type': 'int8',
        })

    def test_explicit_choice_keeps_a_model_the_catalogue_does_not_list(self):
        transcription.save_key('openai', 'sk-key')
        choice = transcription.resolve(LanguageSettings(stt_provider='openai', stt_model='gpt-5-transcribe-future'), {})
        self.assertEqual(choice, {
            'provider': 'openai', 'model': 'gpt-5-transcribe-future', 'reason': 'explicit',
            'engine': 'OpenAI API', 'location': 'remote',
            'device': 'cloud', 'compute_type': None,
        })

    def test_a_model_from_another_provider_is_not_carried_over_on_fallback(self):
        choice = transcription.resolve(LanguageSettings(stt_provider='openai', stt_model='gpt-4o-transcribe'), {})
        self.assertEqual((choice['provider'], choice['model']), ('local', 'base'))

    def test_local_provider_uses_its_default_and_honours_an_explicit_model(self):
        self.assertEqual(transcription.resolve(LanguageSettings(stt_provider='local'), {})['model'], 'base')
        self.assertEqual(transcription.resolve(LanguageSettings(stt_provider='local', stt_model='small'), {})['model'], 'small')
        self.assertEqual(transcription.resolve(LanguageSettings(stt_provider='local', stt_model='turbo'), {})['model'], 'turbo')
        self.assertIn('turbo', {model['id'] for model in transcription.PROVIDERS['local']['models']})

    def test_keys_are_stored_privately_and_can_be_removed(self):
        transcription.save_key('openai', 'sk-one')
        self.assertEqual(transcription.CREDENTIALS.stat().st_mode & 0o777, 0o600)
        self.assertEqual(transcription.stored_key('openai'), 'sk-one')
        transcription.clear_key('openai')
        self.assertIsNone(transcription.stored_key('openai'))
        transcription.clear_key('openai')  # removing what is not there is not an error
        with self.assertRaises(ValueError):
            transcription.save_key('openai', '   ')
        with self.assertRaises(ValueError):
            transcription.save_key('local', 'sk-one')

    def test_catalogue_is_self_consistent(self):
        for provider in transcription.CATALOG['providers']:
            ids = [model['id'] for model in provider['models']]
            self.assertIn(provider['default_model'], ids, provider['id'])
            self.assertEqual(len(ids), len(set(ids)), provider['id'])
            self.assertTrue(provider['note'])


if __name__ == '__main__':
    unittest.main()
