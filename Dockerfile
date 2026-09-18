# syntax=docker/dockerfile:1.7
# The room server with the web room and the browser audio runtime already built.
# Room data (journal, pairings, provider keys) lives in /data: mount a volume there.

FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/browser-audio/package.json packages/browser-audio/
COPY packages/connector/package.json packages/connector/
COPY packages/protocol/package.json packages/protocol/
RUN npm ci --no-audit --no-fund
COPY apps/web apps/web
COPY packages packages
RUN npm run build

FROM python:3.12-slim-bookworm AS room
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    VOICE_RUNTIME_ROOT=/data
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 sidevoice && mkdir -p /data && chown sidevoice:sidevoice /data
COPY requirements.txt ./
COPY apps/server/requirements.txt apps/server/
RUN pip install -r requirements.txt
COPY apps/server apps/server
COPY --from=web /src/apps/web/dist apps/web/dist
COPY packages/browser-audio/catalog.json packages/browser-audio/mic_capture.js packages/browser-audio/
COPY --from=web /src/packages/browser-audio/dist packages/browser-audio/dist
USER sidevoice
VOLUME ["/data"]
EXPOSE 8767
# certifi's bundle, as start.sh exports it, so provider TLS works the same in the image.
ENV PYTHONPATH=/app/apps/server SSL_CERT_FILE=/usr/local/lib/python3.12/site-packages/certifi/cacert.pem
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:8767/api/presentation >/dev/null || exit 1
CMD ["python", "-u", "-m", "sidevoice.app", "--host", "0.0.0.0", "--port", "8767"]
