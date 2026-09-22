# Socket.IO is the connector link — design (#70)

Decided 2026-09-22. This is the binding shape for the link between the connector (one per
machine) and the room. The browser link is a separate decision once this has landed.

## What is decided, and why

| Decision | Choice | Why |
| --- | --- | --- |
| Protocol | Socket.IO, both ends from its maintained libraries: `python-socketio` (5.17, ASGI) in the room, `socket.io-client` (4.8) in the connector | Acknowledgements, automatic reconnection with backoff, ping/pong keepalive and namespaces come from the library; both ends are alive and widely used. RSocket was built and measured first (#66, PR #68): a wash on latency, and the JS side had to be written by us. |
| The old protocol | **Removed**, not kept one release. `/api/connectors/ws` and every hand-rolled frame go; the protocol version in the handshake becomes `2` and the room refuses `1` | A beta with one user: every paired machine re-pairs after upgrading, which is one command. |
| Dependencies | `socket.io-client` and `esbuild` are the connector's dev dependencies, `socket.io` (server) a third for the tests; `python-socketio` in `apps/server/requirements.txt`, pinned | We stop maintaining a transport without asking a machine to resolve one: the client is bundled into the artifact at build time, so the package on npm keeps its zero runtime dependencies. |
| Path and namespace | Path `/api/connectors/socket.io` (not the default `/socket.io`), namespace `/connectors`, WebSocket transport only (`transports: ['websocket']` on the client; polling disabled on the server) | The path is what the oauth2-proxy bypass Ingress exempts, exactly; the browser will get its own path behind the login later. No long-polling through a proxy, no sticky-session question. |
| Authentication | In the connect handshake's `auth`: `{ connector_id, token, protocol: 2, host, version }`. The room's `connect` handler checks `journal.authenticate_connector` and refuses with `ConnectionRefusedError("...")`; the client sees `connect_error` with that message and does not retry a refused credential | One check, before any event, same credential as today. |
| Keepalive | Socket.IO's `pingInterval` / `pingTimeout` (server-side settings, values from today's `heartbeat_seconds` and `HEARTBEAT_MISSES`) | Our heartbeat frames go. |
| Reconnection | The client library's, with backoff; on every `connect` the connector re-registers its bindings (same ids) and replays the outbox | Our reconnect loop goes. |
| Durability | The **outbox stays** (durable on disk, survives a connector restart); the connector emits speech only while connected and never relies on the library's in-memory buffering. Whether `python-socketio` implements connection state recovery is checked, and used for nothing this design depends on | A library buffer dies with the process; the outbox does not. |
| Newer connection wins | The room keeps `connector_id → sid`; a new connection from the same connector disconnects the previous sid | Same rule as today. |
| Encoding | JSON event payloads, the same objects as today's frames minus `type` (the event name carries it) | Readable in logs and tests; field names, statuses and receipts unchanged. |

## Events

| Today (`type`) | Direction | Socket.IO | Acknowledgement |
| --- | --- | --- | --- |
| `connector.hello` | — | the connect handshake (`auth`) | — |
| `connector.welcome` | room → connector | event `connector.welcome` `{protocol}` right after a successful connect | — |
| `heartbeat` / `heartbeat.ack` | — | library ping/pong | — |
| `binding.register` | connector → room | event `binding.register` | ack: the `binding.registered` payload, or `{ error }` for a rejection |
| `binding.unregister` | connector → room | event `binding.unregister` | none |
| `speech.publish` | connector → room | event `speech.publish` | ack: the `speech.published` payload |
| `input.working`, `input.read` | connector → room | events of the same name | none |
| `input.deliver` / `input.ack` | room → connector | event `input.deliver` with an ack callback; the room's ack timeout = today's delivery timeout | ack: the `input.ack` payload (`status`, `detail`, `error`) |
| `binding.close`, `connector.error` | room → connector | events of the same name | none |

## Structure

