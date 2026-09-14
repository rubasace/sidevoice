"""Local voice frontend for a fully equipped Codex interlocutor."""
import os
import asyncio
import time
from pathlib import Path
from dotenv import dotenv_values
from speech_filter import FilteredOpenAISTTService

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import TTSSpeakFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.runner.utils import create_transport
from pipecat.services.llm_service import FunctionCallParams
from pipecat.services.ollama.llm import OLLamaLLMService
from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.transcriptions.language import Language
from pipecat.transports.base_transport import TransportParams
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import SpeechTimeoutUserTurnStopStrategy
from pipecat.workers.runner import WorkerRunner

from adapter import DemoSession
from local_tts import MacTTS
from kokoro_tts import KokoroTTS
from pocket_tts import PocketTTS
from codex_llm import CodexLLMService
from control import controls, mount_controls
from thread_monitor import monitor_thread
from presentation import binding, hub, PresentationCall, NoInference, mount_presentation, PresentationGate, PresentationPlayback
from connector_control import mount_connector_control

PROMPT = """Eres el interlocutor de una prueba de voz local. Habla en español,
con respuestas breves, naturales, sin markdown. Hay un trabajador SIMULADO:
avanza un contador cada segundo; no está programando ni modificando archivos.
Puedes consultar su estado, entregarle mensajes y detenerlo con herramientas.
No inventes estados ni afirmes haberlo parado sin resultado de la herramienta.
Que el usuario interrumpa tu explicación NO significa detener el trabajador.
'Cállate', 'eso ya lo entendí', preguntas o cambios de explicación van dirigidos
a ti; no envíes esos mensajes al trabajador. Una orden explícita de dejar de
trabajar exige detenerlo. Si solo dice 'para' y el alcance es ambiguo, pregunta.
Para instrucciones al trabajador, conserva literalmente las palabras del usuario
en la herramienta enviar_mensaje. No reanudes automáticamente después de parar.
Consulta el estado antes de explicar qué hace. No tienes acceso a sesiones reales.
Usa llamadas de herramientas reales. Nunca escribas nombres de herramientas ni
JSON en la respuesta hablada. Si te piden detener el trabajo, llama primero a
detener_trabajo; espera su resultado y entonces confirma con una frase breve.
"""


async def bot(runner_args):
    from language_settings import load_settings
    language_preferences = load_settings()
    # Read on every connection so adding the key only requires reconnecting.
    config = {**dotenv_values(Path(__file__).resolve().parent.parent / ".env.voice"), **os.environ}
    transport = await create_transport(runner_args, {
        "webrtc": lambda: TransportParams(audio_in_enabled=True, audio_out_enabled=True)
    })
    worker_session = DemoSession()

    async def consultar_estado(params: FunctionCallParams):
        """Consulta el estado real del trabajador simulado."""
        await params.result_callback(await worker_session.status())

    async def enviar_mensaje(params: FunctionCallParams, texto: str):
        """Entrega una instrucción literal al trabajador simulado.

        Args:
            texto: Palabras literales del usuario dirigidas al trabajador.
        """
        await params.result_callback(await worker_session.send(texto))

    async def detener_trabajo(params: FunctionCallParams):
        """Detiene el trabajador, solo por orden explícita de parar el trabajo."""
        await params.result_callback(await worker_session.stop())

    is_presentation = (runner_args.body or {}).get("mode") == "presentation"
    is_codex = not is_presentation and os.getenv("VOICE_BACKEND", "codex") == "codex"
    persona = Path(__file__).with_name("persona.md").read_text()
    llm = NoInference() if is_presentation else CodexLLMService(instructions=persona, model=controls.default_model) if is_codex else OLLamaLLMService(
        base_url=os.getenv("VOICE_LLM_URL", "http://127.0.0.1:8768/v1"),
        settings=OLLamaLLMService.Settings(
            model=os.getenv("VOICE_LLM_MODEL", "mlx-community/Qwen3-1.7B-4bit"),
            system_instruction=PROMPT, temperature=0.0, max_tokens=400,
        ),
    )
    if is_codex:
        controls.register(llm, runner_args.webrtc_connection.pc_id)
    context = LLMContext() if (is_codex or is_presentation) else LLMContext(tools=[consultar_estado, enviar_mensaje, detener_trabajo])
    user, assistant = LLMContextAggregatorPair(context, user_params=LLMUserAggregatorParams(
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
    if is_codex:
        llm.filter_stats = getattr(stt, "filter_stats", {})
    tts_backend = os.getenv("VOICE_TTS_BACKEND", "kokoro").lower()
    tts = MacTTS() if tts_backend == "macos" else PocketTTS() if tts_backend == "pocket" else KokoroTTS()
    if is_codex:
        llm.tts_state = getattr(tts, "runtime_status", {"engine": "macOS", "state": "ready"})
    gate, playback = PresentationGate(), PresentationPlayback()
    processors = [transport.input(), stt, user, llm]
    processors += [gate, tts, transport.output(), playback, assistant] if is_presentation else [tts, transport.output(), assistant]
    pipeline = Pipeline(processors)
    worker = PipelineWorker(pipeline, params=PipelineParams(enable_metrics=True))
    runner = WorkerRunner(handle_sigint=runner_args.handle_sigint)
    await runner.add_workers(worker)
    presentation_call = None
    delivery = None
    if is_presentation:
        # Joining the room is independent of whether an agent has joined it.
        target = binding() or {}
        presentation_call = PresentationCall(runner_args.webrtc_connection.pc_id, target, worker, tts, stt)
        presentation_call.browser_audio = True
        presentation_call.on_browser_event = runner_args.webrtc_connection.send_app_message
        gate.call = playback.call = presentation_call
        presentation_call.on_input_receipt = lambda data: runner_args.webrtc_connection.send_app_message({
            "type": "voice-input-receipt", "data": data,
        })
        presentation_call.audio_grace_seconds = language_preferences.audio_grace_seconds
        hub.attach(presentation_call)
        # The hub owns the durable outbox independently of this call.

        @user.event_handler("on_user_turn_started")
        async def presentation_started(aggregator, strategy):
            presentation_call.user_started()
            runner_args.webrtc_connection.send_app_message({
                "type": "voice-user-turn", "data": {
                    "phase": "started", "revision": presentation_call.revision,
                    "thread_id": presentation_call.target.get("thread_id"),
                },
            })

        @user.event_handler("on_user_turn_stopped")
        async def presentation_stopped(aggregator, strategy, message):
            presentation_call.speaking = False
            runner_args.webrtc_connection.send_app_message({
                "type": "voice-user-turn", "data": {
                    "phase": "cancelled" if getattr(presentation_call, "cancelled_turn", None) == presentation_call.turn_revision else "finished", "revision": presentation_call.turn_revision,
                    "thread_id": presentation_call.turn_target.get("thread_id"),
                    "text": message.content,
                },
            })
            presentation_call.enqueue_input(message.content)
            await presentation_call.finish_user_turn()

    monitoring = None
    if is_codex:
        llm.user_speaking = False
        llm.last_user_activity = time.monotonic()

        @user.event_handler("on_user_turn_started")
        async def user_started(aggregator, strategy):
            llm.user_speaking = True
            llm.last_user_activity = time.monotonic()

        @user.event_handler("on_user_turn_stopped")
        async def user_stopped(aggregator, strategy, message):
            llm.user_speaking = False
            llm.last_user_activity = time.monotonic()

        monitoring = asyncio.create_task(monitor_thread(llm, worker))

    @transport.event_handler("on_client_connected")
    async def connected(transport, client):
        if is_codex:
            llm.voice_connected = True
        if is_presentation:
            presentation_call.connected = True
            return  # No synthetic agent greeting or automatically generated response.
        if not is_codex:
            await worker_session.start()
        greeting = ("Hola, soy Terra. Estoy conectado a tus herramientas. ¿Qué hacemos?" if is_codex else
                    "Hola. Estamos en la prueba local con un trabajador simulado.")
        await worker.queue_frames([TTSSpeakFrame(greeting)])

    @transport.event_handler("on_client_disconnected")
    async def disconnected(transport, client):
        if is_codex:
            llm.voice_connected = False
        if presentation_call:
            presentation_call.disconnect()
        await runner.cancel()

    try:
        await runner.run()
    finally:
        if presentation_call:
            presentation_call.disconnect()
            presentation_call.closed = True
        if delivery:
            delivery.cancel()
            await asyncio.gather(delivery, return_exceptions=True)
        if monitoring:
            monitoring.cancel()
            await asyncio.gather(monitoring, return_exceptions=True)
        if is_codex:
            llm.voice_connected = False
        await worker_session.stop()


if __name__ == "__main__":
    from pipecat.runner.run import app, main
    mount_controls(app)
    mount_presentation(app)
    mount_connector_control(app, Path(__file__).resolve().parent.parent / '.voice-poc' / 'connector-events.sqlite3')
    main()
