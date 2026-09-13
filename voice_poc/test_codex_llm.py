import asyncio
import unittest
from unittest.mock import patch
from pipecat.processors.aggregators.llm_context import LLMContext
from codex_llm import CodexLLMService


class VoiceLifetimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_barge_in_keeps_operation_and_serializes_followup(self):
        agent = CodexLLMService(instructions="Prueba")
        entered = asyncio.Event()
        release = asyncio.Event()
        prompts = []

        async def operation(prompt):
            prompts.append(prompt)
            if len(prompts) == 1:
                entered.set()
                await release.wait()
                agent.thread_id = "real-session"
                return {"text": "La operación terminó"}
            self.assertEqual(agent.thread_id, "real-session")
            return {"text": "Segunda respuesta"}

        with patch.object(agent, "_run_turn", side_effect=operation):
            first = asyncio.create_task(agent.get_chat_completions(LLMContext()))
            await entered.wait()
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            self.assertEqual(len(agent._pending_turns), 1)
            stale = asyncio.create_task(agent.get_chat_completions(LLMContext()))
            await asyncio.sleep(0)
            stale.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await stale
            second = asyncio.create_task(agent.get_chat_completions(LLMContext()))
            await asyncio.sleep(0)
            self.assertEqual(len(prompts), 1)
            release.set()
            stream = await second
            replies = [chunk async for chunk in stream]
            self.assertEqual(replies[0].choices[0].delta.content, "Segunda respuesta")
            self.assertIn("La operación terminó", prompts[1])
            self.assertEqual(len(prompts), 2)

    def test_full_agent_configuration(self):
        agent = CodexLLMService(instructions="Personality")
        command = agent.command()
        self.assertNotIn("--ignore-user-config", command)
        self.assertIn("--dangerously-bypass-approvals-and-sandbox", command)
        self.assertNotIn('sandbox_mode="read-only"', command)
