"""Voice room server: browser audio in, durable delivery out. No LLM lives here."""
import asyncio
import json
import os
import time
import uuid
from dotenv import dotenv_values
from loguru import logger
from fastapi import HTTPException, WebSocket

from . import transcription
from pipecat.audio.turn.smart_turn.base_smart_turn import SmartTurnParams
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import OutputTransportMessageUrgentFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport
from pipecat.turns.user_start.vad_user_turn_start_strategy import VADUserTurnStartStrategy
from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import SpeechTimeoutUserTurnStopStrategy
from pipecat.turns.user_stop.turn_analyzer_user_turn_stop_strategy import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.workers.runner import WorkerRunner

from .browser_socket import BrowserFrameSerializer, session_message
from .presentation import (hub, RoomClient, NoInference, mount_presentation,
                          PresentationGate, PresentationPlayback, require_same_origin)
from .connector_control import mount_connector_control
from .paths import REPOSITORY_ROOT
from .transcribers import TurnTranscriber

HELLO_TIMEOUT = 10.0


async def room_is_full(websocket):
    """Refusing one browser is not tearing the room down for the ones already in it."""
    if len(hub.clients) < hub.MAX_CLIENTS:
        return False
    await websocket.send_text(json.dumps({'type': 'error', 'data': {
        'message': 'La sala ya tiene el máximo de navegadores conectados.'}}))
    await websocket.close(code=1013)  # Try again later.
    return True


def audio_idle_timeout(config):
    try:
        return max(0.0, float(config.get('VOICE_AUDIO_IDLE_TIMEOUT', '5.0')))
    except (TypeError, ValueError):
        return 5.0


def browser_runtime(data):
    """The local Whisper runtime a browser reports, or None when it reports none or an unsupported one."""
    if not isinstance(data, dict):
        return None
    model, device = data.get('model'), data.get('device')
    models = {item['id'] for item in transcription.PROVIDERS['browser']['models']}
    if model not in models or device not in {'webgpu', 'wasm'}:
        raise ValueError('Motor de transcripción del navegador no compatible.')
    return {'model': model, 'device': device}


async def client_hello(websocket):
    """The browser's first message names the device's microphone settings and its transcription runtime."""
    try:
        event = await asyncio.wait_for(websocket.receive(), HELLO_TIMEOUT)
    except asyncio.TimeoutError:
        return {}
    if event.get('type') == 'websocket.disconnect':
        return None
    try:
        message = json.loads(event.get('text') or '{}')
    except ValueError:
        return {}
    data = message.get('data') if isinstance(message, dict) and isinstance(message.get('data'), dict) else {}
    return data


def turn_stop_strategy(mic, config):
    """How a device's turn is declared over: a fixed silence, or smart-turn deciding from the audio."""
    if mic.turn_end_mode == 'smart_turn':
        analyzer = LocalSmartTurnAnalyzerV3(sample_rate=16000, params=SmartTurnParams(stop_secs=mic.smart_turn_max_silence))
        return TurnAnalyzerUserTurnStopStrategy(turn_analyzer=analyzer, wait_for_transcript=False)
    return SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=mic.user_speech_timeout, wait_for_transcript=False)


def vad_analyzer(mic, config):
    # The VAD reports the pause once it has lasted this long; smart-turn is only asked then,
    # so a breath between words does not end the turn. A fixed timer needs no floor.
    default_stop = mic.smart_turn_min_silence if mic.turn_end_mode == 'smart_turn' else 0.2
    return SileroVADAnalyzer(params=VADParams(
        start_secs=float(config.get('VOICE_VAD_START_SECS', '0.08')),
        stop_secs=float(config.get('VOICE_VAD_STOP_SECS', default_stop)),
        confidence=mic.vad_confidence,
        min_volume=mic.vad_min_volume,
    ))


