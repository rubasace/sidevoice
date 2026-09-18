# Frontend architecture

The room UI is a React 19 and TypeScript application built with Vite. It uses a
small component system rather than a full visual framework:

- Zustand vanilla stores serializable view state per application instance.
- Radix primitives provide accessible tooltip, popover and menu behavior.
- Native selects remain the default for devices and simple settings so mobile
  browsers can present their platform picker.
- Class Variance Authority and `clsx` keep component variants consistent.
- Product-specific chat, karaoke, model and audio controls stay in Sidevoice.

## Audit matrix

| Concern | Keep in-house | Shared tool | Status |
| --- | --- | --- | --- |
| View state | Domain events and selectors | Zustand vanilla + React Context | Implemented for conversation, participants, model rows and errors |
| Browser runtime | WebSocket, audio, VAD, karaoke timing and cancellation | None; platform APIs stay behind one runtime instance | Transitional controller retained |
| Controls | Sidevoice variants and tokens | CVA + clsx | Button and NativeSelect applied across React |
| Tooltip, popover, menu | Product copy and model metadata | Radix accessibility and portal primitives | Implemented; call-menu remains on native details until runtime extraction |
| Models | Compatibility, providers, voices and speed policy | Reusable ModelPicker, ModelInfo and ModelCard | Implemented for defaults and per-language rows |
| Chat | Grouping, delivery/audio states, live draft and karaoke | React components; no generic chat SDK | Implemented |
| Forms | Sidevoice validation and save semantics | React Hook Form is the preferred next step | Deferred to avoid changing active-call behavior in the same cut |
| Internationalization | Existing Spanish/English catalog | React translation context is the preferred boundary | DOM observer migration deferred |

A store is not a replacement for the runtime singleton. The store must stay
serializable and disposable per mounted application; the runtime owns scarce
browser resources and publishes snapshots/actions at the boundary. A module that
starts timers and listeners merely by being imported is transitional, not the
end-state.

## State and runtime boundary

The store owns data that React can render: messages, the live speech draft,
participants, model rows and startup failures. Browser resources are not store
state. WebSocket, MediaStream, AudioContext, AudioWorklet, Worker,
AbortController, wake lock and monotonic epochs belong to the single room
runtime instance.

The current `room-session-controller.js` is a transitional runtime. It publishes
render snapshots through `sidevoiceUI` and exposes typed actions through
`sidevoiceActions`; its DOM fallback exists only while the behavioral VM suite
is migrated. New product UI must render in React and must not add another
`replaceChildren` path.

## Component layers

- `components/ui`: generic Button, Avatar, NativeSelect, Tooltip, Popover-backed
  model information and DropdownMenu primitives.
- `components/models`: reusable ModelPicker, ModelInfo and ModelCard.
- `features/conversation`: pure message grouping plus MessageList,
  MessageGroup, MessageBubble, metadata, karaoke and live draft rendering.
- `features/room`: participant list, availability and conversation actions.
- `features/settings`: settings panels and declarative per-language model rows.

Messages group only when sender, thread, session and calendar day match and the
gap is at most five minutes. Grouping is visual: every message retains its own
identifier, delivery/audio state and timestamp. Incoming groups show the sender
and avatar once; outgoing groups align right. A live user draft remains separate
from queued assistant messages.

## Responsive rules

`#root` is the application shell and owns the `100dvh` column layout. Header and
call controls do not shrink; the main grid and transcript use `min-height: 0` so
their own scroll areas work on iOS. At narrow widths controls preserve safe-area
padding, chat bubbles widen, settings become a horizontal tab strip and native
selectors retain the operating-system interaction.

## Deliberately deferred migrations

The following changes should be done separately because they cross tested audio
or form behavior:

1. Turn the transitional controller into `createRoomRuntime()` with complete
   listener/timer disposal and typed modules for API, polling, microphone and
   playback.
2. Move the remaining settings form and credential mutations to React Hook Form
   with a draft distinct from active call preferences.
3. Replace the DOM translation observer with a React translation context.
4. Export browser-audio as modules and retire the `window.roomVoice` and
   `window.roomTranscription` compatibility globals.
5. Migrate diagnostics and the call toolbar state after the runtime factory is
   in place; do not make React render at microphone meter frequency.

These are migration seams, not reasons to move hardware resources into Zustand.
The store/runtime split is the intended end-state.
