import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import transcription
from language_settings import LanguageSettings


class TranscriptionTests(unittest.TestCase):
    def test_catalogue_exposes_browser_and_openai_without_leaking_keys(self):
        providers = {item['id']: item for item in transcription.CATALOG['providers']}
        self.assertEqual(set(providers), {'browser', 'openai'})
        browser_ids = {item['id'] for item in providers['browser']['models']}
        self.assertEqual(browser_ids, {'onnx-community/whisper-tiny', 'onnx-community/whisper-base',
                                       'onnx-community/whisper-small', 'onnx-community/whisper-large-v3-turbo'})
        self.assertIn('gpt-4o-transcribe', {item['id'] for item in providers['openai']['models']})
        for model in providers['browser']['models']:
            self.assertTrue(set(model['devices']) <= {'webgpu', 'wasm'})
            self.assertTrue(model['devices'])
            self.assertTrue(model['description'])

    def test_browser_runtime_remains_local(self):
        choice = transcription.resolve(LanguageSettings(
            stt_provider='browser', stt_device='webgpu',
            stt_model='onnx-community/whisper-base'))
        self.assertEqual((choice['provider'], choice['location'], choice['device']),
                         ('browser', 'browser', 'webgpu'))

    def test_openai_runtime_uses_cloud_and_preserves_model(self):
        settings = LanguageSettings(stt_provider='openai', stt_model='gpt-4o-mini-transcribe')
        choice = transcription.resolve(settings, {'VOICE_STT_API_KEY': 'test-key'})
        self.assertEqual((choice['provider'], choice['location'], choice['model']),
                         ('openai', 'remote', 'gpt-4o-mini-transcribe'))
        self.assertTrue(choice['available'])

    def test_credential_round_trip_only_exposes_hint(self):
        with tempfile.TemporaryDirectory() as root, patch.object(
                transcription, 'CREDENTIALS', Path(root) / 'credentials.json'):
            transcription.save_key('openai', 'sk-test-secret')
            state = transcription.credential_state({})['openai']
            self.assertEqual(state, {'configured': True, 'source': 'stored', 'hint': '…cret'})
            self.assertNotIn('sk-test-secret', repr(state))
            self.assertEqual(oct(transcription.CREDENTIALS.stat().st_mode & 0o777), '0o600')
            transcription.clear_key('openai')
            self.assertFalse(transcription.credential_state({})['openai']['configured'])


if __name__ == '__main__':
    unittest.main()
