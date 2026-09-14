import asyncio
import tempfile
import unittest
from pathlib import Path
try:  # Works both from the repository root and README's discovery command.
    from connector_control import ConnectorControl, Delivery
except ModuleNotFoundError:
    from voice_poc.connector_control import ConnectorControl, Delivery


class ConnectorControlTests(unittest.TestCase):
    def test_queue_is_durable_until_exact_acceptance(self):
        with tempfile.TemporaryDirectory() as directory:
            control = ConnectorControl(Path(directory) / 'events.sqlite3', 'secret')
            event = asyncio.run(control.queue('binding-a', Delivery(text='para esto', session_id='call-1', revision=2)))
            self.assertEqual(len(control.pending('binding-a')), 1)
            asyncio.run(control.acknowledge(event['event_id'], 'failed'))
            self.assertEqual(len(control.pending('binding-a')), 1)
            asyncio.run(control.acknowledge(event['event_id'], 'accepted'))
            self.assertEqual(control.pending('binding-a'), [])

    def test_credential_must_be_configured_and_match(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertFalse(ConnectorControl(Path(directory) / 'a.db', None).authorized('anything'))
            self.assertTrue(ConnectorControl(Path(directory) / 'b.db', 'secret').authorized('secret'))
            self.assertFalse(ConnectorControl(Path(directory) / 'b.db', 'secret').authorized('wrong'))
