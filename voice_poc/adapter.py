"""Control boundary: deliberately independent of any coding harness."""
import asyncio
from typing import Protocol


class SessionAdapter(Protocol):
    async def status(self) -> dict: ...
    async def send(self, text: str) -> dict: ...
    async def stop(self) -> dict: ...


class DemoSession:
    """A clock-driven worker; no files or real coding sessions are modified."""

    def __init__(self):
        self.steps = 0
        self.messages = []
        self.task = None

    async def start(self):
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._work())

    async def _work(self):
        while True:
            await asyncio.sleep(1)
            self.steps += 1

    async def status(self):
        return {"session": "demo", "simulated": True,
                "running": self.task is not None and not self.task.done(),
                "steps": self.steps, "messages": list(self.messages)}

    async def send(self, text):
        self.messages.append(text)
        return {"delivered": True, "simulated": True, "literal_text": text}

    async def stop(self):
        if self.task is not None:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        return await self.status()
