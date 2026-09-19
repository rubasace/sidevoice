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

Compare the first reply per turn separately from progress/final follow-ups.
Include interrupted/failed rows when reporting failures, but do not treat missing
playback measurements as fast successful calls. Avoid adding overlapping intervals.

## Deployment

Restart the server and reload the browser to activate both halves. Do this between
calls, not during a driving test. No live server restart is part of this change.
