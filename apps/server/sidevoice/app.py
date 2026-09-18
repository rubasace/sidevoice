"""Voice room server: browser audio in, durable delivery out. No LLM lives here."""
import asyncio
import json
import os
import uuid
from dotenv import dotenv_values
from loguru import logger
from fastapi import HTTPException, WebSocket

from . import transcription
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import OutputTransportMessageUrgentFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import SpeechTimeoutUserTurnStopStrategy
from pipecat.workers.runner import WorkerRunner

from .browser_socket import BrowserFrameSerializer, session_message
from .presentation import (binding, hub, PresentationCall, NoInference, mount_presentation,
                          PresentationGate, PresentationPlayback, require_same_origin)
from .connector_control import mount_connector_control
from .paths import REPOSITORY_ROOT


def close_on_replacement(call, websocket):
    async def close():
        try:
            await websocket.close(code=4001, reason='La sala se abrió en otro dispositivo.')
        except RuntimeError:
            pass
    call.on_replaced = lambda: asyncio.create_task(close())


async def browser_text_call(websocket, settings=None):
    """Local STT call: microphone audio never leaves the page; only turn control and text arrive."""
    if settings is None:
        from .language_settings import load_settings
        settings = load_settings()
    serializer = BrowserFrameSerializer()
    transcription_choice = transcription.resolve(settings)
    outbox = asyncio.Queue()
    turns = {}

    async def deliver():
        while True:
            await websocket.send_text(json.dumps(await outbox.get()))

    send = outbox.put_nowait
    call = PresentationCall(str(uuid.uuid4()), binding() or {}, None, None, None)
    call.browser_audio = True
    call.transcription = transcription_choice
    call.input_stats = {'transport': 'browser-text', 'turns': 0, 'audio_ms': 0,
                        'recognition_ms': 0, 'pending': 0}
    call.on_browser_event = send
    call.on_input_receipt = lambda data: send({'type': 'voice-input-receipt', 'data': data})
    call.audio_grace_seconds = settings.audio_grace_seconds
    close_on_replacement(call, websocket)
    hub.attach(call)
    sender = asyncio.create_task(deliver())
    call.connected = True
    await websocket.send_text(json.dumps(session_message(call.id, serializer)))

    def payload(message):
        data = message.get('data')
        if not isinstance(data, dict) or data.get('session_id') != call.id:
            raise ValueError('Mensaje de transcripción para otra sesión.')
        return data

    async def finish(turn_id, *, failed=None):
        turn = turns.pop(turn_id, None)
        if not turn:
            return
        current = turn['revision'] == call.turn_revision
        text = turn.get('text', '').strip()
        cancelled = bool(failed or getattr(call, 'cancelled_turn', None) == turn['revision'] or not text)
        send({'type': 'user-stopped-speaking', 'data': {}})
        send({'type': 'voice-user-turn', 'data': {
            'phase': 'cancelled' if cancelled else 'finished',
            'revision': turn['revision'], 'turn_id': turn_id,
            'thread_id': turn['target'].get('thread_id'), 'text': text,
        }})
        # The browser must create the final bubble before its receipt arrives.
        if not cancelled:
            call.enqueue_input(text, target=turn['target'], revision=turn['revision'])
        if failed:
            call.error = failed
            send({'type': 'error', 'data': {'message': failed}})
        if current:
            await call.finish_user_turn()
        call.input_stats['pending'] = len(turns)

    try:
        while True:
            event = await websocket.receive()
            if event.get('type') == 'websocket.disconnect':
                break
            if event.get('bytes') is not None:
                send({'type': 'error', 'data': {
                    'message': 'El audio debe transcribirse en el navegador; el servidor rechazó PCM.'
                }})
                continue
            try:
                message = json.loads(event.get('text') or '{}')
            except ValueError:
                continue
            kind = message.get('type')
            if kind == 'client-ready':
                continue
            try:
                data = payload(message)
                if kind == 'voice-stt-ready':
                    model, device = data.get('model'), data.get('device')
                    models = {item['id'] for item in transcription.PROVIDERS['browser']['models']}
                    if model not in models or device not in {'webgpu', 'wasm'}:
                        raise ValueError('Motor de transcripción del navegador no compatible.')
                    call.transcription = {**transcription_choice, 'model': model, 'device': device}
                elif kind == 'voice-input-start':
                    turn_id = data.get('turn_id')
                    if not isinstance(turn_id, str) or not turn_id or len(turn_id) > 100:
                        raise ValueError('Identificador de turno inválido.')
                    if turn_id in turns:
                        continue
                    if turns:
                        raise ValueError('Ya hay una intervención abierta.')
                    call.user_started()
                    turns[turn_id] = {'revision': call.turn_revision, 'target': dict(call.turn_target),
                                      'sequence': 0, 'text': ''}
                    call.input_stats['pending'] = 1
                    send({'type': 'user-started-speaking', 'data': {}})
                    send({'type': 'voice-user-turn', 'data': {
                        'phase': 'started', 'revision': call.turn_revision, 'turn_id': turn_id,
                        'thread_id': call.turn_target.get('thread_id'),
                    }})
                elif kind == 'voice-input-transcript':
                    turn = turns.get(data.get('turn_id'))
                    sequence, text = data.get('sequence'), data.get('text')
                    if not turn or not isinstance(sequence, int) or sequence <= turn['sequence']:
                        raise ValueError('Resultado de transcripción obsoleto.')
                    if not isinstance(text, str) or len(text) > 12000:
                        raise ValueError('Transcripción inválida o demasiado larga.')
                    turn['sequence'], turn['text'] = sequence, text
                    metrics = data.get('metrics') if isinstance(data.get('metrics'), dict) else {}
                    call.input_stats.update({
                        'audio_ms': max(0, int(metrics.get('audio_ms') or 0)),
                        'recognition_ms': max(0, int(metrics.get('recognition_ms') or 0)),
                    })
                    call.latency.input(turn['target'].get('thread_id'), turn['revision'], metrics)
                    call.input_stats['turns'] += 1
                elif kind == 'voice-input-end':
                    turn = turns.get(data.get('turn_id'))
                    if not turn or data.get('sequence') != turn['sequence']:
                        raise ValueError('La transcripción no está completa.')
                    await finish(data['turn_id'])
                elif kind == 'voice-input-cancel':
                    await finish(data.get('turn_id'))
                elif kind == 'voice-input-error':
                    await finish(data.get('turn_id'), failed=str(data.get('error') or 'Falló la transcripción local.'))
            except (TypeError, ValueError) as error:
                send({'type': 'error', 'data': {'message': str(error)}})
    finally:
        for turn_id in list(turns):
            await finish(turn_id, failed='La llamada terminó durante la transcripción.')
        call.disconnect()
        sender.cancel()

