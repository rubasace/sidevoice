# Decisión: una conversación, voz y orquestación combinables

Revisión adversarial e integración: 13 de septiembre de 2026.

## Conclusión

Una tarea normal puede hablar y orquestar otras tareas usando su propio contexto,
herramientas y modelo. No necesita un interlocutor adicional. Las skills de voz y
orquestación son capacidades combinables, no personalidades ni agentes separados.

Esto no elimina los turnos de inferencia: una herramienta lenta en el coordinador
puede retrasar su siguiente respuesta. Delegar trabajo y registrar seguimiento
independiente devuelve el control; ninguna skill garantiza atención instantánea
mientras el propio coordinador permanece ocupado. Las notificaciones entran por
la mensajería del harness y pueden quedar pendientes hasta ser atendidas.

## Qué heredamos de Qwen Audio Agent

Patrones documentados en su [arquitectura](https://github.com/QwenAudio/qwen-audio-agent/blob/main/docs/architecture/deep-dive.md):
recibos asíncronos, correlación de tareas y resultados, estados de entrega y
separación entre cancelar audio y cancelar trabajo. Implementación propia; no se
ha importado su plataforma ni su modelo conversacional frontal.

| Patrón | Decisión aplicada |
| --- | --- |
| Registro de tareas fuera del LLM | Watcher determinista en el gateway, sin modelo extra. |
| Identidad de la ejecución | Suscripción a tarea y turno; cambio inesperado queda superseded y requiere rearm explícito. |
| Resultados y preguntas | Se entregan al coordinador como datos; preguntas se trasladan al usuario. |
| Entrega idempotente | Outbox persistente para avisos; envío incierto queda unknown sin reintento automático. |
| Correlación de voz | Sesión y revisión obligatorias; una interrupción invalida la generación antigua. |
| Estado de reproducción | queued, synthesizing, playing, playback_finished, interrupted, failed, disconnected. |
| Cancelación confirmada | No se simula: las herramientas actuales no exponen stop nativo de otra tarea. |
| Reintentar voz interrumpida | No incorporado: puede ser obsoleta. El agente atiende primero el nuevo turno. |
| Interlocutor frontal obligatorio | No incorporado. La misma conversación presenta su propia respuesta. |

`playback_finished` significa que el marcador salió detrás del audio del transporte.
No certifica reproducción física en el navegador ni que una persona lo escuchara.

## Resultados de las dos revisiones adversariales

1. Corregida carrera: una explicación antigua podía reproducirse después de acabar
   la intervención que la interrumpió. Ahora exige la revisión capturada al inicio.
2. Corregida idempotencia concurrente: el recibo se reserva antes de encolar. Un ID
   con texto distinto falla; repetir el mismo devuelve su estado, no vuelve a hablar.
3. Añadido seguimiento fuera del turno: antes el modo presentación no arrancaba
   el monitor antiguo de Terra y no seguía múltiples tareas por sí solo.
4. Corregido seguimiento abandonado: un turno nuevo no se confunde con el esperado;
   rearm valida el turno real, cancela avisos pendientes antiguos y reemplaza la suscripción.
5. Límite explícito: vigilar estados no detecta un desvío conceptual del trabajo.
   Para decidir si va por mal camino, el coordinador debe revisar progreso.
6. Límite explícito: solicitar parada por mensaje no demuestra que una operación paró.

Las dos skills superaron validación estructural y una simulación adversarial de
crear dos tareas, seguirlas, explicar mientras avanzan y tratar una posible parada.

## Integración y uso

- Skill `voice-presentation`: presentación oral de esta tarea. Mantiene salida escrita.
- Skill `task-orchestration`: delegación autorizada, suscripciones, revisión y retorno.
- `voice_channel.py status`: obtiene sesión/revisión al inicio de un turno.
- `voice_channel.py speak`: acepta texto por stdin, ID de tarea, sesión, revisión e ID de locución.
- `task_channel.py watch/status/unwatch`: controla el watcher independiente.
- `watch --include-current`: para una tarea recién creada que puede terminar antes de registrarse.
- `watch --rearm --expected-turn-id ID`: continúa seguimiento en un nuevo turno verificado.

El gateway verifica que el propietario sea la conversación real que lo arrancó.
Los avisos solo van a ese propietario, no al trabajador. La llamada de voz puede
estar desconectada y el monitor seguir trabajando mientras el gateway esté vivo.
Las suscripciones y recibos se guardan en `.voice-poc/task-watch-<propietario>.json`.
Un servicio apagado no observa tareas; esto no instala autoarranque del sistema.

## Validación ejecutada

- 22 pruebas Python: protocolo de voz, obsolescencia, reconexión, colisiones,
  interrupciones, finalización, modelo, transcripción y monitor anterior.
- 10 pruebas Node con app simulada: dos tareas terminan fuera de orden, resultados
  antiguos, correlación, tarea rápida, preguntas, entregas ambiguas/reinicio, rearm,
  turno inesperado y fallos de lectura.
- WebRTC sintético real con PocketTTS: salida de audio y lifecycle completo;
  encolado en 1 ms, barge-in en 499 ms, rechazo de explicación antigua después de
  terminar la nueva intervención y entrega de su transcripción a esta misma tarea.
- Adaptador real: registro y lectura de la tarea de prueba existente sin iniciar
  trabajo nuevo; rearm a su turno explícito entregó un único aviso a esta conversación
  y dejó la suscripción terminada. Las pruebas sintéticas no sustituyen altavoces
  y micrófono reales.

## Después

Adaptador de cancelación por harness; seguimiento de progreso con evaluación
solicitada; confirmación de reproducción desde el cliente; política explícita para
avisos que quedaron sin voz. Ninguno exige introducir un interlocutor obligatorio.

Cierre adversarial independiente: apto para esta prueba, sin otro fallo bloqueante
reproducible en la revisión final de código, skills y límites documentados.
