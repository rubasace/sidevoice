# Adapter boundary: extraction plan

Status: **implemented through §7 step 7 on branch `plan/adapter-boundary`
(uncommitted), verified end to end on this pod on 2026-09-14** — see the
progress notes under each step. Remaining: the Mac check for Codex Desktop
(§9.16), npm publication (step 5, needs a scope name), deployment hardening
(step 8) and the documentation strip (step 9).
Written 2026-09-14 against commit `4630053`; line references now resolve
against `6b98a8a`, which leaves every earlier file unchanged except `bot.py`
(one import, one mount).
Revised the same day with the operator's answers: **D3, D4 and D5 are settled**
(§8). Revised again after the operator asked whether Claude could be served
generically before Channels — it can, and §2.1 is the answer; that reordered
§7 and shrank D1 and D2. **Revised a third time after the operator chose the
connector architecture and commit `6b98a8a` landed its first cut**: §2.5
records the decision, answers the two open questions and reviews the commit;
§7 and §8 are re-sequenced around it. §2.1 stays as a **documented
fallback**, not just the road not taken — see the adversarial pass in the
Method section.

`docs/ARCHITECTURE.md` already declares the boundary (common / adapter /
agent-to-room) and admits it has not been extracted. This document says what
"extracted" would concretely mean, in this code, with the new constraint that
the harness and the server need not share a machine.

## Method, and what is not verified

Everything below was read from source, not from the README. File and line
references are to commit `6b98a8a`; the `connector/` tree and
`voice_poc/connector_control.py` exist only there.

External facts were checked against primary sources on 2026-09-14, because the
whole Claude thread depends on them:

- `https://code.claude.com/docs/en/channels-reference` — "A channel is an MCP
  server that **runs on the same machine as Claude Code**. Claude Code spawns it
  as a subprocess and communicates **over stdio**." Channels are in research
  preview; custom channels are not on the approved allowlist and need
  `--dangerously-load-development-channels`. And: "Claude Code doesn't
  acknowledge notifications. The `await` on `mcp.notification()` resolves when
  the message is written to the transport, not when Claude has processed it …
  Claude Code drops the events silently and returns no error to your server."
- `https://code.claude.com/docs/en/channels-reference`, registration section —
  a channel is registered like any MCP server, via `.mcp.json` or
  `~/.claude.json`; "Claude Code reads your MCP config at startup and spawns
  each server as a subprocess"; and "Claude Code delivers the `instructions`
  string to Claude as context when the server connects". This is what §3.2 is
  built on.
- `https://code.claude.com/docs/en/mcp` — ordinary (non-channel) MCP servers do
  support remote transports: `claude mcp add -t http <name> <url> -H
  "Authorization: Bearer <token>"`, plus SSE and WebSocket.
- MCP tool-call timeouts, which decide how long §2.1's held-open call can run:
  the MCP TypeScript SDK's default request timeout is 60 s, progress
  notifications reset that clock (which is what makes a long held window and a
  heartbeat the same mechanism), and Claude Code exposes a per-server `timeout`
  in `.mcp.json` plus environment overrides. The 60 s default and the
  progress-reset behaviour come from the SDK and the primary docs; the exact
  environment-variable names in circulation (`MCP_TOOL_TIMEOUT`,
  `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`) are from issue threads and third-party
  write-ups and are **not** confirmed here. A 60 s long-poll needs none of them.
- Voice Mode (`https://github.com/mbailey/voicemode`) as an install precedent:
  `claude mcp add --scope user voice-mode uvx voice-mode`, i.e. a published
  package run by a runner, plus a separate published bootstrap entry point.
  Taken from its published install documentation, not from running it.

**Not verified, and not assumed anywhere below:**

- The behaviour of Codex Desktop's app tool socket. This machine is a Linux pod;
  the app does not exist here. `CODEX_APP_TOOLS_PIPE_PATH`
  (`voice_poc/desktop_gateway.mjs:11`), the 4-byte little-endian length framing
  (`:44-46`), and the semantics of `send_message_to_thread`, `read_thread`,
  `wait_threads` and the turn-metadata keys at `:71-73` are read from this
  repository's own client code and have not been exercised.
- Whether the app's bundled signed Node runtime can resolve or execute a package
  fetched from the network (`npx`). This matters to decision **D1**.
- Whether the `claude/channel` capability is honoured over any transport other
  than stdio. The documentation states stdio and same machine; nothing says the
  capability is *rejected* elsewhere, and nothing says it is accepted. Untested.
- Whether a channel server process receives the Claude session identity from its
  environment. The draft does not try: it takes the identity from the model
  (`experiments/claude_channel/server.mjs:31`). See **§5.2**.

**Adversarial pass, 2026-09-14.** §2.5's findings and §7's order were handed to
a second model family (the `architect` agent on OpenAI Codex, reasoning
`high`, read-only task, no MCP forwarded) with instructions to falsify them.
It confirmed 11 of 12, marked one overstated (corrected in place), added five
findings (13–17), and argued for a different order of steps 1–4, which §7 now
follows. Its raw report is kept outside the repo
(`~/.agent/scratch/sidevoice-adversarial-2026-09-14.md`). One environmental
note for whoever repeats this: Codex's bubblewrap sandbox cannot create user
namespaces in this pod, so the run had to be unsandboxed; the tree was verified
untouched afterwards.

---

## 0. Product scope, as fixed by the operator

Recorded 2026-09-14. It settles D5 and narrows everything downstream, so it
comes before the map.

Sidevoice does one thing: **the user speaks, and the words arrive in the
conversation they are already having with their agent, marked as having come
from voice.** Barge-in, turn detection and the handling of audio interruption
are Pipecat's job, underneath, and stay in the server.

In scope:

- deliver a voice-originated message into one specific live session;
- the receiving agent can tell the message came from voice — the `channel:
  voice` envelope (`desktop_gateway.mjs:213-216`) is a product property, not an
  implementation detail;
- publish the agent's spoken reply back to the room.

**Out** of scope, and therefore to be deleted rather than relocated:

- watching *other* tasks and reporting when they finish — `/tasks/*`
  (`desktop_gateway.mjs:173-192`), `task_watch.mjs`, `task_channel.py`,
  `thread_monitor.py`;
- re-exposing the harness's own tool catalogue to anything
  (`desktop_gateway.mjs:103-130`);
- any second agent, operator or interlocutor.

Reserved for later, named now so the boundary leaves room for it: **interrupting
the agent's work**, as distinct from interrupting its audio. That becomes a
fifth adapter operation, `interrupt(participant_id)` — specified in §2, not
implemented. It arrives later "as another option" and must not drag anything
else in with it.

---

## 1. What is generic and what is Codex, today

### 1.1 Generic, and already in the right place

`voice_poc/presentation.py` contains no reference to Codex. The room policy is
harness-neutral in substance:

| Concern | Where | Note |
| --- | --- | --- |
| Durable transcript + outbox | `voice_poc/room_history.py:19-31` | SQLite, one table, `id` UNIQUE |
| Crash recovery policy | `room_history.py:54-58` | in-flight → `uncertain`, never resent |
| Delivery loop | `presentation.py:363-389` | drains `journal.pending()` |
| Audio epochs / staleness | `presentation.py:181-254` | `revision` + `utterance_id` |
| Playback receipts | `presentation.py:731-756` | from the browser, not from synthesis |
| Channel closure | `presentation.py:455-479` | persisted membership + room-control message |
| Language / voice settings | `voice_poc/language_settings.py` | catalog-driven |
| Browser synthesis | `voice_poc/browser_audio/` | no macOS dependency |

The test suite is the strongest asset here: the 28 cases in
`voice_poc/test_presentation.py` exercise this policy against `hub` and
`PresentationCall` directly, with the gateway mocked
(`test_presentation.py:244`). **The generic layer is already testable without
any harness.** That is most of the work, and it is done.

### 1.2 Generic, but leaked into the adapter

These are room policies re-implemented inside harness-specific processes:

| Leak | Codex | Claude draft |
| --- | --- | --- |
| Duplicate suppression by `message_id` + content fingerprint | `desktop_gateway.mjs:209-221` | `claude_channel/server.mjs:74-83` |
| Text length ceiling | `:199` (12000) | `:73` (12000) |
| `revision` validation | `:202` | `:73` |
| Participant registration file | `:274-282` | `:43-46` |
| Room activation call | `:131-146` | `:26-29` |
| The envelope the agent reads | `:213-216` (JSON header + `\n\n` + text) | `:78-80` (notification `meta`) |

Two observations that decide §4:

1. **Both dedup maps are in-memory** (`desktop_gateway.mjs:17`,
   `server.mjs:11`). They do not survive a restart — which is precisely the
   failure they exist to cover. Their protection is illusory.
2. **The envelope differs per harness**, which is why the agent-facing contract
   exists twice: `skills/voice-presentation/SKILL.md` (136 lines) and
   `experiments/claude_channel/instructions.md` (32 lines), saying nearly the
   same thing in different words. That duplication, not the code, is the
   expensive one — it is prose that must stay semantically identical across
   harnesses with nothing enforcing it.

### 1.3 Generic, but shaped by Codex inside the server

The room does not *name* Codex, but it hard-codes Codex's shapes:

- `presentation.py:551` — `gateway_url` must match `^http://127\.0\.0\.1:[0-9]{1,5}$`.
  Same regex again at `:626`, `:663`, `:706`.
- `presentation.py:659`, `:702` — participant identity must match
  `[a-f0-9-]{36}`. That is a Codex thread id's shape, enforced by the room.
- `presentation.py:348`, `:622` — participant discovery is a glob over
  `.voice-poc/gateways/*.json`, a directory the adapter writes into. The room
  and the adapter must share a filesystem.
- `presentation.py:142` — default gateway `http://127.0.0.1:8769`.
- `bot.py:134` — the call's `session_id` is `webrtc_connection.pc_id`, a Pipecat
  object identifier, and `desktop_gateway.mjs:202` validates its *string shape*
  (`/^SmallWebRTCConnection#[0-9]+-[a-zA-Z0-9]+$/`). The adapter is coupled to
  the room's audio library.

### 1.4 Genuinely Codex, and correctly so

Roughly 60 lines of `desktop_gateway.mjs` are irreducibly harness-specific:
`appRequest` framing (`:31-60`), tool catalogue lookup (`:61-66`, `:83-89`),
caller metadata extraction (`:67-76`), identity confirmation via `read_thread`
(`:131-135`), and the single call that delivers input,
`send_message_to_thread` (`:218`).

### 1.5 Not the adapter, despite the name

