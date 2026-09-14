import json
from unittest import IsolatedAsyncioTestCase
from pipecat.frames.frames import (InputAudioRawFrame, InputTransportMessageFrame, OutputAudioRawFrame,
                                   OutputTransportMessageFrame, OutputTransportMessageUrgentFrame, TextFrame)
from browser_socket import BrowserFrameSerializer, session_message


class BrowserSocketTest(IsolatedAsyncioTestCase):
    async def test_binary_frames_are_microphone_pcm_in_the_declared_format(self):
        frame = await BrowserFrameSerializer().deserialize(b'\x00\x01' * 320)
        self.assertIsInstance(frame, InputAudioRawFrame)
        self.assertEqual((frame.sample_rate, frame.num_channels, frame.num_frames), (16000, 1, 320))
        self.assertEqual(frame.audio, b'\x00\x01' * 320)

    async def test_a_dangling_byte_never_reaches_the_pipeline(self):
        frame = await BrowserFrameSerializer().deserialize(bytearray(b'\x00\x01\x02'))
        self.assertEqual(frame.audio, b'\x00\x01')
        self.assertIsNone(await BrowserFrameSerializer().deserialize(b'\x02'))

    async def test_text_frames_are_app_messages(self):
        ready = {'label': 'rtvi-ai', 'type': 'client-ready', 'id': '1', 'data': {}}
        frame = await BrowserFrameSerializer().deserialize(json.dumps(ready))
        self.assertIsInstance(frame, InputTransportMessageFrame)
        self.assertEqual(frame.message, ready)
        self.assertIsNone(await BrowserFrameSerializer().deserialize('{not json'))
        self.assertIsNone(await BrowserFrameSerializer().deserialize('[1, 2]'))

    async def test_room_events_reach_the_browser_in_the_shape_the_page_reads(self):
        event = {'type': 'voice-speech', 'data': {'session_id': 's', 'revision': 1, 'utterance_id': 'u', 'text': 'Hola'}}
        for frame in (OutputTransportMessageFrame(message=event), OutputTransportMessageUrgentFrame(message=event)):
            payload = await BrowserFrameSerializer().serialize(frame)
            self.assertIsInstance(payload, str)
            self.assertEqual(json.loads(payload), event)

    async def test_rtvi_events_are_delivered_not_filtered(self):
        rtvi = {'label': 'rtvi-ai', 'type': 'user-transcription', 'data': {'text': 'hola', 'final': True}}
        payload = await BrowserFrameSerializer().serialize(OutputTransportMessageUrgentFrame(message=rtvi))
        self.assertEqual(json.loads(payload), rtvi)

    async def test_nothing_else_crosses_to_the_browser(self):
        serializer = BrowserFrameSerializer()
        self.assertIsNone(await serializer.serialize(OutputAudioRawFrame(audio=b'\x00\x00', sample_rate=16000, num_channels=1)))
        self.assertIsNone(await serializer.serialize(TextFrame(text='x')))

    def test_the_call_announces_its_id_and_the_format_it_expects(self):
        self.assertEqual(session_message('call-1', BrowserFrameSerializer()), {
            'type': 'voice-session', 'data': {'session_id': 'call-1', 'sample_rate': 16000, 'channels': 1}})
