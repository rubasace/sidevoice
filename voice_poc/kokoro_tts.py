"""Kokoro Spanish on native MLX/Metal, isolated from Pipecat's audio loop."""
import asyncio
import base64
import json
import os
import sys
from pathlib import Path

from loguru import logger
from pipecat.frames.frames import ErrorFrame
from pipecat.services.settings import TTSSettings
from pipecat.services.tts_service import TTSService


class KokoroTTS(TTSService):
    def __init__(self, *, voice=None, model=None, speed=None, **kwargs):
        self.voice = voice or os.getenv('VOICE_TTS_VOICE', 'ef_dora')
        self.model_id = model or os.getenv('VOICE_TTS_MODEL', 'mlx-community/Kokoro-82M-bf16')
        self.speed = float(speed or os.getenv('VOICE_TTS_SPEED', '1.0'))
        from language_settings import VOICES
        if self.voice not in VOICES:
            raise ValueError('Unsupported Kokoro voice')
        self.lang_code = self.voice[0]
        if not 0.5 <= self.speed <= 2:
            raise ValueError('Kokoro speed must be between 0.5 and 2')
        self.runtime_status = {"engine": "Kokoro MLX", "voice": self.voice, "state": "not_started", "device": None}
        self._process = None
        self._generation_lock = asyncio.Lock()
        super().__init__(sample_rate=24000, settings=TTSSettings(
            model=self.model_id, voice=self.voice, language=None), **kwargs)

    def select_language(self, language):
        from language_settings import load_settings, resolve_voice
        preferences = load_settings()
        language = language or preferences.default_tts_language
        self.voice = resolve_voice(preferences, language)['voice']
        self.lang_code = self.voice[0]
        self.speed = resolve_voice(preferences, language)['speed']
        self.runtime_status.update(voice=self.voice, language=language, speed=self.speed)

    async def _shutdown_worker(self):
        process, self._process = self._process, None
        if process and process.returncode is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), 2)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()

    async def _ensure_worker(self):
        if self._process and self._process.returncode is None:
            return
        self.runtime_status["state"] = "loading"
        self._process = await asyncio.create_subprocess_exec(
            sys.executable, '-u', str(Path(__file__).with_name('kokoro_worker.py')),
            self.model_id, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            # Diagnostics inherit server stderr; no separate undrained pipe.
            stderr=None, limit=1024*1024)
        ready = await asyncio.wait_for(self._process.stdout.readline(), 120)
        if not ready:
            raise RuntimeError('Kokoro worker failed to initialize; inspect server log')
        status = json.loads(ready)
        if not status.get('metal') or 'gpu' not in status.get('device', ''):
            raise RuntimeError('Kokoro refused: Metal GPU not verified')
        self.runtime_status.update(state='ready', device=status['device'])
        logger.info('Kokoro local TTS ready: {} / {} / {}', self.model_id, self.voice, status['device'])

    async def run_tts(self, text, context_id):
        async with self._generation_lock:
            try:
                await self._ensure_worker()
                self._process.stdin.write((json.dumps({'text': text, 'voice': self.voice,
                                                      'lang_code': self.lang_code, 'speed': self.speed})+'\n').encode())
                await self._process.stdin.drain()
                async def chunks():
                    while True:
                        line = await asyncio.wait_for(self._process.stdout.readline(), 60)
                        if not line:
                            raise RuntimeError('Kokoro worker exited during synthesis')
                        result = json.loads(line)
                        if 'error' in result:
                            raise RuntimeError(result['error'])
                        if result.get('done'):
                            logger.debug('Kokoro synthesis {:.3f}s; GPU peak {} bytes',
                                         result['elapsed'], result['gpu_peak_bytes'])
                            return
                        yield base64.b64decode(result['pcm'])
                        await asyncio.sleep(0)
                async for frame in self._stream_audio_frames_from_iterator(
                        chunks(), in_sample_rate=24000, context_id=context_id):
                    yield frame
            except (asyncio.CancelledError, GeneratorExit):
                # Kill inference, not just audio playback, and prevent stale packets.
                await self._shutdown_worker()
                raise
            except Exception as exc:
                self.runtime_status["state"] = "error"
                await self._shutdown_worker()
                yield ErrorFrame(error=f'Local Kokoro TTS: {exc}')

    async def stop(self, frame):
        try:
            await super().stop(frame)
        finally:
            await self._shutdown_worker()

    async def cancel(self, frame):
        try:
            await super().cancel(frame)
        finally:
            await self._shutdown_worker()
