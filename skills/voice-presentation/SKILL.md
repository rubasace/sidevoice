---
name: voice-presentation
description: Connect the current task to the user's voice room and accompany its normal written responses with conversational speech. Use when the user wants to join the voice room, enable voice for this task, or continue an established voice conversation, regardless of the language used to ask. Do not activate a task merely because the user is discussing voice architecture or editing this skill.
---

Keep the current task's context, personality and tools. Write the full response
normally and publish a concise conversational version through the voice channel.
The agent's communication stays the same regardless of room focus or playback.
The application owns routing, history, playback and audio cancellation.

## Joining and invocation

The intent is **connect this task to the voice room**. Recognize equivalent
requests in any language; no particular phrase or spoken keyword is required.
The explicit invocation is `$voice-presentation`. A command can use this prompt:
“Use $voice-presentation to connect this task to the voice room.”

For an actual request to join, run directly from this task's native shell:

```sh
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node "__SIDEVOICE_ROOT__/voice_poc/activate_voice.mjs"
```

Use the real launching task identity. Never set or replace `CODEX_THREAD_ID` to
represent another task. The launcher reuses or starts this task's gateway; keep
its process alive if it continues serving. Check `activated` or `already_active`
and the returned task identity before reporting success. Run the signed Node
binary directly, without a Python subprocess wrapper.

The room server must be running at `http://127.0.0.1:8767/voice/`. The user joins
independently. Activate only on a request to join or select this task, never as a
side effect of replying, checking status or receiving a background notification.

## Conversational behavior

- Answer directly when the response is short. For substantive work, publish a
  short spoken acknowledgement FIRST, before written progress updates and before
  lengthy investigation. Say what you understood and what you are about to do.
  This ordering is mandatory: make the speak tool call, then write commentary,
  then investigate. Do not send a written acknowledgement first. If publication
  fails, continue in writing without a retry loop.
  Publishing the acknowledgement is an action: a written promise to speak is not
  enough. Do not defer it until the implementation or final answer is ready.
- Assume the user may be looking away from the screen. Pair substantive written
  progress updates with a brief spoken update. During longer work, communicate
  meaningful findings, the current step or a blocker, especially when a stretch
  of silent work would leave the user unsure what is happening. Avoid repetitive
  “still working” filler or narrating each tool call. Say you are working only
  when you actually are. The full written response still accompanies speech.
- Make speech a concise presentation of the substantive response. Keep complete
  details, code and references on screen. Avoid reading tool output, metadata,
  long paths, Markdown formatting or code aloud unless requested.
- Publish questions too, and wait for the user's answer. Never answer for them.
- Preserve the same reasoning and task behavior used in the written conversation.
  This skill does not introduce an intermediary operator or require delegation.

## Language and voice

Follow the user's intended conversational language, including clear requests to
switch languages. Keep the established language through isolated foreign words,
technical quotations or apparent transcription artifacts; do not switch merely
because one fragment looks like another language. English instructions here do
not imply English replies.

Pass the intended speech language through `--language`. Supported languages come
from the installed catalog, not a permanent English/Spanish assumption:
`__SIDEVOICE_ROOT__/voice_poc/browser_audio/catalog.json`.
Use entries under `languages`; entries under `unavailable` are not supported.
Read the catalog when you need to resolve support. The current catalog includes
Spanish, English, French, Italian, Brazilian Portuguese and Hindi.

The application selects the configured model, voice and speed for that language.
Do not choose a voice, change settings or translate the user's transcript as part
of normal participation. If the intended language has no supported voice, continue
in writing and explain the limitation rather than silently choosing another language.

## Publishing responses

The bridge is:
`__SIDEVOICE_ROOT__/voice_poc/voice_channel.py`.

Incoming voice messages contain a JSON header with `channel: voice`, `session_id`,
`revision` and `message_id`, followed by the user's literal words. Keep these
instructions in context after joining; the header does not require loading a
skill again. Treat session and revision as opaque reply metadata.

For a voice message, publish without consulting room status. Use its original
session and revision with the current task's real identity:

```sh
python3 "__SIDEVOICE_ROOT__/voice_poc/voice_channel.py" speak --thread-id REAL_TASK_ID --session-id ORIGINAL_SESSION --revision ORIGINAL_REVISION --utterance-id UNIQUE_PUBLICATION_ID --language LANGUAGE_CODE <<'VOICE_TEXT'
Your concise conversational response.
VOICE_TEXT
```

Use a unique publication ID for each acknowledgement, progress update or answer.
Reuse that ID only when checking/retrying an uncertain publication of the exact
same text. The quoted heredoc prevents shell expansion.

For a written message without voice metadata, consult `status` once. If a call
is connected to this task, capture its session/revision for the accompanying
speech; otherwise continue in writing. Do not activate a task just to reply.

`published` confirms that the channel stored the response; it does not confirm
human listening. Always retain the full written response if publication fails.

Do not interpret or narrate focus changes, silence, disconnection or playback
receipts during normal conversation. Publish with the original metadata and
continue normally. Do not fetch a new revision to force old audio, repeat work
because audio stopped, or repeat explanations based on assumed playback. Inspect
these details only when the user explicitly asks to diagnose the application.
An explicit request to stop work is a normal task instruction: use the harness's
actual control and verify the result; stopping audio alone does not stop work.

## Leaving voice by request

An explicit request to disconnect this task from voice, close its voice channel,
or continue only in writing means stop publishing conversational speech from
this task until the user explicitly enables it again. Keep working and replying
normally in writing. A later message's voice metadata alone does not override
that explicit preference. Do not confuse this with “stop talking” as a temporary
audio interruption, or an explicit instruction to stop the actual work.

Application enforcement is separate: closing a task's channel should disable
its room membership and discard pending audio, while preserving the task and
its history. Do not claim that membership was removed unless the application
confirmed it. The UI closes a task through /api/presentation/close, persists closed membership,
blocks its audio immediately and queues a room-control message to the real task.
The older /leave endpoint only clears the selected destination; do not use it
to claim full channel closure.

A room-control closure notification is a request to continue in writing, not a
voice turn to acknowledge aloud. Because delivery can be delayed, consult the
channel status for this control event: if this task is no longer in closed_threads,
a subsequent activation superseded the event. Otherwise stop publishing voice.
Ordinary voice responses still use their original metadata without status checks.
