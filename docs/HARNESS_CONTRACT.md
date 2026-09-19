# Harness contract

The connector has one module per harness. A module declares exactly five
capabilities as `supported` or `unsupported`; the contract rejects a supported
capability without a callable implementation. At a wire boundary, a missing or
invalid declaration is `unknown`. Unknown is deliberately not false.

| Capability | Meaning | Claude Code | Codex | Generic HTTP |
| --- | --- | --- | --- | --- |
| `deliver` | Accept one room event for the harness's conversation | supported: session messaging socket | supported: `codex queue` (or configured HTTP receiver) | supported: configured HTTP receiver |
| `inspectInbound` | Preflight whether injected input will be admitted | supported: launch flags and `crossSessionInbound` settings | unsupported | unsupported |
| `working` | Mechanically provide whether this conversation is busy now | supported: polled `~/.claude/sessions/*.json` status | supported: `UserPromptSubmit` / `Stop` lifecycle hooks | unsupported |
| `endOfTurn` | Normalize a harness `Stop` hook into an end-of-turn report | supported | supported | unsupported |
| `sessionIdentity` | Identify the conversation without model-supplied text | supported: façade environment | supported: MCP tool metadata (or hook payload) | supported: explicit environment |

A hook invocation says which harness it belongs to because the installed hook
command says so (`sidevoice hook --harness <name>`, or `SIDEVOICE_HOOK_HARNESS`);
`identifyHookHarness` then asks that module alone. Nothing is inferred from the
process environment: a Codex session started from a Claude Code terminal inherits
`CLAUDE_CODE_SESSION_ID`, and both harnesses' hook payloads carry a `session_id`,
so an undeclared hook would silently attribute the turn to the first module that
recognized something. With no declaration the modules are still asked in order,
which only holds on a machine running a single harness.

`binding.register` carries this declaration. Bindings remain in-memory room
state, as before. The participant API exposes the normalized declaration and
the browser distinguishes `unsupported` from `unknown` when explaining why no
harness-native working signal is available.

## Codex's event-backed working state

Checked on Codex CLI 0.153.2 on 2026-09-19:

- `~/.codex` contains rollout/history stores, queue databases and per-thread
  writer locks, but no Claude-style session registry with current busy/idle
  state. A writer lock identifies the process that owns a thread; it does not
  say whether that process is currently running a turn.
- the generated experimental app-server schema includes `turn/started`,
  `turn/completed` and `thread/status/changed`. Those are notifications on the
  owning app-server connection. A normal TUI or stdio app-server exposes no
  endpoint to an unrelated local connector, and a second app-server cannot
  resume a thread while its writer is active (see issue #29's steer design).
- Codex's hook schema includes `UserPromptSubmit` and `Stop`. In a real Codex
  0.153.2 session, both a directly entered prompt and a message delivered by
  `codex queue --thread` to that live thread emitted those two hooks. Each pair
  carried the same `session_id` (the thread) and `turn_id`; the queued turn kept
  the thread identity and received a distinct turn identity.

The public capability is therefore `supported`, while an internal source marker
keeps the connector from trying to poll Codex. The hook reports start/end events
over the connector's local socket. The connector correlates them by turn,
deduplicates them, and sends the aggregate state through the existing
`input.working` path. Lifecycle frames also name `turn_phase`; an older turn's
end can therefore close its own telemetry while carrying `working: true` if a
newer turn remains active. Only the last active end carries `working: false`.
Completed turn IDs are retained for the binding's lifetime, so arbitrarily late
duplicates cannot resurrect work. Aggregate state is re-announced without
lifecycle metadata after a room WebSocket reconnect, and the room retains that
Boolean in memory so a browser selecting or reconnecting mid-turn sees it.

This support has prerequisites rather than invented recovery: both hooks must be
configured, and the conversation must have an active Sidevoice binding. It does
not reconstruct a turn that started before either existed, and connector-process
restart loses in-memory turn state. Hook delivery is fail-open, so an unavailable
connector never blocks Codex.

Assistant speech carries no `final` field. A published utterance is presentation
data, not evidence that the harness ended its turn; one turn may publish zero,
one, or several utterances. Codex's correlated `Stop` closes browser turn
telemetry. Transcription and offline-audio protocols retain their unrelated
`final` fields, where the word means the end of input or an audio upload.
