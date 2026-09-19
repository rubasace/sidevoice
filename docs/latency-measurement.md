# Call latency measurement

This is passive instrumentation, not a latency optimization. It does not change
silence detection, grace periods, routing, microphone state, playback or providers.
ElevenLabs audio is still fully buffered before delivery.

## Using it

After deploying the instrumented server and reloading the room, open the call's
**⋮ → Connection statistics** dialog. It refreshes every two seconds only while
open, times out after five seconds, and cancels outstanding requests on close.
The dialog filters replies to the selected conversation and the browser's current
session; a late response from a closed dialog or previous call cannot replace it.

Make 10 short spoken turns. The cards show the median first reply per input turn,
median complete provider request, and median browser playback preparation.
The table shows the last 12 responses, including follow-ups and failures, without
summing overlapping intervals. Missing observations appear as a dash. Older
servers without this endpoint show an explicit upgrade/restart message.

**Agregados de la sesión** summarizes the same snapshot: count, mean, p50, p90 and
maximum per stage, over every reply the call has measured, not only the selected
conversation. When the call talked to more than one conversation there is a table
per conversation as well, because the agent side dominates and differs per harness.
Percentiles are nearest-rank, so every number shown is a measurement that happened;
a stage nobody measured keeps its row with dashes. The stages still overlap and must
not be added. "Copiar como texto" puts the same tables on the clipboard as plain
text, ready to paste into an issue. All of it is computed in the browser from the
snapshot already polled: the server aggregates nothing and stores nothing extra.

Connection details include local WebSocket/audio/microphone state, reported AEC,
capture sample rate, received mic frame/byte counters, output selection, wake lock,
the latest/largest observed microphone packet gap, gaps over 250 ms, and an
HTTP request duration (not a WebSocket ping or physical audio delay). Packet
gaps are measured when the server deserializes the expected 20 ms PCM frames;
they can reveal browser/network/event-loop stalls, but do not prove which layer
caused one.
These are snapshots, not proof of audibility or successful hardware cancellation.

For the raw report, read GET /api/presentation/latency while that call still exists.
The report contains up to 128 replies, identified by session, thread, original
reply revision and utterance ID. A remapped playback revision must never link
a late response to the wrong input turn.

Only IDs, statuses and durations are retained in memory. There is no additional
audio, transcript, credential or on-disk telemetry storage. A new call replaces
the report; export it before reconnecting. Like the room's existing history API,
this endpoint has no authentication: do not expose the prototype to untrusted users.

## What is measured

- Server: input queued to delivery accepted, input queued to reply received,
  delivery accepted to reply received, reply received to synthesis start,
  synthesis start to complete audio, and audio dispatch to playing receipt.
- ElevenLabs: HTTP request to headers, first nonempty body chunk and complete
  body. The provider interval includes connection setup and network time;
  it is not pure model inference. First chunk does not imply playable audio.
- Browser: audio event received to Web Audio playback scheduled, original turn
  finished event received to playback scheduled, and last VAD-stop event
  received to turn-finished event received.

Durations use monotonic clocks within their own process. Server and browser
timestamps are never subtracted. Missing observations are omitted, not zero.
Browser-reported values are allowlisted, finite and bounded to one hour.

The browser's VAD-stop and turn-finished markers are received server events,
not raw microphone timestamps; their difference includes endpointing and final
transcription/event timing, and is not isolated STT latency. Delivery acceptance
is not proof the model started processing. Queue time versus model generation
still requires host-side instrumentation. The playing callback records scheduling,
not a physical speaker measurement; Bluetooth latency needs external measurement.
Server dispatch-to-receipt includes delivery, browser preparation and the return
request, so do not add it to browser preparation as if they were disjoint.

Compare the first reply per turn separately from any follow-up utterances.
Include interrupted/failed rows when reporting failures, but do not treat missing
playback measurements as fast successful calls. Avoid adding overlapping intervals.

## OpenTelemetry

The same measurements, said in a standard so they can leave this room: one trace per turn,
one histogram per stage, exported over OTLP to whatever collector is configured. The stage
names are the same in all three places — the span, the histogram and the row of the stats
dialog — because they come from one list, `TURN_STAGES` in `@sidevoice/protocol`. Renaming
a stage means renaming it there; the room repeats the list in `sidevoice/telemetry.py` and
a test fails if the two ever disagree.

