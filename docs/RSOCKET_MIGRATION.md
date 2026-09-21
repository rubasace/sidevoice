# RSocket for the connector link — design (#66, phase 1)

Decided 2026-09-22. This document is the binding shape for the first phase: the link
between the connector (one per machine) and the room. The browser link is phase 2 and
gets its own issue once phase 1 has numbers.

## What is decided, and why

| Decision | Choice | Why |
| --- | --- | --- |
| Server side | `rsocket` (rsocket-py, 0.4.20, Sep 2025) over a WebSocket transport bound to the FastAPI app | Maintained, asyncio, ships WebSocket transports (aiohttp, quart, websockets) and an `AbstractMessagingTransport` to write a Starlette one against if the `fastapi` extra does not already provide it. Verify the extra first; write the transport only if needed, modelled on `quart_websocket.py`. |
| Client side (Node) | A minimal, spec-compliant RSocket 1.0 client written in `packages/connector/rsocket.mjs`, **no dependency** | The JS ecosystem is alpha and stale: `@rsocket/core` 1.0.0-alpha.3 (Feb 2024) and `rsocket-core` 0.0.29-alpha (Mar 2024), with no clearly maintained WebSocket client transport. The subset we need is small (below) and the spec is stable; interop is proven by tests against rsocket-py, not assumed. The connector keeps its "Node 22+, no dependencies" property. |
| Resumption | **Not used.** The durable outbox, the re-register-on-reconnect and the reconnect backoff stay exactly as they are | rsocket-py lists Resume as not implemented. A reconnect is a new SETUP. |
| Payload encoding | JSON (`application/json`) in the data; routing and authentication in composite metadata | The room's frames stay the same objects, readable in logs and tests; binary is a later optimisation with no bearing on the protocol shape. |
| Endpoint | New route `/api/connectors/rsocket`; `/api/connectors/ws` (the hand-rolled protocol) stays for one release | Machines upgrade at their own pace. |
| Selection | The pairing response advertises `links: ["rsocket", "ws"]`; `pair` stores the chosen link in `credentials.json`; the connector uses `rsocket` when the credential says so and falls back to `ws` when the room refuses the route (older room, 404) | One place decides; an old credential (no `link`) means `ws`. |
| Lease, fragmentation, metadata push | Not used | Not needed for the sizes and rates involved (frames are small, one connection per machine). |

## The subset of RSocket the client implements

Frames: SETUP, KEEPALIVE (both directions, honouring the respond flag), REQUEST_RESPONSE,
REQUEST_FNF, PAYLOAD (with COMPLETE/NEXT flags), ERROR, CANCEL. Stream ids: odd from the
client, even from the server; the client is also a **responder** for server-initiated
REQUEST_RESPONSE and REQUEST_FNF. Length prefix: none on WebSocket (one frame per
message). Metadata: composite (`message/x.rsocket.composite-metadata.v0`) carrying
`message/x.rsocket.routing.v0` (the route) and, on SETUP, `message/x.rsocket.authentication.v0`
(simple: username = connector id, password = token).

Byte-level correctness is tested against vectors, and behaviour against rsocket-py.

## Mapping from today's frames

| Today (`type`) | Direction | RSocket | Route | Response |
| --- | --- | --- | --- | --- |
| `connector.hello` | connector → room | SETUP (auth in metadata; data `{protocol, host, version}`) then REQUEST_RESPONSE | `connector.hello` | `connector.welcome` payload (`heartbeat_seconds`, protocol). A bad token: SETUP rejected with ERROR `REJECTED_SETUP`, socket closed. |
| `heartbeat` / `heartbeat.ack` | both | KEEPALIVE with respond flag; miss budget = today's `HEARTBEAT_MISSES` | — | — |
| `binding.register` | connector → room | REQUEST_RESPONSE | `binding.register` | `binding.registered` payload; rejection = ERROR `APPLICATION_ERROR` with the reason |
| `binding.unregister` | connector → room | REQUEST_FNF | `binding.unregister` | — |
| `speech.publish` | connector → room | REQUEST_RESPONSE | `speech.publish` | `speech.published` payload |
| `input.working`, `input.read` | connector → room | REQUEST_FNF | same names | — |
| `input.deliver` / `input.ack` | room → connector | REQUEST_RESPONSE (server-initiated) | `input.deliver` | the `input.ack` payload (`status`, `detail`) |
| `binding.close` | room → connector | REQUEST_FNF | `binding.close` | — |
| `connector.error` | room → connector | REQUEST_FNF | `connector.error` | — |

