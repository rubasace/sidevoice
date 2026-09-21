# Installing Sidevoice for your agent

This document is written for an AI agent that has been asked to "install
Sidevoice" for the harness it is running in. Follow only the section for your
harness. Change only your own harness's configuration; nothing here touches any
other tool. Anything marked **(from the user)** must be asked for, never guessed.

## What gets installed

1. The Sidevoice connector package (Node 22+), which provides the `sidevoice`
   command with three subcommands: `mcp` (the stdio MCP server your harness
   starts), `pair` (one-time pairing with the room) and `connector` (the
   per-host process the MCP server starts by itself; you never run it).
2. One pairing of this machine with the user's Sidevoice room.
3. The `voice-presentation` skill, which tells the agent how to behave once
   connected.

Until the package is published to npm, `npx -y @sidevoice/uplink@<version>`
below is equivalent to `node <checkout>/packages/connector/cli.mjs` from a clone of this
repository. Pin an exact version; bump it by hand.

## The short way

One command does everything that is mechanical — pairing this machine with the room, registering the
MCP server with the harness, installing the skill — and prints what is left for a person to decide:

```sh
npx -y @sidevoice/uplink@<version> install <room-url>
```

It asks the room for its own pairing code, so nobody has to read one from the interface. Only a caller
that can already reach the room can do that, which is the gate that matters: the code is a handshake,
not a secret. A room that refuses (or one you reach through a proxy that blocks it) says so, and then
you pass a code from the interface with `--code`.

Running it twice changes nothing and says so. `--repair` pairs again, `--harness claude|codex` picks
one when the machine has both.

What it deliberately does **not** do, and prints instead:

- **Codex's `config.toml`** is machine-wide and may hold anything its owner put there, so the command
  shows the three blocks to paste rather than rewriting the file.
- **Claude Code's inbound safeguard.** If this machine runs sessions in `bypassPermissions`, messages
  from the room are held rather than delivered. The command says so and shows both remedies; choosing
  one is the user's, because the machine-wide remedy lets any local process post into every session.

The rest of this document is the same thing by hand, and what each step is for.

## Common steps

- Check Node.js 22 or newer is on PATH: `node --version`.
- **(from the user)** the room URL (for example `https://sidevoice.example`) and
  a pairing code, which the user reads from the room UI ("Emparejar conector").
  Codes expire after ten minutes and work once.
- Pair this machine:
  `npx -y @sidevoice/uplink@<version> pair <room-url> <code>`
  This writes `~/.sidevoice/credentials.json` (mode 0600) and nothing else.

## Claude Code

1. Register the MCP server for the user (not the project), pinned:
   `claude mcp add --scope user sidevoice -- npx -y @sidevoice/uplink@<version> mcp`
2. Install the skill: copy `skills/voice-presentation/SKILL.md` from this
   repository to `~/.claude/skills/voice-presentation/SKILL.md`.
3. Verify in a **new** Claude Code session: ask it to "connect this conversation
   to the voice room". The `voice_connect` result must say `joined`; `voice_status`
   must report `room_reachable: true`. The conversation then appears in the room
   UI as available.

