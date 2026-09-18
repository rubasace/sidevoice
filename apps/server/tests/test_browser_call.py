import asyncio
import json
import tempfile
from pathlib import Path
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch
from starlette.websockets import WebSocketState


class FakeWebSocket:
    def __init__(self):
        self.client_state = self.application_state = WebSocketState.CONNECTED
        self.headers = {}
        self.incoming, self.sent = asyncio.Queue(), asyncio.Queue()

    async def receive(self):
        return await self.incoming.get()

    async def send_text(self, text):
        self.sent.put_nowait(text)

    async def close(self, code=1000, reason=None):
        self.client_state = self.application_state = WebSocketState.DISCONNECTED


class BrowserCallTest(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from sidevoice.presentation import PresentationHub
        from sidevoice.room_history import RoomHistory
        self.temp = tempfile.TemporaryDirectory()
        self.hub = PresentationHub()
        self.hub.journal = RoomHistory(Path(self.temp.name) / 'history.sqlite3')
        self.binding = Path(self.temp.name) / 'binding.json'
        self.binding.write_text(json.dumps({'thread_id': 'thread-a', 'title': 'A', 'binding_id': 'bind-a'}))
        self.patches = [patch('sidevoice.presentation.BINDING', self.binding), patch('sidevoice.app.hub', self.hub)]
        for active in self.patches: active.start()

    async def asyncTearDown(self):
        for active in self.patches: active.stop()
        self.temp.cleanup()

    async def received(self, socket, kind):
        while True:
            message = json.loads(await asyncio.wait_for(socket.sent.get(), 2))
            if message['type'] == kind: return message

    async def test_only_browser_text_reaches_the_server(self):
        from sidevoice.app import browser_call
        socket = FakeWebSocket()
        task = asyncio.create_task(browser_call(socket))
        first = await self.received(socket, 'voice-session')
        session_id = first['data']['session_id']
        self.assertEqual(first['data']['sample_rate'], 16000)
        socket.incoming.put_nowait({'type': 'websocket.receive', 'bytes': b'pcm'})
        error = await self.received(socket, 'error')
        self.assertIn('rechazó PCM', error['data']['message'])
        for message in [
            {'type': 'voice-stt-ready', 'data': {'session_id': session_id, 'model': 'onnx-community/whisper-tiny', 'device': 'wasm'}},
            {'type': 'voice-input-start', 'data': {'session_id': session_id, 'turn_id': 'turn-1'}},
            {'type': 'voice-input-transcript', 'data': {'session_id': session_id, 'turn_id': 'turn-1', 'sequence': 1, 'text': 'Hola desde el navegador', 'metrics': {'audio_ms': 850, 'endpoint_silence_ms': 2500, 'recognition_ms': 120, 'speech_end_to_transcript_ms': 2640}}},
            {'type': 'voice-input-end', 'data': {'session_id': session_id, 'turn_id': 'turn-1', 'sequence': 1}},
        ]:
            socket.incoming.put_nowait({'type': 'websocket.receive', 'text': json.dumps(message)})
        finished = await self.received(socket, 'voice-user-turn')
        if finished['data']['phase'] == 'started': finished = await self.received(socket, 'voice-user-turn')
        self.assertEqual(finished['data']['phase'], 'finished')
        self.assertEqual(finished['data']['text'], 'Hola desde el navegador')
        rows = self.hub.journal.history('thread-a')
        self.assertEqual(rows[-1]['text'], 'Hola desde el navegador')
        snapshot = self.hub.snapshot()['call']
        self.assertEqual(snapshot['mic']['transport'], 'browser-text')
        self.assertEqual(snapshot['mic']['recognition_ms'], 120)
        input_metrics = self.hub.call.latency.turns[('thread-a', 1)]['input_ms']
        self.assertEqual(input_metrics['endpoint_silence_ms'], 2500)
        self.assertEqual(input_metrics['speech_end_to_transcript_ms'], 2640)
        self.assertEqual(snapshot['transcription']['device'], 'wasm')
        socket.incoming.put_nowait({'type': 'websocket.disconnect'})
        await asyncio.wait_for(task, 2)
        self.assertFalse(self.hub.call.connected)

    async def test_incompatible_runtime_is_rejected(self):
        from sidevoice.app import browser_call
        socket = FakeWebSocket();task = asyncio.create_task(browser_call(socket))
        session_id = (await self.received(socket, 'voice-session'))['data']['session_id']
        socket.incoming.put_nowait({'type': 'websocket.receive', 'text': json.dumps({'type': 'voice-stt-ready', 'data': {'session_id': session_id, 'model': 'server-whisper', 'device': 'cuda'}})})
        error = await self.received(socket, 'error')
        self.assertIn('no compatible', error['data']['message'])
        socket.incoming.put_nowait({'type': 'websocket.disconnect'});await asyncio.wait_for(task, 2)

    async def test_model_switch_cancels_open_turn_without_error(self):
        from sidevoice.app import browser_call
        socket = FakeWebSocket(); task = asyncio.create_task(browser_call(socket))
        session_id = (await self.received(socket, 'voice-session'))['data']['session_id']
        for message in [
            {'type': 'voice-input-start', 'data': {'session_id': session_id, 'turn_id': 'turn-old'}},
            {'type': 'voice-input-cancel', 'data': {'session_id': session_id, 'turn_id': 'turn-old'}},
            {'type': 'voice-stt-ready', 'data': {'session_id': session_id, 'model': 'onnx-community/whisper-small', 'device': 'webgpu'}},
        ]:
            socket.incoming.put_nowait({'type': 'websocket.receive', 'text': json.dumps(message)})
        phases = []
        while len(phases) < 2:
            phases.append((await self.received(socket, 'voice-user-turn'))['data']['phase'])
        self.assertEqual(phases, ['started', 'cancelled'])
        self.assertEqual(self.hub.journal.history('thread-a'), [])
        self.assertEqual(self.hub.snapshot()['call']['transcription']['model'], 'onnx-community/whisper-small')
        socket.incoming.put_nowait({'type': 'websocket.disconnect'}); await asyncio.wait_for(task, 2)

    async def test_openai_provider_routes_to_cloud_pipeline(self):
        from sidevoice.app import browser_call
        socket = FakeWebSocket()
        choice = {'provider': 'openai', 'available': True, 'model': 'gpt-4o-transcribe'}
        with patch('sidevoice.app.transcription.resolve', return_value=choice), patch('sidevoice.app.openai_call', new_callable=AsyncMock) as cloud:
            await browser_call(socket)
            cloud.assert_awaited_once()
            self.assertIs(cloud.await_args.args[0], socket)

    async def test_openai_without_key_fails_before_accepting_audio(self):
        from sidevoice.app import browser_call
        socket = FakeWebSocket()
        choice = {'provider': 'openai', 'available': False, 'model': 'gpt-4o-transcribe'}
        with patch('sidevoice.app.transcription.resolve', return_value=choice):
            await browser_call(socket)
        error = json.loads(socket.sent.get_nowait())
        self.assertEqual(error['type'], 'error')
        self.assertIn('clave de API', error['data']['message'])
        self.assertEqual(socket.application_state, WebSocketState.DISCONNECTED)

if __name__ == '__main__':
    import unittest; unittest.main()
