import asyncio
import json
import tempfile
from pathlib import Path
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch
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

    async def send_bytes(self, data):
        self.sent.put_nowait(data)

    async def close(self, code=1000, reason=None):
        self.client_state = self.application_state = WebSocketState.DISCONNECTED
        self.incoming.put_nowait({'type': 'websocket.disconnect', 'code': code})


class FakeTranscriber:
    """Stands in for the pipeline's transcriber: hands back scripted results, one per finished turn."""

    def __init__(self, results):
        self.results, self.calls = list(results), 0

    async def transcribe_turn(self):
        self.calls += 1
        result = self.results.pop(0)
        if callable(result):
            return await result()
        if isinstance(result, Exception):
            raise result
        return result


TIMER_HELLO = {'conversation': 'thread-a', 'mic': {'turn_end_mode': 'timer', 'user_speech_timeout': 1.0},
               'transcription': {'model': 'onnx-community/whisper-tiny', 'device': 'wasm'}}


class BrowserCallTest(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from sidevoice.room import Room
        from sidevoice.room_history import RoomHistory
        self.temp = tempfile.TemporaryDirectory()
        self.hub = Room(RoomHistory(Path(self.temp.name) / 'history.sqlite3'))
        self.hub.journal.register_binding('connector-a', harness='claude', thread='thread-a', title='A')
        self.patches = [patch('sidevoice.app.hub', self.hub)]
        for active in self.patches: active.start()

    async def asyncTearDown(self):
        for active in self.patches: active.stop()
        self.temp.cleanup()

    async def received(self, socket, kind, timeout=5):
        while True:
            raw = await asyncio.wait_for(socket.sent.get(), timeout)
            if isinstance(raw, (bytes, bytearray)):
                continue
            message = json.loads(raw)
            if message['type'] == kind: return message

    async def settled(self):
        for _ in range(20):
            await asyncio.sleep(0)

    def hello(self, socket, data=None):
        socket.incoming.put_nowait({'type': 'websocket.receive', 'text': json.dumps(
            {'label': 'rtvi-ai', 'type': 'client-ready', 'id': 'x', 'data': data if data is not None else TIMER_HELLO})})

    async def join(self, socket, hello=None):
        from sidevoice.app import browser_call
        task = asyncio.create_task(browser_call(socket))

        async def hang_up():
            # A failed assertion must still end the call the way a browser does, or the runner outlives the test.
            if not task.done():
                socket.incoming.put_nowait({'type': 'websocket.disconnect'})
                try:
                    await asyncio.wait_for(task, 5)
                except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                    task.cancel()
        self.addAsyncCleanup(hang_up)
        self.hello(socket, hello)
        session_id = (await self.received(socket, 'voice-session'))['data']['session_id']
        return task, self.hub.clients[session_id]

    async def leave(self, socket, task):
        socket.incoming.put_nowait({'type': 'websocket.disconnect'})
        await asyncio.wait_for(task, 5)

    # ----- the call: one pipeline, the device's settings, PCM in -----

    async def test_hello_configures_the_device_and_the_room_owns_its_turns(self):
        socket = FakeWebSocket()
        task, client = await self.join(socket)
        session = self.hub.snapshot(client.id)['call']
        self.assertEqual(session['mic_settings']['turn_end_mode'], 'timer')
        self.assertEqual(session['mic_settings']['user_speech_timeout'], 1.0)
        self.assertEqual(session['mic_settings']['vad_confidence'], 0.6)
        self.assertEqual((session['transcription']['provider'], session['transcription']['model'],
                          session['transcription']['device']), ('browser', 'onnx-community/whisper-tiny', 'wasm'))
        self.assertEqual(session['mic']['transport'], 'pcm')
        self.assertEqual(client.stt.provider.kind, 'browser')
        self.assertIs(client.voice.transcriber, client.stt)
        # Microphone frames reach the room's pipeline instead of being refused.
        socket.incoming.put_nowait({'type': 'websocket.receive', 'bytes': bytes(640)})
        for _ in range(50):
            await asyncio.sleep(0.01)
            if client.mic.audio_frames:
                break
        self.assertEqual(client.mic.audio_frames, 1)
        self.assertTrue(socket.sent.empty() or all(
            json.loads(m)['type'] != 'error' for m in list(socket.sent._queue) if isinstance(m, str)))
        await self.leave(socket, task)
        self.assertFalse(client.connected)
        self.assertEqual(self.hub.clients, {})

    async def test_smart_turn_is_the_default_and_builds_the_analyzer(self):
        from sidevoice.app import turn_stop_strategy
        from sidevoice.language_settings import LanguageSettings, mic_settings
        from pipecat.turns.user_stop.turn_analyzer_user_turn_stop_strategy import TurnAnalyzerUserTurnStopStrategy
        from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import SpeechTimeoutUserTurnStopStrategy
        mic, problem = mic_settings(LanguageSettings(), {})
        self.assertIsNone(problem)
        self.assertEqual(mic.turn_end_mode, 'smart_turn')
        strategy = turn_stop_strategy(mic, {})
        self.assertIsInstance(strategy, TurnAnalyzerUserTurnStopStrategy)
        self.assertFalse(strategy.wait_for_transcript)
        self.assertEqual(strategy._turn_analyzer.params.stop_secs, 3.0)
        from sidevoice.app import vad_analyzer
        self.assertEqual(vad_analyzer(mic, {}).params.stop_secs, 0.6)
        floor, _ = mic_settings(LanguageSettings(), {'smart_turn_min_silence': 1.2})
        self.assertEqual(vad_analyzer(floor, {}).params.stop_secs, 1.2)
        timer, _ = mic_settings(LanguageSettings(), {'turn_end_mode': 'timer', 'user_speech_timeout': 4})
        self.assertIsInstance(turn_stop_strategy(timer, {}), SpeechTimeoutUserTurnStopStrategy)

    async def test_the_device_brings_every_setting_and_can_update_the_live_ones(self):
        socket = FakeWebSocket()
        task, client = await self.join(socket, {'settings': {'stt_provider': 'browser', 'stt_model': 'onnx-community/whisper-base',
                                                             'spanish_voice': 'em_alex', 'audio_grace_seconds': 4,
                                                             'turn_end_mode': 'timer', 'user_speech_timeout': 1.5}})
        self.assertEqual(client.settings.spanish_voice, 'em_alex')
        self.assertEqual(client.audio_grace_seconds, 4)
        self.assertEqual(client.transcription['model'], 'onnx-community/whisper-base')
        self.assertEqual(client.mic_settings['user_speech_timeout'], 1.5)
        # Voices and grace change without a reconnect; invalid updates are refused and reported.
        client.voice.browser_message({'type': 'voice-settings', 'data': {'session_id': client.id, 'settings': {'spanish_voice': 'ef_dora', 'audio_grace_seconds': 1}}})
        self.assertEqual((client.settings.spanish_voice, client.audio_grace_seconds), ('ef_dora', 1))
        client.voice.browser_message({'type': 'voice-settings', 'data': {'session_id': client.id, 'settings': {'tts_speed': 9}}})
        self.assertEqual(client.settings.spanish_voice, 'ef_dora')
        self.assertIn('no válidos', (await self.received(socket, 'error'))['data']['message'])
        await self.leave(socket, task)

    async def test_invalid_device_settings_fall_back_to_the_room_defaults(self):
        socket = FakeWebSocket()
        task, client = await self.join(socket, {'mic': {'turn_end_mode': 'timer', 'vad_confidence': 5}})
        error = await self.received(socket, 'error')
        self.assertIn('Ajustes de micrófono no válidos', error['data']['message'])
        self.assertEqual(client.mic_settings['vad_confidence'], 0.6)
        self.assertEqual(client.mic_settings['turn_end_mode'], 'smart_turn')
        await self.leave(socket, task)

    async def test_a_gpu_fallback_reported_by_the_browser_is_kept_with_its_reason(self):
        socket = FakeWebSocket()
        task, client = await self.join(socket, {'mic': TIMER_HELLO['mic'], 'transcription': {
            'model': 'onnx-community/whisper-tiny', 'device': 'wasm', 'fallback_from': 'webgpu', 'fallback_error': 'GPU adapter lost'}})
        self.assertEqual((client.transcription['device'], client.transcription['fallback_from'], client.transcription['fallback_error']),
                         ('wasm', 'webgpu', 'GPU adapter lost'))
        await self.leave(socket, task)

    async def test_incompatible_runtime_is_rejected_but_the_call_stays(self):
        socket = FakeWebSocket()
        task, client = await self.join(socket, {'mic': TIMER_HELLO['mic'],
                                                'transcription': {'model': 'server-whisper', 'device': 'cuda'}})
        error = await self.received(socket, 'error')
        self.assertIn('no compatible', error['data']['message'])
        self.assertTrue(client.connected)
        # The rejected runtime never overrides what the room resolved.
        self.assertEqual((client.transcription['model'], client.transcription['device']), ('onnx-community/whisper-tiny', 'auto'))
        await self.leave(socket, task)

    async def test_openai_provider_is_built_from_the_saved_key(self):
        socket = FakeWebSocket()
        choice = {'provider': 'openai', 'available': True, 'model': 'gpt-4o-transcribe', 'reason': 'explicit'}
        with patch('sidevoice.app.transcription.resolve', return_value=choice), \
                patch('sidevoice.transcription.stored_key', return_value='sk-test-not-used'):
            task, client = await self.join(socket)
            self.assertEqual(client.stt.provider.kind, 'openai')
            self.assertEqual(client.stt.provider.model, 'gpt-4o-transcribe')
            await self.leave(socket, task)

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

    # ----- what a turn does, whatever closed it -----

    def voice(self, results, session_id='s1'):
        from sidevoice.app import VoiceCall
        from sidevoice.room import RoomClient
        from sidevoice.language_settings import LanguageSettings, MicSettings
        sent = []
        client = RoomClient(session_id, self.hub)
        client.connected = True
        client.target = {'thread_id': 'thread-a', 'title': 'A', 'binding_id': 'bind-a'}
        voice = VoiceCall(client, FakeTranscriber(results), sent.append, settings=LanguageSettings(), mic=MicSettings(),
                          choice={'provider': 'browser', 'model': 'onnx-community/whisper-tiny', 'reason': 'explicit'},
                          runtime={'model': 'onnx-community/whisper-tiny', 'device': 'webgpu'})
        return voice, client, sent

    async def test_the_browser_can_report_its_audio_output_and_the_room_shows_it_for_that_call(self):
        voice, client, sent = self.voice([])
        report = {'type': 'voice-audio-health', 'data': {'session_id': client.id, 'reason': 'stall', 'health': {
            'context': 'running', 'clock': 12.5, 'output': 'element', 'element': {'paused': False, 'readyState': 4},
            'playing': True, 'stalls': 1, 'resuming': True, 'events': [{'at': 1, 'kind': 'stall', 'detail': 'running · element playing · 1'}, 'junk']}}}
        voice.browser_message(report)
        shown = client.snapshot()['audio_health']
        self.assertEqual((shown['reason'], shown['stalls'], shown['context'], shown['output']), ('stall', 1, 'running', 'element'))
        self.assertEqual(shown['events'], [{'at': 1, 'kind': 'stall', 'detail': 'running · element playing · 1'}])
        self.assertTrue(shown['at'] > 0)
        # Another call's report never lands here.
        voice.browser_message({**report, 'data': {**report['data'], 'session_id': 'someone-else', 'reason': 'fail'}})
        self.assertEqual(client.snapshot()['audio_health']['reason'], 'stall')

    async def test_a_finished_turn_is_transcribed_once_and_delivered(self):
        from sidevoice.transcribers import Transcript
        voice, client, sent = self.voice([Transcript('Hola desde el navegador', metrics={'audio_ms': 850, 'recognition_ms': 120})])
        voice.turn_started()
        # Starting to speak also cancels this browser's own pending audio, like everyone else's.
        self.assertEqual([m['type'] for m in sent], ['voice-cancel', 'voice-user-turn'])
        self.assertEqual(sent[1]['data'], {'phase': 'started', 'revision': 1, 'thread_id': 'thread-a'})
        self.assertTrue(client.speaking)
        await voice.turn_stopped()
        phases = [m['data']['phase'] for m in sent if m['type'] == 'voice-user-turn']
        self.assertEqual(phases, ['started', 'finished'])
        finished = [m for m in sent if m['type'] == 'voice-user-turn'][-1]['data']
        self.assertEqual((finished['text'], finished['revision']), ('Hola desde el navegador', 1))
        rows = self.hub.journal.history('thread-a')
        self.assertEqual(rows[-1]['text'], 'Hola desde el navegador')
        measured = client.latency.turns[('thread-a', 1)]['input_ms']
        self.assertEqual((measured['audio_ms'], measured['recognition_ms']), (850, 120))
        self.assertGreaterEqual(measured['transcript_to_delivery_ms'], 0)
        self.assertEqual((client.input_stats['turns'], client.input_stats['recognition_ms'], client.input_stats['pending']), (1, 120, 0))
        self.assertFalse(client.speaking)
        self.assertEqual(voice.transcriber.calls, 1)

    async def test_a_model_switch_in_the_browser_updates_what_the_room_reports(self):
        voice, client, sent = self.voice([])
        voice.browser_message({'type': 'voice-stt-ready', 'data': {'session_id': client.id, 'model': 'onnx-community/whisper-small', 'device': 'webgpu'}})
        self.assertEqual(client.transcription['model'], 'onnx-community/whisper-small')
        voice.browser_message({'type': 'voice-stt-ready', 'data': {'session_id': 'other', 'model': 'onnx-community/whisper-tiny', 'device': 'wasm'}})
        self.assertEqual(client.transcription['model'], 'onnx-community/whisper-small')
        voice.browser_message({'type': 'voice-stt-ready', 'data': {'session_id': client.id, 'model': 'server-whisper', 'device': 'cuda'}})
        self.assertEqual(sent[-1]['type'], 'error')
        self.assertEqual(client.transcription['model'], 'onnx-community/whisper-small')

    async def test_empty_failed_or_cancelled_turns_are_not_delivered(self):
        from sidevoice.transcribers import Transcript
        voice, client, sent = self.voice([Transcript(''), RuntimeError('worker died'), Transcript('Descarta esto')])
        for expectation in ('empty', 'failed', 'cancelled'):
            del sent[:]
            voice.turn_started()
            if expectation == 'cancelled':
                client.cancelled_turn = client.turn_revision
            await voice.turn_stopped()
            outcome = [m for m in sent if m['type'] == 'voice-user-turn'][-1]['data']
            self.assertEqual(outcome['phase'], 'cancelled', expectation)
            self.assertFalse(client.speaking, expectation)
        self.assertEqual(self.hub.journal.history('thread-a'), [])
        errors = [m for m in sent if m['type'] == 'error']
        self.assertEqual(errors, [])
        self.assertIn('worker died', client.error)

    async def test_a_turn_cut_while_the_user_kept_going_joins_the_next_one(self):
        from sidevoice.transcribers import Transcript
        async def slow():
            await asyncio.sleep(0.05)
            return Transcript('Pero bueno,')
        voice, client, sent = self.voice([slow, Transcript('lo que te iba a proponer es otra cosa.'), Transcript('Y esto va aparte.')])
        voice.turn_started(); first = voice.turn_stopped()
        voice.turn_started(); second = voice.turn_stopped()   # resumed before the first text was delivered
        await asyncio.gather(first, second)
        rows = self.hub.journal.history('thread-a')
        self.assertEqual([(r['text'], r['revision']) for r in rows], [('Pero bueno, lo que te iba a proponer es otra cosa.', 2)])
        turns = [m['data'] for m in sent if m['type'] == 'voice-user-turn']
        self.assertEqual([(t['phase'], t['revision'], t.get('merged', False)) for t in turns],
                         [('started', 1, False), ('started', 2, False), ('cancelled', 1, True), ('finished', 2, False)])
        self.assertFalse(client.speaking)
        # A turn that starts after delivery is its own message.
        voice.turn_started(); await voice.turn_stopped()
        self.assertEqual([r['text'] for r in self.hub.journal.history('thread-a')][-1], 'Y esto va aparte.')

    async def test_held_text_survives_a_noise_turn_but_not_an_explicit_cancel(self):
        from sidevoice.transcribers import Transcript
        async def slow():
            await asyncio.sleep(0.05)
            return Transcript('Sigo aquí')
        voice, client, sent = self.voice([slow, Transcript(''), slow, Transcript('nada')])
        voice.turn_started(); first = voice.turn_stopped()
        voice.turn_started(); second = voice.turn_stopped()   # noise: empty transcript, held text still delivered
        await asyncio.gather(first, second)
        self.assertEqual([r['text'] for r in self.hub.journal.history('thread-a')], ['Sigo aquí'])
        voice.turn_started(); third = voice.turn_stopped()
        voice.turn_started(); client.cancelled_turn = client.turn_revision; fourth = voice.turn_stopped()
        await asyncio.gather(third, fourth)
        self.assertEqual([r['text'] for r in self.hub.journal.history('thread-a')], ['Sigo aquí'])
        self.assertIsNone(voice.held)

    # ----- several browsers -----

    async def test_two_devices_stay_in_the_room_and_neither_ends_the_other(self):
        first_socket, second_socket = FakeWebSocket(), FakeWebSocket()
        first_task, first = await self.join(first_socket)
        second_task, second = await self.join(second_socket)

        self.assertNotEqual(first.id, second.id)
        self.assertEqual(len(self.hub.clients), 2)
        self.assertTrue(first.connected and second.connected)
        self.assertEqual(first_socket.application_state, WebSocketState.CONNECTED)

        # A microphone turn on one device is that device's alone: the other keeps its epoch and its audio.
        second.voice.turn_started()
        self.assertEqual((await self.received(second_socket, 'voice-cancel'))['data'],
                         {'session_id': second.id, 'revision': 1})
        await self.settled()
        self.assertFalse(any(json.loads(raw)['type'] == 'voice-cancel' for raw in list(first_socket.sent._queue)
                             if not isinstance(raw, (bytes, bytearray))))
        self.assertEqual((second.turn_revision, second.revision), (1, 1))
        self.assertEqual((first.turn_revision, first.revision), (0, 0))

        # One device leaving takes nothing else with it.
        await self.leave(first_socket, first_task)
        self.assertFalse(first.connected)
        self.assertTrue(second.connected)
        self.assertEqual(list(self.hub.clients), [second.id])
        self.assertEqual(second.revision, 1, 'the other device kept its own epoch')
        await self.leave(second_socket, second_task)
        self.assertEqual(self.hub.clients, {})

    async def test_a_browser_over_the_limit_is_refused_without_disturbing_the_room(self):
        from sidevoice.app import browser_call
        joined = []
        for _ in range(self.hub.MAX_CLIENTS):
            socket = FakeWebSocket()
            joined.append((socket, *await self.join(socket)))
        refused = FakeWebSocket()
        await browser_call(refused)
        error = await self.received(refused, 'error')
        self.assertIn('máximo de navegadores', error['data']['message'])
        self.assertEqual(refused.application_state, WebSocketState.DISCONNECTED)
        self.assertEqual(len(self.hub.clients), self.hub.MAX_CLIENTS)
        self.assertTrue(all(client.connected for _, _, client in joined))
        for socket, task, _ in joined:
            await self.leave(socket, task)


if __name__ == '__main__':
    import unittest; unittest.main()
