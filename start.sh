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
if [ ! -f packages/browser-audio/dist/worker.js ] || [ ! -f apps/web/dist/index.html ]; then
 echo "Build web and browser assets first: npm install && npm run build" >&2
 exit 1
fi
export SSL_CERT_FILE=$("$sidevoice_python" -m certifi)
echo "Sidevoice: http://127.0.0.1:8767/voice/"
exec env PYTHONPATH="$sidevoice_root/apps/server" "$sidevoice_python" -u -m sidevoice.app --host 127.0.0.1 --port 8767
