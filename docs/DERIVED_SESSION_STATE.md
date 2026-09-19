# Derived session state (#53)

The controller previously conflated harness activity, the input turn awaiting a
reply, and ambient playback in `workingTurn` / `presenceTurn`. Reasons passed to
`stopPresence` decided both a UI fact and an output action; every handler had to
remember `syncBed`. The new store records independent facts and computes the
answer once. The controller is an adapter for sockets, browser resources and
commands; React and its audio effect subscriber consume the same snapshot.

## State and projections

| Facts owned by the session store | Pure projection |
| --- | --- |
| Per-conversation harness `true` / `false` / absent; per-turn receipts, delivery deadline and settled replies; session and selection | Working dots. Either harness boolean is authoritative; absent reports use unsettled turns of this session and conversation. A reply settles only its own session/revision fallback turn; bubble history IDs remain separate. |
| User speech, room speech, active playback, preview, connection and switching | Speaker: user / room / nobody. Conversation: working / speaking / idle. Tab: reconnecting / switching / out / transcribing / listening. |
| Working, speaker, playback/preview, device presence preference | Ambient breath iff working and quiet, with a connected, stable tab; default on, fixed amplitude `0.1`. |
| Join step, progress, detail, returning conversation and failure | Join line, progress and alert status. |
| Applied engine preferences, actual runtime/fallback, output health | Engine badge and recovery/failure mark; editing preferences does not mislabel the engine already running. |
| Observed microphone AEC, sink type and paused state, connection | Echo coverage light; this claims observable coverage, never detector effectiveness. |
| Selected and viewed threads, active input, cancellation, history, receipts, playback, karaoke and replay marks | Waveform ownership, pending text, transcript order, cancellation, two ticks, replay/audio notes, participant selection and unread counts. |
| Server session existence, asker connection/focus/revisions/speech, current audience | `publication_decision`: destination, effective audio revision, denial reason and whether audio may wait for quiet. |

`room-session-state.js` has no DOM, storage, audio engine or clock reads. Its
store exposes the snapshot/subscription API consumed by Zustand's React hook.
The controller's writable top-level fact facade publishes immutable snapshots;
nested records are replaced. `batch()` commits synchronous protocol transitions
and speech cancellation/replacement atomically. Browser handles are opaque,
unpersisted resources; their observed properties are recorded before projection.
A deadline timer records a clock fact. One subscriber starts/stops the ambient
engine, including when settings, previews or asynchronous playback change.
The start effect guards synchronous engine notifications against re-entry.

A live speech job has an adapter identity separate from its observable playback
facts. Late playing/cue/completion callbacks from cancelled jobs cannot restore
speech. The engine is cancelled before silence is published, so its existing
sink repair happens before ambient audio resumes. Replayed audio does not settle
a live conversational turn.

## Loading and tests

Production still lazy-loads the controller through `RoomProvider` after the React
shell mounts. The controller now imports the pure state module and takes the
store installed by that provider. It does not maintain a second React view store.

The VM adapter tests still execute the actual controller source. Their loader
first evaluates the state module in its own lexical scope, then resolves the
controller's single import against those exports. Test fixture aliases point at
store facts rather than independent globals. This retains deterministic DOM,
media and socket stubs without adding an asynchronous module-loader requirement.
Pure rules import the same production module directly.

Twelve existing ambient/dots sequence tests became the rules in
`room-session-state.test.cjs`:

| Previous test | Replacement rule(s) |
| --- | --- |
| The bed starts when the conversation reads this turn and ends at its first spoken reply | Read readiness; turn-scoped settled replies; ambient iff working and quiet |
| Without a read receipt the bed waits a moment after delivery, and a read overtakes that wait | Delivery deadline versus immediate read |
| A delivery that failed, a new turn, the user speaking and losing the room all end the bed | Failed delivery; ambient speaker/connection predicates. A new turn or audio cancellation alone is not evidence of sound and cannot suppress a quiet working bed. |
| The bed belongs to the turn this browser sent to the conversation it is looking at | Browser/conversation ownership |
| The bed is a device setting: off means silent, and the stored volume is what plays | On by default, off means silent, fixed level ignoring old volume settings |
| Turning the bed off while it sounds silences it at once | Preference predicate and store subscription |
| The read receipt is announced: one short note, the dots, and the bed; the dots stay even with the sound off | Read readiness; dots independent of sound; no receipt chime |
| What silences the bed is not always what puts the dots out | Independent working and speaker facts |
| The dots belong to the conversation, not to the microphone | Harness lifecycle precedence; speaker independence; reply fallback only when lifecycle is absent |
| A reply settles the fallback turn it answers, not whatever the conversation is working on now | Turn-scoped settled state, including late receipts |
| While the harness says it is working, nothing the conversation says puts the dots out | Both harness booleans override receipts/replies/speech |
| The bed belongs to the silence: it goes while anyone speaks and comes back when the room is quiet | Ambient predicate across voice, preview and setting combinations |

The other 98 controller tests remain, including transport hello, reconnection,
gap capture, replay, receipts, selection, settings and pipeline switching. The
preview test now requires capture to remain enabled: its former automatic muting
contradicted the operator's requirement. Legacy karaoke DOM assertions now inspect
the projected records rendered by React; ordering/unread assertions use pure
selectors. Join observations include the initial empty store snapshot. React join
tests write join facts instead of injecting rendered strings.

Added: 16 pure browser rule tests, six adapter regressions (late playback
callbacks, failed playback, synchronous output notifications, stale
audio epochs, cancellation/idle-harness authority, and typed-message turn identity), and 11 server
publication rule tests. All original server, connector and audio tests remain.

Required verification: server **200** (199 passed, one pre-existing optional
skip); web **125** Node tests plus **33** React tests; connector **39**;
browser-audio **41**; both browser-audio and web production builds.

## Preserved boundaries and device verification

No new room persistence or browser-audio engine changes. Microphone capture,
same-hello reconnect, bounded gap PCM,
replay receipts and hot pipeline swaps retain their existing adapters. Device
preferences remain in device storage; detector tuning remains the room's.
Manual microphone controls remain available; playback and previews never mute
capture. Settings form editing, diagnostics and resource lifetimes remain in the
controller because they are outside the conversation projections.

On an iPhone/car output, verify the audible greeting and one-time repair, echo
coverage after cuts, ambient level and return between either voice, interruption
without lost capture, network loss/reconnection with gap and replay, background
return, and transcription/model switches during a call. Automated tests cannot
establish what the physical echo reference or speaker actually rendered.
