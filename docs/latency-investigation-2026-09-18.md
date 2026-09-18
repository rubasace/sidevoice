# Conversation latency: where the time goes (investigation, 2026-09-18)

Measured, not estimated, unless a line says so. Sources: the room journal
(`.voice-poc/room-history.sqlite3` of the worktree the room runs from), the Codex
rollout of the conversation "Sidevoice · pruebas de voz" (57 voice turns on
2026-09-17/18, gpt-5.6-sol/terra), the figures the agent itself reported from the
`/api/presentation/latency` trace on 2026-09-17, and two controlled experiments run
today with throwaway sessions (one Codex thread under Paseo, one headless Claude Code
session). All conversations in the journal ran on Codex; the Claude path was only
measured in the experiment.

## 1. The shape of one turn

End of the user's speech → first audio of the reply, agent **idle**, Codex, Kokoro:

| Stage | Where | Typical | Notes |
|---|---|---|---|
| End-of-turn silence | browser `stt-client.js` / server `SpeechTimeoutUserTurnStopStrategy` | **2.5 s** fixed | `user_speech_timeout`. Browser path uses an RMS energy threshold, no VAD model. |
| Transcription | browser Whisper (WebGPU) | 0.14–0.33 s | measured on the operator's M4 Pro (tiny/base). OpenAI path: see §3. |
| Room → connector → `codex queue` | `connector_control.pump` (250 ms tick) + `adapters.deliverCodex` | ~0.7 s | agent-reported on 2026-09-17; CLI alone 0.5 s. |
| Codex picks the queued row up | Codex app-server polling `~/.codex/queue_1.sqlite` | **0.8–9 s** (≈10 s poll) | experiment: 8.95 / 5.34 / 0.80 s. Field: 1.4–13.4 s on every idle delivery. |
| Turn start → first `voice_say` | the model | **median 9.0 s** (p25 6.8, p75 16.4, min 4.4, max 35) | time to first model output alone: median 5.7 s with 40k–213k-token contexts. |
| `voice_say` → browser | connector → room → WebSocket | < 0.5 s | |
| Synthesis | Kokoro first chunk (unmeasured) / ElevenLabs | ~1 s (estimate) / **3.7 s** | ElevenLabs is fully buffered before dispatch. |
| Quiet grace | `audio_grace_seconds` | 0–2 s | only bites if the reply lands within 2 s of the turn end. |

Sum for a trivial "yes, I hear you": **13–25 s**. The journal agrees: from the user's
row to the first spoken reply row the median is **19.8 s** (p25 11.9, p75 40.3,
n = 62), and the Sep-15 connectivity test never went below **6.0 s** even for
one-sentence replies.

Agent **busy** (working on a task): the queued message is not seen until the whole
turn ends. In the rollout that wait was 37 s to 43 min (p75 ≈ 5 min). This is the
single largest number in the data and it is a property of `codex queue`, not of the
room.

## 2. Per-turn evidence from the Codex rollout

For each of the 57 voice messages: journal-row time → Codex `UserMessage` time
(delivery), then → first model output, then → first `voice_say`.

| Metric | median | p25 | p75 | min | max |
|---|---|---|---|---|---|
| journal → Codex turn start | 20.0 s | 7.2 s | 299 s | 1.4 s | 2570 s |
| turn start → first model output | 5.7 s | 4.1 s | 9.1 s | 1.8 s | 18.6 s |
| turn start → first `voice_say` | 9.0 s | 6.8 s | 16.4 s | 4.4 s | 35.2 s |
| whole turn | 51 s | 17 s | 293 s | 0 | 1020 s |

In **30 of 57** turns the model called other tools before `voice_say`, against the
skill's "acknowledge first" rule; those turns paid up to 20 s extra before the user
heard anything.

## 3. Controlled experiments (2026-09-18)

**Codex, idle thread.** `codex queue` returned in 0.5 s; the turn started 8.95 s,
5.34 s and 0.80 s later on three runs. The CLI only inserts a row in
`~/.codex/queue_1.sqlite`; the process owning the thread polls it. Paseo's own
`send_agent_prompt` (a direct `turn/start`) started the turn **1.25 s** after the call.

