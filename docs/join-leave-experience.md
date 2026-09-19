# Joining and leaving a Sidevoice room

Status: proposed interaction contract for operator review. This note defines the
experience; it does not authorize implementation.

## Recommendation: treat it as a call

Being in the room should mean **an active call that the person deliberately
starts and ends**, not merely that the page is open. An open tab outside the call
may show the transcript and connected conversations, but it must not hold the
microphone, play replies, request a wake lock, or reconnect a call.

This matches the real use better than an always-ready page:

- On iPhone, one user gesture is needed to unlock both microphone capture and
  audio playback. The green entry action gives that gesture an honest meaning.
- In a car, the person needs a clear privacy boundary and a control that can be
  understood at a glance. Green starts; red ends.
- One tab normally represents one conversation. The tab remembers its own
  selection and sends it when joining; the room never chooses a conversation
  for a browser.
- A network drop or room restart is transport trouble inside the same call. It
  must reconnect automatically, not make the person start another call.
- Changing an engine is configuration inside the same call. It must not look or
  behave like a hang-up.

The primary button should always describe its action, while one compact status
line beside or immediately above it describes the current state. Do not make the
phone icon itself carry listening, speaking, loading, and error meanings.

## Control states and copy

The green button is available only when out. From the first tap until an explicit
hang-up or a terminal failure, the button is red: it says either “cancel entry”
while preparing or “leave” during the call. Color is reinforcement, never the
only signal; visible text and accessible names use the copy below.

| State | What the person sees and can do | Spanish UI copy |
| --- | --- | --- |
| Out | No call resources are active. The page and transcript may remain open. Green button starts the call. | Status: **“Fuera de la sala”**. Button: **“Entrar en la sala”**. |
| Preparing | One inline progress row names the current step. The red button cancels preparation and releases anything already acquired; there is no second confirmation tap. | Button: **“Cancelar entrada”**. Steps: **“Preparando audio…”**, **“Cargando el modelo de transcripción (42 %)…”**, **“Cargando el modelo de voz (42 %)…”**, **“Entrando en la sala…”**, **“Volviendo a «{conversación}»…”**. |
| Idle / ready | The call is connected, the selected conversation is available, the microphone is live, and nobody is currently speaking. Red button hangs up. | Status: **“Puedes hablar”**. Button: **“Salir de la sala”**. |
| Listening | Voice activity for this tab has opened a user turn. The live waveform is the draft bubble, not another toolbar animation. | Status and bubble: **“Escuchando…”**. Button remains **“Salir de la sala”**; bubble action is **“Cancelar envío”**. |
| Speaking | Reply audio is playing. The microphone stays open, so the person can interrupt naturally. | Status: **“La conversación está hablando · Puedes interrumpir”**. |
| Reconnecting | The call remains conceptually active. Keep the media stream, unlocked output, mute state, and remembered conversation while reopening the socket. Red still hangs up. | Status: **“Reconectando con la sala… Espera para hablar.”** On success, briefly **“Conexión recuperada”**, then return to the activity state. |
| Switching model | The current pipeline keeps the call usable while the replacement prepares. Show this only when a change needs loading or a new socket; ordinary live voice changes need no state. | **“Cambiando la transcripción…”**, or **“Cargando {modelo} (42 %)…”**. On failure: **“No se pudo cambiar el modelo · Sigues usando {modelo anterior}”**. |
| Muted | The call and playback continue, but this tab sends no microphone audio. The dedicated mic control, not the red button, owns this state. | Status: **“Micrófono silenciado”**. Mic action: **“Activar micrófono”**. |

There is no separate paused state. “Pause but keep the page live” either means
do not send microphone audio, which is mute, or means stop both listening and
speaking, which is leave. A third state would add a dangerous ambiguity in a car:
the person could not tell whether the page was still listening. If a future use
case needs suspended playback while retaining the call, it should be designed as
a separate feature rather than called pause.

