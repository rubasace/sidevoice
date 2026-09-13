import asyncio
import tempfile
from pathlib import Path
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
import control
from codex_llm import CodexLLMService


class ModelControlsTests(IsolatedAsyncioTestCase):
    async def test_model_change_preserves_running_turn_session_and_prompt(self):
        a = CodexLLMService(instructions='Dedicated voice persona')
        a.voice_connected = True
        c = control.VoiceControls()
        c.register(a, 'voice-call')
        entered, release = asyncio.Event(), asyncio.Event()
        observed = []
        async def run(prompt):
            observed.append(a.command())
            entered.set()
            await release.wait()
            a.thread_id = 'same-thread'
            return {'text': 'ready'}
        with tempfile.TemporaryDirectory() as directory, patch.object(control, 'PREFERENCES', Path(directory)/'settings.json'), patch.object(a, '_run_turn', side_effect=run):
            turn = asyncio.create_task(a._serialized_turn({}, {'started':False}))
            await entered.wait()
            c.select('gpt-5.6-luna', 'voice-call')
            self.assertEqual(a.active_model, 'gpt-5.6-terra')
            self.assertEqual(a.selected_model, 'gpt-5.6-luna')
            release.set()
            self.assertEqual((await turn)['model'], 'gpt-5.6-terra')
            await a._serialized_turn({}, {'started':False})
            self.assertEqual(observed[1][observed[1].index('-m')+1], 'gpt-5.6-luna')
            self.assertIn('same-thread', observed[1])
            self.assertEqual(a._settings.system_instruction, 'Dedicated voice persona')

    def test_api_rejects_invalid_model_stale_session_and_external_origin(self):
        app = FastAPI(); control.mount_controls(app)
        client = TestClient(app)
        for payload in ({'model':'not-a-model'}, {'model':'gpt-5.6-terra','session_id':'missing'}):
            self.assertIn(client.post('/api/terra/model',json=payload).status_code, (409,422))
        self.assertEqual(client.post('/api/terra/model',json={'model':'gpt-5.6-terra'},headers={'Origin':'https://external.example'}).status_code,403)
        self.assertEqual(client.get('/terra').status_code,200)
        self.assertEqual(client.get('/api/terra').status_code,200)
