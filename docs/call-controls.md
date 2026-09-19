# Call controls

The audio controls follow the supplied Meet reference: a joined split pill with
three live level bars on the left and mute on the right. Hover/focus reveals the
device chevron; opening it or muting keeps the chevron visible. The selector
button is independently keyboard accessible and exposes its expanded state.

Microphone and speaker selectors extend the tray upwards, with an audio-settings
gear. They stack on narrow screens. Unsupported output selection stays disabled
with a system-settings explanation; it does not pretend to route iPhone audio.
Outside click and Escape close the tray. Changing devices keeps the existing
capture/playback behavior and error handling.

The vertical ellipsis opens settings or a dedicated connection statistics modal.
The modal has a fixed heading/footer, scrollable body and horizontally scrollable
timing table on small screens. Native dialog behavior handles focus containment
and Escape. Diagnostics do not initiate capture, join a call or synthesize audio.

Joining is not silent. One quiet line above the controls names the step the tap is on —
preparing audio, loading Whisper or the voice model with the percentage the engine reports,
asking for the microphone, entering the room, and going back to the conversation this tab was
on — and it disappears once the call is up. The automatic reconnection uses that same line. A
step that fails leaves its reason and what to do about it in its place, as an alert. The
download dialog stays what it was: the long steps' own modal, not the fast ones'. The line's
pulse respects `prefers-reduced-motion`.

Karaoke highlighting and transcript echo comparison are distinct features.
Highlighting uses the actual playback clock and available alignment. This change
does **not** implement transcript-based echo rejection or solve acoustic echo by
itself. A future echo filter must also account for the earlier VAD interruption,
not just discard the final transcription after playback has already stopped.

Automated DOM tests cover control independence, missing measurements, thread and
session isolation, stale requests, polling lifecycle, older/offline servers, and the join's
step sequence and failure texts.
Real-device visual matching, Bluetooth routing and iPhone Safari remain manual
checks; the container WebKit cannot launch without additional system libraries.
