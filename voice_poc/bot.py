"""Voice room server: browser audio in, durable delivery out. No LLM lives here."""
import os
from pathlib import Path
from dotenv import dotenv_values
from speech_filter import FilteredOpenAISTTService

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.runner.utils import create_transport
from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.transcriptions.language import Language
from pipecat.transports.base_transport import TransportParams
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import SpeechTimeoutUserTurnStopStrategy
from pipecat.workers.runner import WorkerRunner

from presentation import binding, hub, PresentationCall, NoInference, mount_presentation, PresentationGate, PresentationPlayback
from connector_control import mount_connector_control


async def bot(runner_args):
    from language_settings import load_settings
    language_preferences = load_settings()
    # Read on every connection so adding the key only requires reconnecting.
    config = {**dotenv_values(Path(__file__).resolve().parent.parent / ".env.voice"), **os.environ}
    transport = await create_transport(runner_args, {
        "webrtc": lambda: TransportParams(audio_in_enabled=True, audio_out_enabled=True)
    })
    user, assistant = LLMContextAggregatorPair(LLMContext(), user_params=LLMUserAggregatorParams(
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
    if config.get("VOICE_STT_API_KEY", "").strip():
        stt = FilteredOpenAISTTService(api_key=config["VOICE_STT_API_KEY"], settings=FilteredOpenAISTTService.Settings(
            model=config.get("VOICE_STT_API_MODEL", "gpt-4o-transcribe"),
            language=None if language_preferences.stt_language == 'auto' else Language(language_preferences.stt_language),
            prompt=language_preferences.stt_context or None,
        ))
    else:
        stt = WhisperSTTService(device="cpu", compute_type="int8", settings=WhisperSTTService.Settings(
            model=os.getenv("VOICE_STT_MODEL", "base"), language=Language.ES,
        ))
    # Synthesis happens in the browser; no TTS service sits in this pipeline.
    gate, playback = PresentationGate(), PresentationPlayback()
    pipeline = Pipeline([transport.input(), stt, user, NoInference(), gate, transport.output(), playback, assistant])
    worker = PipelineWorker(pipeline, params=PipelineParams(enable_metrics=True))
    runner = WorkerRunner(handle_sigint=runner_args.handle_sigint)
    await runner.add_workers(worker)
    # Joining the room is independent of whether an agent has joined it.
    call = PresentationCall(runner_args.webrtc_connection.pc_id, binding() or {}, worker, None, stt)
    call.browser_audio = True
    call.on_browser_event = runner_args.webrtc_connection.send_app_message
    gate.call = playback.call = call
    call.on_input_receipt = lambda data: runner_args.webrtc_connection.send_app_message({
        "type": "voice-input-receipt", "data": data,
    })
    call.audio_grace_seconds = language_preferences.audio_grace_seconds
    hub.attach(call)
    # The hub owns the durable outbox independently of this call.

    @user.event_handler("on_user_turn_started")
    async def presentation_started(aggregator, strategy):
        call.user_started()
        runner_args.webrtc_connection.send_app_message({
            "type": "voice-user-turn", "data": {
                "phase": "started", "revision": call.revision,
                "thread_id": call.target.get("thread_id"),
            },
        })

    @user.event_handler("on_user_turn_stopped")
    async def presentation_stopped(aggregator, strategy, message):
        call.speaking = False
        runner_args.webrtc_connection.send_app_message({
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

    @transport.event_handler("on_client_disconnected")
    async def disconnected(transport, client):
        call.disconnect()
        await runner.cancel()

    try:
        await runner.run()
    finally:
        call.disconnect()
        call.closed = True


if __name__ == "__main__":
    from pipecat.runner.run import app, main
    mount_presentation(app)
    mount_connector_control(app, hub)
    main()
