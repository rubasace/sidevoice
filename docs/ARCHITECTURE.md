# Architecture and boundaries

The active product is `/voice/`, a presentation channel attached to an existing
task.

## Repository shape

Sidevoice is one repository with independently bounded packages, not one deployment artifact. `apps/server` is the Python room service; `apps/web` is the React/TypeScript browser application; `packages/browser-audio` owns the browser-only STT/TTS runtime; `packages/connector` is the separately published Node client; and `packages/protocol` contains shared wire contracts. The root npm workspace builds and tests the JavaScript/TypeScript packages together, while Python keeps its own package and dependency boundary.

The web app is componentized by product concern (room, conversation, call, settings and diagnostics). A per-application Zustand store owns serializable view state, while one runtime instance owns long-lived microphone, playback, WebSocket and AudioContext resources so React Strict Mode cannot duplicate them. The transitional bridge and remaining migration seams are documented in [FRONTEND.md](FRONTEND.md).


## Transport and identity

The room is the control plane. Each agent machine runs one connector with an
outbound WebSocket to `/api/connectors/ws`, authenticated with a credential it
obtained once by redeeming a pairing code shown in the room UI. The stdio MCP
server that a harness starts (`packages/connector/mcp.mjs`) is a thin façade over that
connector: it registers one binding per conversation, identified by what the
harness itself put in the façade's environment or tool-call metadata — never by
anything the model says.

Input the user speaks is a row in the room's journal until a harness adapter
accepts it. The room delivers one event at a time per binding, over the
connector, and only advances on an exact acknowledgement; failures back off and
retry, and a delivery in flight when either side dies is retried, so the
harness may see a message twice and dedups by its `message_id`. Speech comes
back over the same connection and is published like any other utterance. A
harness hook (`sidevoice hook`, on the prompt-admitted event) reports through the
connector that the conversation read a message, which the room shows as the
second tick and measures; the same hook hands the model a line asking it to
acknowledge by voice before other tools.

The last mile is the harness's own session inbox: Claude Code's per-session
messaging socket (inherited by the façade), or `codex queue` on Codex. Both are
private interfaces of those products, versioned by them, and are treated as
replaceable adapters.

## Room and clients

The room is shared and the browsers in it are not. The journal, the assistant's
utterances and any audio a paid engine rendered belong to the room; a WebSocket
identity, **the selected conversation**, the turn epoch, a microphone turn, a
transcription runtime, a playback queue, karaoke, an output device and a latency
trace belong to one browser. Every tab chooses which conversation it talks to
(kept per tab, sent again in its hello after a reload) and the room only routes:
a turn advances that tab's epoch and interrupts that tab's audio, a reply reaches
the tabs that are on its conversation, and a conversation joining the room selects
itself for nobody. Two tabs on two conversations is a supported state; the noise it
makes on one speaker is the user's choice. The split, its invariants and its
lifecycle are in [the multi-client room](MULTI_CLIENT_ROOM.md).

## Transcription

Every browser streams its microphone as 16 kHz PCM over the room's WebSocket, and
the room runs one Pipecat pipeline per browser: Silero as the voice detector and
a user-turn strategy that says when the turn is over. Settings are the device's:
the browser stores them, sends them in its first message and can update the ones
that need no pipeline (voices, speed, grace) over the same socket; the room
validates them, uses them for that call and keeps no copy. The strategy is one
of them: smart-turn v3 (bundled with Pipecat, decides from the audio whether the
sentence is finished, asked only after a minimum silence, with a maximum silence
as a safety net) or a fixed silence timer. Two browsers in the same room may use
different settings.

The rest of them — who transcribes, in which language and with what context, and
how this device's turns are detected — are the shape of that pipeline, and the
room builds one per socket. Changing them does not hang up: the browser prepares
whatever has to load (a local Whisper model, its GPU→CPU fallback) while the call
goes on, opens a second socket with the new hello, and lets the first go only once
the room has answered the second. The microphone stream, the unlocked output and
the tab's chosen conversation cross unchanged; a refusal leaves the call exactly
as it was and says why. For as long as the swap takes, one device counts as two
browsers against `Room.MAX_CLIENTS`.

A socket that drops does not end the call, and no longer loses what was said while
it was down. The microphone is never paused, so the page keeps the last 30 seconds
it could not stream and hands them to the session that comes back as one catch-up:
base64 in text frames, never as the binary frames the detector reads, so audio
spoken to a session that no longer exists cannot open a turn in the one that
replaced it. The room recognises it on its own, through the same gate and filters,
and writes one journal row marked as captured offline with the browser's own clock.
A gap that held no voice produces nothing; one that overflowed the buffer says so in
the message rather than shortening it in silence. Nothing of that audio is stored.

Transcribing the finished turn is a provider behind that pipeline, and the
pipeline does not know which one it has: OpenAI is called from the room with the
stored key; the browser provider sends the turn's WAV back to the browser that
spoke it, which recognises it locally with Whisper and answers with the text. The
fragments of one turn are transcribed once, together, and the speech gate and the
text filters apply to both providers.