- `voice_poc/adapter.py` — the `SessionAdapter` Protocol (`:6-9`) is implemented
  by nothing and referenced by nothing (`DemoSession` is the legacy demo
  worker). The file named `adapter.py` is not the adapter boundary. The real
  boundary is an undocumented HTTP contract between `presentation.py` and a
  gateway process.
- `desktop_gateway.mjs` is **two products in one file**. The room uses exactly
  three of its endpoints: `/identity`, `/activate`, `/presentation/message`.
  Everything else — the MCP proxy of Codex's whole app-tool catalogue
  (`:103-130`), task watches (`:173-192`), `/voice/state` and `/voice/poll`
  (`:232-253`) — belongs to task orchestration and is consumed only by the
  legacy `thread_monitor.py:61,70`, `codex_llm.py:45` and
  `task_channel.py:25`.
- `presentation.py:158-179` (`PresentationCall.deliver_inputs`) is dead. It is
  never called — `bot.py:130` sets `delivery = None` and never assigns it — and
  its queue is only fed when `self.journal is None` (`:144-151`), which
  `hub.attach` (`:520`) prevents. It is a second, orphaned delivery policy
  inside the server.
- `codex_llm.py`, `control.py`, `thread_monitor.py`, `adapter.py`, `terra.html`
  and `launch.py` are the superseded "terra" operator. None of them sit on the
  voice-room path (`bot.py:83`, `is_presentation` → `NoInference()`), yet
  `bot.py:26-34` imports them all unconditionally, so the room server cannot
  start without the MLX-era dependency set, and `control.py:16` reads
  `CODEX_HOME` at import. This is why the product still looks macOS-bound.

---

## 2. The proposed boundary

Five operations, one of them reserved. Stated as a contract rather than as HTTP
routes, because the transports will not be identical.

The important discovery, and the one that answers "can this be generic first":
**four of the five are ordinary MCP and need no harness-specific code at all.**
Only operation 2 — getting text *into* a running conversation — is genuinely
per-harness, and even it has a generic implementation (§2.1).

**The adapter owes the room:**

1. `attach(credential, session_ref, title)` → `participant_id`.
   The adapter proves *which working session it is* and enrols it. The
   harness-native identifier becomes an attribute of the participant, not its
   primary key.
2. `next_input(participant_id, cursor)` → `{message_id, channel, revision,
   correlation, text}` or nothing.
   **The adapter asks. The room never dials the adapter.** Cursor-based, so a
   reconnection resumes without replay.
3. `ack(participant_id, message_id, outcome)` where `outcome ∈ {accepted,
   rejected, unknown}`.
   The outcome is about *the harness*, never about a human having read it —
   `docs/ARCHITECTURE.md` already states that distinction and it survives.
4. `publish(speech)` — the agent-to-room speech API, unchanged and identical
   across harnesses, as the README already claims.
5. *Reserved, not implemented:* `interrupt(participant_id)` — stop the agent's
   **work**, not its audio (§0). Reserved here so that the day it lands it is a
   fifth operation on an existing contract rather than a reason to reopen it.
   `docs/ARCHITECTURE.md` already records that no harness exposes a native stop
   for another session, so this stays a placeholder until one does.

**The adapter owns, and nobody else may:**

- proving session identity in the harness's own terms;
- handing the text to the harness (`send_message_to_thread` /
  `notifications/claude/channel`);
- retrying *its own* harness call under the same `message_id`;
- normalising the harness's answer into the three outcomes above.

**The room owns everything else**, including the things currently leaked:
ordering, duplicate suppression, size limits, the outbox, the retry policy, the
envelope the agent sees, and participant discovery.

Operation 2 is the whole change. Everything else follows from it.

### 2.1 Day 1: plain MCP, no local process anywhere

There is exactly one thing a harness cannot do generically: receive text it did
not ask for. Everything else — joining, publishing speech, reporting outcomes —
is a tool call, and tool calls are standard MCP over a standard remote
transport.

So the day-1 design is a **single remote MCP server, hosted by the room itself**,
with three tools:

| Tool | Maps to | Generic? |
| --- | --- | --- |
| `join(title)` | op 1 `attach` | yes |
| `listen()` | op 2 `next_input`, **held open** | yes |
| `speak(text, session_id, revision, utterance_id, language)` | op 4 `publish` | yes |

Install, in full, on any MCP-capable harness:

```
claude mcp add -t http sidevoice https://<room>/mcp -H "Authorization: Bearer <token>"
```

Nothing is cloned, nothing is spawned, nothing has to be kept alive, and the
room is remote **by construction** rather than as a later port. Most of §5.1 is
answered by not being assumed: the room never dials anyone, there is no shared
filesystem, the bearer token is the credential, and `participant_id` is issued
by the room.

#### This is push, not polling

`listen()` is **not** a "are we there yet" loop. The agent calls it once; the
server holds the request open and sends nothing; the instant a voice message
lands in the room, the server writes it down the connection that is already
open and the call returns. Latency is the network, not a poll interval. That is
push — it is how push over HTTP worked before WebSockets, and streamable-HTTP
MCP responses are an SSE stream, so the transport already supports holding one
open.

The honest residue: the *agent* must re-issue `listen()` after each message it
receives, and again whenever the held window expires. That is not a poll loop,
but it is not nothing either — it is one tool call per message plus one per
window. Two things make it cheap:

- **Long windows.** The MCP SDK's 60 s default request timeout is reset by
  progress notifications, so the server can hold a call open for tens of
  minutes while pinging. One re-issue per half hour of silence is noise-level in
  context terms.
- **Piggyback delivery.** Every Sidevoice tool result is a delivery vehicle.
  When the agent calls `speak()` mid-task, the response carries any pending
  input with it. This matters more than it sounds, because the skill *already*
  mandates speaking: a spoken acknowledgement before substantive work, and brief
  spoken updates during it (`SKILL.md:36-49`). So during exactly the long stretch
  where the agent is not parked in `listen()`, it is calling `speak()` every
  minute or two, and each of those calls delivers.

#### Heartbeat and presence, for free

The held connection **is** the heartbeat, and it runs in the right direction
without adding a mechanism:

| Room's view | How it knows |
| --- | --- |
| listening | a `listen()` request is in flight for this participant |
| working, reachable | no `listen()`, but a tool call within the last N seconds |
| gone | held request's connection dropped, or silence past N seconds |

Server-side this is one future per participant, resolved by the outbox; the
progress pings keep the SDK's clock from firing and double as liveness. The
room can finally show **"nobody is listening"**, which today it cannot tell —
it only knows whether a gateway answered `/identity` at some point
(`presentation.py:355`).

`ack` (op 3) largely dissolves here too. The agent receiving the message in a
tool result *is* the acknowledgement; there is no harness API that might or
might not have taken it. Cursor-advance-on-next-`listen()` still covers a
response lost in flight, but `uncertain` stops being the common outcome.

#### What is genuinely still missing

One case, and only one: **the agent is working, in silence, not parked in
`listen()` and not calling `speak()`** — deep inside a long tool loop. Then the
message waits until it next surfaces. Nothing in standard MCP fixes that: a
server cannot inject text into a conversation the agent is not asking about,
which is precisely why Channels exists as an extension (§2.3).

And that gap is narrower than it sounds. `docs/ARCHITECTURE.md:51-52` already
records that "responses may wait while the working agent is busy. There is no
independent instant-response interlocutor." Today's Codex push does not deliver
true mid-work interruption either — it delivers into the harness's queue without
the agent's cooperation, and the agent still reads it when it comes up for air.

### 2.2 Surviving a restart

A held-open call is a connection, and connections die: the sidecar redeploys,
the network blips, the window expires. The question is what heals by itself and
what needs the model's cooperation. The split is precise, and only one of the
three links is model-dependent.

**Link 1 — the MCP session heals itself, by specification.** Streamable HTTP
assigns an `Mcp-Session-Id` at initialisation. "The server **MAY** terminate the
session at any time, after which it **MUST** respond to requests containing that
session ID with HTTP 404 Not Found… When a client receives HTTP 404 … it
**MUST** start a new session by sending a new `InitializeRequest` without a
session ID attached." So a server restart forces the *client* to re-initialise,
and that is mandated client behaviour, not something we implement or the model
decides. The spec is also explicit that "disconnection **SHOULD NOT** be
interpreted as the client cancelling its request."

Resumability exists too — servers may tag SSE events with `id`, clients may
resume with `Last-Event-ID`, and the server may replay from there. Both sides
are **MAY**, so this is a bonus, not a foundation. Whether Claude Code
implements it is unverified (§9.7).

**Link 2 — the message survives, because it is on disk, not in the
connection.** The outbox is already SQLite (`room_history.py:19-31`) and already
has restart recovery (`:54-58`). Under this design a dropped connection leaves
the message `pending`; the next `listen()` delivers it from the cursor. **A
restart costs latency, not data.** It is in fact *simpler* than today's story,
because nothing was handed to an external API that might or might not have taken
it — the `uncertain` ambiguity does not arise.

This imposes one hard requirement, and it moves earlier than §7 step 7 had it:
**the room must be able to reconstruct everything from disk.** Outbox,
participants and their tokens in SQLite, on a persistent volume. The current
code is the opposite pattern in three places — the single in-memory call
(`presentation.py:516-518`), a one-line binding file (`:18-27`), and the
in-memory dedup maps — and all three have to go anyway.

**Link 3 — re-arming `listen()` does not heal itself.** This is the one
genuinely model-dependent link, and no amount of MCP fixes it: only the agent
can issue a tool call. Four things reduce it from a single point of failure to a
nuisance:

1. **Never return an error where a result will do.** Window expiry returns a
   normal success — `{status: "idle", listen_again: true}` — not an exception.
   A model that receives an error tends to report a problem and stop; a model
   that receives a routine result with an explicit continuation flag tends to
   continue.
2. **Piggyback heals it for free.** Pending input rides on *every* tool result
   (§2.1). So a failed re-arm is repaired by the agent's next `speak()` —
   which, during real work, the skill mandates every minute or two
   (`SKILL.md:36-49`). The agent does not have to notice anything was wrong.
3. **The failure is never silent.** No `listen()` in flight means the room shows
   **nobody is listening**, and the person who would be talking is looking
   straight at that room. Compare today, where the room cannot tell at all.
4. **Bounded retry in the instructions** — re-arm with backoff, a few times,
   then say so once and stop. This is prompt-dependent and therefore the weakest
   of the four; it is a mitigation, not a guarantee, and should be written down
   as such.

