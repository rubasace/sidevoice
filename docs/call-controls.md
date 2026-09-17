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

Karaoke highlighting and transcript echo comparison are distinct features.
Highlighting uses the actual playback clock and available alignment. This change
does **not** implement transcript-based echo rejection or solve acoustic echo by
itself. A future echo filter must also account for the earlier VAD interruption,
not just discard the final transcription after playback has already stopped.

Automated DOM tests cover control independence, missing measurements, thread and
session isolation, stale requests, polling lifecycle and older/offline servers.
Real-device visual matching, Bluetooth routing and iPhone Safari remain manual
checks; the container WebKit cannot launch without additional system libraries.
