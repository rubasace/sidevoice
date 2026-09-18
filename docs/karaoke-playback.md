# Karaoke playback

The room colours the part of the assistant's message that has already been
spoken and leaves the rest dimmed, keeping the entire original text visible;
there is no mark on the current word. It follows AudioContext time,
not text generation, network receipt time or an estimated words-per-second timer.
Highlighting clears on cancellation, failure and completion; late callbacks cannot
highlight another utterance. A history refresh reapplies the current highlight.

ElevenLabs call replies use the documented /with-timestamps endpoint, preserving
the configured voice, model and native speed. Its original-text character alignment
is mapped to word offsets in the browser. Normalized text is not substituted for
the agent's original message. Invalid, missing or mismatched alignment keeps audio
playable and highlights only the full utterance, with an explanatory tooltip.
The timestamp endpoint is tested with mocked HTTP responses, not a paid live call.

Kokoro currently returns text/audio chunks without word alignment. The room therefore
highlights the corresponding chunk; it does not present estimated word positions
as actual timings. Whitespace, repeated phrases and punctuation retain their
original text offsets.

The synthesis response is still fully buffered. This feature does not implement
streaming playout or claim a latency improvement. For timestamp requests, the latency
report's first body chunk is a JSON response chunk, not necessarily playable audio.
The audio clock also cannot measure additional Bluetooth speaker delay.

When several browsers are in the room, the room renders the utterance once and
sends every one of them the same audio and the same alignment, so the highlight
matches across devices without a second timestamp request. Highlighting itself
stays local: stopping playback on one device clears only that device's highlight
and leaves the message, and the others, alone.

Deploy the updated server and browser assets together, then reload the room between
calls. There is no automatic live restart.

Provider contract:
https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps
