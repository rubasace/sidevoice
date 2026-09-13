"""Validate segmented microphone audio before sending it to cloud STT.

This is separate from the fast barge-in VAD: no microphone muting, transcript
deduplication or word blacklist. Echo containing real speech still needs AEC.
"""
import asyncio
from dataclasses import dataclass
from io import BytesIO
from math import gcd
from types import SimpleNamespace
import wave
import unicodedata

import numpy as np
from scipy.signal import resample_poly
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.services.openai.stt import OpenAISTTService


@dataclass(frozen=True)
class SpeechEvidence:
    accepted: bool
    reason: str
    speech_ms: float
    peak_probability: float


class SegmentSpeechGate:
    def __init__(self, *, confidence=0.5, min_speech_ms=96, min_rms=0.001, min_peak_probability=0.9):
        self.confidence = confidence
        self.min_speech_ms = min_speech_ms
        self.min_rms = min_rms
        self.min_peak_probability = min_peak_probability
        self.vad = SileroVADAnalyzer(sample_rate=16000)
        self.vad.set_sample_rate(16000)

    def assess(self, audio: bytes) -> SpeechEvidence:
        with wave.open(BytesIO(audio), 'rb') as source:
            if source.getsampwidth() != 2:
                raise ValueError('The STT gate expects PCM16 WAV segments')
            rate, channels = source.getframerate(), source.getnchannels()
            samples = np.frombuffer(source.readframes(source.getnframes()), dtype='<i2')
        samples = samples.astype(np.float32).reshape(-1, channels).mean(axis=1) / 32768
        if rate != 16000:
            divisor = gcd(rate, 16000)
            samples = resample_poly(samples, 16000 // divisor, rate // divisor)
        if not len(samples):
            return SpeechEvidence(False, 'empty_audio', 0, 0)
        # Reset for each complete segment so previous speech cannot turn noise
        # in a later segment into a false positive. Pipecat 1.10 pins this model.
        self.vad._model.reset_states()
        speech_frames, peak = 0, 0.0
        for offset in range(0, len(samples), 512):
            chunk = samples[offset:offset + 512]
            if len(chunk) < 512:
                chunk = np.pad(chunk, (0, 512 - len(chunk)))
            probability = float(self.vad._model(chunk, 16000).item())
            peak = max(peak, probability)
            rms = float(np.sqrt(np.mean(chunk * chunk)))
            if probability >= self.confidence and rms >= self.min_rms:
                speech_frames += 1
        speech_ms = speech_frames * 32
        return self.decide(speech_ms, peak)

    def decide(self, speech_ms, peak):
        if speech_ms < self.min_speech_ms:
            return SpeechEvidence(False, 'insufficient_speech', speech_ms, peak)
        if peak < self.min_peak_probability:
            return SpeechEvidence(False, 'weak_speech_evidence', speech_ms, peak)
        return SpeechEvidence(True, 'speech', speech_ms, peak)


def unreliable_transcription(response, *, threshold=-2.0):
    """Reject uncertain text, with a more tolerant threshold for short commands.

    Logprobs measure decoder certainty, not whether a person actually spoke.
    They are a secondary signal; the audio gate is the primary defense.
    """
    if len(response.text.split()) <= 2:
        threshold = -3.0
    confidence = transcription_confidence(response)
    return confidence is not None and confidence < threshold


def transcription_confidence(response):
    probabilities = getattr(response, 'logprobs', None) or []
    values = [item.get('logprob') if isinstance(item, dict) else getattr(item, 'logprob', None)
              for item in probabilities]
    values = [float(value) for value in values if value is not None]
    return sum(values) / len(values) if values else None



def isolated_foreign_script(text):
    """ES/EN room: reject isolated non-Latin writing, preserve quoted mentions.

    This is a script guard, not a language classifier. Latin-script names,
    regional languages and technical tokens are deliberately left untouched.
    """
    letters = [char for char in text if char.isalpha()]
    return bool(letters) and not any('LATIN' in unicodedata.name(char, '') for char in letters)


class FilteredOpenAISTTService(OpenAISTTService):
    async def _request_transcription(self, audio):
        # Pipecat 1.10's parent asserts a language; omit it for API auto-detection.
        if self._settings.language is not None:
            return await super()._transcribe(audio)
        model = self._settings.model
        kwargs = {'file': ('audio.wav', audio, 'audio/wav'), 'model': model}
        if self._include_prob_metrics:
            if model.startswith('whisper'):
                kwargs['response_format'] = 'verbose_json'
            elif 'diarize' not in model:
                kwargs.update(response_format='json', include=['logprobs'])
        if self._settings.prompt:
            kwargs['prompt'] = self._settings.prompt
        return await self._client.audio.transcriptions.create(**kwargs)

    def __init__(self, *, speech_gate=None, **kwargs):
        kwargs.setdefault('include_prob_metrics', True)
        super().__init__(**kwargs)
        self.speech_gate = speech_gate or SegmentSpeechGate()
        self.filter_stats = {'audio_rejected': 0, 'confidence_rejected': 0, 'submitted': 0, 'script_rejected': 0}

    async def _transcribe(self, audio):
        evidence = await asyncio.to_thread(self.speech_gate.assess, audio)
        # Only acoustic/decoder measurements: no waveform or transcript archive.
        measurement = {'speech_ms': evidence.speech_ms,
                       'peak_probability': round(evidence.peak_probability, 4),
                       'mean_logprob': None, 'decision': evidence.reason}
        history = self.filter_stats.setdefault('recent_segments', [])
        history.append(measurement)
        del history[:-20]
        if not evidence.accepted:
            self.filter_stats['audio_rejected'] += 1
            logger.info('STT ignored non-speech segment: speech_ms={} peak_probability={:.3f}',
                        evidence.speech_ms, evidence.peak_probability)
            return SimpleNamespace(text='')
        self.filter_stats['submitted'] += 1
        response = await self._request_transcription(audio)
        measurement['mean_logprob'] = transcription_confidence(response)
        measurement['decision'] = 'accepted'
        if isolated_foreign_script(response.text) and self._settings.language != 'hi':
            measurement['decision'] = 'isolated_foreign_script'
            self.filter_stats['script_rejected'] += 1
            logger.info('STT ignored isolated non-Latin text: {}', measurement)
            return SimpleNamespace(text='')
        if unreliable_transcription(response):
            measurement['decision'] = 'low_confidence'
            self.filter_stats['confidence_rejected'] += 1
            logger.info('STT ignored a low-confidence transcript')
            return SimpleNamespace(text='')
        logger.info('STT segment evidence: {}', measurement)
        return response