These are presentation states, not all mutually exclusive facts. In particular,
the mic button can remain visibly muted while the conversation is speaking. For
the single status line, terminal errors take priority, followed by preparing,
reconnecting, switching, speaking, muted, listening, and idle. The draft bubble
still shows listening/transcribing even when a higher-priority toolbar message is
present.

### Transitions

- Out → preparing: the person taps **“Entrar en la sala”**.
- Preparing → idle: audio, models, socket, session, and conversation selection
  are ready. Play the existing short two-note join chime once during preparation;
  it confirms entry and warms the media output.
- Preparing → out: the person cancels or preparation fails.
- Idle ↔ listening: room voice-activity events open and finish a user turn.
- Any joined state ↔ speaking: reply playback starts and stops. Speech never
  causes the app to mute or pause the microphone for echo control.
- Any joined state ↔ muted: the person uses the mic control. A reconnect or model
  swap preserves mute; a new call starts unmuted.
- Any joined state → reconnecting: the socket drops unexpectedly. Recovery returns
  to the appropriate joined state without another tap or join chime.
- Any joined state → switching model: a setting requires a prepared replacement;
  success returns to the prior activity and failure leaves the old engine active.
- Any joined state → out: the person taps the red button, the page closes, or
  reconnection reaches a terminal refusal/exhausts its retries.

## Entering: one tap, one continuous operation

The one tap must cover everything required by iOS. Behind it, the browser:

1. Immediately resumes/unlocks the shared audio output, enters the platform's
   play-and-record audio mode, plays the short join chime, and requests the screen
   wake lock while the gesture is still usable.
2. Loads this device's saved settings. Settings are never room-owned.
3. Requests the microphone, applies the selected input plus echo cancellation and
   noise reduction, and prepares capture. The app does not mute the track as an
   echo workaround.
4. Prepares the selected local transcription and voice models when needed,
   reporting real `voice-preparation` progress. GPU-to-CPU fallback remains
   automatic before declaring failure. Independent preparation may run in
   parallel, but the UI names the current bottleneck rather than showing several
   spinners.
5. Opens the room socket and sends the hello with device settings, resolved
   transcription runtime, and this tab's remembered conversation.
6. Waits for `voice-session`, starts the meter/transcription/capture graph, and
   restores the tab's conversation if it is still connected. If the tab has no
   remembered choice and exactly one conversation is available, the browser may
   apply its existing sole-conversation rule; this is still browser behavior, not
   a room-selected target. With several choices, the person chooses before entry
   or the call stays out.
7. Shows **“Puedes hablar”** only after the session and selection are confirmed.

Preparation feedback is inline and non-modal. The driver should never have to
dismiss a success dialog or tap “continue.” The red cancel action remains usable
throughout.

### Entry failures

Every failure replaces the progress row in place, returns the control to green,
releases call resources, and keeps the tab's remembered selection. It never
closes an agent connector binding.

| Failure | Spanish UI copy and recovery |
| --- | --- |
| Microphone denied or unavailable | **“No se pudo acceder al micrófono. Permítelo para este sitio y vuelve a entrar.”** Green action: **“Volver a intentar”**. |
| Room full (`1013`) | **“La sala está llena. Sal de otro dispositivo y vuelve a intentarlo.”** |
| No conversation connected | **“No hay ninguna conversación conectada. Conecta una conversación y vuelve a entrar.”** Do not keep the microphone open waiting indefinitely. |
| Several conversations but this tab has no selection | **“Elige una conversación antes de entrar.”** Focus or reveal the conversation list; do not let the room choose. |
| Local model fails after fallback | Transcription: **“Este dispositivo no pudo cargar el modelo de transcripción. Elige OpenAI u otro modelo en Configuración.”** Voice: **“Este dispositivo no pudo cargar la voz. Elige otra voz o proveedor en Configuración.”** |
| Room unavailable or handshake timeout | **“No se pudo entrar en la sala. Comprueba la conexión y vuelve a intentarlo.”** |

