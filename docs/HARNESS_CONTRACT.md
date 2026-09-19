# Harness contract

The connector has one module per harness. A module declares exactly five
capabilities as `supported` or `unsupported`; the contract rejects a supported
capability without a callable implementation. At a wire boundary, a missing or
invalid declaration is `unknown`. Unknown is deliberately not false.

| Capability | Meaning | Claude Code | Codex | Generic HTTP |
| --- | --- | --- | --- | --- |
| `deliver` | Accept one room event for the harness's conversation | supported: session messaging socket | supported: `codex queue` (or configured HTTP receiver) | supported: configured HTTP receiver |
| `inspectInbound` | Preflight whether injected input will be admitted | supported: launch flags and `crossSessionInbound` settings | unsupported | unsupported |
| `working` | Query whether this conversation is busy now | supported: `~/.claude/sessions/*.json` status | unsupported | unsupported |
| `endOfTurn` | Normalize a harness `Stop` hook into an end-of-turn report | supported | supported | unsupported |
| `sessionIdentity` | Identify the conversation without model-supplied text | supported: façade environment | supported: MCP tool metadata (or hook payload) | supported: explicit environment |

`binding.register` carries this declaration. Bindings remain in-memory room
state, as before. The participant API exposes the normalized declaration and
the browser distinguishes `unsupported` from `unknown` when explaining why no
harness-native working signal is available.

## Why Codex `working` is unsupported

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
- Codex's hook schema includes `UserPromptSubmit` and `Stop`. A configured
  Sidevoice hook can therefore report prompt admission and the end of a turn,
  but it is an event stream, not an answer to “is this thread working right
  now?”. It also cannot reconstruct state before the hook/connector binding was
  present.

So Codex truthfully supports end-of-turn reporting while declaring pull-style
working state unsupported. If a future owner-side connection becomes available,
the Codex module can implement `working` from that lifecycle stream without
changing the connector, room or UI contract.