**If a real guarantee is wanted, it costs a local process.** Something that is
not the model has to do the retrying, forever, without being asked. That is
exactly what a Channels shim or the Codex gateway is (§2.3). Worth noting
because it reframes the push upgrade: it does not only close the silent-work
gap, it is also **the only way reconnection stops depending on the model's
cooperation**. Two separate reasons pointing at the same later step.

### 2.3 Later: the push upgrade

Push replaces **operation 2 and nothing else**. `join`, `speak`, the outbox, the
cursor and the acks stay exactly as they are, which is what makes it an upgrade
rather than a second implementation — and what makes the choice of when to do it
free.

A parallel design review (Codex/GPT, 2026-09-14) proposed going straight here
and skipping §2.1. It contributed two corrections that are adopted below, and
made three assumptions this document does not share (§2.4).

#### Inbound has three shapes, not two

| Shape | Who holds the connection | Local process | Where it applies |
| --- | --- | --- | --- |
| **A. Held-open MCP call** (§2.1) | the agent, inside `listen()` | none | any MCP-capable harness |
| **B. Local connector** — **chosen, §2.5** | a process on the harness's machine, outbound WSS to the room | one per host | every harness; the last mile differs |
| **C. Server-to-server** | the room calls the harness's public control API | none | harnesses that expose one (e.g. cloud/hosted agents) |

Shape C is worth naming because it is the *only* case where the room dialing
outwards is fine — the target is a public API, not a laptop behind NAT. It is
the inverse of assumption 1 in §5.1, and it fails for exactly the same reason
the current design fails: it only works when the callee is reachable.

#### The connector, if and when it is built

Two corrections adopted from the parallel review, both of which improve on what
this section said before:

1. **One connector per host, multiplexing bindings — not one per conversation.**
   A single outbound WSS carries N `(room, conversation)` bindings, each event
   tagged with both IDs. The current code does the opposite: one gateway process
   per Codex thread, each registering its own file
   (`desktop_gateway.mjs:274-282`). One process per host is strictly better.
2. **Split the harness-spawned MCP process from the long-lived connector.** The
   harness starts and kills its MCP server whenever it likes; a persistent
   connection cannot live in something with that lifetime. So: a thin stdio MCP
   that the harness owns, talking over a local socket to a separate connector
   that owns the WSS. This is a genuinely better answer than "either nothing
   local, or the harness owns it", which is what this section previously said.

#### The lifecycle cost, which is real

A connector spawned by a short-lived process and outliving it is a self-managed
daemon, whatever it is called. Orphans, stale sockets, version skew between an
MCP and the connector it spawned, and cleanup after a crash are all on the
table. "It exits by itself after a grace period" is the classic claim that does
not survive contact. The evidence is in this repository:
`activate_voice.mjs:24-34` is a pidfile, a liveness probe and a lock, written
precisely because this is hard — and that is for the *simpler* one-per-thread
case.

This is not an argument against the connector. It is the reason it belongs at
step 5–6 rather than step 2: it should be built when the `listen()` path has
shown which of its guarantees are actually missing in practice.

### 2.4 Where this document disagrees with the parallel review

Recorded so the disagreement is inspectable rather than absorbed.

**1. "MCP does not replace the local connector; something near the harness is
required to receive a push."** This is the substantive disagreement. It is true
only if inbound must arrive unsolicited. A held-open `listen()` (§2.1) is push
with ~0 latency over standard remote MCP and no local process at all. The
parallel review does not consider that shape. Consequence: its day 1 requires
shipping and installing two executables on every harness machine — and, for a
harness already living in a container, adding them to that image — where §2.1
requires one configuration line.

The fair counter, which this document accepts: the connector survives the
model's non-cooperation, which is link 3 in §2.2 and the one weak link in
§2.1. That is a real advantage. It is an argument about *sequencing*, not about
the destination — and since push replaces only operation 2, starting at §2.1
discards nothing.

**2. Channels are treated as simply another option.** They are not. Research
preview, not on Anthropic's curated allowlist, launched with
`--dangerously-load-development-channels`, a full-screen warning on first run,
and blockable outright by Team/Enterprise policy (§3.2, all verified against the
primary documentation). Any plan that routes Claude through Channels on day 1
ships to a subset of Claude users. That is precisely why §7 puts them at step 6.

**3. The Cursor claims are unverified here, and expand scope.** The parallel
review asserts a Cursor Cloud follow-up API, ACP over stdio with
`session/prompt`, and `cursor-agent --resume <chat-id>`. None of these has been
checked in this repository or against primary sources; they are recorded as
claims, not facts (§9.8). Separately, §0 fixed the scope with the operator:
deliver a voice message into the live conversation, and nothing else. A
server-to-server Cursor Cloud adapter is a fourth harness and a new inbound
shape — worth knowing about, not worth building before steps 0–4 exist.

**4. A connector-only inbound path is a single point of failure.** In the
parallel review's design there is no `listen`: inbound exists only through the
connector, so if the connector is down there is no inbound path at all. In
§2.1 inbound rides the same channel as everything else, so it fails exactly
when `speak` fails and not before. Worth weighing in both directions — the
connector is more robust against the model, less robust against itself.

**Where the two agree completely**, and it is most of it: a remote server as the
control plane; all generic state there; only the last mile per harness; client
initiates reconnection with backoff; re-registration replays from the last
acknowledged event; events carry IDs and acknowledgements so nothing duplicates
or is lost; heartbeat detects offline fast but the real guarantee is persistence
plus ack plus reconcile; no Docker on the developer's machine; one install
command. That convergence, reached separately, is worth more than the
disagreements.

---

### 2.5 The decision, the two open questions, and the first cut

**Settled by the operator, 2026-09-14: shape B.** A local stdio MCP façade that
the harness owns, one multiplexed outbound connector per host that outlives it,
and the room as a remote control plane. The skill carries *behaviour* (how to
speak, when, in which language); the MCP carries *operations*; `voice_connect`
is what ensures the connector exists; only the last mile — how a delivered
event reaches a Codex, Claude or other conversation — is per harness. The
connector exits on its own after the last binding is removed. Presence comes
from the connection and a heartbeat, and the room UI shows a conversation as
offline when it is — at which point the operator tells that conversation to
reconnect. That is the design, and commit `6b98a8a` is its first cut.

What this trades away, stated once: §2.1's zero-install path as the *primary*
transport. It is kept as a documented fallback (§8) because, until the
connector has proven its lifecycle, it is the only inbound path that survives a
connector outage — the adversarial pass made that point and it holds. There is now
something to ship to every harness machine (D1 is back on the critical path,
step 5), and on Claude the last-mile receiver is a Channels server (D2 is back
on the critical path, step 7). What it buys is the two things §2.2 could not
give: reconnection that does not depend on the model, and inbound that does not
require the agent to be parked in a call.

#### Q1 — local MCP, not remote?

**Local — for this design.** The façade's job is to start or reuse a process on
*this* machine and talk to it over a Unix socket (`connector/mcp.mjs:21-26`),
and a remote MCP server cannot spawn anything on the harness's host. That is an
architecture choice, not a protocol necessity: a remote MCP plus a separately
installed local connector service is defensible, but then the connector needs
its own control path and its own installer, which is the same local footprint
with an extra moving part. The local façade is the smaller answer. So `claude mcp add sidevoice -- npx -y @sidevoice/uplink` (or the
equivalent Codex `mcp_servers` entry) is a **stdio** registration, not an HTTP
one. The remote half is the control plane the connector dials
(`SIDEVOICE_CONTROL_URL`, `connector.mjs:11`), never something the harness
talks to directly.

#### Q2 — install through the server, or through npm?

Both, with a clear split, and this is the recommendation rather than an open
choice:

- **npm is the artifact.** `connector.mjs` and `mcp.mjs` ship as one published
  package, run by `npx -y @sidevoice/uplink@<exact>`, exactly the Voice Mode
  shape. Versioned, cached, relocatable, no checkout anywhere. This is D1
  option **B** in §3.4 — settled by the operator on 2026-09-14, *not* C: no
  Sidevoice tool writes into another tool's configuration. Each harness is
  installed on its own terms by whoever owns it.
- **The installer is the user's own agent, reading a standard document.** The
  repository carries an agent-readable install guide — one file, one section
  per harness, each with the exact config entry to add, the environment it
  needs, where the path-free skill goes, and a verification step
  (`voice_status`). The intended use is literally "here is the repo, install
  this", and the agent does it inside its own harness. (Some MCP marketplaces
  have converged on a file named `llms-install.md` for exactly this; the name
  is a convention worth adopting, not a requirement — unverified here.)
- **The room is the pairing step, as text.** The room UI shows the finished
  snippet for a given harness — `SIDEVOICE_CONTROL_URL` plus a one-time pairing
  code — and the agent pastes it where its own harness keeps such things. No
  Sidevoice process touches that file.
- **Versions need not match.** The connector and the room evolve separately:
  `connector.hello` carries a protocol version, the room accepts a stated
  compatible range, and `voice_status` tells an old connector it should be
  bumped. Pinning is per harness, done by hand by whoever installed it; there
  is no lockstep and no auto-update.

A server-served `curl … | sh` that *installs* code is the alternative, and it
is worse: it makes the room a software distributor, couples install to room
availability, and re-creates the checkout-pointer problem of §3.1 with extra
steps. Keep code in npm and configuration in the pairing step.

Two precisions the adversarial pass added, both accepted: **pin the version** —
`npx -y @sidevoice/uplink` resolves whatever is latest at run time, so
"versioned" is not reproducible unless the MCP entry names an exact version
(`@sidevoice/uplink@1.2.3`) and whoever installed it bumps it by hand; and
**a pasted token is a credential lifecycle**, not a config value — pairing
should be a one-time exchange (a short-lived code shown by the room, redeemed
once by the connector for its long-lived credential), with rotation and
revocation on the room side. A static token copied into an MCP config file has
neither.

The behaviour contract travels in two places, deliberately: the MCP
`initialize` result carries `instructions` (the operational minimum — call
`voice_connect` on request to join, `voice_say` for every spoken presentation,
never activate as a side effect), and the skill carries the conversational
rules that are today in `skills/voice-presentation/SKILL.md`, path-free. The
commit sets neither (`mcp.mjs:53`); see finding 8.

#### What commit `6b98a8a` implements

| File | Role in the design | Lines |
| --- | --- | --- |
| `connector/mcp.mjs` | stdio façade; four tools; spawns/reuses the connector over `~/.sidevoice/connector.sock` | 61 |
| `connector/connector.mjs` | one outbound WebSocket per host; `bindings` map; reconnect with backoff; re-announces bindings on open; POSTs deliveries to a per-binding `delivery_url` | 100 |
| `voice_poc/connector_control.py` | server side: `/api/connectors/ws`, durable `connector_events` table, replay of pending on `binding.register`, exact-event acknowledgement | 125 |
| `connector/README.md`, `docs/ARCHITECTURE.md` | contract description; explicit that nothing is wired to the live room yet | — |
| two tests | see finding 10 | — |