### Turning it on, and what off costs

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to an OTLP/HTTP collector's base URL (no `/v1/...` path)
and restart the room; `OTEL_SERVICE_NAME` names the room in the collector. With the endpoint
unset nothing starts: no provider, no exporter, no batch, and `GET /api/telemetry` answers
`{"enabled": false}` so the page never downloads the OpenTelemetry SDK. That is deliberate —
**no endpoint configured costs nothing and fails nothing**, and it is the default.

The page exports to the room (`POST /api/telemetry`) and to nothing else, so the browser
still talks only to the room; the room forwards the batch to the collector without reading
it, and answers `204` whether it forwarded or dropped. A collector that is down or refusing
is logged once per batch and changes nothing about the call.

### What a trace looks like

```
voice.call                              (browser · one per socket)
├─ voice.turn        revision 7         (browser · opened when the room announces the turn)
│  ├─ endpoint_silence                  (room)
│  ├─ recognition                       (room)
│  ├─ request_to_transcript             (browser Whisper, placed on the room's clock)
│  ├─ transcript_to_delivery            (room)
│  ├─ delivery_to_read                  (room)
│  ├─ read_to_reply                     (room)
│  ├─ input_queued_to_reply             (room · overlaps its neighbours; do not add them)
│  ├─ reply_to_synthesis                (room)
│  ├─ provider_synthesis                (room · only for the listener that paid for the render)
│  └─ audio_received_to_playback        (browser)
└─ events: voice.audio.stall, voice.audio.cancel, voice.audio.fail, …
```

Every stage is a direct child of the turn, not of the stage before it: they overlap by design
(`input_queued_to_reply` contains `delivery_to_read` and `read_to_reply`, and
`request_to_transcript` happens inside `recognition`), and nesting them would suggest they add up.

The browser opens the root span when the room announces the turn and hands the room its W3C
`traceparent` over the socket (`voice-turn-trace`); the hello carries the call span's. A turn
so short that the room finishes it before the frame arrives, or a page not tracing at all,
still produces every stage — as a trace of its own rather than not at all.

Stages placed by a duration rather than by two marks (`request_to_transcript`,
`provider_synthesis`) end on a mark the room owns and start a duration earlier. The duration
is the measurement; the placement only puts it on the clock. Server and browser clocks are
still never subtracted.

### Metrics

One histogram per stage, `sidevoice.turn.<stage>` in milliseconds, plus
`sidevoice.audio.stalls`, `sidevoice.turn.cancels`, `sidevoice.input.receipts` (by status)
and `sidevoice.input.redeliveries`. Every stage is recorded exactly once, by the room — the
browser-measured ones too, when their receipt arrives — so a stage is never counted twice by
two halves of the same turn.

### Privacy

Not configurable. A span, an attribute or an event of this room carries ids, revisions,
timings, states and engine names, and nothing else: no transcript, no reply text, no audio,
no credential. Both halves keep an allowlist (`TELEMETRY_ATTRIBUTES`), drop anything not in
it whatever a caller passes, and bound every value. `apps/server/tests/test_telemetry.py`
drives a whole turn through the room with the spoken text in it and asserts that none of it
reaches an exporter, and that the vocabulary itself names nothing content-shaped;
`apps/web/src/services/telemetry.test.ts` does the same for the page.

The room still stores nothing new: telemetry is emitted as it happens and forwarded, never
journalled, and the stats dialog keeps reading the same `/api/presentation/latency`
snapshot it always did.

### Cost

The room's dependencies are `opentelemetry-sdk`, `opentelemetry-exporter-otlp-proto-http`
and `opentelemetry-instrumentation-fastapi`, pinned in `apps/server/requirements.txt`.

The page's SDK weighs about 19 kB gzipped and sits in its own chunk (`telemetry-otel`),
fetched only when the room reports a collector; what a room without one pays is the ~1 kB
facade that asks. Should that ever be too much, the smaller alternative is to drop the SDK
and post OTLP/JSON by hand — the wire format is a few hundred lines of it — at the cost of
owning span ids, context propagation and batching ourselves.

### What is not here yet

The connector and the harness: `voice_say` coming back into the same trace, and the
agent-side span between delivery and reply, are the next stage. Until then a trace ends at
the room's delivery to the harness and resumes at the reply it publishes.

## Deployment

Restart the server and reload the browser to activate both halves. Do this between
calls, not during a driving test. No live server restart is part of this change.
