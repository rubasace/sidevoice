# Sidevoice uplink — the client side (`@sidevoice/uplink`)

The client side. One bin (`sidevoice`), these entry points:

- `install` — registers the MCP server with the harness (re-pinned to this
  version when an older one was registered) and removes a skill copy an earlier
  version left. Pairs with nothing; reports whether the machine is paired and
  with which room.
- `mcp` — the stdio MCP server a harness starts. One per conversation. Exposes
  `voice_connect`, `voice_pair`, `voice_say`, `voice_disconnect`, `voice_status`; carries the
  operational instructions in its `initialize` result. It never talks to the
  room: it keeps one local connection to the connector for as long as the
  session lives, and the binding it registered dies with that connection.
- `connector` — one per machine, started by the first façade that needs it and
  gone fifteen seconds after the last binding leaves. Holds the outbound link to
  the room, re-announces its bindings after a reconnect, keeps a durable outbox
  for speech published while offline, answers the room's heartbeat, and delivers
  one input event at a time per binding through the adapter that binding was
  registered with. A file lock makes it a singleton.
- `pair` — redeems, by hand, a pairing code from the room UI for this machine's
  credential (`~/.sidevoice/credentials.json`, mode 0600). The room answers with
  the links it serves and the machine picks one there, once, writing it into the
  credential. The usual path is the conversation's `voice_pair`, with the code
  the user read from the room; nothing on the client side ever asks the room for
  a code.

Harness modules implement one contract (`harness-contract.mjs`): delivery,
inbound inspection, mechanical working state (polled or lifecycle-backed), end-of-turn reporting and session
identity. Every capability is explicitly `supported` or `unsupported`; an old
or malformed declaration becomes `unknown`, never false. Claude Code, Codex and
generic HTTP each have one module. See the repository's
[`docs/HARNESS_CONTRACT.md`](../../docs/HARNESS_CONTRACT.md).

## The link to the room

`link.mjs` is the link as an interface — `open`, `close`, `send(route, data)`,
`request(route, data)`, and callbacks for what the room asks and when the
connection is lost. Everything above it — bindings, the outbox, the harness
adapters, the façades — is written against that and never learns which link is
underneath. There are two, and `voice_status` reports which one is in use.

**`rsocket`** (`/api/connectors/rsocket`) is RSocket 1.0 over a WebSocket,
implemented in `rsocket.mjs`: SETUP, KEEPALIVE, REQUEST_RESPONSE, REQUEST_FNF,
PAYLOAD, ERROR and CANCEL, with composite metadata carrying the route and, in
SETUP, the credential as simple authentication. Data is JSON. The credential is
checked once, in SETUP, and a bad one is `REJECTED_SETUP` and no socket. An
answer arrives on the stream that asked, so nothing is correlated by hand; a
registration the room refuses is an `APPLICATION_ERROR` on that stream and the
connection carries on. Resumption, lease and fragmentation are not used: a
reconnect is a new SETUP, and the durable outbox is what survives it.

**`ws`** (`/api/connectors/ws`) is the older protocol, newline-free JSON objects
over the WebSocket: `connector.hello` -> `connector.welcome`;
`binding.register` (including declared harness capabilities) ->
`binding.registered|rejected`; `binding.unregister`; `input.deliver` ->
`input.ack`; `input.working`; `input.read`; `speech.publish` ->
`speech.published`; `heartbeat` <-> `heartbeat.ack`.

Both carry the same frames, the same field names and the same protocol version
(1); over `rsocket` the frame's `type` is the route and the rest is the data.
Which one a machine uses is chosen when it pairs and stored in its credential; a
credential written before the choice existed means `ws`. A room that does not
serve the link a credential names is one the connector reaches over the other
after a few attempts, because a WebSocket cannot tell a refused route from a
room that is not there.

Node 22+, no dependencies. Tests: `node --test test/test_connector.mjs`.