class VoiceCall:
    """What one browser's turns do to the room: open the epoch, transcribe once closed, deliver in order.

    The pipeline reports turn boundaries; this object owns everything after them,
    so the same flow serves any turn-end strategy and any transcription provider.
    """

    def __init__(self, call, transcriber, send, *, settings, mic, choice, runtime=None, vad_stop_secs=0.2):
        self.call, self.transcriber, self.send = call, transcriber, send
        self.vad_stop_secs = vad_stop_secs
        self.finishing = set()
        self.lock = asyncio.Lock()
        self.held = None   # text of a turn the user resumed before it was delivered; the next turn carries it
        call.stt = transcriber
        call.voice = self
        call.settings = settings
        call.transcription = {**choice, **(runtime or {})}
        call.mic_settings = mic.model_dump()
        call.input_stats = {'transport': 'pcm', 'turns': 0, 'audio_ms': 0, 'recognition_ms': 0, 'pending': 0}
        call.on_browser_event = send
        call.on_input_receipt = lambda data: send({'type': 'voice-input-receipt', 'data': data})
        call.audio_grace_seconds = settings.audio_grace_seconds
        transcriber.on_message = self.browser_message

    def browser_message(self, message):
        """What a connected browser tells the room about itself, beyond audio.

        A switched local Whisper is recorded if the room can run it; new settings
        apply to this call at once for what needs no pipeline (voice, speed, grace),
        while transcription and microphone changes wait for the next connection.
        """
        if not isinstance(message, dict) or message.get('type') not in {'voice-stt-ready', 'voice-settings'}:
            return
        data = message.get('data') if isinstance(message.get('data'), dict) else {}
        if data.get('session_id') != self.call.id:
            return
        if message['type'] == 'voice-settings':
            from .language_settings import settings_from
            settings, problem = settings_from(data.get('settings'))
            if problem:
                self.send({'type': 'error', 'data': {'message': problem}})
                return
            self.call.settings = settings
            self.call.audio_grace_seconds = settings.audio_grace_seconds
            return
        try:
            runtime = browser_runtime(data)
        except ValueError as error:
            self.send({'type': 'error', 'data': {'message': str(error)}})
            return
        if runtime:
            self.call.transcription = {**self.call.transcription, **runtime}

    def turn_started(self):
        call = self.call
        call.user_started()
        call.input_stats['pending'] = 1
        # The transport already tells the browser about speaking state; this names the turn.
        self.send({'type': 'voice-user-turn', 'data': {
            'phase': 'started', 'revision': call.turn_revision,
            'thread_id': call.turn_target.get('thread_id'),
        }})

    def turn_stopped(self):
        task = asyncio.create_task(self.finish_turn(self.call.turn_revision, dict(self.call.turn_target), time.monotonic()))
        self.finishing.add(task)
        task.add_done_callback(self.finishing.discard)
        return task

    async def finish_turn(self, revision, target, stopped_at=None):
        call = self.call
        stopped_at = stopped_at or time.monotonic()
        # The detector reports the pause once it has lasted vad_stop_secs, so speech ended that much earlier.
        vad_stopped_at = getattr(self.transcriber, 'vad_stopped_at', None)
        speech_end = (vad_stopped_at - self.vad_stop_secs) if vad_stopped_at else None
        # Turns are transcribed and delivered in the order they were spoken.
        async with self.lock:
            text, failed, metrics = '', None, {}
            try:
                result = await self.transcriber.transcribe_turn()
                if result is not None:
                    text, metrics = result.text.strip(), dict(result.metrics or {})
            except Exception as error:
                failed = 'No se pudo transcribir tu intervención: ' + (str(error) or type(error).__name__)
            transcript_at = time.monotonic()
            if text or metrics:
                # Server-side stages of this turn, on one clock: what the browser measured stays as it came.
                metrics.setdefault('recognition_ms', round((transcript_at - stopped_at) * 1000, 1))
                if speech_end is not None and speech_end <= stopped_at:
                    metrics['endpoint_silence_ms'] = round((stopped_at - speech_end) * 1000, 1)
                    metrics['speech_end_to_transcript_ms'] = round((transcript_at - speech_end) * 1000, 1)
            if metrics:
                call.input_stats.update({
                    'audio_ms': max(0, int(metrics.get('audio_ms') or 0)),
                    'recognition_ms': max(0, int(metrics.get('recognition_ms') or 0)),
                })
                call.latency.input(target.get('thread_id'), revision, metrics)
            call.input_stats['turns'] += 1
            current = revision == call.turn_revision
            if call.cancelled_turn == revision:
                # Cancelling the draft cancels what was being held for it too.
                self.held = None
            elif self.held and not failed:
                # The previous turn was cut while the user was still going: it belongs to this message.
                text, self.held = (self.held + ' ' + text).strip(), None
            cancelled = bool(failed or call.cancelled_turn == revision or not text)
            if not cancelled and not current:
                # The user started speaking again before this text was delivered: a breath, not a
                # new message. Hold it for the turn now open instead of sending half a sentence.
                self.held = text
                self.send({'type': 'voice-user-turn', 'data': {
                    'phase': 'cancelled', 'revision': revision, 'thread_id': target.get('thread_id'),
                    'text': text, 'merged': True}})
                return
            self.send({'type': 'voice-user-turn', 'data': {
                'phase': 'cancelled' if cancelled else 'finished', 'revision': revision,
                'thread_id': target.get('thread_id'), 'text': text,
            }})
            # The browser must create the final bubble before its receipt arrives.
            if not cancelled:
                call.enqueue_input(text, target=target, revision=revision)
                call.latency.input(target.get('thread_id'), revision, {
                    'transcript_to_delivery_ms': round((time.monotonic() - transcript_at) * 1000, 1)})
            if failed:
                call.error = failed
                self.send({'type': 'error', 'data': {'message': failed}})
            if current:
                call.input_stats['pending'] = 0
                await call.finish_user_turn()

    def close(self):
        for task in list(self.finishing):
            task.cancel()


