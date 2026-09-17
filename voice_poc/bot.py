"""Voice room server: browser audio in, durable delivery out. No LLM lives here."""
import asyncio
import json
import os
import uuid
from pathlib import Path
from dotenv import dotenv_values
from fastapi import HTTPException, WebSocket
from loguru import logger

import transcription
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

from browser_socket import BrowserFrameSerializer, session_message
from presentation import binding, hub, PresentationCall, NoInference, mount_presentation, PresentationGate, PresentationPlayback, require_same_origin
from connector_control import mount_connector_control


def audio_idle_timeout(config):
    """How long missing PCM packets may stall before treating an active voice as stopped.

    This is not conversational silence: regular silent PCM still reaches VAD and
    uses its normal 2.5 s turn policy. Mobile Safari can pause AudioWorklet
    delivery for multiple seconds while the page remains visible.
    """
    try:
        return max(0.0, float(config.get("VOICE_AUDIO_IDLE_TIMEOUT", "5.0")))
    except (TypeError, ValueError):
        return 5.0


async def browser_call(websocket):
    """One accepted browser socket is one call: the room mints its id and announces it first."""
    from language_settings import load_settings
    language_preferences = load_settings()
    # Read on every connection so adding the key only requires reconnecting.
    config = {**dotenv_values(Path(__file__).resolve().parent.parent / ".env.voice"), **os.environ}
    serializer = BrowserFrameSerializer()
    # The room's own origin policy ran before accept; pipecat's env-driven list stays out of it.
    transport = FastAPIWebsocketTransport(websocket, FastAPIWebsocketParams(
        audio_in_enabled=True, serializer=serializer, allowed_origins=[]))
    user, assistant = LLMContextAggregatorPair(LLMContext(), user_params=LLMUserAggregatorParams(
        audio_idle_timeout=audio_idle_timeout(config),
        vad_analyzer=SileroVADAnalyzer(params=VADParams(
            start_secs=float(config.get("VOICE_VAD_START_SECS", "0.08")),
            stop_secs=float(config.get("VOICE_VAD_STOP_SECS", "0.35")),
            confidence=float(config.get("VOICE_VAD_CONFIDENCE", "0.6")),
            min_volume=float(config.get("VOICE_VAD_MIN_VOLUME", "0.35")),
        )),
        user_turn_strategies=UserTurnStrategies(stop=[
            SpeechTimeoutUserTurnStopStrategy(
                user_speech_timeout=language_preferences.user_speech_timeout
            )
        ]),
    ))
    transcription_choice = transcription.resolve(language_preferences, config)
    local_transcription = transcription_choice['provider'] == 'local'
    if local_transcription:
        await websocket.send_text(json.dumps({
            "type": "voice-preparation",
            "data": {
                "kind": "transcription",
                "phase": "loading",
                "title": "Preparando transcripción",
                "text": f"Descargando o cargando Whisper {transcription_choice['model']} en Sidevoice…",
                "model": transcription_choice["model"],
                "progress": None,
            },
        }))
    try:
        # Local Whisper downloads and loads synchronously. Keep the server responsive
        # while it does so; the browser already has a visible preparation state.
        stt, transcription_choice = await asyncio.to_thread(
            transcription.build, language_preferences, config
        )
    except Exception as error:
        if local_transcription:
            try:
                await websocket.send_text(json.dumps({
                    "type": "voice-preparation",
                    "data": {
                        "kind": "transcription",
                        "phase": "error",
                        "title": "No se pudo preparar la transcripción",
                        "text": str(error),
                        "model": transcription_choice["model"],
                    },
                }))
            except Exception:
                pass
        raise
    if local_transcription:
        await websocket.send_text(json.dumps({
            "type": "voice-preparation",
            "data": {
                "kind": "transcription",
                "phase": "ready",
                "model": transcription_choice["model"],
            },
        }))
    logger.info("Transcription: {} · {} ({})", transcription_choice['provider'],
                transcription_choice['model'], transcription_choice['reason'])
    # Synthesis happens in the browser; no TTS service sits in this pipeline and no audio flows down.
    gate, playback = PresentationGate(), PresentationPlayback()
    pipeline = Pipeline([transport.input(), stt, user, NoInference(), gate, transport.output(), playback, assistant])
    worker = PipelineWorker(pipeline, params=PipelineParams(enable_metrics=True))
    runner = WorkerRunner(handle_sigint=False)  # The web server owns the process signals.
    await runner.add_workers(worker)
    # Room events leave through one queue: PresentationCall raises them from synchronous code,
    # and a single sender keeps their order on the wire.
    outbox = asyncio.Queue()
    send = outbox.put_nowait

    async def deliver():
        while True:
            message = await outbox.get()
            await transport.output().send_message(OutputTransportMessageUrgentFrame(message=message))

    # Joining the room is independent of whether an agent has joined it.
    call = PresentationCall(str(uuid.uuid4()), binding() or {}, worker, None, stt)
    call.browser_audio = True
    call.mic = serializer
    call.transcription = transcription_choice
    call.on_browser_event = send
    gate.call = playback.call = call
    call.on_input_receipt = lambda data: send({"type": "voice-input-receipt", "data": data})
    call.audio_grace_seconds = language_preferences.audio_grace_seconds
    hub.attach(call)
    # The hub owns the durable outbox independently of this call.
    sender = asyncio.create_task(deliver())

    @user.event_handler("on_user_turn_started")
    async def presentation_started(aggregator, strategy):
        call.user_started()
        send({
            "type": "voice-user-turn", "data": {
                "phase": "started", "revision": call.revision,
                "thread_id": call.target.get("thread_id"),
            },
        })

    @user.event_handler("on_user_turn_stopped")
    async def presentation_stopped(aggregator, strategy, message):
        call.speaking = False
        send({
            "type": "voice-user-turn", "data": {
                "phase": "cancelled" if getattr(call, "cancelled_turn", None) == call.turn_revision else "finished",
                "revision": call.turn_revision,
                "thread_id": call.turn_target.get("thread_id"),
                "text": message.content,
            },
        })
        call.enqueue_input(message.content)
        await call.finish_user_turn()

    @transport.event_handler("on_client_connected")
    async def connected(transport, client):
        call.connected = True  # No synthetic agent greeting or automatically generated response.
        # Awaited here, inside pipeline start-up, so it is the first frame the browser reads.
        await transport.output().send_message(OutputTransportMessageUrgentFrame(message=session_message(call.id, serializer)))

    @transport.event_handler("on_client_disconnected")
    async def disconnected(transport, client):
        call.disconnect()
        await runner.cancel()

    try:
        await runner.run()
    finally:
        call.disconnect()
        call.closed = True
        sender.cancel()


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
