# Harness contract

The connector has one module per harness. A module declares exactly five
capabilities as `supported` or `unsupported`; the contract rejects a supported
capability without a callable implementation. At a wire boundary, a missing or
invalid declaration is `unknown`. Unknown is deliberately not false.

| Capability | Meaning | Claude Code | Codex | Generic HTTP |
| --- | --- | --- | --- | --- |
| `deliver` | Accept one room event for the harness's conversation | supported: session messaging socket | supported: `codex queue` (or configured HTTP receiver) | supported: configured HTTP receiver |
| `inspectInbound` | Preflight whether injected input will be admitted | supported: launch flags and `crossSessionInbound` settings | unsupported | unsupported |
| `working` | Mechanically provide whether this conversation is busy now | supported: observed — `~/.claude/sessions/*.json` status | supported: observed — `task_started` / `task_complete` in the thread's rollout | unsupported |
| `endOfTurn` | Report the end of a turn, correlated with the message that started it | supported: observed — status goes idle | supported: observed — `task_complete` / `turn_aborted` | unsupported |
| `sessionIdentity` | Identify the conversation without model-supplied text | supported: façade environment | supported: MCP tool metadata | supported: explicit environment |

`working` and `endOfTurn` are answered by one method, `observe(thread, handlers)`: the
module watches what its harness writes about that conversation and calls back with every
working transition and every user message the conversation admits. The connector matches
admitted messages against what it delivered (by `message_id`) for the read receipt and
the turn correlation. Nothing is installed in the harness, and a harness that writes
nothing observable declares both unsupported.

The same watch reports one more thing about the conversation: `handlers.engine({ model,
effort, thinking })`, the model it thinks with, whenever the module first sees it and
whenever it changes. It is not a sixth capability — a module that never sees a model
simply never calls it — and it is the harness's own record, never asked of the model.
`engine` on the module (`engine(thread)`) stays what it is: the launch line, which is what
the binding carries until the first observation replaces it. Effort and thinking are still
only said on that launch line, so an observation that has none reports them as null.

`binding.register` carries this declaration. Bindings remain in-memory room
state, as before. The participant API exposes the normalized declaration and
the browser distinguishes `unsupported` from `unknown` when explaining why no
harness-native working signal is available. `binding.register` carries the engine too, and
`input.engine` carries it again whenever an observation replaces it; the room keeps the latest
on the binding and the participant API returns it as `engine: {model, effort, thinking}`.

## What each harness writes, and when

Checked on Claude Code 2.1.278 and Codex CLI 0.153.2 on 2026-09-21, with a live session of each:

- Claude Code keeps `~/.claude/sessions/<pid>.json` per session with a `status` it
  updates (`busy`, `idle`), and appends the session's transcript as
  `~/.claude/projects/<project>/<session id>.jsonl`. A message posted to the session's
  inbox is recorded as `queue-operation` enqueue/dequeue and then as a `user` entry
  (`"Another Claude session sent a message:\n"` + the envelope) the moment the session
  admits it; the entry's `promptId` names the turn. A message that arrives while the session
  is busy is admitted into the running turn instead, recorded as an `attachment` entry of type
  `queued_command` whose `prompt` is the whole message: the observer reads both shapes, or the
  read receipt is missed for every message delivered mid-turn. Measured: the `user` entry appeared
  9 ms after the socket write for an idle session, and the connector reported it read
  300 ms later at its 400 ms poll. Every `assistant` entry in that transcript carries the
  model that wrote it — `{"type":"assistant","message":{"model":"claude-fable-5-1", …}}` —
  so a session launched with no `--model` says what it thinks with the moment it answers once.
- Codex appends `sessions/YYYY/MM/DD/rollout-<stamp>-<thread id>.jsonl`: `event_msg`
  `task_started` / `task_complete` / `turn_aborted` with the `turn_id`, and
  `response_item` `message` with `role: user` for every message a turn takes, including
  one that arrived through `codex queue`. Measured: the queued message ran as its own turn
  once the previous one ended, and the read receipt followed `turn/started` by 190 ms.
  On attach, the rollout is read once silently so a turn already running is reported as
  running; old messages are not re-read. Each turn opens with a `turn_context` naming the
  model — `{"type":"turn_context","payload":{"model":"gpt-5.6-terra", …}}` — and the
  `session_meta` that opens the file says it when that build writes it there (0.153.2 does
  not); the model found during the silent read is reported once the replay is over.

The connector correlates by turn: the read receipt carries the turn id it was taken in,
the working start carries the same id with the message's `session_id` and `revision`,
and the end of that turn carries them again. Aggregate state is re-announced on a clock
and after a room reconnect, and the room retains that Boolean in memory so a browser
selecting or reconnecting mid-turn sees it. A connector restart loses what it was
expecting; the room's redelivery on a missing acknowledgement covers the message, not a
receipt for one already taken.

Assistant speech carries no `final` field. A published utterance is presentation
data, not evidence that the harness ended its turn; one turn may publish zero,
one, or several utterances. The correlated end of turn, observed, closes browser turn
telemetry. Transcription and offline-audio protocols retain their unrelated
`final` fields, where the word means the end of input or an audio upload.
