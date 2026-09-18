"""Regressions for a room with more than one browser in it.

Everything here asks the same question in a different place: does what belongs to
one browser stay in that browser, and does what belongs to the room stay shared?
"""
import asyncio
import tempfile
from pathlib import Path
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from sidevoice.presentation import Speech
from sidevoice.room import Room, RoomClient
from sidevoice.room_history import RoomHistory
from sidevoice.synthesis_cache import SynthesisCache

KOKORO = {'provider': 'kokoro', 'model': 'kokoro', 'voice': 'ef_dora', 'speed': 1.0, 'language': 'es'}
ELEVEN = {'provider': 'elevenlabs', 'model': 'eleven_v3', 'voice': 'una-voz', 'speed': 1.0, 'language': 'es'}


class MultiClientRoomTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        for target in [patch('sidevoice.room.BINDING', self.path('binding.json')),
                       patch('sidevoice.language_settings.PATH', self.path('settings.json'))]:
            target.start()
            self.addCleanup(target.stop)
        self.renders = []
        self.hub = Room(RoomHistory(self.path('history.sqlite3')), SynthesisCache(renderer=self.render))
        self.voice = KOKORO
        voices = patch('sidevoice.language_settings.resolve_voice', side_effect=lambda *a, **k: dict(self.voice))
        voices.start()
        self.addCleanup(voices.stop)
        await self.hub.activate({'thread_id': 'task', 'title': 'Tarea'})

    def path(self, name):
        return Path(self.temp.name) / name

    async def render(self, choice, text):
        """Stand in for ElevenLabs: one call here is one call the room would have paid for."""
        self.renders.append((choice['provider'], choice['voice'], text))
        return {'mime_type': 'audio/mpeg', 'audio_base64': 'YQ==',
                'timings_ms': {'request_to_complete_ms': 20},
                'alignment': {'characters': list(text[:3])}}

    def browser(self, session_id):
        client = RoomClient(session_id, self.hub, worker=AsyncMock())
        client.connected = True
        client.heard = []
        client.on_browser_event = client.heard.append
        return client

    def spoken(self, client):
        return [event['data'] for event in client.heard
                if event['type'] in {'voice-speech', 'voice-speech-audio'}]

    def row(self, utterance_id, session_id):
        return self.hub.journal.get(session_id + ':voice:' + utterance_id)

    async def reply(self, client, utterance_id, text='Ya está listo', **extra):
        return await self.hub.publish(Speech(thread_id='task', session_id=client.id,
                                             revision=self.hub.revision, text=text,
                                             utterance_id=utterance_id, **extra))

    # ----- the room is shared -----

    async def test_two_browsers_stay_connected_and_both_hear_one_shared_reply(self):
        first, second = self.browser('one'), self.browser('two')
        result = await self.reply(first, 'shared')
        self.assertEqual(result['status'], 'synthesizing')
        self.assertEqual(len(self.hub.listeners()), 2)
        for client in (first, second):
            spoken = self.spoken(client)
            self.assertEqual(len(spoken), 1)
            self.assertEqual((spoken[0]['session_id'], spoken[0]['text'], spoken[0]['utterance_id']),
                             (client.id, 'Ya está listo', 'shared'))
        # One reply, one row, one text; two independent playbacks of it.
        self.assertEqual(len(self.hub.journal.history('task')), 1)
        self.assertEqual(set(self.hub.utterances['shared'].clients), {'one', 'two'})

    async def test_a_reply_answering_one_browser_still_reaches_the_other(self):
        first, second = self.browser('one'), self.browser('two')
        first.user_started(); first.speaking = False
        await self.reply(first, 'answer-to-one')
        self.assertEqual(len(self.spoken(second)), 1)
        self.assertEqual(self.spoken(second)[0]['session_id'], 'two')

    async def test_a_turn_in_one_browser_moves_the_epoch_for_every_browser(self):
        first, second = self.browser('one'), self.browser('two')
        await self.reply(first, 'stale')
        second.user_started()
        self.assertEqual(self.hub.revision, 2)
        # Both browsers were told to drop the audio of the epoch that just ended.
        for client in (first, second):
            self.assertEqual(client.heard[-1]['type'], 'voice-cancel')
            self.assertEqual(client.heard[-1]['data']['revision'], 2)
        with self.assertRaises(HTTPException):
            await self.hub.speak('Respuesta de un turno viejo', 'late', first.id, 1)

    # ----- playback is not -----

    async def test_one_browser_stopping_playback_leaves_the_other_playing(self):
        first, second = self.browser('one'), self.browser('two')
        await self.reply(first, 'shared')
        revision = self.hub.revision
        self.assertTrue(second.browser_cancelled('shared', revision, True))
        utterance = self.hub.utterances['shared']
        self.assertEqual(utterance.clients['two']['status'], 'interrupted')
        self.assertIsNone(second.active)
        # The other browser is untouched, and so is the shared message.
        self.assertEqual(utterance.clients['one']['status'], 'synthesizing')
        self.assertEqual(first.active, 'shared')
        self.assertEqual(self.row('shared', first.id)['text'], 'Ya está listo')
        self.assertEqual(self.row('shared', first.id)['status'], 'synthesizing')
        first.transition('shared', 'playing')
        await first.playback_finished('shared', revision)
        self.assertEqual(self.row('shared', first.id)['status'], 'playback_finished')

    async def test_a_failure_in_one_browser_does_not_silence_the_others(self):
        first, second = self.browser('one'), self.browser('two')
        await self.reply(first, 'shared')
        second.fail_active()
        self.assertEqual(self.hub.utterances['shared'].clients['two']['status'], 'failed')
        self.assertEqual(self.hub.utterances['shared'].clients['one']['status'], 'synthesizing')
        self.assertEqual(self.row('shared', first.id)['status'], 'synthesizing')

    async def test_a_receipt_from_one_browser_can_never_move_another(self):
        first, second = self.browser('one'), self.browser('two')
        await self.reply(first, 'shared')
        revision = self.hub.revision
        # Whatever the second browser claims, it is answered under its own id.
        second.browser_cancelled('shared', revision, True)
        self.assertFalse(second.is_current('shared', revision))
        self.assertTrue(first.is_current('shared', revision))
        # A stale epoch from the second browser is refused outright.
        second.user_started(); second.speaking = False
        self.assertFalse(second.browser_cancelled('shared', revision + 5, True))
        await second.playback_finished('shared', revision)
        self.assertEqual(self.hub.utterances['shared'].clients['two']['status'], 'interrupted')

    # ----- input -----

    async def test_each_browser_input_is_delivered_once_and_overlapping_turns_are_ordered(self):
        first, second = self.browser('one'), self.browser('two')
        first.user_started()          # turn opened first: epoch 2
        second.user_started()         # overlapping turn: epoch 3
        self.assertEqual((first.turn_revision, second.turn_revision), (2, 3))
        first.speaking = second.speaking = False
        first.enqueue_input('Lo que dije yo')
        second.enqueue_input('Lo que dijo el otro')
        first.enqueue_input('Lo que dije yo')   # a redelivery of the same turn
        rows = self.hub.journal.pending()
        self.assertEqual([row['text'] for row in rows], ['Lo que dije yo', 'Lo que dijo el otro'])
        self.assertEqual([row['session'] for row in rows], ['one', 'two'])
        self.assertEqual([row['revision'] for row in rows], [2, 3])
        self.assertEqual(len({row['id'] for row in rows}), 2)

    async def test_the_outbox_delivers_each_participant_exactly_once_in_order(self):
        from sidevoice.connector_control import ConnectorControl
        control = ConnectorControl(self.hub.journal, self.hub)
        sent = []
        class FakeSocket:
            async def send_json(self, frame): sent.append(frame)
        binding = self.hub.journal.register_binding('conn-1', harness='test', thread='task')
        control.sockets['conn-1'] = FakeSocket(); control.live[binding['id']] = 'conn-1'
        first, second = self.browser('one'), self.browser('two')
        for client, text in ((first, 'De la primera'), (second, 'De la segunda')):
            client.user_started(); client.speaking = False
            client.enqueue_input(text)
        for _ in range(2):
            await control.tick()
            await control.acknowledge('conn-1', {'event_id': sent[-1]['event_id'], 'status': 'accepted'})
        await control.tick()
        self.assertEqual([frame['text'] for frame in sent], ['De la primera', 'De la segunda'])
        self.assertEqual(len({frame['event_id'] for frame in sent}), 2)
        self.assertEqual([frame['session_id'] for frame in sent], ['one', 'two'])

    async def test_a_receipt_reaches_the_browser_that_spoke_and_no_other(self):
        first, second = self.browser('one'), self.browser('two')
        first.receipts, second.receipts = [], []
        first.on_input_receipt = first.receipts.append
        second.on_input_receipt = second.receipts.append
        first.user_started(); first.speaking = False
        row = first.enqueue_input('Solo mío')
        self.hub.delivery_status(row['history_id'], 'delivered')
        self.assertEqual([r['status'] for r in first.receipts], ['pending', 'delivered'])
        self.assertEqual(second.receipts, [])
        self.assertEqual((first.sent, second.sent), (1, 0))
        # And the latency trace of the turn belongs to the browser that took it.
        self.assertIn(('task', first.turn_revision), first.latency.turns)
        self.assertEqual(second.latency.turns, {})

    async def test_typed_input_opens_a_room_turn_without_taking_over_another_microphone(self):
        first, second = self.browser('one'), self.browser('two')
        second.user_started()
        microphone_turn = second.turn_revision
        result = await self.hub.send_text('Escribo yo', first.id, 'task',
                                          self.hub.target['binding_id'], 'msg-1')
        self.assertEqual(result['revision'], self.hub.revision)
        self.assertGreater(self.hub.revision, microphone_turn)
        self.assertEqual(second.turn_revision, microphone_turn)
        self.assertTrue(second.speaking)
        row = self.hub.journal.get(result['id'])
        self.assertEqual((row['session'], row['text']), ('one', 'Escribo yo'))
        with self.assertRaises(HTTPException):
            # Nobody may send text as a browser that is not theirs.
            await self.hub.send_text('Suplantando', 'nadie', 'task',
                                     self.hub.target['binding_id'], 'msg-2')

    # ----- coming and going -----

    async def test_one_browser_leaving_keeps_the_room_and_everyone_else_live(self):
        first, second = self.browser('one'), self.browser('two')
        await self.reply(first, 'shared')
        revision = self.hub.revision
        first.disconnect()
        self.assertFalse(first.connected)
        self.assertEqual(list(self.hub.clients), ['two'])
        self.assertTrue(second.connected)
        self.assertEqual(self.hub.revision, revision)
        self.assertEqual(self.hub.target['thread_id'], 'task')
        self.assertEqual(self.hub.utterances['shared'].clients['one']['status'], 'disconnected')
        # The row still reports the browser that is actually still playing it.
        self.assertEqual(self.row('shared', first.id)['status'], 'synthesizing')
        await second.playback_finished('shared', revision)
        self.assertEqual(self.row('shared', first.id)['status'], 'playback_finished')
        # And the room keeps accepting work from whoever is left.
        second.user_started(); second.speaking = False
        second.enqueue_input('Sigo aquí')
        self.assertEqual(self.hub.journal.pending()[0]['text'], 'Sigo aquí')

    async def test_a_browser_that_left_is_not_a_listener_and_nothing_is_replayed_into_the_next(self):
        first = self.browser('one')
        first.disconnect()
        result = await self.hub.publish(Speech(thread_id='task', session_id='one',
                                               revision=self.hub.revision, text='Nadie escucha',
                                               utterance_id='alone'))
        self.assertEqual((result['status'], result['reason']), ('text_only', 'call_ended'))
        self.assertTrue(result['text_saved'])
        second = self.browser('two')
        self.assertEqual(self.spoken(second), [])

    async def test_the_room_refuses_more_browsers_than_it_bounds_without_dropping_any(self):
        clients = [self.browser('client-%d' % index) for index in range(self.hub.MAX_CLIENTS)]
        with self.assertRaises(RuntimeError):
            self.browser('one-too-many')
        self.assertEqual(len(self.hub.clients), self.hub.MAX_CLIENTS)
        self.assertTrue(all(client.connected for client in clients))

    # ----- audio the room pays for -----

    async def test_paid_synthesis_happens_once_per_utterance_and_is_fanned_out(self):
        self.voice = ELEVEN
        first, second, third = self.browser('one'), self.browser('two'), self.browser('three')
        await self.reply(first, 'shared', text='Esto lo paga la sala una sola vez')
        self.assertEqual(self.renders, [('elevenlabs', 'una-voz', 'Esto lo paga la sala una sola vez')])
        for client in (first, second, third):
            spoken = self.spoken(client)
            self.assertEqual(len(spoken), 1)
            self.assertEqual(spoken[0]['audio_base64'], 'YQ==')
            # Karaoke needs the same alignment everywhere, and it costs no second request.
            self.assertEqual(spoken[0]['alignment'], {'characters': ['E', 's', 't']})
        self.assertEqual(self.hub.assets.stats()['renders'], 1)
        self.assertEqual(self.hub.assets.stats()['reuses'], 2)
        # A later utterance with the same words and voice is not paid for twice either.
        for client in (first, second, third):
            client.transition('shared', 'playing')
            await client.playback_finished('shared', self.hub.revision)
        await self.reply(first, 'again', text='Esto lo paga la sala una sola vez')
        self.assertEqual(len(self.renders), 1)

    async def test_a_shared_render_is_never_reported_as_a_wait_the_listener_did_not_make(self):
        self.voice = ELEVEN
        first, second = self.browser('one'), self.browser('two')
        await self.reply(first, 'shared')
        payer, reuser = self.spoken(first)[0], self.spoken(second)[0]
        self.assertEqual(payer['timings_ms'], {'request_to_complete_ms': 20})
        self.assertFalse(payer['shared'])
        self.assertEqual(reuser['timings_ms'], {})
        self.assertTrue(reuser['shared'])
        self.assertEqual(first.latency.snapshot()['replies'][0]['provider_ms'],
                         {'request_to_complete_ms': 20})
        self.assertEqual(second.latency.snapshot()['replies'][0]['provider_ms'], {})

    async def test_a_slow_render_is_shared_in_flight_rather_than_repeated(self):
        self.voice = ELEVEN
        gate, asked = asyncio.Event(), []
        async def slow(choice, text):
            asked.append(text)
            await gate.wait()
            return {'mime_type': 'audio/mpeg', 'audio_base64': 'YQ==', 'timings_ms': {}, 'alignment': None}
        self.hub.assets.renderer = slow
        clients = [self.browser('one'), self.browser('two'), self.browser('three')]
        reply = asyncio.create_task(self.reply(clients[0], 'shared'))
        for _ in range(8):
            await asyncio.sleep(0)   # every browser reaches the render before any of them finishes
        self.assertEqual(asked, ['Ya está listo'])
        gate.set()
        await reply
        self.assertEqual(self.hub.assets.stats()['renders'], 1)
        for client in clients:
            self.assertEqual(len(self.spoken(client)), 1)

    async def test_a_paid_engine_that_fails_marks_the_browsers_and_keeps_the_message(self):
        self.voice = ELEVEN
        async def broken(choice, text):
            raise ValueError('ElevenLabs respondió 429.')
        self.hub.assets.renderer = broken
        first, second = self.browser('one'), self.browser('two')
        await self.reply(first, 'shared')
        for client in (first, second):
            self.assertEqual(self.spoken(client), [])
            self.assertIn('429', client.error)
            self.assertEqual(self.hub.utterances['shared'].clients[client.id]['status'], 'failed')
        # The text is the room's and survives a provider outage.
        self.assertEqual(self.row('shared', first.id)['text'], 'Ya está listo')

    async def test_a_snapshot_shows_the_room_to_all_and_playback_only_to_its_owner(self):
        first, second = self.browser('one'), self.browser('two')
        await self.reply(first, 'shared')
        second.browser_cancelled('shared', self.hub.revision, True)
        mine = self.hub.snapshot('one')
        self.assertEqual(mine['call']['id'], 'one')
        self.assertEqual(mine['call']['utterances'], [{'utterance_id': 'shared', 'revision': self.hub.revision,
                                                       'session_id': 'one', 'status': 'synthesizing'}])
        self.assertEqual(mine['room']['clients'], 2)
        self.assertEqual({entry['id'] for entry in mine['clients']}, {'one', 'two'})
        theirs = self.hub.snapshot('two')
        self.assertEqual(theirs['call']['utterances'][0]['status'], 'interrupted')
        # An unknown browser is told about the room, never handed someone else's playback.
        self.assertIsNone(self.hub.snapshot('who')['call'])
        self.assertIsNone(self.hub.snapshot()['call'])


