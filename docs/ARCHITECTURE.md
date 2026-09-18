# Architecture and boundaries

The active product is `/voice/`, a presentation channel attached to an existing
task.

## Repository shape

Sidevoice is one repository with independently bounded packages, not one deployment artifact. `apps/server` is the Python room service; `apps/web` is the React/TypeScript browser application; `packages/browser-audio` owns the browser-only STT/TTS runtime; `packages/connector` is the separately published Node client; and `packages/protocol` contains shared wire contracts. The root npm workspace builds and tests the JavaScript/TypeScript packages together, while Python keeps its own package and dependency boundary.

The web app is componentized by product concern (room, conversation, call, settings and diagnostics). Long-lived microphone, playback, WebSocket and AudioContext state is deliberately owned by one session controller outside the React render lifecycle, so React Strict Mode cannot duplicate browser resources.


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
back over the same connection and is published like any other utterance.

The last mile is the harness's own session inbox: Claude Code's per-session
messaging socket (inherited by the façade), or `codex queue` on Codex. Both are
private interfaces of those products, versioned by them, and are treated as
replaceable adapters.

## Transcription

The engine that turns the microphone into text is chosen in the room: a local
Whisper on CPU, or a cloud provider. A provider's key is stored by the room in
`.voice-poc/stt-credentials.json` (mode 0600), never returned to the browser and
never written to the transcript; only its last four characters are shown so a
person can tell which key is installed. `VOICE_STT_API_KEY` still works as a
source. Choosing a provider whose key is missing falls back to the local engine
with a stated reason rather than failing mid-sentence, and each call reports the
engine it resolved to.

## Persistence and playback

SQLite stores the transcript and durable outbox. Input delivery can outlive a
call. Acceptance by the harness is not a read acknowledgement. Uncertain attempted
deliveries are not automatically retried.

Playback completion comes from the browser, not synthesis completion or a timer.
Replies can wait for the user to finish and the configured grace period to pass.
Audio already interrupted by the user is not automatically replayed.

Closing persists closed membership, suppresses audio and queues an instruction
to continue in writing. The task keeps working. Closed channels disappear from
the UI; history remains stored internally. Cancelling microphone input applies
only to the still-active turn, before outbox insertion.

## Adapter boundary

- Common: registry, persistence, delivery policy, duplicate handling and audio.
- Adapter: connect, identify the session, deliver input and normalize results.
- Agent-to-room: the same speech publication API regardless of harness.

This boundary has not been fully extracted from the prototype. It is not yet
a finished plug-and-play adapter SDK.

The earlier Claude draft used MCP Channels; the session socket made it
unnecessary and it is kept only as the fallback reference.

## Known limitations

- One local call. Claude Code delivery is verified end to end; Codex delivery
  through `codex queue` is verified for the CLI path only until checked against
  Codex Desktop.
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
