# Estado y siguientes pasos

Actualizado: 2026-09-13.

## Operativo y probado

- Sala de voz para la tarea actual, sin agente operador intermediario.
- Activación por identidad real y cambio entre tareas registradas.
- Kokoro en el navegador, WebGPU/WASM, carga automática y caché.
- Idiomas disponibles según `browser_audio/catalog.json`: es/en/fr/it/pt/hi.
- Configuración de voz, modelo y velocidad global y por idioma, con pruebas y reset.
- Historial persistente y envío independiente del foco de reproducción.
- Orden por hora de envío: borrador sin hora hasta que finaliza la intervención.
- Motivos de audio omitido/interrumpido visibles en la UI desde su implementación.
- Recibos de reproducción del navegador, interrupción y atajos de micrófono.
- Nivel de audio integrado en el fondo del botón del micrófono, con gradiente y aviso de pico.
- Prueba de respuestas pendientes: si llegan mientras el usuario habla, esperan al
  fin de intervención. Audios ya interrumpidos no se reanudan; cambio de tarea o
  desconexión descarta audio pendiente y mantiene texto. Validar comodidad en uso.
- Skill `voice-presentation` en inglés: ACK temprano cuando hay trabajo, avances
  útiles, idioma conversacional y publicación transparente para el agente.

## Próximos cambios de producto

### Retirar conversaciones de la sala

Implementado el cierre por fila: pertenencia persistente, notificación al agente
para continuar por escrito y bloqueo inmediato de voz. Si se cierra el destino
seleccionado, la sala permanece abierta sin destinatario. El historial se conserva internamente, sin sección de conversaciones cerradas en la UI. Reactivar desde la tarea la incorpora otra vez.
No borra ni archiva la tarea original. Borrado definitivo de historial pendiente.
Validar el flujo real de cierre y reactivación con el usuario.

### Disparador de voz y comando de Codex

La intención estable es «conectar esta tarea a la sala de voz», reconocida en
cualquier idioma. La invocación explícita es `$voice-presentation` y su prompt de
entrada en inglés está en `agents/openai.yaml`. El usuario quiere crear un comando
para Codex sobre esa intención. No requiere una palabra hablada fija ni un operador.
El comando personalizado todavía no está creado.

### Estado real del trabajo

Se retira `Waiting for a reply`: inducía a interpretar actividad no confirmada.
Se conservan recibos de entrega y estados reales del audio. Conectar cualquier
futuro indicador de trabajo a eventos reales del harness. Los ACKs y avances
conversacionales se publican por voz, antes de depender del texto en pantalla.

## Pendientes técnicos

- Despliegue remoto, HTTPS/WebRTC y adaptadores Paseo/Claude con interfaces verificadas.
- Arquitectura de proveedores para otros modelos STT/TTS; solo Kokoro implementado
  para TTS en navegador. Evaluar Pocket TTS y Supertonic según el runtime real.
- VAD local en navegador, fin de intervención y pruebas de ruido/altavoces/eco.
- Pronunciación japonesa/china antes de anunciarlas como idiomas disponibles.
- Mantener `/voice-browser/` como diagnóstico; `/voice/` es la sala principal.

La velocidad pertenece al usuario: no modificarla durante pruebas salvo petición
explícita. El agente publica siempre igual; la aplicación decide y explica en la
UI qué se reproduce. No volver al diseño del operador intermediario.

Actualización de interacción: cuadro de texto en la sala conectada (Enter envía,
Shift+Enter añade línea), margen de 2 segundos antes de liberar audio pendiente,
configurable en Avanzado junto al silencio que cierra el turno (5 s por defecto).
El medidor rellena el propio icono del micrófono, ampliado, con señal de pico.

Limpieza visual: lateral solo con conversaciones, sin instrucciones ni diagnóstico;
se quitan etiquetas redundantes de conexión/micrófono. La preparación de voces
con modelo ya cargado usa el estado inferior; el diálogo solo aparece al preparar
el modelo. El icono del micro (30 px) se rellena con el nivel de entrada.

### Semántica acordada de cerrar voz (13 septiembre)

Cerrar el canal de una conversación significa que ese agente deje de publicar
por voz; su trabajo y conversación escrita continúan. La sala del usuario
permanece abierta. Reactivar voz vuelve a incorporar la tarea.
La skill ya respeta una petición explícita de seguir solo por escrito.
Implementado: acción por fila con pertenencia persistente, señal al agente y descarte
de audio en tránsito. No depender solo de que el agente procese la señal:
la aplicación debe hacer efectivo el cierre inmediatamente. Conservar historial.
Para otros harnesses el mismo agente conserva contexto y herramientas y publica
directamente; adaptar activación/identidad/entrega sin introducir un interlocutor.

Cancelación del borrador de voz: «Cancelar envío», abajo a la derecha, solo antes de finalizar el turno. Hora bajo el mensaje y lista de conversaciones a la derecha.

Cierre integrado en menú de tres puntos por conversación. Las cerradas desaparecen de la lista; no hay sección de archivo en la sala.