Delivery into Claude Code uses the session's own messaging socket, which the MCP
server inherits from the session that started it
([documented here](https://code.claude.com/docs/en/cross-session-messaging)).

**One setting decides whether it arrives.** A session that bypasses permission
prompts does not receive messages posted by other local processes: Claude Code
**holds** them for the user to approve, and the sender is told nothing — voice
looks sent and never arrives. This is not an edge case if
`permissions.defaultMode` is `bypassPermissions`, because then every session
starts that way.

`voice_connect` reports this as `inbound.ok: false` with the reason and the
remedy, so the agent can say it instead of the user guessing. The two ways out:

- **One session**: start it with
  `--settings '{"crossSessionInbound":"accept"}'`, or in a prompting mode such
  as `--permission-mode auto`. Cannot be changed once the session is running.
- **All sessions on the machine**: add `"crossSessionInbound": "accept"` to
  `~/.claude/settings.json`. It takes effect immediately and releases messages
  already held. **(from the user)** — it also lets any other local process post
  into all of their Claude sessions, which is exactly the safeguard it removes.
  Ask before writing it.

See `crossSessionInbound` in the
[settings reference](https://code.claude.com/docs/en/settings-reference#crosssessioninbound);
values are `accept`, `hold` and `refuse`, and a managed policy can override any
of this.

## Codex (CLI and Desktop)

1. Register the MCP server in `~/.codex/config.toml`, pinned:
   ```toml
   [mcp_servers.sidevoice]
   command = "npx"
   args = ["-y", "@sidevoice/uplink@<version>", "mcp"]
   ```
2. Install the skill: copy `skills/voice-presentation/SKILL.md` to
   `$CODEX_HOME/skills/voice-presentation/SKILL.md` (default `~/.codex/skills/`).
3. Verify as for Claude Code, in a new Codex conversation.

Delivery into Codex — CLI and Desktop alike — uses `codex queue` on this
machine, so the `codex` command must be on PATH for the MCP server (set
`SIDEVOICE_CODEX_BIN` in the server's `env` otherwise).

## Compatibility

The connector declares protocol version 1 when it connects; the room accepts a
stated range and `voice_status` says when a bump is needed. Connector and room
do not have to be the same version.

## Read receipts and speaking first

The room shows one tick when the harness accepted a voice message and two when the
conversation actually read it. The second tick, and a line of context that asks the
model to acknowledge by voice before any other tool, come from a harness hook on the
prompt-admitted event. The hook is a plain command (no model involved, about 40 ms):
it only acts on Sidevoice voice envelopes, reports to the connector over its local
socket, so no room credential lives in any hook configuration, and always exits 0.

**Claude Code, per conversation (preferred).** Install the `voice-room` skill once (`/voice` itself is Claude Code's own command):

```bash
npx -y @sidevoice/uplink@<version> skill install     # copies ~/.claude/skills/voice-room/
```

In a conversation, `/voice-room` (or asking to enable voice) joins the room and registers
the hook for that session only; other sessions are untouched. New sessions see the
skill; a session already open needs a restart. `skill remove` deletes the copy, and
neither command touches a `voice-room` skill that is not Sidevoice's.

**Claude Code, every session on the machine.** Alternatively, in `~/.claude/settings.json`
(or a project's `.claude/settings.json`):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "npx -y @sidevoice/uplink@<version> hook --harness claude" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "npx -y @sidevoice/uplink@<version> hook --harness claude" } ] }
    ]
  }
}
```

**Codex** (`~/.codex/config.toml`; verified with Codex CLI 0.153.2 for both a
direct turn and `codex queue --thread` into the same live thread; Codex has no
per-session hooks):

```toml
[[hooks.UserPromptSubmit]]
hooks = [ { type = "command", command = "npx -y @sidevoice/uplink@<version> hook --harness codex" } ]

[[hooks.Stop]]
hooks = [ { type = "command", command = "npx -y @sidevoice/uplink@<version> hook --harness codex" } ]
```

The command names the harness it was installed for (`--harness claude` / `--harness codex`,
or `SIDEVOICE_HOOK_HARNESS`). It is not a formality: a Codex session started from a Claude
Code terminal inherits `CLAUDE_CODE_SESSION_ID`, and both harnesses' payloads carry a
`session_id`, so an undeclared hook can attribute a turn to the wrong harness and report no
working state at all.

Set `SIDEVOICE_HOOK_NUDGE=0` in the hook's environment to keep the read receipt but
drop the nudge. `UserPromptSubmit` mechanically reports the thread working and
`Stop` reports it idle; the queued voice envelope also supplies the browser turn
correlation used by telemetry. Both hooks produce no model-authored working
signal. Restart Codex after editing the configuration, then join the conversation
to create the active binding; work that predates the hooks or binding cannot be
reconstructed.

The package does not rewrite `config.toml`: unlike the Claude skill installer,
Codex's hook is machine-wide and the file may contain user-managed TOML that the
uplink does not own. Add the two entries explicitly. A machine-wide hook changes
how Codex runs every session on the machine, so inspect the command and scope
before adding it.

## The room: observability (optional)

This section is about the machine that runs the **room**, not about a harness. Nothing
here is needed to use Sidevoice, and with none of it set the room behaves exactly as it
did before: no provider is started, no batch is posted, and the page never downloads the
OpenTelemetry SDK.

Set these in `.env.voice` (or the room process's environment) to send one trace per turn
and one histogram per stage to a collector:

| Variable | What it does |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL of an OTLP/HTTP collector, with no `/v1/...` path — for example `http://127.0.0.1:4318`. The room appends `/v1/traces` and `/v1/metrics`, and relays the browser's own spans to the same place. **Unset means telemetry is entirely off.** |
| `OTEL_SERVICE_NAME` | What the room calls itself in the collector. Defaults to `sidevoice-room`; the page always reports itself as `sidevoice-web`. |

The browser posts its spans to the room (`POST /api/telemetry`) and never to a collector,
so a collector on a private network needs no exposure and the page needs no second origin.
Like the room's other browser endpoints, `/api/telemetry` has no authentication beyond the
same-origin check: do not expose the prototype to untrusted users.

What is and is not in a span — and why no transcript, reply or credential can be — is in
[the latency measurement document](latency-measurement.md).

## Uninstall

Remove the MCP server entry from your harness, the skill directory, and
`~/.sidevoice/`. The room keeps this machine's credential until it is revoked
from the room UI.
