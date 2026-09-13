# Voz de una conversación existente

Prueba disponible en http://127.0.0.1:8767/voice/ . El modo anterior permanece en
`/terra/`. Al conectar, el modo nuevo no crea ni ejecuta un LLM, no selecciona
modelos y no interpreta mensajes con un operador.

## Sala y presencia de la conversación

«Entrar en la sala» conecta al usuario por WebRTC, incluso sin agente. Una
conversación se incorpora cuando el usuario pide «activa la voz aquí» y el agente
ejecuta desde su tarea real:

```sh
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node "/path/to/sidevoice/voice_poc/activate_voice.mjs"
```

El lanzador valida la identidad real con Codex y reutiliza o crea un gateway por
tarea. El registro `.voice-poc/gateways/` conserva sus puertos locales. El archivo
`.voice-poc/presentation.json` es estado de presencia, no configuración que deba
editarse para elegir conversación. El servidor de audio debe estar en marcha.

Una sola conversación tiene la palabra. Incorporar otra corta la voz anterior y
cambia el destino manteniendo la misma sesión WebRTC y el micrófono. «Retirar
conversación» deja al usuario en la sala vacía. «Salir de la sala» cierra su audio;
la conversación puede seguir vinculada para la siguiente entrada. Estas acciones
no cancelan tareas ni sus monitores. La presencia indica destino de mensajes, no
que el agente esté generando o escuchando continuamente.

No se almacenan mensajes hablados sin destinatario para una incorporación futura.
Cada turno fija su destinatario al empezar. Las entradas aceptadas se guardan en
una cola persistente y se entregan a esa tarea aunque cambie el foco o se cierre
la llamada. Las respuestas antiguas se guardan como texto, sin reproducir audio.
Una entrega incierta no se reintenta automáticamente para evitar duplicar trabajo.

## Flujo

Micrófono → VAD/Silero → STT actual → cola FIFO de transcripciones literales →
`send_message_to_thread` de la app, con el contexto de presentación y el texto
separados. El gateway usa la identidad real `CODEX_THREAD_ID` del proceso que lo
arranca; no inventa una sesión ni modifica la autorización de la app.

La tarea mantiene su contexto y toolbox. Escribe normalmente y llama por shell:

```sh
python3 voice_poc/voice_channel.py speak --thread-id ID_DE_LA_TAREA --session-id SESION --revision REVISION --utterance-id LOCUCION <<'VOICE_TEXT'
Aquí va una explicación breve, escrita por el mismo agente que responde en pantalla.
VOICE_TEXT
```

Obtén SESION y REVISION al comenzar a atender el turno con `voice_channel.py status`.
Conserva esos valores; si cambian por una interrupción, no fuerces la respuesta antigua.
El endpoint guarda primero el texto y devuelve `text_saved: true`. Si el turno
conserva el foco de audio, encola síntesis Kokoro en el navegador. Si ha caducado,
devuelve `text_only` y el resumen queda disponible en el historial de esa tarea. No significa que el usuario lo haya escuchado. El VAD cancela la locución
al detectar voz. No se cancelan operaciones del harness ni se reenvían respuestas
habladas de vuelta al agente. Sin conexión, o mientras el usuario está hablando,
la herramienta conserva el resumen como texto; no guarda audio para reproducirlo después.

Las instrucciones están en `AGENTS.md` y en el contexto que acompaña la entrada de
voz. No se instala un MCP global ni se cambian permisos: en esta prueba la
herramienta usa el shell que el agente ya tiene. Las tareas con sandbox que impida
HTTP local necesitarán un transporte permitido; no se modifica ese sandbox.

## Límites de la prueba

- La entrada usa mensajería del harness: puede quedar en cola mientras trabaja.
  Para parar trabajo inmediatamente se usa el botón de detener de Codex.
- El agente debe llamar a la herramienta; no hay resumen automático de sus respuestas.
- No hay precisión palabra por palabra de lo que el usuario alcanzó a escuchar.
- Desconectar cancela la cola de entrada pendiente; una entrega ya iniciada puede
  haberse aceptado. No se reintentan entregas inciertas para evitar duplicados.
- Audio local; sin exposición remota ni adaptación a Paseo en este modo.

## Validación

`python -m unittest discover -s voice_poc -p 'test_*.py'`: pruebas del transporte
literal, repetición legítima, deduplicación de locuciones y rechazo de voz obsoleta.
La prueba WebRTC sintética verificó GPU Metal, retorno inmediato y barge-in de
aproximadamente 0,4 segundos. No sustituye una prueba con altavoces y micro reales.

También se verificó que una transcripción sintética entraba en la tarea principal
y que esa misma tarea podía devolver su voz a través de WebRTC, sin ejecutar
CodexLLMService ni iniciar otra sesión de agente.


## Voz y tareas en segundo plano

