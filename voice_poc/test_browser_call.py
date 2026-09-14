import asyncio
import json
import os
import tempfile
from pathlib import Path
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch
from starlette.websockets import WebSocketState


class FakeWebSocket:
    """Just enough of a Starlette WebSocket for the transport: ASGI events in, frames out."""

    def __init__(self):
        self.client_state = self.application_state = WebSocketState.CONNECTED
        self.headers = {}
        self.incoming, self.sent = asyncio.Queue(), asyncio.Queue()

    async def receive(self):
        return await self.incoming.get()

    async def send_text(self, text):
        self.sent.put_nowait(text)

    async def send_bytes(self, data):
        self.sent.put_nowait(data)

    async def close(self, code=1000, reason=None):
        self.client_state = self.application_state = WebSocketState.DISCONNECTED


class BrowserCallTest(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from presentation import PresentationHub
        from room_history import RoomHistory
        self.temp = tempfile.TemporaryDirectory()
        self.hub = PresentationHub()
        self.hub.journal = RoomHistory(Path(self.temp.name) / 'history.sqlite3')
        self.patches = [patch('presentation.BINDING', Path(self.temp.name) / 'binding.json'),
                        patch('bot.hub', self.hub),
                        patch.dict(os.environ, {'VOICE_STT_API_KEY': 'test-not-used'})]
        for active in self.patches:
            active.start()

    async def asyncTearDown(self):
        for active in self.patches:
            active.stop()
        self.temp.cleanup()

    async def received(self, socket, kind):
        while True:
            message = json.loads(await asyncio.wait_for(socket.sent.get(), 15))
            if message['type'] == kind:
                return message

    async def test_the_call_speaks_first_with_its_id_relays_room_events_and_ends_with_the_socket(self):
        from bot import browser_call
        socket = FakeWebSocket()
        session = asyncio.create_task(browser_call(socket))
        first = json.loads(await asyncio.wait_for(socket.sent.get(), 15))
        self.assertEqual(first['type'], 'voice-session')
        call = self.hub.call
        self.assertEqual(first['data'], {'session_id': call.id, 'sample_rate': 16000, 'channels': 1})
        self.assertTrue(call.connected)
        self.assertEqual(self.hub.snapshot()['call']['id'], call.id)
        socket.incoming.put_nowait({'type': 'websocket.receive', 'bytes': b'\x00' * 640})
        # Events the room raises from synchronous code reach the browser in the shape the page reads.
        call.user_started()
        cancel = await self.received(socket, 'voice-cancel')
        self.assertEqual(cancel['data'], {'session_id': call.id, 'revision': 1})
        socket.incoming.put_nowait({'type': 'websocket.disconnect'})
        await asyncio.wait_for(session, 15)
        self.assertFalse(call.connected)
        self.assertTrue(call.closed)
