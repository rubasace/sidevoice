# A room with more than one browser in it

The room used to be one browser. `PresentationHub` held a single
`PresentationCall`, and that object was at once the conversation the room was
pointed at, the shared transcript of what the agent said, and one person's
microphone, playback queue and mute button. Because it was a singleton, a second
browser could only take the room away from the first: `attach` disconnected the
previous call and closed its socket with `4001 · La sala se abrió en otro
dispositivo`. That was a stopgap, not the intended behaviour.

This document describes what replaced it: a **room** (`sidevoice/room.py`) that
owns the conversation, and many **clients** that each own one browser. It is the
reference for the split; the code follows it, not the other way round.

## What belongs to whom

The dividing question is: *if a second browser joined, would this have to be the
same?* If yes it is room state; if no it is client state. Nothing is both.

| Room (`room.Room`) | Client (`room.RoomClient`) |
| --- | --- |
| selected connector conversation (`target`, mirrored in `.voice-poc/presentation.json`) | WebSocket identity (`id`, minted per socket) |
| durable journal: transcript, outbox, delivery state | microphone stream, mute, level meter, input gap stats |
| assistant utterances: text, language, epoch | input turn (`turn_revision`, `turn_target`, cancellation) |
| the room revision (`revision`) | the STT runtime it resolved to, local or cloud |
| audio a paid engine rendered (`synthesis_cache.SynthesisCache`) | playback queue (`pending`, `active`), quiet grace, dispatch timer |
| which conversations are closed | local interruption, karaoke, output device |
| `switching` while the focus moves | its own latency trace (`CallLatency`) |

Two consequences worth stating on their own:

- **The room outlives every client.** No browser owns the room. The last one
  leaving does not close the conversation, empty the journal or reset the
  revision; the next one to arrive joins what is already there.
- **A client never reaches into another client.** Everything a browser reports
  — a receipt, a cancellation, a failure, a measurement — is written under its
  own id inside the shared utterance, never onto the utterance itself.

## The two clocks

There are two revisions, and confusing them is the whole bug class this design
exists to prevent.

`room.revision` is the **room epoch**. It increases by one every time *any*
participant starts an input turn, whether by microphone or by typing. It is the
number the agent is handed with the input, the number it must quote in
`voice_say`, and the number every audio decision is checked against. An utterance
whose revision is not the room's is stale everywhere at once.

`client.turn_revision` is **that browser's current input turn** — the room epoch
the turn was allocated. It is what `/api/presentation/cancel-input` checks and
what a delivery receipt is matched against. It is never compared across clients.

So: *starting to speak* is room-wide, because it makes the agent's previous
answer stale for everybody. *Stopping the audio* is local, because it only says
what one listener wants to hear. The first bumps `room.revision` and invalidates
every client's queue; the second writes one entry in one utterance.

## Utterance lifecycle

One `voice_say` publishes one `Utterance`, held once by the room, and one row in
the journal. Every eligible client gets its own playback entry inside it.

```
publish ──▶ Utterance(text, language, revision, row_id)
             ├─ clients[A] = queued  ──▶ synthesizing ──▶ playing ──▶ playback_finished
             ├─ clients[B] = queued  ──▶ synthesizing ──▶ interrupted   (B pressed stop)
             └─ clients[C] = queued  ──▶ waiting_for_turn                (C is speaking)
```

The journal row carries the **furthest state any client reached**, by a fixed
rank: `disconnected < failed < interrupted < queued < waiting_* < synthesizing <
playing < playback_finished`. B stopping its own playback cannot pull the shared
row back from `playing`, and cannot remove the message: the text was saved before
any audio was attempted and is never deleted by a playback event. A client's own
entry is monotone into a terminal state (`interrupted`, `failed`, `disconnected`,
`playback_finished`); a late event for a settled entry is ignored, not applied.

An utterance is dispatched to every client at once and independently, so a
browser that is mid-sentence, muted or slow delays only itself — and a failure in
one is recorded against that client, never raised at the agent that published the
reply.

## Client lifecycle