It is a faithful skeleton of §2.3 and it makes the right structural calls:
outbound-only from the host, one process per host, durable events on the
server, replay after reconnect, exact-event acks, liveness by socket rather
than pidfile. The findings below are about what is missing between skeleton
and product, ordered by how much they matter.

#### Findings, most severe first

1. **Neither direction reaches the room yet.** The room's outbox
   (`presentation.py:363-389`) still posts to loopback gateways and never calls
   `/api/connectors/{binding}/deliver`; and the control plane's receive loop
   (`connector_control.py:73-97`) has no branch for `speech.publish`, so a
   `voice_say` arrives at the server and is **silently dropped**. Today: no voice
   in, no speech out, through this path. `docs/ARCHITECTURE.md` says "not yet
   wired"; it should also say the outbound half is unimplemented server-side.
2. **A second outbox.** `connector_events` (`connector_control.py:32-34`) sits
   beside `room_history.messages` (`room_history.py:19-31`): two tables, two
   owners for "has this input been delivered". This is the exact thing §4 argued
   against. One of them must own delivery state; the natural answer is that the
   room's journal gains `binding_id`/`event_id` and the control plane *is* the
   room's delivery path, not a parallel one.
3. **The heartbeat exists on neither side as an initiator.** The connector
   *answers* a `heartbeat` (`connector.mjs:45`); the server *answers* a
   `heartbeat` (`connector_control.py:96-97`); nobody ever sends one. Presence
   is therefore "a socket once registered this binding" (`:123`,
   `binding_id in control.bindings`), which is registration, not liveness — a
   WSS through a proxy can sit half-open for minutes. This is precisely the
   signal the operator asked for and it is the missing piece. Fix:
   server-initiated ping with nonce every N s, connector marked dead after K
   misses, its bindings dropped, UI shows the conversation offline.
4. **One shared secret for everything, and bindings can be hijacked.** A single
   deployment token authorises `connector.hello`, `/deliver` and `/status`
   (`connector_control.py:36-39,77,115,121`). `binding_id` is chosen by the
   client and `binding.register` simply overwrites ownership (`:89`), so any
   connector holding the token can register someone else's binding and receive
   its deliveries; `/deliver` accepts any binding id. Fix: the server mints
   binding ids on register; the pairing step (Q2) mints per-connector
   credentials; ownership is checked on register/unregister/publish;
   `/deliver` is an internal call from the room, not an endpoint guarded by
   the connector token.
5. **`voice_say` while disconnected loses the speech and says it didn't.**
   `send()` drops silently when the socket is not open (`connector.mjs:21-23`);
   `publish` then returns `queued_for_reconnect` (`:78`) with nothing queued.
   Fix: a connector-side durable queue for `speech.publish`, keyed by
   `event_id`, replayed after `connector.hello` — the mirror of the server's
   replay.
6. **A failed delivery stalls until an unrelated reconnect.** A non-2xx from
   `delivery_url` throws (`connector.mjs:55`), which sends `connector.error`
   (`:38-39`) but **no `input.ack` with a failure status** and starts no retry;
   the server replays only on `binding.register` (`connector_control.py:85-90`)
   or when a new event is queued. A transient harness hiccup leaves the
   utterance pending indefinitely. Fix: ack `{status:'failed'}`, server-side
   retry with backoff, replay on every `connector.hello`.
7. **Identity is model-asserted again, and so is the delivery target.**
   `conversation_id` defaults to `CODEX_THREAD_ID` (`mcp.mjs:13,37`) — Codex
   leaking into the generic façade — and otherwise comes from the tool argument,
   i.e. from the model, the §5.2 weakness reproduced. `delivery_url` is likewise
   a model-supplied argument the connector will POST to (`connector.mjs:49`).
   Both should be resolved by the façade from the harness adapter it was
   installed for, never passed by the model.
8. **No `instructions` in `initialize`** (`mcp.mjs:53`). The operational
   contract has a standard place to travel and it is empty (Q2).
9. **The token can go over plaintext.** `SIDEVOICE_CONTROL_URL` is not
   validated (`connector.mjs:11,15`) and the token rides in the `hello` body
   (`:25`). Require `wss://` unless the host is loopback.
10. **The tests do not test the transport.** `test_connector_contract.cjs`
    greps the source for identifiers (`:5-15`); it passes with a broken
    connector. `test_connector_control.py` covers durability and the credential
    check — good — but not replay-on-register, ownership, or the WebSocket
    handler. Findings 1, 3, 5 and 6 would all pass both suites.
11. **Dead bindings live forever — on the connector side.** Nothing
   unregisters when a harness session dies; the connector keeps the binding and
   the 15 s idle exit (`connector.mjs:14,58-61`) never fires. *Corrected after
   the adversarial pass:* the server does **not** keep replaying past a socket
   drop — it discards that connector's bindings on disconnect
   (`connector_control.py:100-103`); the stale-`delivery_url` case only bites
   while the WebSocket stays up. Fix unchanged: bindings as leases the façade
   renews. The concurrency claim was wrong in the other direction — see 15.
12. Minor: a third copy of the 12 000-character limit (`connector_control.py:19`,
    cf. §1.2); Unix-socket path on Windows (`connector.mjs:10,97`); `hostId` is a
    hash of the hostname (`:13`), fine in a pod, unverified on shared laptops.

Five more from the adversarial pass, each re-checked here against the lines
cited:

13. **Any connector can acknowledge — and thereby delete — another binding's
    event.** `input.ack` updates by `event_id` alone
    (`connector_control.py:63-67`, called at `:94-95`) with no check that the
    event belongs to the acknowledging connector. With the shared token
    (finding 4) a connector can mark a stranger's utterance `accepted` without
    delivering it. Ownership on ack is part of step 2.
14. **Delivery is unordered and unbounded.** The server sends every pending
    event at once (`connector_control.py:46-52`) and the connector handles each
    WebSocket message as an independent async `receive` (`connector.mjs:38`),
    so two voice turns race to the harness and a large replay fans out into
    unbounded concurrent POSTs. Per-binding serialisation and bounded replay go
    with step 4.
15. **Pathname takeover, not `EADDRINUSE`.** Every connector unconditionally
    unlinks the socket path before listening (`connector.mjs:97-99`), so two
    façades that both find no socket (`mcp.mjs:21-24`) both spawn, and the
    second *replaces* the first's socket while the first stays connected
    upstream with its own binding map: two connectors, one reachable. The
    singleton needs a lock the second respects, not a `rm -f`.
16. **A connector with zero bindings never exits.** `ensure()` runs before the
    conversation id is validated (`mcp.mjs:35-40`), and `scheduleExit()` is only
    ever called from `unregister` (`connector.mjs:58-61,73`) — never at startup.
    One malformed `voice_connect` leaves a permanent reconnecting daemon that
    never had a binding.
17. **The local IPC trusts every same-user process and has no request bound.**
    The Unix socket accepts any newline-delimited JSON from any client
    (`connector.mjs:84-94`); the directory is `0700` (`:96`) so other *users*
    are excluded, but any process under the same account can register a
    hostile `delivery_url`, publish speech, or hold memory by withholding a
    newline. Whether same-user processes are trusted is an assumption the design
    should state; a buffer cap costs one line either way.

None of these argues against the direction. 1–4 and 13 are what separate a
skeleton from something the room can rely on; 14–16 are what separate it from
something that stays up. Their order in §7 is the adversarial pass's, not the
one this document first proposed.

---

### 2.6 The harness matrix, and the generic tier

Raised by the operator at the go/no-go: with §2.5 as written, Codex works
only through the Desktop app's socket — a Codex CLI session in this pod would
not. The requirement is broader: Codex Desktop, Codex CLI, Claude Code in all
its surfaces, and "in general", with **one user action per conversation and no
per-user registration**.

The fact underneath, stated plainly because it is what feels ugly: **there is
no generic way to push text into a running conversation.** The only capability
every harness shares is MCP tools — the agent *pulling*. So inbound has exactly
two tiers, and the contract hides which one is in use:

| Harness | Outbound `voice_say` | Tier 2 — native push | Tier 1 — generic |
| --- | --- | --- | --- |
| Claude Code (CLI, IDE, desktop-embedded) | MCP | **the session's own messaging socket**, inherited by the stdio façade (§2.7); Channels as fallback (§3.2) | `voice_listen` |
| Codex Desktop | MCP | **`codex queue`** if Desktop threads live on the shared daemon (§2.8, §9.16); else the app tool socket (§9.1) | `voice_listen` |
| Codex CLI | MCP | **`codex queue --thread <id>`** on the shared local app-server daemon (§2.8) | `voice_listen` |
| any other MCP-capable harness | MCP | — | `voice_listen` |

**Tier 1 is §2.1's held-open call, moved inside the connector.** `voice_listen`
becomes the fifth façade tool: it blocks until the connector receives an
`input.deliver` for this binding, then returns the message; if the window
expires it returns `{status: "idle", listen_again: true}` — a result, never an
error. The room pushes down the WSS as before; the connector's delivery target
for that binding is simply "whoever is parked in `voice_listen`" instead of a
`delivery_url`. Everything else — the WSS, the bindings, presence, credentials,
the outbox, the acks — is shared with tier 2. The agent re-arms after each
message; pending input piggybacks on every `voice_say` result during the
working stretch (§2.1). Where tier 2 exists the agent never parks at all.

**How the agent knows which tier it is on:** `voice_connect` returns
`{delivery: "push" | "listen"}`. The façade knows, because the per-harness
section of the install document (§2.5 Q2) says whether a push adapter was
enabled for that harness. The `instructions` string carries one rule: *if
`delivery` is `listen`, call `voice_listen` after every reply.* One user
action — "join the voice room" — and the conversation works, on any harness.

**What it costs, unchanged from §2.1:** a parked turn looks busy in the UI; the
re-arm depends on the model's discipline, mitigated by piggyback and by the
room showing "nobody listening" when no call is parked; window length is
bounded by the harness's MCP tool timeout (Claude: progress notifications
reset it; Codex CLI: unverified, §9.13). Tier 2, where it exists, removes all
three — which is why it stays worth building.

**This is also the answer to the connector's weakest point.** §2.2 link 3 said
re-arming depends on the model; §2.4 said a connector-only inbound is a single
point of failure. With both tiers behind one contract, each covers the other's
failure: if the push adapter is down, `voice_listen` still works; if the model
forgets to re-arm, push still lands.