La arquitectura revisada y sus límites están en [ARCHITECTURE_REVIEW.md](ARCHITECTURE_REVIEW.md).
El monitor nuevo `task_watch.mjs` vive en el gateway y no necesita un interlocutor.
Las skills `voice-presentation` y `task-orchestration` se pueden usar juntas o separadas.
Usa `task_channel.py --help` para watch, status y unwatch. Las notificaciones son
hechos para la conversación coordinadora; no se leen automáticamente por un modelo
nuevo, y un estado de atención no autoriza contestar por el usuario.

## Validación de sala persistente

25 pruebas Python y 10 del monitor Node. Prueba WebRTC sintética: entrar sin
agente, incorporar la tarea real, retirarla durante audio y reincorporarla usando
el mismo ID de conexión; el corte observado fue de 139 ms. Las revisiones antiguas
se rechazaron y la nueva voz funcionó. Los cambios entre dos IDs distintos se
validaron en pruebas aisladas; falta la prueba manual desde una segunda tarea real.

## Filtro de ruido e idiomas

El 13 de septiembre se midieron dos segmentos de fondo: 224 ms/pico .783 y
192 ms/pico .8487; el segundo fue transcrito con alta confianza como `咳咳`.
La frase real «Prueba terminada» produjo 800 ms/pico .96. El filtro local exige
ahora un pico .9 además de 96 ms de evidencia de habla. Este ajuste separa las
mediciones recogidas, pero no prueba rechazo de todo ruido ni de voces de fondo.
Las pruebas locales preservan «sí», «no» y «para» sintetizados; voz humana tenue
puede requerir calibración adicional.

Por petición del usuario, se descartan transcripciones compuestas exclusivamente
por letras no latinas. Una mención dentro de texto latino se conserva. Esto es
un filtro de escritura, no un clasificador español/inglés: nombres, gallego y
otras lenguas latinas no se distinguen con esta regla. Los últimos veinte
segmentos exponen medidas, decisión y confianza en el estado, sin guardar audio.

## Instrucciones cargadas mediante skill

El gateway entrega una línea JSON con canal/sesión/revisión/ID de mensaje y la
transcripción literal, sin nombre de skill. Las instrucciones se cargan al unirse. No incorpora comandos de shell ni reglas
de comportamiento en cada intervención. La skill instalada contiene cómo unirse,
cómo responder por voz y texto y cómo tratar interrupciones. AGENTS.md solo enruta
hacia ella. Las conversaciones que ya contienen el formato antiguo lo conservan
en su historial: cambiar el transporte no borra mensajes ni reinicia su contexto.

## Sala con participantes y transcripción

La UI lista las conversaciones que registraron gateway de voz. Pulsar una llama
al gateway de esa tarea y cambia el destino confirmado; no inicia otra inferencia
ni lista tareas sin puente como participantes. Solo una recibe el micrófono.
`Cmd+D` / `Ctrl+D` silencia/activa y mantener Espacio abre temporalmente un micro silenciado;
soltar la tecla, cambiar de pestaña o perder foco lo vuelve a silenciar. Los
atajos requieren foco en la página y no actúan mientras se edita texto.

La transcripción se guarda en SQLite (`.voice-poc/room-history.sqlite3`), separada
por tarea. La UI consulta las últimas 1000 entradas y mantiene una copia en sessionStorage. No es el historial completo de Codex.
Muestra parciales si el transporte los produce, frases finales y texto del agente;
no simula karaoke por palabra. El STT actual devuelve texto por fragmentos.
El medidor representa audio real del micrófono, no probabilidad de habla.

El runtime se puede seleccionar con VOICE_RUNTIME_PYTHON. Esta instalación usa
.venv/bin/python para evitar dependencias
en Documentos marcadas dataless por macOS; el entorno antiguo se conserva.

## Idiomas configurables

La sala incluye «Idiomas y voces». Guarda preferencias en
`.voice-poc/language-settings.json`: STT automático/es/en, contexto opcional,
voz Kokoro española e inglesa y un idioma de voz de respaldo. Automático omite
`language` y el contexto vacío omite `prompt` en la API OpenAI. Se aplican a STT
al reconectar; las voces se resuelven por locución. El agente indica el idioma
con `voice_channel.py speak --language es|en`; sigue la intención del usuario,
sin fijar una voz en la skill. Esta implementación sigue siendo Kokoro MLX nativo,
no WebGPU. Probadas síntesis Heart (en) y Dora (es).

La transcripción visible recupera las últimas 1000 entradas del servidor,
separadas por tarea. Recargar o reconectar no la elimina. No es el
historial completo del harness: los mensajes enviados también se conservan en
la tarea real. La burbuja se construye durante el turno; su tick de entrega solo
aparece tras la confirmación del gateway. No existe recibo de lectura del agente.

