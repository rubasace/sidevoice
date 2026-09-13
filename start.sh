#!/bin/sh
set -eu
sidevoice_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$sidevoice_root"
if [ -f .env.voice ]; then
 set -a
 . ./.env.voice
 set +a
fi
sidevoice_python="${VOICE_RUNTIME_PYTHON:-$sidevoice_root/.venv/bin/python}"
if [ ! -x "$sidevoice_python" ]; then
 echo "Create .venv and install requirements.txt first; see README.md." >&2
 exit 1
fi
if [ ! -f voice_poc/browser_audio/dist/worker.js ]; then
 echo "Build browser assets first: npm ci --prefix voice_poc/browser_audio && npm run build --prefix voice_poc/browser_audio" >&2
 exit 1
fi
export SSL_CERT_FILE=$("$sidevoice_python" -m certifi)
echo "Sidevoice: http://127.0.0.1:8767/voice/"
exec "$sidevoice_python" -u voice_poc/bot.py -t webrtc --host 127.0.0.1 --port 8767
