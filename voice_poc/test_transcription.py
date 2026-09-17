import unittest

import transcription
from language_settings import LanguageSettings


class BrowserTranscriptionTests(unittest.TestCase):
    def test_catalogue_has_browser_models_and_no_credentials(self):
        self.assertEqual(transcription.CATALOG['provider'], 'browser')
        self.assertEqual(transcription.credential_state(), {})
        ids = {item['id'] for item in transcription.CATALOG['models']}
        self.assertEqual(ids, {'onnx-community/whisper-tiny', 'onnx-community/whisper-base',
                               'onnx-community/whisper-small', 'onnx-community/whisper-large-v3-turbo'})
        for model in transcription.CATALOG['models']:
            self.assertTrue(set(model['devices']) <= {'webgpu', 'wasm'})
            self.assertTrue(model['devices'])
            self.assertTrue(model['description'])
        large = {item['id']: item for item in transcription.CATALOG['models']}
        self.assertEqual(large['onnx-community/whisper-small']['devices'], ['webgpu'])
        self.assertEqual(large['onnx-community/whisper-large-v3-turbo']['devices'], ['webgpu'])

    def test_effective_runtime_is_always_in_the_browser(self):
        choice = transcription.resolve(LanguageSettings(stt_device='webgpu', stt_model='onnx-community/whisper-base'))
        self.assertEqual(choice['provider'], 'browser')
        self.assertEqual(choice['location'], 'browser')
        self.assertEqual(choice['device'], 'webgpu')
        self.assertEqual(choice['model'], 'onnx-community/whisper-base')


if __name__ == '__main__':
    unittest.main()