*Rejected by the operator, 2026-09-14: no parked call, "prefiero directamente
los sends específicos de Claude y Codex". Tier 1 is not built. Inbound is
tier 2 only — §2.7 on Claude, §2.8 on Codex — and a harness with neither
gets outbound speech but no inbound until it grows a session inbox of its
own. Kept here as the record of why.*

---

### 2.7 The Claude last mile that was there all along

Found 2026-09-14 while answering "does Claude have nothing like `SendMessage`?"
— it does, and it is not Channels. Everything below was verified on this pod
against Claude Code 2.1.270 unless marked otherwise.

**Every Claude Code session runs a Unix-socket inbox.** The session's own
environment carries `CLAUDE_CODE_MESSAGING_SOCKET` (e.g.
`/tmp/cc-socks/<pid>.sock`, directory `0700`) and
`CLAUDE_CODE_MESSAGING_TOKEN`. Sessions register in
`~/.claude/sessions/<pid>.json` — `sessionId`, `cwd`, `version`,
`peerProtocol: 1`, `peerFeatures: [notify_idle, …]`, `messagingSocketPath`,
`name`, `status: busy|idle` — with a sibling `<pid>.<sha256>.key` holding the
token for peers. This is what the `ListAgents`/`SendMessage` tools use to let
one session message another on the same machine.

**The protocol is spelled out by the binary itself**, as a debug hint
(`[uds-messaging] Inject messages (auth line REQUIRED here)`): newline-delimited
JSON, first `{"type":"auth","token":"<TOKEN>"}`, then
`{"type":"user","message":{"role":"user","content":"…"}}` — the same user
shape as stream-json — piped with `socat - UNIX-CONNECT:<sock>` or `nc -N -U`.
The message arrives in the session **as a user-role message**, wrapped in
`<cross-session-message from="…">`. The receiver vets the sender by uid
(`ownerUids`, `verifiedPeerProcStart`). The hint is written for exactly our
use: an external process injecting a user message into a running session.

**The façade inherits all of it.** Tested: a stdio MCP server spawned by
Claude Code via `--mcp-config` received `CLAUDE_CODE_MESSAGING_SOCKET`,
`CLAUDE_CODE_MESSAGING_TOKEN` (32 chars) and `CLAUDE_CODE_SESSION_ID` of the
session that spawned it. So `voice_connect` on Claude needs **no argument**:
the façade already knows which session it is (harness-asserted identity — the
§5.2 weakness closed) and hands the connector the socket path and token as
that binding's delivery target. The connector delivers by writing two lines.

**What this buys over Channels (§3.2):** no `--dangerously-load-development-
channels`, no first-run warning, no allowlist, no org-policy gate, no separate
channel process; the `instructions` string still travels via the MCP
`initialize` result. It works in the CLI, in IDE-embedded sessions and in
anything that spawns the façade — the same surfaces the socket serves.

**What it costs, stated once:** it is **private IPC**, exactly like Codex
Desktop's app socket — a debug hint is not a public API, the file layout and
the frame shape can change with a release, and `peerProtocol` is already
versioned, which is the tell. It is the same class of "hack" the operator
accepted for Codex, with a much smaller footprint. Pin the Claude Code version
range the adapter was verified against and check `peerProtocol` on connect.

**Verified 2026-09-14, by the production path:** a throwaway session
(stream-json, stdin held open, idle after one turn) was given a stdio MCP
server that recorded its inherited socket and token; a separate Node process
then connected to that socket, wrote the auth line and a user message, and
the idle session **ran a new turn on its own** (one `result` before, two
after). That is the connector's exact code path, end to end, with nothing
assumed.

**Hooks are a complement, not an inbound path** (verified in the hooks
reference): a `Stop` hook that exits 2 "prevents Claude from stopping,
continues the conversation", with its stderr or JSON `reason` shown to the
model — so pending voice can be delivered at the end of every turn without the
model's cooperation; `UserPromptSubmit` stdout becomes context Claude "can see
and act on". But **no hook fires while Claude is idle**, so hooks cannot wake a
session. They can replace the piggyback-on-`voice_say` trick for the working
stretch; they cannot replace the socket or `voice_listen`.

