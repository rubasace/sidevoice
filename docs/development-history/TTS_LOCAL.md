# Voz local de Terra: Kokoro en MLX / Metal

Preparado como fase independiente; `local_tts.MacTTS` sigue intacto hasta que se active
`voice_poc.kokoro_tts.KokoroTTS` en la conexión Pipecat. No reinicia el servicio ni
modifica otros servidores de voz del usuario.

## Elección

Kokoro-82M bf16, voz española `ef_dora`, idioma `e`. Es un modelo pequeño con
implementación MLX explícita para Apple Silicon. No hay cuantización adicional.
Alternativas españolas disponibles: `em_alex`, `em_santa`. Pocket TTS ya dispone de
modelos en español; no se descarta por idioma, sino que esta primera integración
prioriza el camino GPU MLX de Kokoro verificado en este Mac.

Fuentes de los mantenedores:
- https://github.com/Blaizzy/mlx-audio/blob/main/docs/models/tts/kokoro.md
- https://huggingface.co/mlx-community/Kokoro-82M-bf16
- https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md
- https://github.com/kyutai-labs/pocket-tts

## Instalación nativa y activación

Desde la raíz del proyecto en macOS Apple Silicon:

```sh
.venv-voice/bin/pip install -r voice_poc/requirements-tts-mlx.txt
.venv-voice/bin/python -m voice_poc.test_kokoro_tts
```

`KokoroTTS()` usa `VOICE_TTS_VOICE=ef_dora`, `VOICE_TTS_SPEED=1.0` y
`VOICE_TTS_MODEL=mlx-community/Kokoro-82M-bf16`. También acepta esos tres valores
como argumentos explícitos `voice`, `speed`, `model`. No confundir Mónica (voz macOS)
con un nombre de voz de Kokoro: se valida y se rechaza.

El modelo público se descarga la primera vez a la caché Hugging Face. La inferencia
es local: un worker persistente carga MLX, exige `metal.is_available()`, selecciona
`mx.gpu`, confirma `Device(gpu, 0)` y entrega PCM mono 24kHz al pipeline. La
fonemización española con espeak es CPU; el modelo neuronal y vocoder son MLX GPU.
No hay reproducción independiente, TTS de pago ni fallback silencioso a CPU.

El proceso de síntesis no bloquea el bucle de audio/VAD. Al cancelar una generación
se termina y espera el worker; se descarta su salida y la siguiente locución crea
uno limpio. Eso añade carga de modelo tras interrupciones, pero evita arrastrar
inferencia antigua. El transporte Pipecat sigue siendo responsable de vaciar su
cola de reproducción cuando entra una interrupción.

## Evidencia local (2026-09-12)

`python -m voice_poc.test_kokoro_tts` sintetizó voz española real en
`.voice-poc/kokoro-dora-es.wav` (6.275 segundos mono 24kHz). Produjo exclusivamente
`TTSAudioRawFrame`, completó en 2.363s incluyendo arranque; inferencia 1.607s.
Registró `Device(gpu, 0)`, Metal disponible y 1.14GB de memoria GPU pico. Cancelación
durante inferencia: worker terminado en 6.9ms; siguiente generación recuperada con
83 frames. `pip check`: sin dependencias rotas. Los tiempos son de esta ejecución,
no una garantía de latencia extremo a extremo.

La prueba comprueba síntesis, frames y cancelación del worker; no sustituye probar
el micrófono, eco, vaciado de audio WebRTC ni preferencia subjetiva de voz. No se ha
hecho una evaluación perceptual comparativa de voces. Los segmentos españoles se
cortan por frase y como máximo a unas 240 letras para evitar truncado upstream;
las divisiones largas pueden perder continuidad de prosodia.

## Separación futura Mac / pod

El worker MLX se ejecuta nativamente en el Mac. **No instalarlo en el contenedor
Linux del pod ni asumir acceso a Metal desde Docker.** En este módulo el transporte
al worker es stdin/stdout privado, no un servidor TCP.

Para el despliegue remoto hay dos opciones que preservan la síntesis local:
1. Mantener el pipeline de voz en el Mac y alojar en el pod el puente a Paseo/Codex.
   La conexión autenticada Mac→pod intercambia texto y operaciones de tareas.
2. Implementar un servicio compañero nativo de TTS en loopback (contrato sugerido:
   POST `/tts` con texto/voz/velocidad, respuesta PCM 24kHz por streaming; cancelar
   la conexión cancela la síntesis). Para alcanzar el Mac desde el pod hace falta
   un túnel privado iniciado por el Mac, o llevar texto al cliente local. Un pod
   remoto no puede alcanzar el `127.0.0.1` del portátil. El endpoint/túnel no se
   implementa ni se publica con estos módulos.

El reverse proxy del pod sirve la interfaz/puente remoto; no convierte por sí solo
la síntesis en local. Queda pendiente validar el circuito dividido cuando se elija
esa arquitectura. No se ha expuesto ningún puerto ni modificado infraestructura.
