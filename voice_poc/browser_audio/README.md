# Browser Kokoro audio

Build with `npm ci && npm run build` in this directory. The Pipecat app serves
`dist/` at `/voice-browser/`. The main `/voice/` room uses `room-client.js` for
local synthesis and WebAudio playout; `/voice-browser/` remains a diagnostic page. Requires HTTPS or localhost for WebGPU.

Actual synthesis and phonemization run in a browser Worker. Models are fetched
from a fixed Hugging Face revision and cached by Transformers.js. Voice embeddings
use Cache API. eSpeak-NG 1.0.2 is bundled with its full language data, unlike the
English-only phonemizer distribution used by kokoro-js. Spanish phoneme mappings
follow Misaki's EspeakG2P conventions; human pronunciation evaluation remains due.

Validated in the Codex embedded browser on this Mac:
- WebGPU Spanish Dora: 4.325 s audio / 1.018 s inference+phonemization (warm model).
- WebGPU English Heart: 4.425 s audio / .998 s inference+phonemization.
- WASM Spanish Dora: 4.325 s audio / 9.503 s inference+phonemization, one thread.
These are individual smoke measurements, not a general benchmark. Cold download
and initialization take longer. Native Kokoro remains the conversation default.

Cancel stops Web Audio immediately, increments the request generation and discards
later outputs. A running model operation can finish computing; it is not replayed.
The model queue is serial. CPU fallback currently covers GPU initialization failure;
runtime/device-loss recovery remains to be tested before integrating into calls.

This is a standalone synthesis test, not the production voice-room integration.
Future integration needs local VAD, delivery receipts, cleanup/disposal on room
switches, and tests for reconnect/late output. Microphone and STT are absent here.

Dependencies retain their licenses: Transformers.js/ONNX Runtime (Apache/MIT as
shipped upstream), Kokoro model (Apache-2.0), eSpeak-NG JS/WASM (GPL-3.0-or-later).
No code was copied from tts.rocks. Its engine selection and cache design were
reviewed as references: https://github.com/steveseguin/tts-web.

## Room integration

`catalog.json` declares the available model, six languages and voice IDs. Python
validates preferences against this same catalog; the engine bundles it. Japanese
and Mandarin are listed as unavailable until their G2P implementations exist.
Preferences contain defaults plus `language_overrides`; a default voice from another
language falls back to the first compatible voice. Explicit language overrides win.
The settings reset button resets language overrides, leaving speed and defaults alone.

A room negotiates `tts_execution: browser` on join. The server dispatches `voice-speech`
(text, voice, speed, device, task/session/revision/utterance) over the WebRTC data channel,
without invoking server TTS. The browser acknowledges playing and playback_finished
only after the last AudioBufferSource ends. This confirms browser playout, not human
comprehension. The next utterance waits for this receipt. Generation errors mark failed.
Server VAD starts and binding changes send cancellation; the client stops all scheduled
sources, cancels the worker epoch, and ignores late results. VAD still runs in the
server, so onset latency includes microphone transport; client-side VAD is future work.

Model weights download automatically from the pinned Hugging Face revision into browser
cache; preparing loads the model into memory and initializes the GPU/CPU. Clearing
site data, eviction, another browser/origin, or a changed model can require download again.
GPU and CPU use different weight variants. Native server synthesis remains selectable.
STT still uses the existing backend OpenAI API; no key moves into the browser.

Per-language `speed` is nullable: null inherits global `tts_speed`. The row preview
uses unsaved voice/speed selections; actual speech uses saved resolved settings.
Resetting language overrides resets speed inheritance too, without changing global speed.

2026-09-13 UI update: the main room now always uses browser synthesis; the server
choice and native preview route were removed. UI language (Spanish/English) is
independent of speech language. Joining or previewing automatically opens a progress
dialog for model loading, voice assets and first synthesis. Explicit preload is optional.
User text and task titles are excluded from UI translation.
