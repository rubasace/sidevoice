"""Wire format between the room page and its call: binary frames carry microphone PCM up,
text frames carry JSON app messages both ways. No audio flows down; the browser synthesizes."""
import json

from pipecat.frames.frames import (Frame, InputAudioRawFrame, InputTransportMessageFrame,
                                   OutputTransportMessageFrame, OutputTransportMessageUrgentFrame)
from pipecat.serializers.base_serializer import FrameSerializer

MIC_SAMPLE_RATE = 16000
MIC_CHANNELS = 1


class BrowserFrameSerializer(FrameSerializer):
    """Binary in: 16-bit little-endian PCM at the declared format. Text: one JSON object per frame."""

    def __init__(self, sample_rate=MIC_SAMPLE_RATE, channels=MIC_CHANNELS):
        # RTVI events (transcriptions, speaking state) are exactly what the page listens for.
        super().__init__(FrameSerializer.InputParams(ignore_rtvi_messages=False))
        self.sample_rate, self.channels = sample_rate, channels
        # What the microphone actually delivered, so a silent call can be told from a broken one.
        self.audio_frames = self.audio_bytes = 0

    async def serialize(self, frame: Frame):
        if isinstance(frame, (OutputTransportMessageFrame, OutputTransportMessageUrgentFrame)):
            return json.dumps(frame.message)
        return None  # Nothing else crosses to the browser: no audio, no pipeline control.

    async def deserialize(self, data):
        if isinstance(data, (bytes, bytearray)):
            usable = len(data) - len(data) % (2 * self.channels)
            if not usable:
                return None
            self.audio_frames += 1
            self.audio_bytes += usable
            return InputAudioRawFrame(audio=bytes(data[:usable]), sample_rate=self.sample_rate,
                                      num_channels=self.channels)
        try:
            message = json.loads(data)
        except ValueError:
            return None
        return InputTransportMessageFrame(message=message) if isinstance(message, dict) else None


def session_message(session_id, serializer):
    """First text frame of a call: the id the room minted and the PCM format it expects."""
    return {'type': 'voice-session', 'data': {'session_id': session_id,
                                              'sample_rate': serializer.sample_rate,
                                              'channels': serializer.channels}}
