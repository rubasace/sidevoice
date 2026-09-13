"""Audition a configured voice without sending anything to an agent."""
import asyncio
from io import BytesIO
import wave
from typing import Literal
from fastapi import HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator
from pipecat.frames.frames import TTSAudioRawFrame, ErrorFrame
from kokoro_tts import KokoroTTS

from language_settings import CATALOG, VOICES

SAMPLES = {
    'es': 'Hola. Esta es una prueba de voz. Podemos conversar, hacer una pausa y seguir pensando juntos.',
    'en': 'Hello. This is a voice preview. We can talk, take a pause, and keep thinking together.',
}
class Preview(BaseModel):
    voice: str

    @field_validator('voice')
    @classmethod
    def supported(cls, value):
        if value not in VOICES:
            raise ValueError('Voz no compatible')
        return value
    speed: float = Field(default=1, ge=.5, le=2)


def mount_voice_preview(app):
    lock = asyncio.Lock()
    @app.post('/api/presentation/preview')
    async def preview(payload: Preview, request: Request):
        origin=request.headers.get('origin')
        if origin and origin != str(request.base_url).rstrip('/'):
            raise HTTPException(403,'Usa la configuración de la sala.')
        if lock.locked():
            raise HTTPException(409,'Ya se está preparando una prueba. Espera un momento.')
        async with lock:
            tts=KokoroTTS(voice=payload.voice,speed=payload.speed)
            tts._sample_rate=24000
            audio=bytearray()
            try:
                async with asyncio.timeout(120):
                    async for frame in tts.run_tts(next(item['sample'] for item in CATALOG['languages'] if payload.voice in {v[0] for v in item['voices']}),'preview'):
                        if await request.is_disconnected():
                            raise HTTPException(499,'Prueba cancelada')
                        if isinstance(frame,ErrorFrame):
                            raise HTTPException(502,'No se pudo generar la prueba de voz.')
                        if isinstance(frame,TTSAudioRawFrame):
                            audio.extend(frame.audio)
                if not audio:
                    raise HTTPException(502,'La prueba no produjo audio.')
                output=BytesIO()
                with wave.open(output,'wb') as wav:
                    wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(24000);wav.writeframes(audio)
                return Response(output.getvalue(),media_type='audio/wav',headers={'Cache-Control':'no-store'})
            finally:
                await tts._shutdown_worker()