A policy refusal (`1008`) uses the reason supplied by the room when it is safe to
show; it is terminal, not an automatic reconnect. During a later socket drop,
speech is not guaranteed to survive yet, hence **“Espera para hablar”**. Buffering
speech across the gap is separate work.

## Leaving, muting, and selection ownership

Only leave and mute are needed.

| Action | Browser call | Selected conversation | Connector binding |
| --- | --- | --- | --- |
| Leave | Close the socket; stop capture, tracks, meter, transcription, playback, retries, audio-session mode, and wake lock. Return to out. | Keep the tab's remembered conversation in session storage for the next call. The departed room client no longer has an active target. | Unchanged. The agent/harness owns it and remains connected to the room until its own `voice_disconnect`/close action. |
| Mute | Keep socket, playback, session, wake lock, and call state. Disable the microphone track and send no PCM. | Unchanged and active for replies and typed input. | Unchanged. |
| Pause | Not offered. | No additional semantics. | No additional semantics. |

Leaving never closes a conversation, removes its journal, or affects another tab.
Closing a conversation from the participant list remains a different, explicit
operation because it removes the connector binding.

## Feedback without toolbar clutter

Use one hierarchy rather than one indicator per subsystem:

1. **Call status:** one short, live status line carries the state copy above.
   Temporary preparation, reconnection, and switching text replaces the stable
   line; messages do not accumulate.
2. **Current user turn:** the listening waveform and **“Cancelar envío”** live in
   the draft message bubble (#45). Delivery/read receipts stay on the completed
   user bubble (#28): `✓` is delivered/unconfirmed and `✓✓` is read. They are
   message facts, not call-health indicators.
3. **Conversation working:** the optional ambient presence sound (#42) begins from
   the best available receipt (`read`, otherwise delivered/unconfirmed), stops
   before reply speech, on a new turn, on delivery failure, or on disconnect, and
   never overlaps speech. It uses the same media-element output as replies so echo
   cancellation can account for it. Off/volume is a per-device setting.
4. **Engine detail:** keep the engine badge as small secondary text in the toolbar.
   Stable state shows engine/model/processor/turn-end mode; transient switching
   progress temporarily replaces it. `audio ↻` and `audio ✕` remain suffixes for
   output recovery/failure, with full detail in connection statistics.
5. **Device assurances:** keep the screen-lock and echo-coverage lights as the two
   tiny toolbar dots, with accessible names and full explanations in the device
   panel. They report conditions, not promises: echo coverage never causes an
   automatic mic mute, and a wake lock does not guarantee background capture.

On the narrow phone layout, the visible priority is call action, mic action, and
the one status line. The engine badge may truncate; the two lights remain dots;
receipts and working feedback stay with the transcript/audio where they belong.

## Implementation map after approval

- **#47:** give `CallToolbar` and the room runtime an explicit view-state contract;
  update action labels/colors, inline status priority, fresh-call unmute, cancel,
  terminal cleanup, and no-conversation/selection behavior. Cover transitions and
  accessible copy in controller/component tests, then verify on iPhone in the car.
- **#48:** feed the real audio, model, socket, session, and conversation-selection
  steps into the inline preparation row; retain the landed join chime and output
  health reporting. The existing preparation dialog can remain for voice previews,
  but joining should not be modal.
- **#46:** surface reconnecting/recovered/final states without ending the call;
  preserve stream, output, mute, and per-tab selection. Finish the one-tap version
  notice in that issue.
- **#50:** prepare a replacement transcription pipeline/socket while the old one
  remains active, swap only after `voice-session`, and keep the old model on error.
  Live TTS changes continue without a reconnect.
- **#42, #45, #28:** add the ambient working sound, replace listening bars with the
  waveform bubble, and retain the already-landed read receipts in that bubble's
  lifecycle. These do not add toolbar states.
- **New issue:** split “buffer microphone speech during a reconnect and submit it
  safely after the new session” out of #46. It needs its own protocol/epoch design,
  bounded-buffer policy, failure copy, and tests; the join/leave UI should not imply
  that this audio is preserved until that work lands.
