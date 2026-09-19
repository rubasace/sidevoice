# Audio de la sala (issue #19)

Base: `implement-eleven-labs`, commit `4933665`.
Trabajo de audio trasladado a `sidevoice/issue19-elevenlabs` en el worktree
`audio-elevenlabs`. El worktree anterior queda limpio.

## Micrófono abierto y eco

Las respuestas de Kokoro y ElevenLabs mantienen el micrófono abierto. La detección
de voz sigue pudiendo interrumpir la reproducción; se retiró el mute automático
de la primera propuesta. Las muestras de voz en configuración conservan su mute
temporal para no enviarlas como una intervención.

La captura solicita cancelación de eco y reducción de ruido. Si la pista declara
soporte para `echoCancellation: "all"`, se solicita ese modo para incluir el TTS
local. Si no lo admite o rechaza el cambio, se conserva la cancelación normal.
Captura y reproducción comparten un AudioContext y el worklet adapta las muestras
a la frecuencia del servidor. Tras abrir el micro se reanuda la salida; cuando
Audio Session está disponible se solicita el modo de conversación bidireccional.

Esto es una mejora comprobable de la configuración y del ciclo de vida del audio,
no una garantía de eliminación del eco acústico. Sigue pendiente probar altavoces
a volumen alto y Bluetooth en coche en los navegadores y dispositivos reales.

## Velocidad de ElevenLabs

La integración genera el audio con `voice_settings.speed` en la petición al
proveedor. El navegador no acelera el MP3. La interfaz usa el rango documentado
0,7–1,2× para ElevenLabs y 0,5–2× para Kokoro. Las velocidades heredadas de otro
motor se ajustan al rango aplicable y la vista previa muestra su valor efectivo.