A provider's key is stored by the room in `.voice-poc/stt-credentials.json` (mode
0600), never returned to the browser and never written to the transcript; only its
last four characters are shown so a person can tell which key is installed.
`VOICE_STT_API_KEY` still works as a source. Choosing a provider whose key is
missing is refused before any audio is accepted.

## Synthesis

Kokoro runs inside each browser and costs nothing per listener. ElevenLabs is
billed per character, so the room renders one utterance once — keyed by provider,
model, voice, speed and text — keeps the result in a bounded LRU and hands every
client the same MP3 and the same character alignment, so karaoke matches without
a second request. The measurement is not shared: a listener handed an existing
render records no provider duration, because it never made that request.

## Persistence and playback

The journal (transcripts, outbox, spoken-reply states) lives in memory and dies with
the process: the room writes nothing anyone said to disk. One small file,
`room-state.json`, keeps what would otherwise be redone by hand after a redeploy:
connector credentials. Bindings are not kept; every connector re-registers its own on
reconnect. Input delivery can outlive a
call while the room runs. Acceptance by the harness is not a read acknowledgement. Uncertain attempted
deliveries are not automatically retried.

Playback completion comes from the browser, not synthesis completion or a timer.
Replies can wait for the user to finish and the configured grace period to pass.
Audio already interrupted by the user is not automatically replayed.

A browser that comes back — after a reconnection, or entering a conversation again — is played the
replies of that conversation it never heard through, oldest first and ahead of anything new, for as
far back as that device asked for (two minutes by default, off and longer available). The room does
not guess who heard what: every utterance records what each browser did with it, and since
reconnecting mints a new client id, the page names the ids it has used. A reply that ran to the end,
or that the listener stopped on purpose, is never repeated; a new turn cancels the catch-up, and one
cancelled before it sounded stays unheard rather than claiming it was played. A paid render the room
no longer has is not bought again and not invented: the bubble says it could not be repeated. Nothing
is stored for any of this — the replies were already the room's, and no journal row is added.

Closing a conversation's voice from the room removes its binding: the connector is
told and forgets it, input still waiting for it is marked not sent, and the agent's
next `voice_say` fails with the reason. The room remembers nothing; joining again is
the agent's explicit `voice_connect` on the user's request. Cancelling microphone input applies
only to the still-active turn, before outbox insertion.

## Observability

Every measurement the room takes has one owner and two readings. `CallLatency` owns the
marks of one browser's turns, in memory and bounded, and the connection-statistics dialog
reads them from `/api/presentation/latency` exactly as it always did. `telemetry.py` reads
the same marks and says them in OpenTelemetry: one trace per turn, rooted in the browser's
own span and continued by the room through the `traceparent` the page sends over the socket,
and one histogram per stage. The stage names are a wire contract (`TURN_STAGES` in
`packages/protocol`), so a span, a histogram and a row of the dialog are the same thing.

Nothing of it is on unless a collector is named: with `OTEL_EXPORTER_OTLP_ENDPOINT` unset
the room starts no provider and the page never downloads the SDK. The browser exports to the
room and to nothing else — the room forwards the batch unread — so the browser's rule that it
talks only to the room survives. A span carries ids, timings, states and engine names, and no
transcript, reply or credential can reach one: both halves keep an allowlist and a test that
drives real text through and asserts it never appears. The room persists nothing new.
See [latency measurement](latency-measurement.md).

## Adapter boundary

- Common: registry, persistence, delivery policy, duplicate handling and audio.
- Adapter: connect, identify the session, deliver input and normalize results.
- Agent-to-room: the same speech publication API regardless of harness.

This boundary has not been fully extracted from the prototype. It is not yet
a finished plug-and-play adapter SDK.

The earlier Claude draft used MCP Channels; the session socket made it
unnecessary and it is kept only as the fallback reference.

## Known limitations

- One room, bounded to `Room.MAX_CLIENTS` browsers at a time; a browser over the
  limit is refused with a stated reason and disturbs nothing already connected.
  Claude Code delivery is verified end to end; Codex delivery through
  `codex queue` is verified for the CLI path only until checked against Codex
  Desktop.
- Several browsers at once are covered by tests, not by field use: real
  multi-device behaviour, and a shared render against a live ElevenLabs account,
  remain unproven.
- The last-mile interfaces are private to each harness and may change across
  versions; the connector pins the ranges it was verified against.
- Connector credentials are per machine. The browser side of the room still
  binds to loopback; its link is a plain WebSocket, so remote exposure needs only
  a TLS reverse proxy, which is separate work.
- WebGPU initialization fallback exists; full device-loss recovery needs work.
- Responses may wait while the working agent is busy. There is no independent
  instant-response interlocutor.

## Dependency audit at first publication

The browser dependency audit reports two high-severity entries: sharp and its
parent, @huggingface/transformers. The advisories concern native image-decoding
libraries pulled into the Node dependency tree; npm reports no automatic fix
for the pinned set. The audio browser build succeeds, but a dependency update
and reachability review remain open. No claim of a clean security audit is made.