Velocidad de Kokoro configurable entre 0.5× y 2×, en el panel de idiomas y voces;
se aplica a locuciones nuevas. Preferencia inicial del usuario: 1.15×.
Atajos actuales: Cmd+D (Mac) o Ctrl+D para alternar micrófono. Espacio abre
momentáneamente un micro silenciado y lo restaura al soltar/perder foco. Repeticiones
y liberación de Espacio consumen el evento para no activar botones ni desplazar
la página. Requieren foco en la sala y se ignoran al editar campos.

## Browser voice room

The main room now defaults to browser synthesis. On connect, it prepares cached
Kokoro weights and then joins the same task channel. Settings offer six language
rows (es/en/fr/it/pt/hi), compatible voice inheritance, per-language model choices,
previews and a reset for language overrides. Only Kokoro is implemented today.
Speed stays at the user's saved value. Browser execution changes require reconnect;
voice overrides apply to the next utterance. STT remains the configured backend API.

Speech text is dispatched via `voice-speech` and never synthesized on the Mac when
browser mode is negotiated. Browser completion receipts advance the speech queue.
Interruption clears scheduled WebAudio sources and invalidates queued worker results.
The VAD is still server-side; stopping audio does not stop task work.

Per-language `speed` is nullable: null inherits global `tts_speed`. The row preview
uses unsaved voice/speed selections; actual speech uses saved resolved settings.
Resetting language overrides resets speed inheritance too, without changing global speed.


## Entrega e historial independientes del foco (septiembre 2026)

- `room_history.py` guarda mensajes, destinatarios y estados antes del envío.
- El ciclo de vida de la aplicación mantiene la cola aunque termine WebRTC.
- Un gateway con `durable_delivery` puede entregar a cualquier participante
  registrado usando la identidad real del gateway como caller y la tarea
  destinataria como argumento; no modifica `CODEX_THREAD_ID` ni el foco.
- Al reiniciar, un POST que estaba en curso se marca `uncertain`; no se repite.
- `speak` guarda el resumen aunque su sesión o revisión hayan caducado. Una
  repetición con el mismo ID no reproduce audio al volver a seleccionar la tarea.
- Los tres puntos muestran envío pendiente o espera tras entrega confirmada.
  No equivalen a un recibo de lectura ni a actividad de inferencia confirmada.
- La lista de participantes conserva el acceso al historial sin gateway activo
  y cuenta respuestas nuevas de las tareas que no se están viendo.
- El historial contiene lo publicado por el agente en el canal de voz; no copia
  automáticamente toda la salida del harness. La skill debe conservar en contexto
  la regla de publicar también cuando la tarea pierda el foco.


El contrato del agente es publicar su respuesta, sin interpretar el foco. Para
mensajes `channel: voice` devuelve los metadatos originales sin consultar estado.
El CLI devuelve `published` cuando se guarda el resumen; los estados de audio
siguen disponibles en la API y la UI para diagnóstico. Un cambio de foco no
modifica el contenido ni provoca que el agente repita explicaciones.


La UI ordena por fecha de publicación/envío, no por la revisión a la que responde
el agente. Una intervención en curso es un borrador sin hora visible y permanece
después de los mensajes recibidos. Al finalizar se actualiza su hora; el historial
persistente confirma la marca del servidor. `audio_reason` registra el motivo
real de omisión/cancelación para la UI; mensajes anteriores sin esa información
muestran «Motivo no registrado», sin inferirlo retrospectivamente.


Prueba de reproducción pendiente (2026-09-13): una respuesta que llega durante
una intervención posterior en la misma tarea y llamada puede esperar con estado
`waiting_for_turn`. Al terminar de hablar, la aplicación asigna la revisión de
reproducción actual y despacha la cola; los metadatos originales del mensaje se
conservan en el historial. El agente publica exactamente igual. Audios que ya
fueron interrumpidos, una tarea sin foco y otra sesión no se reactivan. La espera
no sobrevive a desconexión/reinicio. Evaluar con el usuario antes de dar por
definitivo este comportamiento.

El medidor vertical junto al micrófono usa RMS en escala logarítmica y detecta
picos por separado: ámbar >= 0.8, rojo >= 0.98 con retención visual de 600 ms.
Es señal de posible saturación en el audio entregado por el navegador después
de su procesamiento; no diagnostica por sí sola saturación analógica del micro.


Entrada escrita: `/api/presentation/text` registra un mensaje independiente con
el destino capturado al enviar. Admite reintentos idempotentes y no sustituye
un turno de micrófono en curso. Requiere una sala conectada y tarea seleccionada;
funciona con el micrófono silenciado. El compositor conserva el texto ante fallos
y permite Enter para enviar / Shift+Enter para salto de línea.

El margen `audio_grace_seconds` (2 s) se inicia al cerrar una intervención o
enviar texto. Un nuevo inicio de voz cancela el temporizador y reinicia la espera
al terminar. `user_speech_timeout` (5 s) configura el silencio que cierra el turno.
Ambos se muestran en Avanzado; el silencio de STT requiere reconectar. La UI ya
no muestra `Waiting for a reply`, porque no era un estado real de inferencia.