Referencias:
- [Velocidad de ElevenLabs](https://elevenlabs.io/docs/help-center/product/core-capabilities/text-to-speech/can-i-change-the-pace-of-the-voice)
- [Modos de cancelación de eco](https://w3c.github.io/mediacapture-main/#dom-echocancellationmodeenum)

## Dispositivos y pantalla

El selector sobre los controles permite cambiar el micrófono durante una llamada.
La salida se selecciona cuando el navegador expone AudioContext.setSinkId; en los
demás se indica que debe cambiarse en los ajustes del sistema. Una selección
fallida conserva el dispositivo anterior. Las barras muestran niveles recientes
de la entrada, y el silencio predeterminado para terminar el turno es 2,5 s
(sin sobrescribir preferencias ya guardadas).

Wake Lock se solicita al entrar y al volver a primer plano; se libera al colgar.
El panel informa si no está disponible o si se deniega. No garantiza captura en
segundo plano ni con la pantalla bloqueada manualmente.

## Sonido de presencia mientras la conversación trabaja (issue #42)

Entre el momento en que la conversación tiene lo que dijiste y el momento en que habla
pueden pasar veinte segundos o más. Sin nada audible en medio, un agente trabajando y uno
colgado se oyen igual, así que el navegador pone un fondo suyo en ese hueco. No hay modelo
de por medio y el servidor no interviene: la sala ya emite todos los estados que hacen falta.

Empieza con el acuse `read` del turno que envió **este** navegador; si el harness no informa
de lecturas, un segundo y medio después de `delivered`/`unconfirmed`. Termina con la primera
respuesta hablada de ese turno, al abrirse otra intervención, cuando el usuario habla, cuando
la entrega falla (`not_sent`, `channel_closed`), al cambiar de conversación y al caerse la sala.
`RoomVoice.cancel()` lo apaga también, así que ninguna locución comparte la salida con él.

El sonido se genera en el navegador, sin ficheros: un bucle de cuatro segundos con una banda
de ruido entre unos 110 y 420 Hz y dos parciales a 220 y 330 Hz, respirando una vez cada dos
segundos. El bucle empalma consigo mismo (los parciales cierran ciclos enteros a los cuatro
segundos y el ruido se encadena con su propia cola). El buffer se normaliza a pico 1, de modo
que la ganancia **es** el pico en escala completa: el valor por defecto, 3,5 %, son −29 dBFS de
pico y unos −42 dBFS de RMS. Entra y sale con una rampa de 250 ms y al apagarse deja la cola de
silencio de siempre, porque un sink vacío en iPhone Safari repite su último instante.

Sale por el mismo `MediaStreamAudioDestinationNode` y el mismo `<audio>` oculto que la voz, así
que la cancelación de eco del dispositivo lo cubre, y nunca es lo primero que suena en una salida
recién abierta: hasta que el saludo ha pasado o ya se ha reproducido una locución, se niega a
empezar (un primer origen silencioso dejó al elemento fuera de la referencia de eco toda la
sesión, 2026-09-19).

Es un ajuste **de este dispositivo**: activado o desactivado, y un volumen de 1 a 12 % en
«Avanzado». La sala no recibe ni guarda ninguno de los dos.

## Lo que se dijo mientras no había conexión (issue #46)

La reconexión automática mantiene la llamada cuando se cae el socket, pero el micrófono nunca se
para: durante ese hueco la persona sigue hablando y, hasta ahora, a nadie. La página se queda con
ese audio y se lo da a la sesión siguiente.

**En el navegador.** Mientras `lostConnection` reintenta, el worklet de captura sigue vivo — no se
para el medidor ni se suelta el contexto — y cada trama de 20 ms que no se puede enviar entra en un
anillo acotado a los **últimos 30 s**; lo más viejo se cae. Al volver la sala se recorta el tramo
con voz (pico por trama por encima de −34 dBFS, con 250 ms de margen a cada lado): si el hueco solo
tuvo ruido de sala, **no se envía nada**. Si al caer lo más viejo ya había voz, no se puede saber
cuánto se perdió, y eso se dice — no se acorta la frase en silencio.

**Cómo viaja.** Rodajas base64 en tramas de texto `voice-catchup` (`seq`, `final`, `sample_rate`,
`truncated`, `started_at`), nunca como las tramas binarias del micrófono. Las binarias son audio en
directo y van al detector; esto se dijo a una sesión que ya no existe y **no puede** abrir una
intervención aquí — lo impide la forma del mensaje, no el cuidado de quien lo lee. Las rodajas
además dejan cada trama pequeña: ningún límite de tamaño por el camino puede tirar justo lo que
esta función existe para salvar. Una rodaja fuera de orden tira la grabación entera antes que
transcribir una frase con un agujero, y por encima de 35 s la sala la rechaza y lo dice.

**En la sala.** `VoiceCall.catch_up` la reconoce por su cuenta, con el mismo *speech gate*, el mismo
proveedor y los mismos filtros que un turno, y bajo el mismo *lock*, así que no se entrelaza con una
intervención en curso. No toca el detector, ni la época del navegador (queda en la revisión 0, la de
antes de su primer turno), ni el texto que la sesión tenga retenido. Si hay texto, es **un** mensaje
en el diario, con el reloj del propio navegador y marcado `offline` (`buffered` o `truncated`); si no
lo hay, no es un mensaje ni una incidencia y no se envía nada. El PCM se suelta en cuanto se ha
reconocido: la sala no guarda nada de él, ni en disco ni en el diario, y la telemetría no ve audio ni
texto, solo duraciones y la decisión.

**En la burbuja.** El mensaje aparece donde le toca por la hora en que se dijo, no por la hora en que
la sala se enteró, con «Capturado sin conexión» debajo, o «Capturado sin conexión · solo se guardaron
los últimos 30 s» cuando el anillo desbordó. Su acuse de entrega es el de cualquier otro mensaje.

Queda por comprobar en un dispositivo: hablar durante un reinicio real de la sala en el iPhone y
confirmar que la frase llega entera, que no abre una intervención al volver, y que un hueco de más de
30 s dice que se cortó.

## Lo que te dijeron mientras no estabas (issue #52)

La otra dirección del mismo momento. Del operador, conduciendo: «si entro en un túnel y se cae la
conexión, al volver me gustaría oír lo último que me dijiste». El texto está en la transcripción, y
quien conduce no puede leerla.

**Qué se repite.** Al volver a la sala — tras una reconexión, o al entrar otra vez en esa conversación —
la sala le ofrece a ese navegador las respuestas de la conversación que **no llegó a oír enteras**, de la
más antigua a la más reciente y antes que nada nuevo. Una que sonó hasta el final no se repite. Una que
paraste tú tampoco: parar el audio es una decisión, no un hueco. Lo demás — en cola, sintetizándose,
cortada a media frase cuando se fue el socket, fallida — es una respuesta que este navegador no oyó.

**Cómo lo sabe la sala.** No lo adivina. Cada locución guarda lo que hizo con ella cada navegador
(`Utterance.clients`), y como reconectar es entrar con un id nuevo, la página nombra en su saludo los
ids que ha usado (`sessions`, hasta ocho, solo cadenas). Nombrar un id solo puede **quitar** una
respuesta de la repetición, nunca meter la de otro navegador: equivocarse cuesta como mucho oír algo
dos veces.

**Cuánto hacia atrás es de este dispositivo**: desactivado, el último minuto, 2 minutos (por defecto),
5 o 15, en «Avanzado». La sala lo recibe en el saludo, lo usa para esa llamada y no guarda copia —
a diferencia del ajuste del detector, que es de la sala porque nadie lo oye y romperlo lo rompe para todos.

**Cómo se reproduce.** Cada repetición entra en la misma cola de reproducción del navegador, como una
locución más, con la época de quien la oye. De ahí salen dos garantías sin escribir una línea para
ellas: hay una salida y una cosa sonando en ella, así que **una respuesta vieja nunca suena encima de
una en directo**; y una intervención nueva la cancela por el mismo `halt` que interrumpe cualquier otra
cosa. Una repetición cancelada antes de sonar no dice que sonó: sigue siendo una respuesta no oída y se
volverá a ofrecer.

**En la burbuja.** «Repitiendo lo que no oíste» mientras suena, «Repetido al volver» cuando terminó,
«Repetición cancelada» si hablaste antes. Si la respuesta la pagó un motor externo y la sala ya no
tiene ese *render* (la caché acotada lo soltó), **no se vuelve a pagar y no se inventa**: la burbuja
dice «No se pudo repetir · la sala ya no tiene ese audio». Una respuesta tan vieja que ya no está en el
registro de la sala no tiene burbuja donde decirlo, y por eso no se dice nada de ella.

**La sala no guarda nada nuevo.** Las respuestas ya eran suyas; una repetición no añade fila al diario
ni toca la de la respuesta, salvo para dejar constancia de que por fin alguien la oyó entera.

Queda por comprobar en un dispositivo: cortar la red del iPhone mientras la conversación habla, volver,
y oír lo que se perdió; comprobar que hablar durante la repetición la corta; y que con el ajuste en
«Desactivado» no suena nada al volver.

## Verificación y prueba manual pendiente

Las pruebas automatizadas cubren micro abierto durante TTS e interrupción por voz,
AEC ampliado y fallback, cambios de dispositivos fallidos o cancelados, contexto
de audio compartido, liberación de Wake Lock pendiente y envío de la velocidad
nativa a ElevenLabs (con HTTP simulado, sin consumir síntesis del proveedor).

Para validar físicamente:
1. Hablar e interrumpir una respuesta de ElevenLabs con altavoces y volumen alto.
2. Repetir con Bluetooth/coche y cambiar entrada/salida durante la llamada.
3. Dejar la sala visible más allá del apagado automático y comprobar Wake Lock.
4. Volver desde otra aplicación y comprobar la recuperación; probar bloqueo
   manual por separado, sin asumir que el sistema mantendrá la captura.
5. Comparar 0,85×, 1× y 1,15× en ElevenLabs y confirmar la cadencia generada.
6. Oír el sonido de presencia en móvil y en altavoz de portátil: si al 3,5 % no se percibe,
   subirlo en Avanzado y anotar el valor que sí funciona, en lugar de suponerlo.
7. Comprobar con él sonando que no abre ninguna intervención (ni con el detector a 0,35 de
   volumen mínimo, ni en manos libres) y que no se oye a sí mismo por el micrófono.
8. Reiniciar la sala mientras se habla y comprobar que lo dicho en el hueco llega como un mensaje
   marcado «Capturado sin conexión», que no abre una intervención al reconectar, y que un hueco
   de más de 30 s avisa de que se cortó.
9. Cortar la red mientras la conversación habla, volver, y comprobar que se oye lo que se perdió y no
   lo que ya se había oído; que hablar durante la repetición la cancela; y que en «Desactivado» no
   suena nada al volver.

## Missing microphone packets versus silence

Conversational silence and a stalled browser are deliberately different:

- While 20 ms PCM frames keep arriving, Silero VAD and the configured 2.5 s
  speech timeout decide when the turn ends.
- If no PCM frame arrives at all while VAD thinks the user is speaking, Pipecat's
  safety fallback now waits 5 s (configurable with `VOICE_AUDIO_IDLE_TIMEOUT`)
  instead of 1 s. This covers the multi-second AudioWorklet delivery gaps observed
  in foreground iPhone Safari without making ordinary pauses five seconds long.

The diagnostics expose the last/largest server-observed packet gap and a count
over 250 ms. A five-second absence still forces the turn closed so a dead capture
cannot hold the conversation forever.