**Codex, busy thread.** A message queued at +18.8 s into a long turn was processed at
+239 s, immediately after `task_complete`. Paseo's `send_agent_message` defaults to
`activeTurnBehavior: "interrupt"` and aborted the turn; its `"steer"` mode maps to the
app-server's `turn/steer` (`threadId`, `expectedTurnId`, `input`), which the binary
also exposes next to `turn/interrupt`, `thread/queue/*` and `thread/realtime/*`.

**Claude Code 2.1.270, busy session.** A message posted to the inbox socket while a
6 s Bash call ran was read at that tool boundary and acknowledged in text **2.4 s**
after posting (Sonnet 5, small context). The docs confirm the rule: read between
tool calls during an active turn, new turn when idle. On Claude the worst case is one
tool call plus one model step, not the whole turn.

## 4. Other findings

- **OpenAI STT path pays the silence twice.** `FilteredOpenAISTTService` holds the
  audio for `turn_silence_seconds` (2.5 s) after VAD stop and only then uploads, so the
  transcript arrives 2.5 s + 1–3 s after speech ends; the turn-stop strategy waits for
  it. Uploading speculatively at VAD stop (0.35 s) and discarding on resume would
  remove 1–3 s on that path.
- **Browser endpointing is a fixed 2.5 s timer on an RMS threshold.** Pipecat 1.10
  bundles smart-turn v3.2 (CPU ONNX, ~65 ms per decision) and a
  `TurnAnalyzerUserTurnStopStrategy`; a browser-side VAD model plus a 0.8–1.0 s
  floor would cut 1.5–2 s per turn and stop phantom turns from noise.
- **ElevenLabs is streamed from the provider but buffered by the room** before the
  browser gets it: 3.7 s to complete audio where first audio would be ~0.5–1 s.
- **Kokoro** already splits by sentence and plays the first chunk as soon as it is
  ready; its first-chunk time is not in the trace (`elapsedMs` exists in the worker
  but is not reported). `phonemes()` instantiates a new espeak-ng WASM module per
  punctuation-delimited part; caching one instance is a small, safe win.
- **Delivery receipts on Claude** wait 1.5 s for an acknowledgement the socket never
  sends, then report `unconfirmed`; that delays the receipt, not the model.
- **Pipecat's guidance** (docs and the smart-turn/STT benchmark work) targets
  sub-second user-to-bot latency with streaming STT, semantic end-of-turn, sentence-
  level TTS streaming and `UserBotLatencyObserver` for measurement. Sidevoice's
  pipeline is not the bottleneck today, but its endpointing and TTS buffering are the
  parts that guidance applies to.

## 5. What to change, in order of gain per unit of work

1. **Codex last mile: steer, not queue.** Adapter that reaches the app-server owning
   the thread and sends `turn/steer` when a turn is active and `turn/start` when idle,
   falling back to `thread/queue/add`. Expected: idle delivery 0.8–9 s → ~1 s; busy
   delivery minutes → one tool call. Two routes to that RPC: Paseo's API
   (`send_agent_message` with `activeTurnBehavior: "steer"`, ties Sidevoice to Paseo) or
   a direct app-server client. On this pod the thread lives inside Paseo's stdio
   app-server and only the queue store is shared; on the operator's Mac the Codex
   desktop app owns the threads through the daemon, so `turn/steer` via the daemon
   needs a check there before it is relied on. Related upstream request:
   openai/codex#37883 (explicit queue/steer controls for voice follow-ups).
2. **Instant feedback that does not depend on the model.** The room knows when the
   harness accepted the message; today it shows a receipt, and the user waits in
   silence 6–20 s for the model's own acknowledgement (which it skips half the time).
   A short earcon or a canned spoken "received" in the user's language at delivery
   acceptance, and a "turn started" event from the harness, remove the perception of
   dead air at zero model cost. Whether a canned phrase is acceptable is a product
   call.
3. **Endpointing.** Smart-turn v3 + shorter floor on the server path; VAD model +
   shorter floor in the browser path. 1.5–2 s per turn.
4. **STT and TTS streaming.** Speculative upload (or streaming STT) on the OpenAI path;
   stream ElevenLabs chunks to the browser; report Kokoro first-chunk time in the
   trace. 1–3 s per turn where each applies.
5. **Model-side.** Half of the turns break "acknowledge first". Options that cost
   nothing: state in the skill that the first `voice_say` must precede any other tool
   call (already there, not obeyed on Codex), lower reasoning effort for the voice
   conversation, Codex "fast mode". Model and effort are the operator's choice.

## 6. On a second, fast model

