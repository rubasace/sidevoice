# Sidevoice

**Give your coding agent a voice. Keep the conversation.**

A voice room for your coding agents. Talk, interrupt, and keep working in the same
conversation, with local speech synthesis in your browser.

Your working agent keeps its context and tools, writes its normal response, and
publishes a conversational version to the room. There is no separate voice operator.

> Early prototype. Delivery into Claude Code is verified end to end on Linux;
> delivery into Codex goes through `codex queue` and is being verified against
> Codex Desktop. Nothing here is a stable release yet.

## What works

- Browser microphone over a plain WebSocket with OpenAI speech-to-text.
- Several browsers and devices in the same room at once, sharing one conversation
  and one history, each with its own microphone, playback and interruptions.
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

- The room server runs on Linux or macOS. Agents connect from wherever they run
  (see `docs/INSTALL.md`); the agent's machine needs Node.js 22+.
- Python 3.12 and Node.js 22+ with npm.
- A compatible browser. Windows and mobile are not validated end to end.
- Optionally an OpenAI API key for cloud transcription, which you can paste into
  the room's settings; without one the room transcribes locally on CPU.


## Run the room

```sh
git clone https://github.com/rubasace/sidevoice.git
cd sidevoice
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci
npm run build
cp .env.example .env.voice
```

Optionally set `VOICE_STT_API_KEY` in `.env.voice` — the room's transcription
settings can hold the key instead. Then run:

```sh
./start.sh
```

Open **http://127.0.0.1:8767/voice/**. The room can stay open without an agent
selected. The browser downloads model assets on first use, prepares them and
caches them locally. Initial preparation is slower than subsequent use.

Transcription is configurable from the room: pick the engine (local Whisper on
CPU, or OpenAI) and its model, and store the OpenAI key there. With no key the
room transcribes locally. The key is kept by the room, never by the browser,
and the room itself has no access control yet — do not expose it publicly with
a key installed.

## Connect a conversation

The agent's harness gets one MCP server (`sidevoice mcp`) and the
`voice-presentation` skill; the machine it runs on is paired once with the room
using a code from the room UI ("Emparejar conector"). `docs/INSTALL.md` is
written so that you can hand it to the agent itself and say "install this".

Once installed, ask the agent to connect the conversation to the voice room. It
calls `voice_connect`; the conversation appears in the room; what you say
arrives in that conversation as a user message marked as voice; the agent
answers in writing and speaks through `voice_say`.

On Claude Code, one setting decides whether your voice reaches a conversation at
all: a session that bypasses permission prompts has incoming messages **held for
your approval** rather than delivered, and nothing tells the sender, so voice
looks sent and never arrives. `voice_connect` detects it and says so; the fix is
`crossSessionInbound` and the trade-off it carries is spelled out in
`docs/INSTALL.md`.

The room service uses port 8767 by default. Several browsers may be in the room
at the same time, on the same conversation and the same history; muting, stopping
the audio or closing one of them affects only that browser, and a reply ElevenLabs
renders is paid for once and shared with everyone listening. See
[the multi-client room](docs/MULTI_CLIENT_ROOM.md).

## Architecture

```text
Browser mic -> STT -> durable outbox (room) -> WebSocket -> connector (one per host)
                                                  -> Claude Code: the session's own inbox socket
                                                  -> Codex: `codex queue --thread <id>`

Existing conversation -> normal written answer in its harness
                      -> voice_say (MCP) -> connector -> room -> browser Kokoro
```

The room owns participants, history, delivery, playback and cancellation. The
agent owns its work and its spoken version. The connector owns one outbound
connection per machine and the last mile into each harness; the stdio MCP
server the harness starts is a thin façade over it and knows which conversation
it speaks for because the harness told it, not the model.

See [architecture and limitations](docs/ARCHITECTURE.md).

## Development

With dependencies installed:

```sh
PYTHONPATH=apps/server .venv/bin/python -m unittest discover -s apps/server/tests -p 'test_*.py'
npm test
```

Tests cover routing, stale replies, playback, interruptions, persistence, closure,
draft cancellation and several browsers in one room. They do not prove live Claude
support, real multi-device use or every browser.

- `apps/server/`: Python room API, persistence, delivery and orchestration.
- `apps/web/`: React/TypeScript room UI and its session controller.
- `packages/browser-audio/`: browser-only STT/TTS, worklets and model catalog.
- `packages/connector/`: published client — MCP façade, uplink and harness adapters.
- `packages/protocol/`: shared TypeScript contracts and JSON schemas.

- `skills/voice-presentation/`: the agent-facing skill, harness-independent.
- `docs/INSTALL.md`: install guide written for the agent.
- `experiments/claude_channel/`: earlier Channels draft, superseded by the
  session socket; kept as the fallback reference.
- `docs/development-history/`: historical notes, including superseded designs.
  This README is authoritative for current setup.

## Next steps

- Verify `codex queue` against Codex Desktop threads; publish the connector to npm.
- Validate real refinement sessions, reconnection and noisy microphones.
- Simplify setup and validate Windows/mobile clients.
- Package remote deployment behind an HTTPS reverse proxy.
- Add TTS/STT engines and permanent room-history deletion.

## Data and license

Runtime data lives in `.voice-poc/`, including transcript text, preferences,
delivery state and gateway records. Environment files, runtime data, downloaded
dependencies and generated bundles are ignored by Git. Closing a channel does
not erase stored records.

Sidevoice's own code is MIT licensed. Dependencies and model weights retain their
own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md). No model weights
or generated browser bundles are included in this repository.
