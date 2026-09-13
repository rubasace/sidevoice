"""Own the two local processes and cleanly stop both on Ctrl-C."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


def main():
    processes = []
    def stop(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    try:
        if os.getenv("VOICE_BACKEND", "codex") != "codex" and not os.getenv("VOICE_LLM_URL"):
            processes.append(subprocess.Popen([
                sys.executable, "-m", "mlx_lm.server", "--host", "127.0.0.1",
                "--port", "8768", "--model",
                os.getenv("VOICE_LLM_MODEL", "mlx-community/Qwen3-1.7B-4bit"),
                "--chat-template-args", '{"enable_thinking":false}',
            ]))
            print("Preparando modelo local; el primer arranque descarga sus pesos.", flush=True)
            deadline = time.monotonic() + 900
            while time.monotonic() < deadline:
                if processes[0].poll() is not None:
                    raise RuntimeError("El servidor del modelo no pudo arrancar.")
                try:
                    with urllib.request.urlopen("http://127.0.0.1:8768/v1/models", timeout=1):
                        break
                except OSError:
                    time.sleep(1)
            else:
                raise TimeoutError("El modelo no estuvo disponible en 15 minutos.")
        processes.append(subprocess.Popen([
            sys.executable, str(ROOT / "voice_poc" / "bot.py"),
            "-t", "webrtc", "--host", "127.0.0.1", "--port", "8767",
        ]))
        print("Abre http://127.0.0.1:8767/terra/ y pulsa Connect. Ctrl-C para cerrar.", flush=True)
        while all(p.poll() is None for p in processes):
            time.sleep(0.5)
        return next((p.returncode for p in processes if p.returncode), 0)
    except KeyboardInterrupt:
        return 0
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    sys.exit(main())
