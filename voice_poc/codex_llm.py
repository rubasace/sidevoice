"""A full Codex agent, with voice as its final-response presentation layer."""
import asyncio
import json
import os
from pathlib import Path
import time
import uuid

from loguru import logger
from openai.types.chat import ChatCompletionChunk
from pipecat.services.ollama.llm import OLLamaLLMService

ROOT = Path(__file__).resolve().parent.parent


class CodexLLMService(OLLamaLLMService):
    def __init__(self, *, instructions, model="gpt-5.6-terra", **kwargs):
        super().__init__(settings=self.Settings(
            model=model, system_instruction=instructions,
        ), **kwargs)
        self.thread_id = None
        self.selected_model = model
        self.active_model = None
        self.last_model = None
        self.last_error = None
        self.voice_connected = False
        self.binary = os.getenv("VOICE_CODEX_BIN", "/Applications/ChatGPT.app/Contents/Resources/codex")
        self.schema = Path(__file__).with_name("codex_reply.schema.json")
        self.workdir = Path(os.getenv("VOICE_WORKSPACE", str(ROOT))).resolve()
        self._turn_lock = asyncio.Lock()
        self._pending_turns = set()
        self._last_result = None

    def command(self):
        command = [self.binary, "exec"]
        if self.thread_id:
            command += ["resume", self.thread_id]
        # Keep user config, MCP, plugins and native tools. Persona is independent
        # from execution permissions; the owner explicitly requested full access.
        command += ["--skip-git-repo-check", "--json", "-m", self.active_model or self.selected_model,
                    "-c", 'model_reasoning_effort="low"',
                    "--dangerously-bypass-approvals-and-sandbox",
                    "-c", "developer_instructions=" + json.dumps(self._settings.system_instruction),
                    "--output-schema", str(self.schema),
                    "-c", 'mcp_servers.voice_desktop.url="http://127.0.0.1:8769/mcp"',
                    "-c", 'mcp_servers.voice_desktop.enabled=true', "-"]
        return command

    async def get_chat_completions(self, context):
        params = self.get_llm_adapter().get_llm_invocation_params(
            context, system_instruction=self._settings.system_instruction,
            convert_developer_to_user=True,
        )
        params = {key: value for key, value in params.items()
                  if isinstance(value, (str, list, dict, bool, int, float)) or value is None}
        # Barge-in cancels this waiter, not the real agent/tool operation. Retain
        # a strong reference and serialize the next turn on the same session.
        state = {"started": False}
        task = asyncio.create_task(self._serialized_turn(params, state))
        self._pending_turns.add(task)
        task.add_done_callback(self._turn_finished)
        try:
            response = await asyncio.shield(task)
        except asyncio.CancelledError:
            if not state["started"]:
                task.cancel()  # Superseded input must not execute later.
            raise

        async def stream():
            yield ChatCompletionChunk(
                id=str(uuid.uuid4()), created=int(time.time()), model=response.get("model", self.selected_model),
                object="chat.completion.chunk",
                choices=[{"index": 0, "delta": {"role": "assistant", "content": response["text"]},
                          "finish_reason": None}],
            )
        return stream()

    def _turn_finished(self, task):
        self._pending_turns.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.error("El turno del interlocutor falló: {}", type(task.exception()).__name__)

    async def _serialized_turn(self, params, state):
        async with self._turn_lock:
            state["started"] = True
            prompt = (
                "Este es el historial de la llamada de voz. Atiende el último mensaje o evento. "
                "Las respuestas anteriores pudieron ser interrumpidas o no escuchadas; no repitas "
                "acciones ya realizadas. Tu historial nativo conserva herramientas y resultados. "
                "Puedes usar todas tus herramientas nativas. Devuelve la respuesta final en el "
                "esquema text para que se reproduzca por voz.\n"
                + json.dumps(params, ensure_ascii=False)
            )
            if self._last_result:
                prompt += "\nÚltima respuesta completada (puede no haberse oído): " + json.dumps(self._last_result, ensure_ascii=False)
            self.active_model = self.selected_model
            self.last_error = None
            try:
                response = await self._run_turn(prompt)
                response["model"] = self.active_model
                self.last_model = self.active_model
                self._last_result = response
                return response
            except Exception:
                self.last_error = "El turno falló. Puedes elegir otro modelo y volver a intentarlo."
                raise
            finally:
                self.active_model = None

    async def _run_turn(self, prompt):
        process = await asyncio.create_subprocess_exec(
            *self.command(), cwd=self.workdir, start_new_session=True,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, limit=8 * 1024 * 1024,
        )
        error_task = asyncio.create_task(process.stderr.read())
        response = None
        try:
            process.stdin.write(prompt.encode())
            await process.stdin.drain()
            process.stdin.close()
            async for line in process.stdout:
                event = json.loads(line)
                if event.get("type") == "thread.started":
                    self.thread_id = event["thread_id"]
                    logger.info("Interlocutor Terra: {}", self.thread_id)
                if event.get("type") == "item.completed":
                    item = event.get("item", {})
                    if item.get("type") == "agent_message":
                        try:
                            candidate = json.loads(item["text"])
                            if isinstance(candidate, dict) and isinstance(candidate.get("text"), str):
                                response = candidate
                        except (ValueError, KeyError):
                            pass  # Native progress commentary is not spoken.
            await process.wait()
            if process.returncode or response is None:
                raise RuntimeError("El interlocutor no pudo completar su respuesta; revisa la sesión Codex.")
            return response
        finally:
            # No SIGTERM on voice interruption. This coroutine is shielded.
            errors = await error_task
            if errors:
                logdir = ROOT / ".voice-poc"
                logdir.mkdir(exist_ok=True)
                (logdir / f"codex-{self.thread_id or process.pid}.stderr").write_bytes(errors)