The question is whether an interlocutor model answering instantly would fix the
felt latency. The data says the wait has three parts: delivery (fixable in the
adapter), the model's first token (4–9 s at these context sizes, inherent to the
working agent), and the model choosing to work before speaking (a compliance issue).
A second model removes the first-token wait for the *acknowledgement* only; it cannot
answer about the work without the agent's context, so anything substantive still
waits for the agent. Codex itself ships exactly this pattern (a realtime GPT-Live
voice layer that hands off to the agent), which shows it is viable, and also shows
its cost: a second pipeline, a handoff protocol and a status feed from the agent so
the fast model does not invent progress. The earlier design decision in this
repository (no intermediary operator) was about not replacing the agent; a
"concierge" that only acknowledges, relays harness state and answers from the room
transcript would not violate it. Recommendation: do items 1–3 first and re-measure;
they address the same perceived gap for a fraction of the work, and item 2 is the
concierge's most valuable job with no model at all. Decide on the concierge with
those numbers in hand. That decision, and the trade-off it carries (a voice that may
answer with less than the agent knows), is the operator's.

## 7. Measurement gaps worth closing

- A harness-side "turn started" mark correlated to the message (the only honest
  "read" receipt) — Codex and Claude both expose the event to their clients.
- Kokoro per-chunk `elapsedMs` and first-chunk time in `CallLatency`.
- Speech-end → first audio as one number per turn in the statistics dialog, next to
  the per-stage rows, so a regression is visible without a spreadsheet.

## 8. Addendum: `turn/steer` verified (2026-09-18, later)

A private `codex app-server --listen ws://127.0.0.1:4799` (same npm binary, no desktop app),
one WebSocket client started a thread and a turn of eight `sleep 6` commands, a second client
sent `turn/steer {threadId, expectedTurnId, input}` while command 2 was running:

| Event | Time after steer |
|---|---|
| message ingested as `userMessage` item (command 2 finished) | +3.1 s |
| agent text "GOT STEER." | +5.5 s |
| commands 3–8 ran, then "DONE." and `turn/completed` | +6.6 s … +54.1 s |

The turn was not aborted: steer appends input at the next tool boundary and the work continues.
`turn/interrupt` is the call that aborts. `codex queue` needs no server (it only writes
`~/.codex/queue_1.sqlite`), but no CLI subcommand exposes steer; it needs a JSON-RPC connection
to the app-server that owns the thread (a `--listen` app-server the TUI attaches to with
`--remote`, the standalone daemon, or Paseo's API with `activeTurnBehavior: "steer"`). The
`unix://` listener closed every connection attempt here; `ws://127.0.0.1` worked.

## 9. Addendum: cost of smart-turn v3 on the server vs in the browser (2026-09-18)

Measured on this pod's CPU (Intel i7-8559U, 8 threads, shared with other work), with the
`smart-turn-v3.2-cpu.onnx` that Pipecat 1.10 bundles, synthetic 16 kHz audio, 15 runs each.

| Runtime | Per decision (median / p90) |
|---|---|
| Server, Python onnxruntime, 1 thread (what `LocalSmartTurnAnalyzerV3` does) | 117 ms / 129 ms |
| Server, 2 threads | 81 ms / 112 ms |
| Server, native onnxruntime-node, 1 thread | 74 ms / 85 ms |
| Browser-like: onnxruntime-web WASM in Node, 1 or 4 threads | 210 ms / 215 ms |
| Log-mel feature extraction (8 s of audio, numpy) | 11 ms |
| Silero VAD, per 32 ms chunk (runs continuously while listening) | 0.15 ms → ~0.5 % of one core |

The model runs once per pause, not continuously; the continuous cost is the VAD. Both
placements are far below the 2.5 s timer they would replace. Server placement adds one
WebSocket round trip for the "turn ended" message (≈1 ms locally, tens of ms through a
tunnel) and requires the browser to stream PCM even when Whisper stays local, which the
OpenAI path already does (20 ms frames, ~256 kbit/s). Browser placement avoids the round
trip but needs a port: log-mel via the Whisper feature extractor that `@huggingface/transformers`
already ships, plus an onnxruntime-web session; the WASM figure above is from this Intel
CPU under Node, not from Safari on an M-series Mac, which will be faster. Either way the
setting should be explicit: end-of-turn mode `timer` (today) / `vad` / `smart-turn`, with
its floor and maximum silence, and, once both exist, where it runs.
