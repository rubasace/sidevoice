# Architecture and boundaries

The active product is `/voice/`, a presentation channel attached to an existing
task. Earlier `/terra/` operator and demo code remains in this first snapshot
as legacy code and is not the recommended entry point.

## Transport and identity

`desktop_gateway.mjs` connects to Codex Desktop's local app tool socket and calls
`send_message_to_thread` for the chosen task. It does not edit transcript files
or simulate terminal typing. The agent publishes through `voice_channel.py`.

Each task has a gateway record. The room has one selected binding and one call.
Session/revision metadata associates replies with input. Changing audio focus
never changes the captured recipient of an already-submitted message.

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

The Claude draft uses MCP Channels to reach the same working session. It is paused,
not verified with a live model and not integrated into harness-aware routing.

## Known limitations

- One local call, with Codex Desktop on macOS as the verified harness.
- App-specific socket/runtime paths may change across app versions.
- No general multi-user/server authentication or production exposure. The
  launcher binds to loopback.
- WebGPU initialization fallback exists; full device-loss recovery needs work.
- Responses may wait while the working agent is busy. There is no independent
  instant-response interlocutor.
- Legacy MLX/native voice dependencies remain in the Python package.

## Dependency audit at first publication

The browser dependency audit reports two high-severity entries: sharp and its
parent, @huggingface/transformers. The advisories concern native image-decoding
libraries pulled into the Node dependency tree; npm reports no automatic fix
for the pinned set. The audio browser build succeeds, but a dependency update
and reachability review remain open. No claim of a clean security audit is made.