Payload data for each is today's frame object minus `type` (the route carries it). Field
names, statuses and the `protocol` version stay as documented in `packages/connector/README.md`.

## Server structure

- `apps/server/sidevoice/connector_rsocket.py` mounts `/api/connectors/rsocket` and
  translates routes to the existing `ConnectorControl` methods (`register`, `unregister`,
  `speech`, `acknowledge`, `working`, `read`, `close_binding`, heartbeat handling).
- `ConnectorControl` stops holding raw WebSockets in `self.sockets`: it holds a **peer**
  with `send(frame)` (fire-and-forget to the connector) and `request(frame) -> reply`
  (`input.deliver` → `input.ack`). The existing WebSocket path implements the same peer
  over its frames, so the control plane has one code path and two transports.
- Authentication in SETUP goes through `journal.authenticate_connector` exactly as today;
  "newer connection from the same connector wins" stays.

## Connector structure

- `packages/connector/rsocket.mjs`: the client (framing, composite metadata, requester
  and responder, keepalive). No room knowledge.
- `packages/connector/link.mjs` (or inside `connector.mjs` if it stays small): the room
  link as an interface — `open()`, `send(route, data)`, `request(route, data)`, `onRequest`,
  `onConnected`, `onLost` — with two implementations, `ws` (today's frames) and `rsocket`.
  Everything else in `connector.mjs` (bindings, outbox, observation, IPC) talks to the
  interface and does not know which one is under it.
- `pair.mjs` records `link` from the pairing response; `voice_status` reports `link`.

## Tests, and the numbers the PR must show

- Node: frame encoding/decoding against fixed byte vectors (SETUP with composite
  metadata, KEEPALIVE, REQUEST_RESPONSE, PAYLOAD, ERROR); requester/responder behaviour
  against a tiny in-test RSocket server written with the same module.
- Python: the route with `TestClient`, authentication rejected in SETUP, each mapped
  route reaching the same `ConnectorControl` outcomes as the WebSocket tests do.
- **Interop**: a Python test that serves the app on a loopback port and spawns the real
  Node connector against it over RSocket: hello, register, delivery + ack, speech +
  published, read receipt, binding close, and a forced disconnect followed by re-register
  and outbox replay. The same test runs over `ws` and reports both.
- **Numbers**: from that interop test, delivery → ack and disconnect → re-registered, for
  `rsocket` and `ws`, printed and quoted in the PR body. This is the comparison #66 asks
  for before anything is decided about the browser.

## Out of scope for this phase

The browser link (`/api/presentation/ws`, Pipecat transport). Resume. Lease. Binary
payloads. Removing the `ws` route (one release later). The homelab ingress exemption for
`/api/connectors/rsocket` (a one-line follow-up in rubasace/homelab, noted in the PR).

## Acceptance

1. A connector paired with a room that offers `rsocket` joins, delivers, speaks, reports
   reads and working state, survives a room restart and replays its outbox — all through
   `/api/connectors/rsocket`, with the Python server using rsocket-py.
2. A connector with an old credential, or against a room without the route, behaves exactly
   as today over `/api/connectors/ws`.
3. Both suites pass; the interop test prints the two latency numbers for both links.
4. No new dependency in `packages/connector`; `rsocket` added to `requirements.txt`.
5. `docs/ARCHITECTURE.md` and `packages/connector/README.md` describe the link as it is.
