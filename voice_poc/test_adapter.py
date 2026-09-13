import asyncio
import unittest
from adapter import DemoSession


class DemoTests(unittest.IsolatedAsyncioTestCase):
    async def test_message_preserved_and_stop_confirmed(self):
        session = DemoSession()
        await session.start()
        self.assertTrue((await session.status())["running"])
        text = "No cambies la API; conserva exactamente esto."
        await session.send(text)
        self.assertEqual((await session.status())["messages"], [text])
        stopped = await session.stop()
        self.assertFalse(stopped["running"])
        await asyncio.sleep(0)
        self.assertEqual((await session.status())["steps"], stopped["steps"])
        self.assertFalse((await session.stop())["running"])


if __name__ == "__main__":
    unittest.main()
