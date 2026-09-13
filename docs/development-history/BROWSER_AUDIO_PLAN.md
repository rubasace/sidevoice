# Audio en navegador sin instalación

Decisión del usuario: inicialmente TTS Kokoro en el cliente y STT OpenAI mediante
el servidor. En el futuro ambos deben permitir modelos en navegador o proveedores
API, elegibles desde configuración. No requiere daemon ni Python del usuario.

El navegador descarga runtime, modelo y voz versionados automáticamente, con
progreso visible, y reutiliza Cache API. La caché puede ser eliminada por el
navegador: contemplar descarga posterior, falta de espacio y botón para borrarla.
Servidor en clúster: configuración, credenciales API, salas y puente al harness.
Cliente: captura, corte inmediato de reproducción, síntesis y cola de audio.
Preservar sesión/revisión/binding para descartar resultados obsoletos.

Configuración propuesta:
- TTS: proveedor, modelo, voz, velocidad; inicialmente Kokoro/Dora.
- STT: proveedor, modelo, idioma; inicialmente OpenAI/gpt-4o-transcribe.
- Ejecución local: automática WebGPU con alternativa WASM CPU explícita y estado
  real de carga/error. API es otra elección, no fallback de pago silencioso.
- Turnos: margen de silencio y, después de validación, detección de fin de turno.

Bloqueo técnico de TTS: kokoro-js oficial fonemiza inglés; ef_dora.bin existe en
ONNX pero cambiar voz no incorpora fonemización española. Portar/probar el
preprocesamiento español (Misaki/eSpeak WASM) antes de sustituir Kokoro MLX.
Mantener la implementación actual mientras se valida una ruta de prueba aparte.

Validar: español/números/nombres, textos largos completos, WebGPU y WASM forzado,
interrupciones/cambios de tarea, caché fría, pérdida de GPU y navegador real.
La existencia de navigator.gpu no garantiza compatibilidad del modelo.

Fuentes revisadas:
- https://github.com/hexgrad/kokoro/tree/main/kokoro.js
- https://github.com/hexgrad/kokoro/blob/main/kokoro.js/src/phonemize.js
- https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/main/voices
- https://huggingface.co/docs/transformers.js/en/api/env
- https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html

## Ajuste inmediato de turnos

VOICE_USER_SPEECH_TIMEOUT ahora configurable, predeterminado 5 segundos después
del VAD stop (0.35 s): unos 5.35 s de silencio como mínimo, sujeto a STT pendiente.
Reanudar habla reinicia la espera. VAD start permanece en 0.08 s.
Detección semántica/acústica del fin de turno pendiente de probar; no está activa.

## Pending spoken explanations (requested discussion; not implemented)

Current behavior: beginning a new user turn increments revision, invalidates queued
and active speech, and rejects old-revision speak requests even after the new user
turn ends. Rejected requests return an error to the agent. Already accepted speech
can later become interrupted; the agent sees this by reading status, not through
an automatic interruption message. Playback completion measures transport output,
not actual browser playback or human understanding.

Proposed improvement: attach compact delivery receipts to the next user message,
including utterance ID, source turn, status and last confirmed played chunk. Track
pending explanation separately from pending work. Let the conversation agent merge
still-relevant unanswered points with the new request, or drop superseded points.
Never automatically replay the previous audio or repeat its associated actions.
Browser playback acknowledgments belong in the browser-TTS migration. No read/understood
claim should be inferred from a playback acknowledgment.


## Avance: prueba real de navegador

Implementado `browser_audio/`, con compilación reproducible npm y página
`/voice-browser/`. Probada síntesis española e inglesa con WebGPU y española con
WASM CPU. Motor eSpeak-NG completo mediante WASM + adaptación de fonemas española;
no usa el paquete phonemizer que solo incluye inglés. Modelos fijados a revisión.
El botón Detener invalida resultados pendientes y para las fuentes Web Audio.

La sala sigue con Kokoro nativo; su menú ya permite escuchar muestras de voces.
Siguiente hito: integrar el worker en la sala con VAD en cliente y recibos de
reproducción, sin modificar las herramientas ni identidad de la tarea.
Ver mediciones y límites en browser_audio/README.md.