*Accepted by the operator, 2026-09-14 ("socket en vez de channels sin duda
mejor"): the Claude adapter is the messaging socket; Channels is the
fallback. §9.14 exercised the same day — see the Method section.*

---

### 2.8 The Codex counterpart: `codex queue`

Found by the operator on 2026-09-14, in parallel with §2.7. Verified here on
codex-cli 0.153.2:

- `codex queue --thread <uuid|session name> --message <text>` — "Queue a
  message for an existing session". It resolves the thread on the **shared
  local app-server daemon** (`codex agents` browses the same daemon;
  `codex app-server daemon` manages it; `--listen unix://PATH | ws://IP:PORT`
  is its transport) and `--remote unix://PATH | ws://…` points `queue` at a
  different app-server, with `--remote-auth-token-env` for a bearer token.
- Semantics, from the binary's own strings: implemented in
  `tui/src/session_queue_commands.rs` ("Queued message … for thread …",
  "No active session found matching …"); the app-server's turn processor
  distinguishes **steer** (inject into the active turn) from **queue**
  ("thread already has an active or pending turn", "resume the thread before
  starting a queued message"); the TUI composer offers "Queue the draft while
  a task is running". So a queued message is delivered as the **next user
  turn** — immediately if the thread is idle, after the current turn if busy.
  That is precisely the delivery the room wants; steer is what `interrupt()`
  (§0, reserved) would use later.
- Exercised here without a tty against a non-existent id: `codex queue`
  ran, reached the daemon and failed only at the lookup —
  `thread/queue/add failed: failed to read thread: … no rollout found for
  thread id …`. So the command needs no terminal (unlike `codex agents`,
  which is a TUI), it is a JSON-RPC call to the daemon, and it resolves the
  target in the thread store. A connector can call it from a background
  process.
- Identity on Codex is already harness-asserted: Codex passes the calling
  thread in MCP `tools/call` `_meta` (`openai/threadId`,
  `x-codex-turn-metadata`), which `desktop_gateway.mjs:67-76` parsed before it
  was slimmed. The façade reads it from the `voice_connect` call; the model
  supplies nothing.

**What it retires, if §9.16 holds:** the entire app-tools-socket bridge —
`CODEX_APP_TOOLS_PIPE_PATH`, the 4-byte framing, `send_message_to_thread`, the
app's bundled signed Node, `activate_voice.mjs`'s pidfile dance. §1.4 becomes
one `codex queue` invocation from the connector.

**Unverified — the Mac decides (§9.16, §9.17):** whether Codex **Desktop**
threads are hosted on that shared daemon (or expose an app-server socket that
`--remote unix://…` can reach), and whether a queue into an idle CLI session
starts a turn. Two commands with a Desktop thread open: `codex agents` — is
the thread listed? — then `codex queue --thread <id> --message "ping"` — does
it appear in the app?

**Taken together with §2.7, tier 2 stops being "two hacks".** On both
harnesses the last mile becomes *the harness's own session inbox*: a Unix
socket the façade inherits on Claude, a CLI verb on a local daemon on Codex.
Both are private and version-bound; neither needs a research-preview flag, a
signed runtime, or a model-asserted identity.

*Proposed as the Codex tier-2 adapter; pending the Mac check.*

---

## 3. Thread 1 — how the client-side binary is delivered

> Since §2.5 the connector is the product, so this section is back on the
> critical path: it decides how `mcp.mjs` + `connector.mjs`, the Codex last
> mile and the Claude channel server ship. §2.5 Q2 already gives the answer
> (npm artifact + room-side pairing); what follows is the reasoning behind it.

### 3.1 Judgment on `scripts/install-codex-skill.py`

Sixteen lines. It copies `skills/voice-presentation/SKILL.md` into
`$CODEX_HOME/skills/voice-presentation/`, substituting `__SIDEVOICE_ROOT__`
with the absolute path of this checkout (`:14-15`).

It does not hold up, for reasons visible in the code:

- **It installs a pointer, not an artifact.** The installed skill tells the
  agent to run `"<abs>/voice_poc/activate_voice.mjs"` (`SKILL.md:21`),
  `"<abs>/voice_poc/voice_channel.py"` (`:80,91`) and to read
  `"<abs>/voice_poc/browser_audio/catalog.json"` (`:67`). The installed copy is
  frozen text pointing at a *moving* checkout: `git pull` changes the behaviour
  of something that was "installed", with no reinstall and no version.
- **It cannot install the part that matters.** A skill is prose for a model. The
  bridge is a long-running process. `install-codex-skill.py` copies one markdown
  file and zero executables.
- **The macOS runtime path is not even templated.**
  `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node`
  (`SKILL.md:21`) is a literal. An app update means editing a generated file.
- **The fork has already started.** The script is Codex-only by name and by
  `CODEX_HOME` (`:7`). There is no Claude equivalent; `launch.sh.example` is a
  hand-written shell sketch whose own README admits the MCP configuration "still
  needs to be generated".
- Minor: backups accumulate in `$CODEX_HOME/skill-backups/` forever (`:9-11`)
  and nothing reads them.

What it *gets right*, and what should be kept: the agent-facing contract has to
be installed where the harness looks for skills, and it has to be a disposable
copy that reinstalling repairs.

**The mistake is conflating the two deliverables.** The skill is the agent
contract; the bridge is code. Templating a filesystem path is what welds them
together.

### 3.2 How a Claude channel is actually installed and started

This is the part that was missing, so it is written out rather than summarised.

**A channel is not a special kind of program.** It is an ordinary MCP server
that declares one extra capability. Three facts from the documentation decide
the install story:

1. **It is registered like any other MCP server** — an entry in `.mcp.json`
   (project) or `~/.claude.json` (user):
   `{"mcpServers": {"sidevoice": {"command": "npx", "args": ["-y",
   "@sidevoice/claude"]}}}`. "Claude Code reads your MCP config at startup and
   spawns each server as a subprocess." So yes: **a script can install it**, and
   the install is one config entry plus one thing that can be executed.
2. **Claude Code starts it, we do not.** "Claude Code spawns your server as a
   subprocess … You don't need to run the server yourself." It stays alive for
   the whole session and idles until the user asks to join the room.
3. **It carries its own instructions.** "Claude Code delivers the `instructions`
   string to Claude as context when the server connects." The draft already does
   this (`server.mjs:13,15`). **On Claude, no skill file has to be installed at
   all** — the agent-facing contract ships inside the server package and is
   delivered automatically. That is a genuine simplification over the Codex
   side, and it removes one of the two things `install-codex-skill.py` exists to
   do.

**What it costs, in terms a user sees — this is what D2 is asking you to
accept:**

- Custom channels are not on Anthropic's approved allowlist during the research
  preview, so the user cannot just run `claude`. They must run
  `claude --dangerously-load-development-channels server:sidevoice`.
- On that launch, Claude Code shows a **full-screen warning dialog** listing the
  development channels being loaded, which the user must accept ("I am using
  this for local development"), plus the ordinary new-MCP-server consent prompt.
- An organisation policy (`channelsEnabled`) can refuse it outright — the
  documented failure is "blocked by org policy" — and Team/Enterprise admins
  must enable channels before anyone there can use Sidevoice at all.
- The allowlist is Anthropic-curated at its discretion; publishing to a
  community marketplace does not get you onto it.

None of that is a coding problem. It is the shape of the install instructions,
how alarming they look, and which users are allowed to follow them. Accepting
D2 means accepting that Sidevoice-on-Claude ships with a `--dangerously-` flag
in its README until the preview ends.

### 3.3 The asymmetry that shapes the answer

The wish — *that a script install and start it, and that the skill be able to
run it* — works on Codex and **cannot** work on Claude:

| | Codex Desktop | Claude Code |
| --- | --- | --- |
| Who starts the bridge | the skill shells out, on demand (`SKILL.md:21` → `activate_voice.mjs`) | Claude Code, at session startup, from the MCP config |
| When it can be installed | any time, including mid-session | before the session starts |
| Agent-facing contract | a skill file that must be installed (`SKILL.md`) | the server's own `instructions` string, delivered automatically |
| Can a skill install it? | yes, and does today | it can write the config, but the session must then restart |

A skill runs *inside* an already-started session. By then Claude has already
spawned its channels, or not. So on Claude the order is **install → restart →
join**, never join → install. On Codex it stays **install once → join on
demand**.

This asymmetry is the strongest argument for a single installer that knows both
shapes, rather than two scripts that each know one.

### 3.4 Options

**Precedent worth copying.** Voice Mode (`mbailey/voicemode`) installs exactly
as B/C below: `claude mcp add --scope user voice-mode uvx voice-mode` — a
published package, run by a runner, one command, no checkout anywhere. Its
bootstrap is a second published entry point (`uvx voice-mode-install`). Node's
equivalent of `uvx` is `npx -y <package>`. That is the shape described as
"install it and that's it", and it is option B with C's installer on top.

| | Approach | Cost | What it buys |
| --- | --- | --- | --- |
| **A** | Status quo: per-harness installer templating an absolute checkout path | Zero now. Requires the repo cloned on every harness machine; breaks silently on move; one installer per harness; nothing versioned | Nothing new |
| **B** | Publish to npm; the MCP config and the skill name a package, not a path | Publishing pipeline, semver discipline, npm org | Versioned, relocatable; `claude mcp add … npx -y @sidevoice/claude` becomes the whole Claude install |
| **C** | **A `sidevoice` CLI on B's rails**: `sidevoice install --harness codex\|claude`, `sidevoice bridge`, `sidevoice doctor` | B's cost plus a CLI surface with its own compatibility promise | One place that knows the two shapes in §3.3; kills the per-harness installer fork; `doctor` diagnoses exactly the items in §9 |
| **D** | Compiled single binary (bun/deno compile), fetched by an install script | Per-platform build matrix, macOS notarisation, larger artifact | Removes the Node dependency — which neither target harness actually lacks |

### 3.5 Recommendation

**C, built on B.** One npm package; `sidevoice install --harness claude` writes
the MCP entry and prints the `--dangerously-load-development-channels` launch
line; `sidevoice install --harness codex` writes the skill and replaces
`scripts/install-codex-skill.py`; `sidevoice bridge` is the long-running local
process. No `__SIDEVOICE_ROOT__` anywhere. D is unjustified while both harnesses
already require a Node runtime.

If the CLI feels like too much surface for now, **B alone is a legitimate
stopping point**: the Claude install genuinely is one `claude mcp add` line, and
the Codex install stays a small script. C only pays for itself at the moment
both exist and start to drift.

This was **operator decision D1**. Settled 2026-09-14 as **B, not C**: the
operator does not want a Sidevoice tool editing other tools' configuration —
"prefiero que cada uno gestione su harness como quiera". The installer role C
would have played goes to the user's own agent, guided by a standard document
(§2.5 Q2).

---

## 4. Thread 2 — where the generic lives

**Answer: absorb it into the server.** The argument is not preference:

1. **The generic is already in the server.** §1.1. What sits outside is five
   specific behaviours (§1.2), not a layer.
2. **The duplicated copies do not work.** Both adapter dedup maps are in-memory
   (`desktop_gateway.mjs:17`, `server.mjs:11`) and die with the process. They
   defend against a restart, during a restart.
3. **They defend against a retry the system does not perform.** The room's
   stated invariant is never to retry an uncertain mutation
   (`presentation.py:159`, `:346`, `room_history.py:55`). Given that, adapter-side
   suppression guards nothing that currently happens.
4. **Duplication is already producing divergence**, in the most expensive place:
   the agent-facing envelope and therefore the agent-facing prose, which now
   exists in two files that must mean the same thing with nothing checking.
5. **Absorbing is what the network change enables.** Once the adapter *asks* for
   input instead of accepting unsolicited writes (§2, operation 2), ordering,
   idempotency, limits and retry policy have exactly one possible home. The
   adapter has no inbox to deduplicate.

The fair counter-argument, stated: adapter-side suppression is defence in depth,
and it becomes genuinely useful the day the room adopts at-least-once delivery —
which §5 argues it must, over a network. That is a real point, and it does not
change the answer: the guard belongs at the *harness call*, keyed by
`message_id`, inside the adapter's own retry loop (§2, bullet 3) — not as an
HTTP-layer map in front of an endpoint that will no longer exist.

One piece must **not** be absorbed: everything in §1.4. Absorbing the harness
call into the server is what would make the server macOS-bound.

Two clean-ups fall out of the same decision: delete the dead second delivery
path (`presentation.py:158-179`), and move participant discovery from a shared
filesystem glob (`:348`, `:622`) into the SQLite the room already owns — because
a glob over a shared directory is not implementable across two machines at all.

---

## 5. Thread 3 — the Claude adapter across a network

### 5.1 Assumptions that break

| # | Assumption | Evidence | What breaks |
| --- | --- | --- | --- |
| 1 | The room can open a connection to the adapter | `presentation.py:551,626,663,706` (loopback regex), `:355`, `:374`, `:610`, `:670` | A harness in a pod behind NAT is not dialable. This is the load-bearing one |
| 2 | Room and adapter share a filesystem | `presentation.py:348,622` glob; `desktop_gateway.mjs:274-282`, `server.mjs:43-46` write | No shared volume across machines; participant discovery returns nothing |
| 3 | Presence in the registry is authorisation | `desktop_gateway.mjs:205-208` delivers to *any* thread with a record; `presentation.py:345-361` picks *any* live gateway advertising `durable_delivery` | On loopback, a local-trust shortcut. On a network, an open relay — and it is the exact cross-harness misrouting `experiments/claude_channel/README.md:11-12` warns about. Nothing reads the `harness` field that `server.mjs:45,68` writes |
| 4 | Loopback *is* the authentication | No credential anywhere. `/identity` and `/presentation/message` unauthenticated; `presentation.py:606` rejects any request that *has* an `Origin`; `:760` compares it to the base URL | An absent `Origin` header is not an identity; every non-browser client passes. Unusable off loopback |
| 5 | The correlation key is the audio library's object id | `bot.py:134` (`pc_id`), validated by shape at `desktop_gateway.mjs:202` | Any transport change breaks the adapter; a reconnect mints a new identity mid-conversation |
| 6 | One room, one call, one process, local disk | `presentation.py:516-518`, `:18-27` (single binding file), `.voice-poc/` | A sidecar serving a remote agent has no reason to be single-call, and loses its state on redeploy without a volume |
| 7 | Session identity is a 36-char lowercase-hex UUID | `presentation.py:659,702`; `activate_voice.mjs:5`; `server.mjs:31` | A harness whose ids have another shape is rejected by the *room*, not by its adapter |
| 8 | The agent can shell out to the room on loopback | `voice_channel.py:19` | From a pod, `127.0.0.1:8767` is the pod's own loopback — nothing, or something else |
| 9 | Leaving a delivery `uncertain` forever is safe | `room_history.py:54-58`; never retried | Correct when the link is a loopback socket and a failure means a crash. Over a network, a routine blip silently loses a user's utterance |

### 5.2 What the boundary must add

**Session identity.** The room must stop accepting a self-asserted id. Today it
verifies by dialing the adapter back and comparing `instance_id`
(`presentation.py:609-616`) — a callback proof that dies with assumption 1.
Replacement: an operator-provisioned enrolment credential; the room mints
`participant_id`; the harness-native id becomes an attribute. This also removes
assumptions 3 and 7.

Note the asymmetry to fix while doing it: the Codex bridge takes identity from
its *process environment* and confirms it with the app (`desktop_gateway.mjs:
131-135`), whereas the Claude draft takes it **from the model** and validates
only that it is a UUID (`server.mjs:31`; `instructions.md:5-6` asks the model not
to invent one). Model-asserted identity is not identity.

**Authentication.** One shared secret per deployment as the floor; a
per-participant token issued at enrolment. The Claude side maps onto something
already supported: `claude mcp add -t http … -H "Authorization: Bearer …"`
(verified). `Origin` checks come out entirely — they are CSRF protection for the
room's *browser* UI and were never authentication for the adapter.

**Reliable delivery when the transport cuts.** Input already lives in the
server's outbox. The adapter drains it with a cursor and acks; the cursor does
not advance without an ack. That converts today's at-most-once into
at-least-once, which is only safe because `message_id` idempotency moves to the
harness call itself (§4). `unknown` stays a first-class outcome and stays
visible in the UI — the room already models it (`status='uncertain'`).

**Who retries: the adapter, never the room.** Only the adapter can distinguish
"the network lost my request" from "the harness took it and I lost the
response". The room cannot, which is exactly why it currently refuses to retry
at all. Inverted, that knowledge is local: the adapter reissues its own harness
call under the same `message_id` and only then acks. The room's job shrinks to
not advancing the cursor and not inventing an outcome.

**Scope warning.** None of this makes the room remotely *usable*. The
browser↔room leg is WebRTC against a loopback-bound Pipecat server
(`start.sh:21`) with `PIPECAT_ICE_SERVERS` defaulting to `[]`
(`presentation.py:525`). HTTPS, TURN/STUN and room access control are a parallel
track. Fixing the adapter boundary does not deliver it, and the plan should not
be sold as if it did.

---

## 6. Judgment on the Claude draft: base, with its transport discarded

**Keep** — it is a faithful instance of the documented channel contract, and it
is the part that is genuinely hard to rediscover:

- capability declaration `experimental['claude/channel']` (`server.mjs:14-16`);
- the push itself, `notifications/claude/channel` with `content` + `meta`
  (`:78-80`), matching the documented event shape;
- `speak` as a reply tool (`:20`), which is exactly the documented two-way
  pattern;
- `--dangerously-load-development-channels server:voice-room`
  (`launch.sh.example:5`), which is the documented research-preview invocation.

That is roughly forty lines, and they are correct.

**Discard** — all of it is the §5.1 assumption set, reproduced:

- It **listens on a port for the room to dial** (`:64-87`, bound to loopback at
  `:88-89`). Assumption 1, in the one component whose entire purpose is to work
  from somewhere else.
- It writes into the **shared-filesystem registry** (`:43-46`). Assumption 2.
- It re-implements **in-memory dedup** (`:74-83`). §4.
- It **reports a receipt it cannot have**: `{status:'sent'}` after awaiting
  `mcp.notification()` (`:84-85`). The documentation is explicit that this await
  resolves on *transport write*, and that a session which has not loaded the
  channel drops events silently with no error. The room records that as
  `delivered`. Under the new contract this is `unknown` at best — and this one
  is a correctness bug, not a style point.
- Identity taken from the model (`:31`). §5.2.
- A **second copy of the agent contract** in `instructions.md`. §1.2.

**Two product-level risks the operator must accept knowingly, not discover
later:** Channels are a research preview, custom channels are not on the
approved allowlist and require a flag whose name is `--dangerously-…`, and Team
and Enterprise organisations must enable them explicitly. And the draft has
never been run against a live model — its own README says so, and nothing in
this plan changes that until step 6.

One cheap experiment is still worth running before step 6: **does the
`claude/channel` capability work over a non-stdio transport?** If it does, the
local shim disappears for Claude entirely and D1 collapses to "Codex only". The
documentation says stdio and same machine; it does not say the alternative was
tried. An afternoon answers it — though it is now the *second* experiment to
run, behind the blocking-poll test in §9.6, which the whole of day 1 rests on.

---

## 7. Execution order

Re-sequenced around the connector (§2.5), then re-ordered once more by the
adversarial pass: persistence first, credentials second, wiring third — never
wire a shared-token endpoint that is already mounted. Each step leaves the tree
working.

0. **Delete everything the room does not use.** D4 and D5, unchanged.
   **Done 2026-09-14** (uncommitted, branch `plan/adapter-boundary`): 22 files
   removed; `bot.py` rewritten as a presentation-only server with no TTS in
   the pipeline; `desktop_gateway.mjs` slimmed to `/identity`, `/activate`,
   `/presentation/message` with the receiver byte-identical to `6b98a8a`
   (Codex socket still unverifiable here — operator check on the Mac);
   `requirements.txt` without MLX now installs on Linux. Baseline before →
   after: Python 53 → 44 OK (exactly the 9 deleted tests), Node 35 → 25 OK
   (exactly the 10 task-watch tests). Original scope:
   - *Legacy terra operator:* `codex_llm.py`, `control.py`, `adapter.py`,
     `terra.html`, `launch.py`, `persona.md`, `codex_reply.schema.json`, their
     tests, the `is_codex` branch and unconditional imports in
     `bot.py:26-34,83-121,225`, and the MLX half of `requirements.txt`.
   - *Task orchestration (§0):* `task_watch.mjs`, `task_channel.py`,
     `test_task_watch.mjs`, `thread_monitor.py`, and `desktop_gateway.mjs:23-30,
     103-130, 173-192, 232-253`.
   - *Native TTS backends:* `local_tts.py`, `kokoro_tts.py`, `pocket_tts.py`,
     `kokoro_worker.py`, `voice_preview.py` and their tests (check
     `voice_preview.py` is not on the settings-page path first).
1. **One outbox, one participant model, on disk that survives** (finding 2 +
   §1.3 + §2.2). **Done 2026-09-14:** `room_history.py` owns `messages`
   (now with `attempts`/`next_attempt`), `connectors`, `pairing_codes` and
   `bindings` in the one SQLite file; server-minted binding ids; the
   `connector_events` table, the filesystem registry, the loopback and UUID
   regexes and the dead `deliver_inputs` are gone. Volume placement is a
   deployment setting (step 8) — the path is one constant. Fold `connector_events` into the room's journal:
   `room_history.messages` gains `binding_id` and `event_id`; the control plane
   reads and acknowledges *that* table. Bindings and their owning connector in
   SQLite too, with **server-minted** binding ids. The SQLite on a persistent
   volume from this step, not at deployment time — "durable" that lives on a
   pod's ephemeral disk is not. Drop the UUID regex (`presentation.py:659,702`),
   the loopback URL regex (`:551,626,663,706`), the filesystem glob (`:348,622`)
   and the dead `deliver_inputs` (`:158-179`). The old loopback gateway path
   keeps working until step 6 by enrolling itself as a binding.
2. **Pairing, credentials and ownership** (findings 4, 7, 9, 13, 17). **Done
   2026-09-14:** one-time pairing code from the room UI redeemed by
   `sidevoice pair` for a per-machine credential (hash stored); `connector.hello`
   authenticated and protocol-checked; ownership enforced on register,
   unregister, publish and **ack**; identity and delivery target come from the
   harness (Claude: inherited env; Codex: MCP `_meta`), never from the model;
   `wss://` required off loopback; the local IPC has a size bound. — *before*
   anything is wired, because the endpoint is already mounted in the room
   process (`bot.py:227-228`) and wiring it under a shared token would make
   binding takeover and cross-binding acks reachable from the first day.
   One-time pairing exchange mints per-connector credentials (§2.5 Q2);
   ownership checked on register/unregister/publish **and ack**; `/deliver`
   becomes internal; `wss://` required off loopback; `conversation_id` and
   `delivery_url` resolved by the façade from its installed adapter, never from
   the model; a request bound on the local IPC. Remove `Origin`-as-auth for
   adapters, keep it for the browser UI. Only now can the room bind to
   something other than `127.0.0.1`.
3. **Wire both directions** (finding 1). **Done 2026-09-14, verified end to
   end:** the room's journal is drained by the control plane over the
   connector's WebSocket; `speech.publish` becomes `hub.publish`. A message
   queued in the journal reached a live Claude Code session through its socket,
   woke it, and its `voice_say` came back into the room's history. The room's
   delivery loop calls the control plane in-process — no HTTP self-call — and
   `speech.publish` on the WebSocket becomes `hub.publish` with the same
   `session_id`/`revision`/`utterance_id` semantics `presentation.py:391-429`
   already enforces. The connector's delivery target for a binding is a
   harness send — `claude-uds` (§2.7), `codex-queue` (§2.8) or `http` (the
   slimmed bridge, as fallback) — chosen by the façade from what it was
   spawned by. At the end of this step a voice message reaches a Claude
   session on this pod end to end, and a `voice_say` reaches the browser,
   under credentials.
4. **Presence, ordering and reliability** (findings 3, 5, 6, 11, 14, 15, 16).
   **Done 2026-09-14:** server-initiated heartbeat with nonce, dead connectors
   dropped after two misses and their bindings freed; one delivery in flight
   per binding; failure acks and backoff retry (2/5/15/60 s); ack timeout;
   replay on reconnect; connector-side durable outbox for speech; bindings
   tied to the façade's IPC connection (no leases needed — the façade dies
   with the session); file-lock singleton; idle exit armed at start. Tested
   over a real WebSocket on both sides (8 Python + 5 Node tests).
   Server-initiated heartbeat with nonce; dead-connector detection drops its
   bindings and the room UI shows the conversation offline; per-binding
   serialised delivery with bounded replay; failure acks and server-side retry
   with backoff; replay on every `connector.hello`; a connector-side durable
   queue for outbound speech; bindings as renewable leases; a real singleton
   lock instead of `rm -f`; idle exit armed at startup. D3's at-least-once
   lands here: `event_id` idempotency at the harness adapter. **Test this over
   a real WebSocket**, not by grepping source (finding 10).

   *At this point the transport is trustworthy. Everything below is shipping
   and last miles.*

5. **Package, document, pair** (§2.5 Q2; D1 settled as B). **Done except
   publication:** `connector/package.json` (`@sidevoice/uplink`, one
   `sidevoice` bin: `mcp|pair|connector`), `instructions` in `initialize`,
   protocol version in `hello`, `docs/INSTALL.md` written for the agent, the
   skill path-free, `scripts/install-codex-skill.py` retired. Publishing needs
   the operator's npm scope. One npm package
   with `mcp.mjs` and `connector.mjs`, pinned by whoever installs it;
   `initialize` carries `instructions` (finding 8); a protocol version in
   `connector.hello` with a compatibility range on the room; an agent-readable
   install guide with one section per harness; the room UI emits the pairing
   snippet as text; the skill becomes path-free. Retire
   `scripts/install-codex-skill.py` — its job is now the document.
6. **Codex push adapter (tier 2).** **Done:** `codex-queue` adapter and
   `_meta` identity; operator-confirmed against Codex Desktop; the app-socket
   bridge deleted. Originally: the façade takes the
   thread id from MCP `_meta` and the connector delivers with
   `codex queue --thread <id> --message …` (§2.8); `desktop_gateway.mjs` and
   `activate_voice.mjs` are deleted. If it does not: `desktop_gateway.mjs`
   stays as the receiver behind `delivery_url` — the ~60 lines of §1.4 plus `/presentation/message` — and
   the façade resolves that URL itself. *(Socket behaviour: still unverified
   here, §9.1.)*
7. **Claude Code push adapter (tier 2).** **Done and verified end to end
   2026-09-14.** The stdio façade hands the connector
   its inherited `CLAUDE_CODE_MESSAGING_SOCKET`, token and `CLAUDE_CODE_SESSION_ID`
   at `voice_connect`; the connector delivers by writing the auth line and a
   user message to that socket (§2.7). No separate receiver process, no
   Channels flag; identity comes from the harness, not the model. Ack =
   "socket accepted the frame" — written, not read, stated as such. Check
   `peerProtocol` on connect and pin the verified Claude Code range. **Run the
   §9.14 wake-on-idle one-liner first.** Channels (§6) stays as the fallback if
   the socket path proves unstable across releases.
8. **Remote deployment hardening.** HTTPS, TURN/STUN for the browser leg, room
   access control. (The persistent volume moved up to step 1.) The browser↔room
   leg is a separate network problem from the connector leg and none of the
   above solves it.
9. **Strip the published documentation.** `docs/development-history/` (7
   files), the product detail in `README.md` and `docs/ARCHITECTURE.md`, and
   this plan with them — scaffolding, not documentation. Last.

---

## 8. Decisions

### Settled 2026-09-14

**Architecture — local MCP façade + per-host multiplexed connector + remote
control plane. Settled by the operator; first cut in `6b98a8a`.** Recorded in
§2.5 with the two open questions answered: the MCP is local (stdio), the
artifact is npm, the pairing is served by the room. §2.1 stays in the document as a
**documented fallback**: nothing to install, and the only inbound path that
survives a connector outage — kept until the connector has proven its
lifecycle (findings 14–16), and subject to the unverified point in §9.6 about
holding a call open concurrently with agent work.

**D3 — Guarantee that the message arrives. Settled: at-least-once.**
Now concretely: durable `event_id`s on the server, exact-event acks from the
connector, replay on reconnect, retry on failure, idempotency at the harness
adapter (step 3). `README.md` and `docs/ARCHITECTURE.md` still document the old
at-most-once invariant and change with it.

**D4 — Retire the terra operator. Settled: delete, not archive.** Extended to
everything the room does not use; step 0 enumerates it.

**D5 — Task orchestration is not part of Sidevoice. Settled: out, and
deleted.** §0 records the scope; `interrupt()` stays reserved in §2.

**D1 — How the client-side piece ships. Settled: option B.** npm package,
pinned per harness by whoever installs it; installation done by the user's own
agent from a standard document in the repo; pairing delivered by the room as
text to paste; connector and room versions independent behind a protocol
version. Explicitly *not* C: no Sidevoice tool writes another tool's
configuration. Unblocks step 5.

**Generic tier (§2.6) — rejected 2026-09-14.** No `voice_listen`; inbound is
the harness-specific send on each side. **Claude via the messaging socket
(§2.7) — settled 2026-09-14**, Channels demoted to fallback; D2 as accepted
earlier now names the fallback. **Codex via `codex queue` (§2.8) — settled
in principle**, the Mac check (§9.16) decides whether the app-socket bridge is
deleted or kept behind the connector as an `http` delivery kind. Operator's
framing for all of it: *the connectors are the least of it — they are meant to
be simple and replaceable*; the room, the outbox, the credentials and the
presence are what must be right.

**D2 — Claude via Channels, Codex via the app socket. Settled 2026-09-14, as
"what exists today".** The operator accepts the research-preview terms for
Channels (`--dangerously-load-development-channels`, the first-run warning,
org-policy gating) and keeps the Codex Desktop app-socket bridge as the Codex
last mile, both explicitly as interim: "luego buscaremos formas mejores". Two
constraints attached: **the conversation must appear in the harness's own UI**
— which both mechanisms satisfy, since each injects into the user's live
interactive session rather than a headless one (the §2.5 Q2 follow-up rejected
the headless alternative for exactly this reason) — and **nothing specific to
any orchestration layer above the harness**: the design targets Claude Code
and Codex Desktop directly. Unblocks steps 6–7.

### Still open

**Codex last mile via `codex queue` (§2.8) — settled, confirmed by the
operator on 2026-09-14 ("confirmadísimo").** `desktop_gateway.mjs` deleted;
the whole app-tools-socket bridge (§1.4) is gone. The `http` adapter kind
stays as a generic receiver path for harnesses with no session inbox.

**D6 — Plaintext transcripts and outbox in SQLite.** Raised by the operator:
the journal stores what the user said and what the agent answered in clear, on
the room's disk; the connector's `~/.sidevoice/outbox.json` holds unsent speech
the same way (mode 0600). Accepted for a first version; the operator will
confirm the policy later. Options, cheapest first:
1. *Retention* — delete message text once delivered and played (keep ids and
   status). Conflicts with "persistent room history", so it becomes a setting.
2. *Application-level encryption* of the `text`/`payload` columns (e.g. Fernet
   with a key from the deployment's secret store); the outbox is decrypted only
   to deliver. Key management is the real cost; SQLite itself stays plain.
3. *Encrypted volume* on the sidecar — operational, no code, protects at rest
   but not from anyone who can read the running process.
4. Access hygiene regardless: DB file mode 0600, volume not shared, credential
   tokens already stored hashed.
Recommendation when it comes up: 1 as a setting plus 2 for what remains.

**D7 — Package name. Settled 2026-09-14: `@sidevoice/uplink`** (operator: "llámale
como quieras"). It is the piece next to the agent that carries voice *up* to the
room; the bin stays `sidevoice`. Checked free on npm; the `sidevoice` scope
needs an npm org of that name, created when the publishing token is (tracked in
the publishing issue). Unscoped fallback if the org is taken: `sidevoice-uplink`.


### What execution needs from the operator

- **A go for implementation.** The original brief was planning only; §7 is the
  order to execute, starting at step 0, and it needs an explicit yes.
- **A Mac with Codex Desktop for steps 0 and 6.** The app socket cannot be
  exercised in this pod (§9.1). The Codex bridge will be slimmed blind, keeping
  its `/presentation/message` receiver byte-for-byte, so the operator's check
  reduces to "does the old thing still work".
- **A Claude Code session launched with the development-channels flag for step
  7.** This can run in the pod; it needs the operator's account to be allowed
  channels (org policy) — one launch tells.
- **Nothing else until step 5** (an npm scope name) **and step 8** (where the
  room is deployed). Steps 1–4 run entirely on loopback.

---

## 9. Unverified register

Carried forward so these are not silently promoted to facts:

1. Codex Desktop app tool socket: env var, framing, and the semantics of
   `send_message_to_thread`, `read_thread`, `wait_threads`, `tools/list`
   (`threadStartKind`) and the turn-metadata keys at `desktop_gateway.mjs:71-73`.
   Read from this repo's client code only; never exercised here.
2. Whether the app's bundled signed Node runtime can execute a network-fetched
   package. Affects D1.
3. Whether `claude/channel` is honoured over WebSocket or streamable-HTTP MCP.
   Affects D1 and D2 (§6).
4. Whether a channel server receives the Claude session identity from its
   environment. Affects §5.2.
5. Everything about the Claude draft's runtime behaviour: never run against a
   live model, per `experiments/claude_channel/README.md:6-8`.
6. **Whether a held-open `listen()` call behaves** — the one thing day 1 (§2.1)
   rests on. Four sub-questions, all answered by the same stub MCP server with
   one sleeping tool, in an afternoon, before any of step 2 is written:
   - how long a streamable-HTTP MCP response can actually be held open by each
     harness before something times it out;
   - whether the client sends a `progressToken`, without which the server cannot
     send the progress pings that reset the clock and act as heartbeat. If it
     does not, windows shorten to the 60 s default — workable, just more
     re-issues;
   - how a parked turn looks in the UI, and whether typing while parked behaves
     sanely;
   - what one re-issue per window actually costs in context over an hour.

   Note these are *comfort and tuning* questions, not feasibility ones: the
   design degrades to shorter windows rather than failing.
7. **What each harness's MCP client does when a held stream dies** — whether it
   implements `Last-Event-ID` resumability (the spec makes it **MAY** on both
   sides, so it may simply not), and whether the in-flight request surfaces to
   the model as an error or as nothing at all. §2.2 is designed not to need
   resumability, but the answer decides how link 3's mitigations are worded.
8. **The parallel review's Cursor claims** (§2.4): a Cursor Cloud follow-up API,
   ACP over stdio with `session/prompt`, and `cursor-agent --resume <chat-id>`.
   Recorded as claims. Cursor is out of scope per §0, so these need checking
   only if that scope changes.
9. **Node 22's built-in `WebSocket` client behind corporate proxies.**
   `connector.mjs:36` uses the global client with no proxy handling; whether it
   honours `HTTPS_PROXY` (the underlying `undici` implementation historically
   did not) decides whether the connector works from a laptop on a corporate
   network. Not checked here.
10. **Whether Claude Code surfaces `instructions` from a plain MCP server's
    `InitializeResult`.** The channels reference confirms it for channel
    servers; §2.5 Q2 assumes it for the stdio façade too. Not confirmed for
    non-channel servers.
11. **Whether an MCP client keeps a held-open tool call alive while the agent
    does other work.** §2.1's fallback value depends on it and the adversarial
    pass rightly flagged it as unverified in this repository. Same stub server
    as §9.6 answers it.
12. **Whether Codex CLI has any push path into a running session.** The
    `codex app-server` JSON-RPC protocol is what the Desktop app and IDE
    extension use to drive threads; whether an external process can attach to
    a thread the user already has open in the TUI is not verified here. If it
    can, it is a tier-2 adapter for Codex CLI; if not, Codex CLI is tier 1.
13. **Codex CLI's MCP tool-call timeout** and whether progress notifications
    reset it. Decides `voice_listen`'s window on Codex CLI; degrades to shorter
    windows, not to failure.
14. ~~Whether an injected uds message wakes an idle Claude Code session.~~
    **Verified 2026-09-14** (§2.7): it does. The recipe below is kept for
    re-verification after Claude Code upgrades:
    `{ echo '{"type":"auth","token":"'"$T"'"}'; echo '{"type":"user","message":{"role":"user","content":"Reply PONG"}}'; } | socat - UNIX-CONNECT:/tmp/cc-socks/<pid>.sock`
    with `$T` from that session's `~/.claude/sessions/<pid>.<sha>.key`, then
    watch its stdout for a new turn.
15. **Stability of the uds-messaging layout across Claude Code releases.** It
    is private IPC with a `peerProtocol` number; nothing promises the frame
    shape, the registry fields or the socket directory. Same standing as
    Codex's app socket (§9.1).
16. ~~Whether Codex Desktop threads are hosted on the shared local app-server
    daemon~~ — **confirmed by the operator on 2026-09-14** (Codex `queue`
    reaches Desktop threads) — or expose an
    app-server socket reachable with `--remote unix://…`. Only checkable on the
    Mac with the app running: `codex agents`, then
    `codex queue --thread <id> --message "ping"`. Decides §7 step 6.
17. **Whether `codex queue` into an idle CLI session starts a turn.** The
    strings say it is the next user turn; not exercised here (the TUI needs a
    tty and this pod has none to spare for it).
