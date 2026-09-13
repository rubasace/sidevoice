# Evolución de la prueba de voz

## Decisiones propuestas

Separar tres decisiones:
1. Inicio de habla: VAD local corta playback y descarta audio del turno anterior;
   no necesita un LLM ni espera a que termine la transcripción.
2. Fin de intervención: VAD más detector de final de turno; espera configurable
   como alternativa. Un modelo pequeño puede ayudar a decidir si falta continuar.
3. Intención de trabajo: el agente que tiene el contexto interpreta «para de
   hablar», «explícame esto» o «cancela el trabajo». Un clasificador pequeño puede
   proponer una intención, pero no debería cancelar tareas por una etiqueta sin
   contexto. Una parada explícita debe ejecutarse con la operación del harness y
   confirmarse. No confundir mensaje entregado con cancelación ejecutada.

Interrumpir voz no vuelve a ejecutar acciones. Explicaciones no enviadas se
recuperan según el contexto; recibos explícitos en el siguiente turno mejorarán
esa fiabilidad. No reproducir automáticamente el audio antiguo.

## Tecnología y organización

Actual: Python/FastAPI/Pipecat, gateway Node, interfaz HTML/CSS/JS sin framework.
Prueba WebGPU: ES modules + esbuild + Transformers.js/ONNX Runtime Web + eSpeak WASM.
Ya existe .git local; no hay una base de commits y muchos prototipos están sin
seguimiento. No se ha creado repositorio remoto ni publicado contenido.

Siguiente estructura recomendada: React + TypeScript + Vite para la sala y
configuración, un paquete TypeScript independiente para audio/worker y adaptadores,
y conservar Python para Pipecat/STT mientras aporte valor. React gestiona la UI;
los workers y protocolos no deben depender de React. Migrar el panel de ajustes
primero y después chat/participantes, sin reescribir los protocolos a la vez.

## Hitos verificables

- [x] Muestras de voz en configuración, separadas del historial del agente.
- [x] Prueba aislada: WebGPU español/inglés y WASM español.
- [ ] Validar pronunciación humana, textos largos y pérdida de GPU.
- [ ] Integrar worker en sala: epochs, cambio de tarea, desconexión y VAD cliente.
- [ ] Adjuntar recibos de reproducción/rechazo al siguiente mensaje del usuario.
- [ ] Crear una base de repositorio limpia con fuentes y pruebas, excluyendo
      secretos, modelos, entornos, audios y otros prototipos; acordar remoto aparte.
- [ ] UI React/TypeScript y pruebas reales de navegador para las transiciones.
- [ ] Despliegue clúster y verificación de adaptadores Codex/Claude/Paseo.

Referencia revisada: https://github.com/steveseguin/tts-web (tts.rocks). Aprovechar
sus decisiones de selección de motor, caché, carga y formatos de entrada. No se
ha incorporado su código ni probado que su Kokoro admita voz española.

### Integrated browser room (2026-09-13)
- `/voice/` now negotiates client-side Kokoro; `/voice-browser/` is still a diagnostic page.
- Six language rows with model/voice inheritance, previews, reset overrides and persisted settings.
- Browser playout receipts gate the speech queue; interruption invalidates worker/audio output.
- Model catalog currently contains Kokoro only. Japanese/Chinese G2P, other providers,
  client VAD and cluster deployment remain pending.

### Next model and cross-device architecture (2026-09-13)

Completed: browser-only room synthesis, Spanish/English UI, compatible inherited voice
labels, centered scrollable settings, and automatic preparation progress for preview/join.
Explicit preload is optional; model, voice asset and first-audio stages share one loader.

Next, extract one engine adapter per model behind prepare/progress, synthesize-to-PCM,
cancel and dispose. Capabilities should declare languages, compatible voices, speed
support, GPU/WASM availability, revisions and download footprint. Current `engine.js`
is still Kokoro-specific: a catalog row alone does not add a working model. Reuse
session epochs, playback queue, browser receipts and UI across adapters. Load engines
lazily, release GPU memory when switching, and preserve native model speed semantics.

Candidates checked against primary sources:
- Supertonic 3: browser ONNX/WebGPU and WASM sample, 31 languages. Repository currently
  redirects to an archive namespace; pin a reviewed revision and verify maintenance.
  https://github.com/supertone-oss-archive/supertonic/blob/main/web/README.md
  https://huggingface.co/Supertone/supertonic-3
- Pocket TTS: current upstream lists six languages and community in-browser ports.
  CPU/WASM is a valid first target; do not claim all ONNX ports support WebGPU or the
  newest multilingual weights without testing that exact port/export.
  https://github.com/kyutai-labs/pocket-tts#in-browser-implementations
  https://github.com/KevinAHM/pocket-tts-onnx-export
- OuteTTS: Transformers.js has a WebGPU example; evaluate latency and memory before
  choosing it for an interruptible call.
  https://github.com/huggingface/transformers.js-examples

Client browser audio contains no macOS dependency. Windows/Android/Safari clients are
architecturally possible, but only the Mac embedded browser has been tested. Current
localhost URL and loopback-bound server are not reachable from another device. A pod
rollout needs HTTPS, reachable media transport (STUN/TURN as required), room access
control and a harness adapter replacing the Mac desktop app pipe. Legacy native TTS
and operator imports/start scripts still need separation from the presentation server.
Browser support alone does not establish sufficient mobile memory or realtime speed.
Test actual Windows, Android and iPhone devices, interruption latency, mic echo,
background/lock behavior and recovery from GPU device loss before promising parity.