class SharedRenderTests(IsolatedAsyncioTestCase):
    """The cache itself: one render per configuration, shared, bounded."""

    def choice(self, voice='v', speed=1.0):
        return {'provider': 'elevenlabs', 'model': 'm', 'voice': voice, 'speed': speed}

    @staticmethod
    def audio(size=4):
        return {'mime_type': 'audio/mpeg', 'audio_base64': 'a' * size, 'timings_ms': {}, 'alignment': None}

    async def test_concurrent_listeners_share_one_in_flight_render(self):
        started, release, calls = asyncio.Event(), asyncio.Event(), []
        async def slow(choice, text):
            calls.append(text)
            started.set()
            await release.wait()
            return self.audio()
        cache = SynthesisCache(renderer=slow)
        waiting = [asyncio.create_task(cache.obtain(self.choice(), 'hola')) for _ in range(4)]
        await started.wait()
        release.set()
        results = await asyncio.gather(*waiting)
        self.assertEqual(calls, ['hola'])
        self.assertEqual({id(audio) for audio, _ in results}, {id(results[0][0])})
        self.assertEqual([fresh for _, fresh in results].count(True), 1)
        self.assertEqual(cache.stats()['renders'], 1)

    async def test_a_listener_that_walks_away_does_not_cancel_the_render_for_the_others(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def slow(choice, text):
            started.set()
            await release.wait()
            return self.audio()
        cache = SynthesisCache(renderer=slow)
        leaving = asyncio.create_task(cache.obtain(self.choice(), 'hola'))
        await started.wait()
        staying = asyncio.create_task(cache.obtain(self.choice(), 'hola'))
        await asyncio.sleep(0)
        leaving.cancel()
        release.set()
        audio, fresh = await staying
        self.assertEqual(audio['audio_base64'], 'aaaa')
        self.assertFalse(fresh)
        self.assertEqual(cache.stats()['renders'], 1)

    async def test_the_key_separates_anything_that_would_change_the_audio(self):
        calls = []
        async def renderer(choice, text):
            calls.append((choice['voice'], choice['speed'], text))
            return self.audio()
        cache = SynthesisCache(renderer=renderer)
        await cache.obtain(self.choice(), 'hola')
        await cache.obtain(self.choice(), 'hola')
        await cache.obtain(self.choice(voice='otra'), 'hola')
        await cache.obtain(self.choice(speed=1.2), 'hola')
        await cache.obtain(self.choice(), 'adiós')
        self.assertEqual(len(calls), 4)
        self.assertEqual(cache.stats()['reuses'], 1)

    async def test_the_cache_is_bounded_and_drops_the_least_recently_used(self):
        async def renderer(choice, text):
            return {**self.audio(), 'audio_base64': text}
        cache = SynthesisCache(limit_items=2, renderer=renderer)
        first, _ = await cache.obtain(self.choice(), 'uno')
        await cache.obtain(self.choice(), 'dos')
        await cache.obtain(self.choice(), 'uno')      # keeps the first one warm
        await cache.obtain(self.choice(), 'tres')
        self.assertIsNotNone(cache.read(SynthesisCache.key(self.choice(), 'uno')))
        self.assertEqual(cache.stats()['items'], 2)
        self.assertEqual(cache.stats()['bytes'], len('uno') + len('tres'))
        self.assertIs(cache.read(SynthesisCache.key(self.choice(), 'uno')), first)

    async def test_bytes_are_bounded_too(self):
        async def renderer(choice, text):
            return self.audio(100)
        cache = SynthesisCache(limit_bytes=250, renderer=renderer)
        for word in ('uno', 'dos', 'tres', 'cuatro'):
            await cache.obtain(self.choice(), word)
        self.assertEqual(cache.stats()['items'], 2)
        self.assertLessEqual(cache.stats()['bytes'], 250)
