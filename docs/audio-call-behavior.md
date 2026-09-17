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