- Room: `apps/server/sidevoice/connector_socketio.py` creates the `AsyncServer`, mounts it at the
  path on the FastAPI app, and translates events to `ConnectorControl` methods. `ConnectorControl`
  talks to a **peer** (`send(event, data)`, `request(event, data) -> ack`) and holds no socket;
  PR #68's commit `cc0a62f` did this seam and can be cherry-picked and stripped of its RSocket
  files rather than re-derived. `connector_control.py` keeps the control plane only.
- Connector: `packages/connector/link.mjs` is the link interface (`open`, `send`, `request`,
  `onEvent`, `onConnected`, `onLost`) with one implementation over `socket.io-client`; PR #68's
  `a9fdda8` is the reference for how `connector.mjs` asks-and-waits instead of send-and-match.
  `pair.mjs` stores the room's origin; the path is the client's knowledge. The `privateNetwork`
  rule for `http://` rooms stays.
- **The published package is bundled.** `npm run build` — a `prepack` script too, so no `npm pack`
  can forget it — runs esbuild over `cli.mjs` and everything it imports (`bundle: true`,
  `platform: 'node'`, `format: 'esm'`, `target: 'node22'`, `node:*` external) into `dist/`, and
  `bin.sidevoice` and `files` name `dist/`. `packages/browser-audio/build.mjs` is how this repo
  drives esbuild. `install.mjs`'s `materialize` therefore stays what it is — copy the files, run
  them with `node` — with no `npm install` in the copy and no network at install time; `uninstall`
  removes the copy as before. `mcp.mjs` starts the connector through that same entry
  (`cli.mjs connector`), which is one file in `dist/` once bundled and the checkout's own `cli.mjs`
  when it is not.
- `voice_status` reports `protocol: 2`; a credential from a client older than this version is
  refused by the room with a message that says to pair again, and `voice_connect` relays it.

## Tests, and the numbers the PR must show

- Node: a real `socket.io` server in the tests (dev dependency) stands in for the room, so the
  connector suite keeps its shape; `test/ws-server.mjs` goes. The suites run on the source with
  `node --test`; the interop test also runs once against the built `dist/`, so the bundle is proven
  and not assumed. CI's `Client (Node)` job builds before it packs, and its `node --check` line
  names the files that exist.
- Python: the namespace with a `python-socketio` async client in the tests: refused credential,
  refused protocol, each event reaching the same `ConnectorControl` outcomes as today's tests.
- **Interop**: the Python test from PR #68 (`test_connector_interop.py`: uvicorn on a loopback
  port, the real `connector.mjs` spawned against it) over this link: hello, register, delivery +
  ack, speech + published, read receipt, binding close, forced disconnect → re-register + outbox
  replay, and a refused credential. It prints delivery → ack and disconnect → re-registered; the
  PR quotes them next to #68's reference (old link: 17 ms, 281 ms).
- Both suites green in five consecutive full runs; the two new test modules collect garbage at
  their own teardown (`tearDownModule`), as #68 learned to (#69).

## Out of scope

The browser link. Binary payloads. Connection state recovery as a dependency. The homelab
Ingress exemption for `/api/connectors/socket.io` (one line in rubasace/homelab, noted in the PR).

## Acceptance

1. A connector paired with the room joins, delivers, speaks, reports reads and working state,
   survives a room restart and replays its outbox — over `/api/connectors/socket.io`, with no
   hand-rolled framing left anywhere in `packages/connector` or `apps/server`.
2. A credential from the previous client is refused with a message that says to pair again.
3. `npm pack` ships one bundled `dist/` and no runtime dependency; `install` produces a copy that
   runs from it with nothing fetched; `uninstall` removes it.
4. Both suites green 5/5; the interop test prints the two numbers.
5. `docs/ARCHITECTURE.md`, `docs/INSTALL.md`, `packages/connector/README.md` and
   `THIRD_PARTY_NOTICES.md` describe the link and the dependency as they are.
