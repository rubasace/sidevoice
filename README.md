# Sidevoice

**Give your coding agent a voice. Keep the conversation.**

A voice room for your coding agents. Talk, interrupt, and keep working in the same
conversation, with local speech synthesis in your browser.

Your working agent keeps its context and tools, writes its normal response, and
publishes a conversational version to the room. There is no separate voice operator.

> Early prototype, first public snapshot. The working integration is Codex Desktop
> on macOS. Claude integration is an unfinished experiment, not a supported feature.
> Earlier prototypes remain in the source; refactoring is planned before a stable release.

## What works

- Browser microphone over WebRTC with OpenAI speech-to-text.
- Kokoro TTS in the browser: WebGPU with WASM fallback during initialization.
- Interrupt speech without automatically cancelling the agent's work.
- Replies arriving while you speak wait for your turn and a configurable pause.
- Written messages alongside voice; cancel a microphone draft before it is sent.
- Switch between registered conversations and close their voice channels.
- Persistent room history and delivery receipts. Accepted does not mean read.
- Global and per-language voice/speed settings, samples and reset.
- Spanish, English, French, Italian, Brazilian Portuguese and Hindi voices.

Closing a channel hides it from the room, suppresses its audio and queues an
instruction to continue in writing. It preserves the task and room history.

## Current requirements

- Apple Silicon macOS and Codex Desktop for the verified harness integration.
- Python 3.12 and Node.js 22+ with npm.
- A compatible browser. Windows and mobile are not validated end to end.
- An OpenAI API key for the recommended transcription path. Browser TTS is local.

The Python dependency set still includes Apple MLX dependencies from earlier
experiments. This is not yet a portable server package.

## Run the room

```sh
git clone https://github.com/rubasace/sidevoice.git
cd sidevoice
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci --prefix voice_poc/browser_audio
npm run build --prefix voice_poc/browser_audio
cp .env.example .env.voice
```

Set `VOICE_STT_API_KEY` in `.env.voice`, then run:

```sh
./start.sh
```

Open **http://127.0.0.1:8767/voice/**. The room can stay open without an agent
selected. The browser downloads model assets on first use, prepares them and
caches them locally. Initial preparation is slower than subsequent use.

Without an STT key the prototype falls back to CPU Whisper. The main workflow
has been exercised with OpenAI transcription.

## Connect a Codex conversation

Install the skill with paths pointing to this checkout:

```sh
python3 scripts/install-codex-skill.py
```

An existing skill is backed up first. Load `voice-presentation` in Codex and ask
to connect the current task to the voice room, or invoke `$voice-presentation`.

The skill runs `voice_poc/activate_voice.mjs` from the actual task environment.
It starts or reuses that task's gateway and registers its real identity.
Do not set `CODEX_THREAD_ID` to impersonate another task.

The bridge requires `CODEX_APP_TOOLS_PIPE_PATH`, supplied by Codex Desktop, and
the app's bundled signed Node runtime. An ordinary external terminal is not
sufficient. This socket integration is app-specific, not a promised public API.
App updates may require adjusting the runtime path or bridge.

The room service uses port 8767. Keep it and the task gateways alive during use.
Only one active room call is supported by this prototype.

## Architecture

```text
Browser mic -> STT -> durable queue -> harness bridge -> existing conversation

Existing conversation -> normal written answer in its harness
                      -> spoken summary -> room -> browser Kokoro
```

The room owns participants, history, routing, playback and cancellation. The
agent owns its work and spoken summary. The intended harness adapter is small:
connect, identify the session, deliver input and normalize results. The current
Codex bridge still contains infrastructure that should move into a shared layer.

See [architecture and limitations](docs/ARCHITECTURE.md).

## Development

With dependencies installed:

```sh
.venv/bin/python -m unittest discover -s voice_poc -p 'test_*.py'
node --test voice_poc/test_*.cjs voice_poc/test_task_watch.mjs
```

Tests cover routing, stale replies, playback, interruptions, persistence, closure
and draft cancellation. They do not prove live Claude support or every browser.

- `voice_poc/presentation.py`: room API, delivery and audio lifecycle.
- `voice_poc/presentation.html`: room UI.
- `voice_poc/browser_audio/`: browser synthesis and model catalog.
- `voice_poc/desktop_gateway.mjs`: current Codex Desktop bridge.
- `skills/voice-presentation/`: Codex skill template.
- `experiments/claude_channel/`: paused Claude Channels draft, not integrated.
- `docs/development-history/`: historical notes, including superseded designs.
  This README is authoritative for current setup.

## Next steps

- Extract shared gateway infrastructure and finish the Claude adapter.
- Validate real refinement sessions, reconnection and noisy microphones.
- Simplify setup and validate Windows/mobile clients.
- Package remote deployment with HTTPS and WebRTC networking.
- Add TTS/STT engines and permanent room-history deletion.

## Data and license

Runtime data lives in `.voice-poc/`, including transcript text, preferences,
delivery state and gateway records. Environment files, runtime data, downloaded
dependencies and generated bundles are ignored by Git. Closing a channel does
not erase stored records.

Sidevoice's own code is MIT licensed. Dependencies and model weights retain their
own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md). No model weights
or generated browser bundles are included in this repository.