async def voice_call(websocket, settings, config, choice, hello, settings_problem=None):
    """One pipeline for every call: PCM in, the device's turn detection, and a transcription provider.

    The provider is OpenAI or the browser itself; the pipeline never knows which.
    """
    from .language_settings import mic_settings
    mic, problem = mic_settings(settings, hello.get('mic'))
    problem = settings_problem or problem
    serializer = BrowserFrameSerializer()
    transport = FastAPIWebsocketTransport(websocket, FastAPIWebsocketParams(
        audio_in_enabled=True, serializer=serializer, allowed_origins=[]))
    vad = vad_analyzer(mic, config)
    user, assistant = LLMContextAggregatorPair(LLMContext(), user_params=LLMUserAggregatorParams(
        audio_idle_timeout=audio_idle_timeout(config),
        vad_analyzer=vad,
        user_turn_strategies=UserTurnStrategies(start=[VADUserTurnStartStrategy()], stop=[turn_stop_strategy(mic, config)]),
    ))
    outbox = asyncio.Queue()
    send = outbox.put_nowait

    async def deliver():
        while True:
            message = await outbox.get()
            await transport.output().send_message(OutputTransportMessageUrgentFrame(message=message))

    call = RoomClient(str(uuid.uuid4()), hub)
    wanted = hello.get('conversation')
    if isinstance(wanted, str) and wanted:
        # The browser names the conversation it was talking to (its own state, kept across a reload);
        # it is honoured only if that conversation is still connected to the room.
        record = hub.journal.binding_for_thread(wanted) if hub.journal else None
        if record:
            call.target = {'thread_id': wanted, 'title': record.get('title'), 'binding_id': str(uuid.uuid4())}
    provider = transcription.build(settings, choice, config=config, send=send, session_id=call.id)
    transcriber = TurnTranscriber(provider, language=None if settings.stt_language == 'auto' else settings.stt_language)
    runtime, runtime_problem = None, None
    try:
        runtime = browser_runtime(hello.get('transcription'))
    except ValueError as error:
        runtime_problem = str(error)
    reported = hello.get('transcription') if isinstance(hello.get('transcription'), dict) else {}
    if runtime and reported.get('fallback_error'):
        # The browser offered a GPU and could not load Whisper on it: keep the reason where the stats can show it.
        runtime['fallback_from'] = str(reported.get('fallback_from') or '')[:20]
        runtime['fallback_error'] = str(reported['fallback_error'])[:300]
        logger.warning('Call {}: local Whisper fell back from {} to {}: {}', call.id[:8], runtime['fallback_from'],
                       runtime['device'], runtime['fallback_error'])
    voice = VoiceCall(call, transcriber, send, settings=settings, mic=mic, choice=choice, runtime=runtime,
                      vad_stop_secs=float(vad.params.stop_secs))
    call.mic = serializer
    problems = [message for message in (problem, runtime_problem) if message]
    logger.info('Call {}: transcription {} · {} ({}), turn end {}', call.id[:8], choice['provider'],
                call.transcription.get('model'), choice['reason'], mic.turn_end_mode)

    gate, playback = PresentationGate(), PresentationPlayback()
    pipeline = Pipeline([transport.input(), transcriber, user, NoInference(), gate,
                         transport.output(), playback, assistant])
    worker = PipelineWorker(pipeline, params=PipelineParams(enable_metrics=True))
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    call.worker = worker
    gate.client = playback.client = call
    sender = asyncio.create_task(deliver())

    @user.event_handler('on_user_turn_started')
    async def turn_started(aggregator, strategy):
        voice.turn_started()

    @user.event_handler('on_user_turn_stopped')
    async def turn_stopped(aggregator, strategy, message):
        voice.turn_stopped()

    @transport.event_handler('on_client_connected')
    async def connected(transport, client):
        call.connected = True
        await transport.output().send_message(
            OutputTransportMessageUrgentFrame(message=session_message(call.id, serializer)))
        # Only now can anything reach the browser: what its hello got wrong goes right after the session.
        for message in problems:
            send({'type': 'error', 'data': {'message': message}})

    @transport.event_handler('on_client_disconnected')
    async def disconnected(transport, client):
        call.disconnect()
        await runner.cancel()

    try:
        await runner.run()
    finally:
        voice.close()
        call.disconnect()
        sender.cancel()


