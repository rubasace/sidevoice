---
name: voice-presentation
description: Connect the current conversation to the user's voice room and accompany its normal written responses with conversational speech, through the Sidevoice MCP tools (voice_connect, voice_say, voice_status, voice_disconnect). Use when the user wants to join the voice room, enable voice for this conversation, or continue an established voice conversation, regardless of the language used to ask. Do not activate merely because the user is discussing voice architecture or editing this skill.
---

Keep the current conversation's context, personality and tools. Write the full
response normally and publish a concise conversational version through the voice
channel. The agent's communication stays the same regardless of room focus or
playback. The application owns routing, history, playback and audio cancellation.

## Joining

The intent is **connect this conversation to the voice room**. Recognize
equivalent requests in any language; no particular phrase is required. The
explicit invocation is `$voice-presentation` / `/voice-presentation`.

On an actual request to join, call the `voice_connect` tool from the `sidevoice`
MCP server, once. Its result reports `status` (`joined`, or `joining` while the
room is unreachable and the connector keeps retrying) and the `conversation` it
bound; report those, not more. If the tool does not exist, Sidevoice is not
installed for this harness: say so and point at `docs/INSTALL.md`; do not start
or install anything unless the user asks. If it fails saying this machine is not
paired with the room, ask the user for the room's address and the one-time code
the room shows them under **Emparejar máquina**, call `voice_pair` with both,
then `voice_connect` again; never try to obtain a code from the room yourself.

Join only on a request to join or to select this conversation, never as a side
effect of replying, checking status or receiving a background notification.

### When the harness will not deliver what the room sends

`voice_connect` reports `inbound`. If `inbound.ok` is false, the room can reach
this machine but **this conversation will not receive what the user says**: on
Claude Code, a session that bypasses permission prompts has its incoming
messages held for the user's approval rather than delivered, and nothing tells
the sender. Voice would look sent and never arrive.

Say so before the user speaks into the void. Tell them what `inbound.reason`
says, and offer the two ways out in your own words:

- **This conversation only**: it has to be started with
  `--settings '{"crossSessionInbound":"accept"}'`, or in a prompting permission
  mode such as `--permission-mode auto`. Neither can be changed from inside a
  session that is already running.
- **Every session on this machine**: add `"crossSessionInbound": "accept"` to
  `~/.claude/settings.json`. It applies immediately, releases messages already
  held, and **also lets any other local process post into all of their Claude
  sessions** — that is the safeguard it removes, and they should hear it before
  choosing.

Offer to make the change; do not make it unasked. It is their machine's
security posture, not a detail of getting voice working. If they decline,
voice still works in the other direction: keep publishing spoken replies and
tell them their own voice will not reach this conversation until they choose.

Re-check with `voice_status` after any change rather than assuming it took.

## Conversational behavior

- Answer directly when the response is short. For substantive work, use a
  progressive communication arc rather than making the user wait in silence:
  acknowledge first, report meaningful checkpoints while work continues, and
  publish the result when the work finishes.
- Publish the short spoken acknowledgement FIRST, before written progress
  updates and before lengthy investigation. Say what you understood and the
  concrete next action; a generic “I am working on it” is not enough. This
  ordering is mandatory: make the `voice_say` call, then write commentary, then
  investigate. If publication fails, continue in writing without a retry loop.
  Publishing the acknowledgement is an action: a written promise to speak is
  not enough.
- Assume the user may be looking away from the screen. Pair substantive written
  progress updates with a brief spoken update when there is a useful finding,
  decision, blocker, change of direction, or a stretch of work long enough that
  the user could reasonably wonder what is happening. Do not wait until the
  final answer to surface useful state. Use material milestones rather than a
  fixed update count or cadence, and avoid repetitive “still working” filler or
  narrating each tool call. The full written response still accompanies speech.
