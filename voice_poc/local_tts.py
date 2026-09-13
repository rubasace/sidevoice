"""macOS synthesis into Pipecat's audio pipeline, never independent playback."""
import asyncio
import os
import tempfile
from pathlib import Path

import soundfile as sf
from pipecat.frames.frames import ErrorFrame
from pipecat.services.tts_service import TTSService
from pipecat.services.settings import TTSSettings


class MacTTS(TTSService):
    def __init__(self, **kwargs):
        self.voice = os.getenv("VOICE_TTS_VOICE", "Mónica")
        super().__init__(sample_rate=24000, settings=TTSSettings(
            model="macos-say", voice=self.voice, language=None,
        ), **kwargs)

    async def run_tts(self, text, context_id):
        with tempfile.TemporaryDirectory(prefix="voice-poc-") as directory:
            path = Path(directory) / "speech.wav"
            process = await asyncio.create_subprocess_exec(
                "/usr/bin/say", "-v", self.voice, "-o", str(path),
                "--file-format=WAVE", "--data-format=LEI16@24000", text,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
            )
            try:
                _, error = await process.communicate()
                if process.returncode:
                    yield ErrorFrame(error=f"macOS TTS: {error.decode()}")
                    return
                async def chunks():
                    with sf.SoundFile(path) as audio:
                        while len(data := audio.buffer_read(480, dtype="int16")):
                            yield bytes(data)
                            await asyncio.sleep(0)
                async for frame in self._stream_audio_frames_from_iterator(
                    chunks(), in_sample_rate=24000, context_id=context_id
                ):
                    yield frame
            finally:
                if process.returncode is None:
                    process.terminate()
                    await process.wait()