async def browser_call(websocket):
    """Every browser gets the same call, configured by what that browser brings in its first message."""
    from .language_settings import settings_from
    config = {**dotenv_values(REPOSITORY_ROOT / '.env.voice'), **os.environ}
    if await room_is_full(websocket):
        return
    hello = await client_hello(websocket)
    if hello is None:
        return
    settings, problem = settings_from(hello.get('settings'))
    choice = transcription.resolve(settings, config)
    if choice['provider'] == 'openai' and not choice.get('available'):
        await websocket.send_text(json.dumps({'type': 'error', 'data': {
            'message': 'OpenAI necesita una clave de API antes de conectar.'}}))
        await websocket.close(code=1008)
        return
    await voice_call(websocket, settings, config, choice, hello, problem)


def mount_browser_call(app):
    @app.websocket('/api/presentation/ws')
    async def browser_socket(websocket: WebSocket):
        try:
            require_same_origin(websocket)
        except HTTPException:
            await websocket.close(code=1008)  # Policy violation: not this room's own page.
            return
        await websocket.accept()
        await browser_call(websocket)


if __name__ == "__main__":
    import argparse
    import uvicorn
    from fastapi import FastAPI
    parser = argparse.ArgumentParser(description="Sidevoice room: browser voice in, durable delivery out.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8767)
    arguments = parser.parse_args()
    app = FastAPI()
    mount_presentation(app)
    mount_connector_control(app, hub)
    mount_browser_call(app)
    uvicorn.run(app, host=arguments.host, port=arguments.port)