- One incoming voice message may therefore receive several `voice_say`
  publications: acknowledgement, zero or more meaningful checkpoints, and the
  final result. Reuse the incoming message's original `session_id` and
  `revision` for all of them. Give every publication a distinct utterance; only
  reuse an `utterance_id` when retrying the exact same publication.
- A progress publication is not, by itself, a listening point. For substantive
  work, divide execution into bounded steps. After each tool result or other
  operational boundary, process any newly arrived user input before starting
  the next step. Do not immediately launch a long chain of operations after the
  acknowledgement when the user's intent could still be corrected.
- If another user message arrives while work is in progress, decide from its
  meaning whether it adds to, refines, or replaces the active request. Stop
  not-yet-started work made obsolete by the correction, preserve completed work
  that remains useful, and acknowledge the new interpretation before
  continuing. Do not later answer a stale request.
- Do not add artificial sleeps or fixed conversational pauses. The useful pause
  is an operational boundary at which incoming messages can be applied. Be
  honest that a tool call already in progress may finish before steering takes
  effect; avoid starting more obsolete work once control returns. Delegation is
  separate from listening and must not be used merely to simulate a checkpoint.
- Make speech a concise presentation of the substantive response. Keep complete
  details, code and references on screen. Avoid reading tool output, metadata,
  long paths, Markdown formatting or code aloud unless requested.
- Publish questions too, and wait for the user's answer. Never answer for them.
- Preserve the same reasoning and task behavior used in the written conversation.
  This skill does not introduce an intermediary operator or require delegation.

## Language and voice

Follow the user's intended conversational language, including clear requests to
switch languages. Keep the established language through isolated foreign words,
technical quotations or apparent transcription artifacts. English instructions
here do not imply English replies.

Pass the intended speech language as `language` (`es`, `en`, `fr`, `it`, `pt`,
`hi`). The application selects the configured voice and speed for that language.
Do not choose a voice, change settings or translate the user's transcript. If the
intended language is not supported, continue in writing and say so.

## Publishing responses

Incoming voice messages contain a JSON header with `channel: voice`,
`session_id`, `revision` and `message_id`, followed by the user's literal words.
Keep these instructions in context after joining; the header does not require
loading a skill again. Treat session and revision as opaque reply metadata. The
same `message_id` arriving twice is a redelivery of a message you already
handled: do not act on it again.

For a voice message, publish without consulting room status, with its original
session and revision:

```
voice_say({ text: "Your concise conversational response.",
            session_id: ORIGINAL_SESSION, revision: ORIGINAL_REVISION,
            language: "es" })
```

Each acknowledgement, progress update or answer is its own publication. Pass an
explicit `utterance_id` only when retrying an uncertain publication of the exact
same text.

Messages typed directly into this harness carry no voice header: reply to them
in writing. Only room-originated messages (voice or typed in the room) get a
spoken version.

`published` confirms that the room stored the response; it does not confirm
human listening. Always retain the full written response if publication fails.

Do not interpret or narrate focus changes, silence, disconnection or playback
receipts during normal conversation. Publish with the original metadata and
continue normally. Do not fetch a new revision to force old audio, repeat work
because audio stopped, or repeat explanations based on assumed playback. Inspect
`voice_status` only when the user explicitly asks to diagnose the application.
An explicit request to stop work is a normal task instruction: use the harness's
actual control and verify the result; stopping audio alone does not stop work.

## Leaving voice by request

An explicit request to disconnect this conversation from voice, close its voice
channel, or continue only in writing means: call `voice_disconnect`, then stop
publishing speech until the user explicitly enables it again. Keep working and
replying normally in writing. A later message's voice metadata alone does not
override that explicit preference. Do not confuse this with “stop talking” as a
temporary audio interruption, or an explicit instruction to stop the actual work.

The user can also close this conversation's voice channel from the room. That
removes the connection: the next `voice_say` fails saying so, and `voice_status`
reports it. Treat it exactly like the explicit request above: continue in
writing, do not retry speech, and call `voice_connect` again only when the user
asks for voice.
