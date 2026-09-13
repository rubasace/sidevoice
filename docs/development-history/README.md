# Modo nuevo: voz de esta conversación

La prueba sin operador está en `/voice/`. Consulta [PRESENTATION.md](PRESENTATION.md).
La [revisión adversarial e integración](ARCHITECTURE_REVIEW.md) documenta las skills combinables,
el monitor de tareas independiente y las garantías de entrega de voz.
La implementación anterior de Terra se conserva a continuación.

# Terra: voz local para tus conversaciones de Codex

Interfaz propia: **http://127.0.0.1:8767/terra/**. No sustituye la interfaz de
Codex. El Playground original sigue disponible en `/client/`.

## Arranque local

En macOS Apple Silicon, desde una terminal de Codex con su conexión de herramientas:

```sh
./start-terra.sh
```

Arranca el gateway de herramientas si no existe y después el servidor de voz.
Para iniciarlos por separado: `./start-voice-tools.sh` y `./start-voice-poc.sh`.
El gateway necesita `CODEX_APP_TOOLS_PIPE_PATH`, proporcionado por la app; no se
modifica la validación nativa de identidad de Codex. La app debe permanecer abierta.
El script unificado solo cierra los procesos que él mismo arrancó.

## Qué controla la vista

El selector cambia exclusivamente el modelo del interlocutor. Lee el catálogo
local de modelos de Codex. El prompt `persona.md` permanece igual y la CLI reanuda
el mismo hilo. Si hay un turno en curso, termina con su modelo original y el
siguiente usa el elegido. No hay reconexión de audio al cambiarlo.

La vista muestra el modelo en ejecución, último modelo utilizado, hilo activo,
estado de GPU y contadores del filtro de transcripción. La preferencia se guarda
en `.voice-poc/preferences.json`, nunca en la configuración global de Codex.
Cada llamada controla solo su propio interlocutor. Reconectar la llamada todavía
crea otro interlocutor: no existe recuperación automática de esa sesión.

## Interlocutor e hilo activo

Terra conserva el toolbox nativo y los MCP/plugins de la instalación. Por petición
del usuario se ejecuta sin sandbox ni solicitudes de aprobación adicionales; eso
no añade operaciones que el harness no exponga. Su papel está definido por prompt:

- Conversación libre al conectar. Reenvío literal cuando el usuario elige una tarea.
- Excepciones locales estrictas: gestión de la llamada y preguntas claramente a Terra.
- Selección de hilo explícita mediante `voice_select_thread`; leer otro hilo no cambia el destino.
- Resultados, bloqueos y preguntas relevantes se presentan por voz mediante seguimiento.
  Se omiten comentarios técnicos y se deduplican IDs de eventos. Los eventos son datos,
  no mensajes nuevos del usuario y no se reenvían creando bucles.
- Los enlaces y artefactos se anuncian como disponibles en la conversación; no se leen
  completos salvo petición. El acceso al artefacto sigue en la conversación de Codex.
- Terra traslada las preguntas de otros agentes al usuario y espera su respuesta;
  no responde ni confirma en su nombre.
- `voice_clear_thread` vuelve a conversación libre sin detener la tarea.

No hay destino inicial ni vinculación automática al leer, crear o enviar mensajes.
La elección de tarea requiere una petición explícita del usuario.
La política de interpretación es del modelo; no constituye una garantía semántica.

## Audio y transcripciones espurias

La voz predeterminada es **Kokoro MLX, ef_dora (español)**. Para usar PocketTTS con una
voz clonada, añade `VOICE_TTS_BACKEND=pocket` y
`VOICE_TTS_VOICE_FILE=/ruta/a/voz.bin` al entorno antes de arrancar. El primer inicio
descarga y compila FluidAudio; los siguientes conservan el motor Core ML cargado durante
la llamada. `VOICE_TTS_BACKEND=kokoro` o `macos` recupera los motores anteriores.

La transcripción usa `VOICE_STT_API_KEY` en `.env.voice` y por defecto
`gpt-4o-transcribe`. La clave se lee al conectar, no se envía al navegador ni se
reutiliza para el agente. Solo los segmentos aceptados se envían al STT cloud.

Se reprodujo una alucinación con 2 segundos de silencio exacto: con el prompt antiguo
GPT devolvió «Conversación en español sobre software.»; sin prompt también inventó
texto. El nuevo filtro valida WAV con un Silero independiente antes de la API:
probabilidad de voz >=0,5, al menos64ms y RMS>=0,001. Después descarta frases largas
con confianza extremadamente baja cuando la API la devuelve. Se retiró el glosario.
Silencio/ruido/clics se rechazan sin llamada cloud; no/para/sí reales y repetidos pasan.
No se descartan frases solo por repetirse: una orden repetida puede ser legítima.

La detección rápida de interrupciones sigue separada. Configurables:
`VOICE_VAD_START_SECS`, `VOICE_VAD_STOP_SECS`, `VOICE_VAD_CONFIDENCE`,
`VOICE_VAD_MIN_VOLUME`. La vista solicita echoCancellation, noiseSuppression y
AGC al navegador y muestra si confirma el procesamiento. No silencia el micro
mientras Terra habla. La eficacia del AEC con altavoces reales necesita prueba manual;
la voz de otra persona o una televisión puede seguir siendo reconocida como habla.

## Interrupciones

Hablar corta el audio. No mata una operación ya iniciada por el interlocutor.
Una orden todavía en cola que se rectifica se cancela antes de ejecutar.
Las operaciones reales conservan sus resultados aunque no se haya oído la respuesta.

La app no expone una herramienta de parada inmediata de otras tareas. Terra envía
la solicitud literal y no la presenta como una parada confirmada. Una herramienta
larga del propio interlocutor retrasa el siguiente turno; no se afirma que esa
solicitud pueda adelantarse a cualquier operación ya en ejecución.

## Verificación

```sh
.venv-voice/bin/python -m unittest discover -s voice_poc
.venv-voice/bin/python -m voice_poc.test_kokoro_tts
.venv-voice/bin/python -m unittest discover -s deploy/terra-relay -p 'test_*.py'
```

Comprobado con servicios reales: listado/creación/lectura de tarea de prueba;
selección de destino y envío literal; seguimiento convertido en evento; conversación
WebRTC con Kokoro; cambio Terra→Luna con el mismo hilo y conexión de audio. GPU
`Device(gpu, 0)` confirmada durante la llamada. Prueba sintética de barge-in de baja
amplitud: último audio audible284ms después del inicio de la intervención. No es
una garantía de latencia en cualquier micrófono o red.

## Contenedor y reverse proxy

[deploy/terra-relay/README.md](../deploy/terra-relay/README.md) contiene el relay,
conector saliente desde Mac, Dockerfile, Compose y ejemplo nginx. El contenedor
no ejecuta MLX ni accede a Metal. El TTS es un subprocess privado del servidor
nativo; no se expone un endpoint de inferencia a Internet.

Para WebRTC remoto se puede proporcionar `PIPECAT_ICE_SERVERS` (JSON de servidores
STUN/TURN): lo reciben tanto el servidor Pipecat como la vista propia. Credenciales
TURN se entregan al navegador según el protocolo; usar credenciales temporales en
un despliegue real. Esto prepara la configuración, no prueba conectividad remota.
El relay requiere autenticación y TLS remoto. Ningún acceso externo se publicó.
El daemon Docker está apagado: Compose validado, imagen sin build verificado.
Audio fuera de LAN y certificados/TURN siguen pendientes de una prueba posterior.
