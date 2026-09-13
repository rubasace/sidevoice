import asyncio
from io import BytesIO
from types import SimpleNamespace
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
import wave

import numpy as np

try:
    from .speech_filter import SegmentSpeechGate, FilteredOpenAISTTService, unreliable_transcription
except ImportError:
    from speech_filter import SegmentSpeechGate, FilteredOpenAISTTService, unreliable_transcription


def wav(samples, rate=16000):
    output = BytesIO()
    with wave.open(output, 'wb') as stream:
        stream.setnchannels(1); stream.setsampwidth(2); stream.setframerate(rate)
        stream.writeframes(np.asarray(samples, dtype='<i2').tobytes())
    return output.getvalue()


class SpeechFilterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gate = SegmentSpeechGate()

    def test_real_vad_rejects_silence_noise_and_clicks(self):
        rng = np.random.default_rng(42)
        click = np.zeros(32000); click[1000:1010] = 25000
        for samples in [np.zeros(32000), rng.normal(0, 300, 32000), click]:
            with self.subTest(kind=float(np.max(samples))):
                self.assertFalse(self.gate.assess(wav(samples)).accepted)

    def test_short_commands_are_not_rejected_by_text_confidence(self):
        for text in ['Para.', 'No.', 'No lo hagas']:
            score = -0.1
            self.assertFalse(unreliable_transcription(SimpleNamespace(
                text=text, logprobs=[{'logprob': score}])))

    @unittest.skipUnless(sys.platform == 'darwin', 'Uses the local macOS voice')
    def test_real_short_speech_and_repetitions_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'command.wav'
            for command in ['No', 'Para', 'Sí']:
                subprocess.run(['/usr/bin/say', '-v', 'Mónica', '-o', str(target),
                                '--file-format=WAVE', '--data-format=LEI16@16000', command], check=True)
                audio = target.read_bytes()
                # The same instruction can legitimately be repeated.
                self.assertTrue(self.gate.assess(audio).accepted, command)
                self.assertTrue(self.gate.assess(audio).accepted, command)

    def test_isolated_scripts_rejected_but_mentions_preserved(self):
        from speech_filter import isolated_foreign_script
        for text in ['咳咳', 'うん', 'لنهاية.', '「東京」']:
            self.assertTrue(isolated_foreign_script(text), text)
        for text in ['¿Qué significa 咳咳?', 'Translate 東京 please', 'No', 'Sí',
                     'Pokémon', 'GPT-5', 'Prueba terminada', 'Se podería probar', '123']:
            self.assertFalse(isolated_foreign_script(text), text)

    def test_measured_background_noise_and_user_speech(self):
        # Measurements from the user's labeled background-noise test, 2026-09-13.
        self.assertFalse(self.gate.decide(224, .783).accepted)
        self.assertFalse(self.gate.decide(192, .8487).accepted)
        self.assertTrue(self.gate.decide(800, .96).accepted)

    def test_low_confidence_fragments_are_rejected_in_any_script(self):
        for text in ['うん', 'لنهاية.', 'Eh', 'No']:
            self.assertTrue(unreliable_transcription(SimpleNamespace(
                text=text, logprobs=[{'logprob': -4.0}])), text)
        # Script alone is not evidence of noise or a reason to censor speech.
        self.assertFalse(unreliable_transcription(SimpleNamespace(
            text='うん', logprobs=[{'logprob': -0.1}])))

    def test_missing_confidence_is_not_evidence_of_bad_transcription(self):
        self.assertFalse(unreliable_transcription(SimpleNamespace(text='Una frase perfectamente válida')))
        self.assertTrue(unreliable_transcription(SimpleNamespace(
            text='Una frase poco fiable', logprobs=[{'logprob': -3}])) )

    def test_diagnostics_record_evidence_without_audio_or_text(self):
        from speech_filter import SpeechEvidence
        async def run():
            gate = SimpleNamespace(assess=lambda audio: SpeechEvidence(True, 'speech', 128, .8))
            service = FilteredOpenAISTTService(api_key='test-not-used', speech_gate=gate)
            response = SimpleNamespace(text='Sorry', logprobs=[{'logprob': -4}])
            with patch('pipecat.services.openai.stt.OpenAISTTService._transcribe',
                       new_callable=AsyncMock, return_value=response):
                result = await service._transcribe(b'not-stored')
            self.assertEqual(result.text, '')
            self.assertEqual(service.filter_stats['recent_segments'], [{
                'speech_ms': 128, 'peak_probability': .8,
                'mean_logprob': -4, 'decision': 'low_confidence'}])
        asyncio.run(run())

    def test_rejected_audio_never_calls_cloud(self):
        async def run():
            service = FilteredOpenAISTTService(api_key='test-not-used', speech_gate=self.gate)
            with patch('pipecat.services.openai.stt.OpenAISTTService._transcribe', new_callable=AsyncMock) as cloud:
                result = await service._transcribe(wav(np.zeros(32000)))
                self.assertEqual(result.text, '')
                cloud.assert_not_awaited()
        asyncio.run(run())


if __name__ == '__main__':
    unittest.main()
