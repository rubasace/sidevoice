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

## Read receipts and speaking first (optional hook)

The room shows one tick when the harness accepted a voice message and two when the
conversation actually read it. The second tick, and a nudge that asks the model to
acknowledge by voice before any other tool, come from a harness hook that runs
`sidevoice hook` when a prompt is admitted. The hook only acts on Sidevoice voice
messages; any other prompt exits silently. It reports to the connector over its
local socket, so no room credential lives in the hook configuration.

Claude Code (`~/.claude/settings.json`, or the project's `.claude/settings.json`):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "npx -y @sidevoice/uplink@<version> hook" } ] }
    ]
  }
}
```

Codex (`~/.codex/config.toml`; verified for a turn started directly, still to be
checked for a queued message on a long-lived thread):

```toml
[[hooks.UserPromptSubmit]]
hooks = [ { type = "command", command = "npx -y @sidevoice/uplink@<version> hook" } ]
```

Set `SIDEVOICE_HOOK_NUDGE=0` in the hook's environment to keep the read receipt but
drop the nudge. Installing a hook changes how that harness runs every session on the
machine: ask before adding it to someone's settings.

## Uninstall

Remove the MCP server entry from your harness, the skill directory, and
`~/.sidevoice/`. The room keeps this machine's credential until it is revoked
from the room UI.
