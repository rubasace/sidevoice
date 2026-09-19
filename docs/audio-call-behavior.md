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
