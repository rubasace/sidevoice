"""PocketTTS Core ML bridge for Pipecat, with a persistent cloned voice."""
import asyncio
import base64
import json
import os
from pathlib import Path

from loguru import logger
from pipecat.frames.frames import ErrorFrame
from pipecat.services.settings import TTSSettings
from pipecat.services.tts_service import TTSService


class PocketTTS(TTSService):
    def __init__(self, **kwargs):
        self.voice_file = Path(os.environ.get("VOICE_TTS_VOICE_FILE", "")).expanduser()
        self.worker = Path(os.environ.get(
            "VOICE_POCKET_WORKER", "/private/tmp/fluid-audio/.build/release/pocketttsworker"))
        if not self.voice_file.is_file():
            raise ValueError("VOICE_TTS_VOICE_FILE must point to a saved PocketTTS cloned voice")
        if not self.worker.is_file():
            raise ValueError("PocketTTS worker missing; run ./start-voice-poc.sh once")
        self._process = None
        self._generation_lock = asyncio.Lock()
        self.runtime_status = {"engine": "PocketTTS Core ML", "voice": self.voice_file.stem,
                               "state": "not_started", "device": "Apple Neural Engine / GPU"}
        super().__init__(sample_rate=24000, settings=TTSSettings(
            model="kyutai/pocket-tts", voice=self.voice_file.stem, language=None), **kwargs)

    async def _shutdown_worker(self):
        process, self._process = self._process, None
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 2)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()

    async def _ensure_worker(self):
        if self._process and self._process.returncode is None:
            return
        self.runtime_status["state"] = "loading"
        env = {**os.environ, "VOICE_TTS_VOICE_FILE": str(self.voice_file)}
        self._process = await asyncio.create_subprocess_exec(
            str(self.worker), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=None, env=env, limit=1024 * 1024)
        ready = await asyncio.wait_for(self._process.stdout.readline(), 180)
        if not ready:
            raise RuntimeError("PocketTTS worker exited during startup")
        response = json.loads(ready)
        if response.get("type") != "ready":
            raise RuntimeError(response.get("error", "PocketTTS failed to initialize"))
        self.runtime_status["state"] = "ready"
        logger.info("PocketTTS local voice ready: {}", self.voice_file.name)

    async def run_tts(self, text, context_id):
        async with self._generation_lock:
            try:
                await self._ensure_worker()
                self._process.stdin.write((json.dumps({"text": text}) + "\n").encode())
                await self._process.stdin.drain()
                async def chunks():
                    while True:
                        line = await asyncio.wait_for(self._process.stdout.readline(), 90)
                        if not line:
                            raise RuntimeError("PocketTTS worker exited during synthesis")
                        response = json.loads(line)
                        if response["type"] == "audio":
                            yield base64.b64decode(response["pcm"])
                        elif response["type"] == "done":
                            return
                        else:
                            raise RuntimeError(response.get("error", "PocketTTS worker error"))
                async for frame in self._stream_audio_frames_from_iterator(
                        chunks(), in_sample_rate=24000, context_id=context_id):
                    yield frame
            except (asyncio.CancelledError, GeneratorExit):
                await self._shutdown_worker()
                raise
            except Exception as exc:
                self.runtime_status["state"] = "error"
                await self._shutdown_worker()
                yield ErrorFrame(error=f"PocketTTS: {exc}")

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
