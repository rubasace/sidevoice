"""Private JSON-lines subprocess: MLX GPU synthesis only, no device playback."""
import base64
import contextlib
import json
import os
import re
import sys
import time


def segments(text, limit=240):
    """Bound Spanish G2P chunks; upstream does not chunk non-English itself."""
    current = ''
    for word in re.findall(r'\S+', text):
        if current and len(current) + len(word) + 1 > limit:
            yield current
            current = ''
        current = (current + ' ' + word).strip()
        if re.search(r'[.!?;:]$', word):
            yield current
            current = ''
    if current:
        yield current


def main():
    # Redirect the descriptor too: dependency subprocesses inherit fd 1 and can
    # otherwise corrupt JSON-lines even inside redirect_stdout.
    output = os.fdopen(os.dup(sys.stdout.fileno()), 'w', buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    def emit(value):
        output.write(json.dumps(value) + '\n')
        output.flush()
    # Libraries can print diagnostics: keep stdout exclusively our protocol.
    with contextlib.redirect_stdout(sys.stderr):
        import mlx.core as mx
        import numpy as np
        from mlx_audio.tts.utils import load_model
        if not mx.metal.is_available():
            raise RuntimeError('Kokoro requires native macOS Metal GPU; no CPU fallback.')
        mx.set_default_device(mx.gpu)
        model = load_model(sys.argv[1])
        emit({'ready': True, 'device': str(mx.default_device()), 'metal': True})
        for line in sys.stdin:
            request = json.loads(line)
            started = time.monotonic()
            try:
                for segment in segments(request['text']):
                    for result in model.generate(text=segment, voice=request['voice'],
                                                 lang_code=request['lang_code'], speed=request['speed']):
                        mx.eval(result.audio)
                        if result.sample_rate != 24000:
                            raise RuntimeError('Unexpected Kokoro sample rate')
                        pcm = (np.clip(np.asarray(result.audio), -1, 1) * 32767).astype('<i2').tobytes()
                        # Small packets let cancellation discard pending audio promptly.
                        for start in range(0, len(pcm), 960):
                            emit({'pcm': base64.b64encode(pcm[start:start+960]).decode()})
                emit({'done': True, 'elapsed': time.monotonic()-started,
                      'gpu_peak_bytes': mx.get_peak_memory()})
            except Exception as exc:
                emit({'error': str(exc)})


if __name__ == '__main__':
    main()