def audio_idle_timeout(config):
    try:
        return max(0.0, float(config.get('VOICE_AUDIO_IDLE_TIMEOUT', '5.0')))
    except (TypeError, ValueError):
        return 5.0


async def openai_call(websocket, settings, config):
    """Cloud STT call: PCM reaches this server and OpenAI; TTS still plays in the browser."""
    serializer = BrowserFrameSerializer()
    transport = FastAPIWebsocketTransport(websocket, FastAPIWebsocketParams(
        audio_in_enabled=True, serializer=serializer, allowed_origins=[]))
    user, assistant = LLMContextAggregatorPair(LLMContext(), user_params=LLMUserAggregatorParams(
        audio_idle_timeout=audio_idle_timeout(config),
        vad_analyzer=SileroVADAnalyzer(params=VADParams(
            start_secs=float(config.get('VOICE_VAD_START_SECS', '0.08')),
            stop_secs=float(config.get('VOICE_VAD_STOP_SECS', '0.35')),
            confidence=float(config.get('VOICE_VAD_CONFIDENCE', '0.6')),
            min_volume=float(config.get('VOICE_VAD_MIN_VOLUME', '0.35')),
        )),
        user_turn_strategies=UserTurnStrategies(stop=[
            SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=settings.user_speech_timeout)
        ]),
    ))
    stt, transcription_choice = transcription.build(settings, config)
    logger.info('Transcription: {} · {} ({})', transcription_choice['provider'],
                transcription_choice['model'], transcription_choice['reason'])
    gate, playback = PresentationGate(), PresentationPlayback()
    pipeline = Pipeline([transport.input(), stt, user, NoInference(), gate,
                         transport.output(), playback, assistant])
    worker = PipelineWorker(pipeline, params=PipelineParams(enable_metrics=True))
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    outbox = asyncio.Queue()
    send = outbox.put_nowait

    async def deliver():
        while True:
            message = await outbox.get()
            await transport.output().send_message(OutputTransportMessageUrgentFrame(message=message))

    call = PresentationCall(str(uuid.uuid4()), binding() or {}, worker, None, stt)
    call.browser_audio = True
    call.mic = serializer
    call.transcription = transcription_choice
    call.on_browser_event = send
    call.on_input_receipt = lambda data: send({'type': 'voice-input-receipt', 'data': data})
    call.audio_grace_seconds = settings.audio_grace_seconds
    gate.call = playback.call = call
    close_on_replacement(call, websocket)
    hub.attach(call)
    sender = asyncio.create_task(deliver())

    @user.event_handler('on_user_turn_started')
    async def presentation_started(aggregator, strategy):
        call.user_started()
        send({'type': 'voice-user-turn', 'data': {
            'phase': 'started', 'revision': call.turn_revision,
            'thread_id': call.turn_target.get('thread_id'),
        }})

    @user.event_handler('on_user_turn_stopped')
    async def presentation_stopped(aggregator, strategy, message):
        call.speaking = False
        text = str(message.content or '').strip()
        cancelled = getattr(call, 'cancelled_turn', None) == call.turn_revision or not text
        send({'type': 'voice-user-turn', 'data': {
            'phase': 'cancelled' if cancelled else 'finished',
            'revision': call.turn_revision,
            'thread_id': call.turn_target.get('thread_id'), 'text': text,
        }})
        if not cancelled:
            call.enqueue_input(text)
        await call.finish_user_turn()

    @transport.event_handler('on_client_connected')
    async def connected(transport, client):
        call.connected = True
        await transport.output().send_message(
            OutputTransportMessageUrgentFrame(message=session_message(call.id, serializer)))

    @transport.event_handler('on_client_disconnected')
    async def disconnected(transport, client):
        call.disconnect()
        await runner.cancel()

    try:
        await runner.run()
    finally:
        call.disconnect()
        sender.cancel()


async def browser_call(websocket):
    """Select the transport from the saved provider for this connection."""
    from .language_settings import load_settings
    settings = load_settings()
    config = {**dotenv_values(REPOSITORY_ROOT / '.env.voice'), **os.environ}
    choice = transcription.resolve(settings, config)
    if choice['provider'] == 'openai':
        if not choice.get('available'):
            await websocket.send_text(json.dumps({'type': 'error', 'data': {
                'message': 'OpenAI necesita una clave de API antes de conectar.'}}))
            await websocket.close(code=1008)
            return
        await openai_call(websocket, settings, config)
    else:
        await browser_text_call(websocket, settings)


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