```
socket accepted (origin checked)
  └─ Room.join(client)        refused over MAX_CLIENTS; nothing else is torn down
       ├─ the room announces the client's own id as the first text frame
       ├─ the client runs its own transcription: in-page WebGPU/WASM Whisper, or
       │  its own pipecat pipeline when this connection resolved to OpenAI
       └─ it receives voice-speech / voice-speech-audio / voice-cancel /
          voice-input-receipt, each addressed to its own session id
socket closed
  └─ Room.leave(client)
       ├─ the client's entries in live utterances become `disconnected`
       ├─ its pending queue, dispatch timer and open turns are dropped
       └─ the room, its target, its revision and every other client are untouched
```

Reconnecting is joining again with a new id. Nothing is replayed: audio the
previous session did not finish is not resurrected, which is the pre-existing
rule and still holds per client. Two browsers may resolve to different
transcription engines — one local, one cloud — at the same time; the transport is
chosen per connection and the room does not care which one produced the words.

## Input: independent, once each, ordered

Every participant speaks or types on their own. Each input becomes one journal row
whose id is `<client id>:user-turn:<room revision>` (or `:user-text:<message id>`
for typed messages). Client ids are unique per socket and room revisions are
allocated one at a time by the room, so two participants can never collide, and
`RoomHistory.put` is idempotent on that id, so a retry cannot duplicate.

Delivery to the agent is unchanged: the connector control plane drains the journal
in `seq` order, one delivery in flight per binding, advancing only on an exact
acknowledgement. **Ordering when turns overlap** is therefore the order turns
*completed*, which is total and stable, while the room revision orders turns
*started* and governs audio epochs. Two participants who start together get
distinct revisions; whoever finishes first is delivered first.

A receipt for a row is routed back to the client named in its payload, and only
there. Every other browser learns the same fact from the shared history poll, so
a stale receipt can never move a state that is not its own. The same holds for
latency: `/api/presentation/latency?session_id=…` answers with that browser's
trace, and a browser that is not in the room is handed an empty one.

## Speech engines

Kokoro is unchanged: each browser downloads the model once, synthesizes with
WebGPU or the WASM fallback and plays it locally. It costs nothing per listener,
so there is nothing to share.

ElevenLabs is billed per character, so paying once per listener would be a defect,
not a detail. `synthesis_cache.SynthesisCache` renders one utterance once and
hands every client the same result:

- the **render key** is a hash of `(provider, model, voice, speed, text)`, so two
  clients listening to the same utterance with the same configuration share one
  render, and a different voice or speed is correctly a different render;
- one **in-flight render per key**: concurrent dispatches await the same task
  through a shield, so a listener that disconnects mid-render does not cancel it
  for the others;
- the encoded MP3 *and its character alignment* are shared, so karaoke is
  identical on every device without a second `/with-timestamps` request;
- results are kept in a bounded LRU (`limit_items`, `limit_bytes`);
- a failed render fails that reply for the browsers waiting on it, with the
  provider's own reason, and never silently substitutes a different voice.

What is **not** shared is the measurement. `obtain` returns `(audio, fresh)`, and
a listener handed someone else's render records no provider duration at all: it
never made that request, and reporting the first listener's wait as its own would
be a number nobody measured. The event it receives carries `shared: true` and an
empty `timings_ms` for the same reason.

Decoding, playout, the interrupt button, karaoke highlighting and output-device
selection stay in the browser either way. The room ships bytes and offsets; it
never ships playback state.

## Bounds

| Limit | Where | Why |
| --- | --- | --- |
| `Room.MAX_CLIENTS` (8) | `Room.join`, checked again before the socket is accepted | an unbounded room is an unbounded fan-out of every utterance |
| 16 pending utterances per client | `Room.speak` | a stalled browser must not queue the room's audio forever |
| 2048 live utterances | `Room.speak` | the in-memory registry; the journal keeps the text regardless |
| 32 queued inputs per client | `RoomClient.input_queue` | only used when no journal is attached |
| 64 remembered session ids | `Room.sessions` | a reply naming an older session is rejected, not searched for |
| `SynthesisCache` items and bytes | `synthesis_cache` | paid audio is cached, not accumulated |
| 128 latency traces per client | `CallLatency` | pre-existing, and now per browser rather than per room |
| 6000 characters per utterance | `Speech` | pre-existing |

Origin validation is unchanged: browser endpoints require the `Origin` host to be
the room's own (or `VOICE_PUBLIC_ORIGIN`), the credential endpoints additionally
refuse a request with no `Origin` at all, and the WebSocket is checked before
`accept`. A browser over the limit is told why and closed with `1013`, which
disturbs nothing already in the room.
