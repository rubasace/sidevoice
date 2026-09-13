# Claude Channels draft — not integrated

This paused experiment aims to deliver room input directly into the working
Claude conversation through MCP Channels, without another agent.

It is not installed in Claude, not integrated into harness-aware room routing,
and not tested with a live Claude subscription. `launch.sh.example` is a sketch;
its MCP configuration still needs to be generated.

Finish shared gateway extraction and adapter-aware routing before using it.
In particular, a Claude destination must never be forwarded through a Codex
gateway. Port/path defaults also need review.

Reference: https://code.claude.com/docs/en/channels-reference
