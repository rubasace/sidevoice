"""Optional native GPU integration checks: python -m voice_poc.test_kokoro_tts."""
import asyncio
import json
import time
from pathlib import Path
import soundfile as sf
import numpy as np
from pipecat.frames.frames import TTSAudioRawFrame
from voice_poc.kokoro_tts import KokoroTTS


async def main():
    tts = KokoroTTS()
    # Pipeline normally sets this during StartFrame; isolate synthesis here.
    tts._sample_rate = 24000
    try:
        started = time.monotonic()
        frames = [f async for f in tts.run_tts(
            'Hola, soy Terra. El archivo está listo en la conversación. Puedes interrumpirme cuando quieras.', 'test')]
        assert frames and all(isinstance(f, TTSAudioRawFrame) for f in frames)
        audio = b''.join(f.audio for f in frames)
        assert len(audio) > 24000 and any(audio)
        path = Path('.voice-poc/kokoro-dora-es.wav')
        sf.write(path, np.frombuffer(audio, dtype='<i2'), 24000)
        elapsed = time.monotonic()-started
        original = tts._process
        stream = tts.run_tts('Esta frase será interrumpida. ' * 100, 'cancel')
        task = asyncio.create_task(anext(stream))
        await asyncio.sleep(.03)
        started = time.monotonic()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await stream.aclose()
        assert tts._process is None and original.returncode is not None
        cancel_time = time.monotonic()-started
        recovered = [f async for f in tts.run_tts('Ya puedo escucharte.', 'new')]
        assert recovered and all(isinstance(f, TTSAudioRawFrame) for f in recovered)
        print(json.dumps({'audio': str(path), 'duration_s': len(audio)/48000,
                         'synthesis_with_boot_s': elapsed, 'cancel_s': cancel_time,
                         'recovery_frames': len(recovered)}))
    finally:
        await tts._shutdown_worker()


if __name__ == '__main__':
    asyncio.run(main())
