"""Voice room server: browser audio in, durable delivery out. No LLM lives here."""
import asyncio
import json
import uuid

from fastapi import HTTPException, WebSocket

import transcription
from browser_socket import BrowserFrameSerializer, session_message
from presentation import binding, hub, PresentationCall, mount_presentation, require_same_origin
from connector_control import mount_connector_control


async def browser_call(websocket):
    """Browser-only call: microphone audio never leaves the page; only turn control and text arrive."""
    from language_settings import load_settings
    settings = load_settings()
    serializer = BrowserFrameSerializer()
    transcription_choice = transcription.resolve(settings)
    outbox = asyncio.Queue()
    turns = {}

    async def deliver():
        while True:
            await websocket.send_text(json.dumps(await outbox.get()))

    send = outbox.put_nowait
    call = PresentationCall(str(uuid.uuid4()), binding() or {}, None, None, None)
    call.browser_audio = True
    call.transcription = transcription_choice
    call.input_stats = {'transport': 'browser-text', 'turns': 0, 'audio_ms': 0,
                        'recognition_ms': 0, 'pending': 0}
    call.on_browser_event = send
    call.on_input_receipt = lambda data: send({'type': 'voice-input-receipt', 'data': data})
    call.audio_grace_seconds = settings.audio_grace_seconds
    hub.attach(call)
    sender = asyncio.create_task(deliver())
    call.connected = True
    await websocket.send_text(json.dumps(session_message(call.id, serializer)))

    def payload(message):
        data = message.get('data')
        if not isinstance(data, dict) or data.get('session_id') != call.id:
            raise ValueError('Mensaje de transcripción para otra sesión.')
        return data

    async def finish(turn_id, *, failed=None):
        turn = turns.pop(turn_id, None)
        if not turn:
            return
        current = turn['revision'] == call.turn_revision
        text = turn.get('text', '').strip()
        cancelled = bool(failed or getattr(call, 'cancelled_turn', None) == turn['revision'] or not text)
        if not cancelled:
            call.enqueue_input(text, target=turn['target'], revision=turn['revision'])
        send({'type': 'user-stopped-speaking', 'data': {}})
        send({'type': 'voice-user-turn', 'data': {
            'phase': 'cancelled' if cancelled else 'finished',
            'revision': turn['revision'], 'turn_id': turn_id,
            'thread_id': turn['target'].get('thread_id'), 'text': text,
        }})
        if failed:
            call.error = failed
            send({'type': 'error', 'data': {'message': failed}})
        if current:
            await call.finish_user_turn()
        call.input_stats['pending'] = len(turns)

    try:
        while True:
            event = await websocket.receive()
            if event.get('type') == 'websocket.disconnect':
                break
            if event.get('bytes') is not None:
                send({'type': 'error', 'data': {
                    'message': 'El audio debe transcribirse en el navegador; el servidor rechazó PCM.'
                }})
                continue
            try:
                message = json.loads(event.get('text') or '{}')
            except ValueError:
                continue
            kind = message.get('type')
            if kind == 'client-ready':
                continue
            try:
                data = payload(message)
                if kind == 'voice-stt-ready':
                    model, device = data.get('model'), data.get('device')
                    models = {item['id'] for item in transcription.CATALOG['models']}
                    if model not in models or device not in {'webgpu', 'wasm'}:
                        raise ValueError('Motor de transcripción del navegador no compatible.')
                    call.transcription = {**transcription_choice, 'model': model, 'device': device}
                elif kind == 'voice-input-start':
                    turn_id = data.get('turn_id')
                    if not isinstance(turn_id, str) or not turn_id or len(turn_id) > 100:
                        raise ValueError('Identificador de turno inválido.')
                    if turn_id in turns:
                        continue
                    if turns:
                        raise ValueError('Ya hay una intervención abierta.')
                    call.user_started()
                    turns[turn_id] = {'revision': call.turn_revision, 'target': dict(call.turn_target),
                                      'sequence': 0, 'text': ''}
                    call.input_stats['pending'] = 1
                    send({'type': 'user-started-speaking', 'data': {}})
                    send({'type': 'voice-user-turn', 'data': {
                        'phase': 'started', 'revision': call.turn_revision, 'turn_id': turn_id,
                        'thread_id': call.turn_target.get('thread_id'),
                    }})
                elif kind == 'voice-input-transcript':
                    turn = turns.get(data.get('turn_id'))
                    sequence, text = data.get('sequence'), data.get('text')
                    if not turn or not isinstance(sequence, int) or sequence <= turn['sequence']:
                        raise ValueError('Resultado de transcripción obsoleto.')
                    if not isinstance(text, str) or len(text) > 12000:
                        raise ValueError('Transcripción inválida o demasiado larga.')
                    turn['sequence'], turn['text'] = sequence, text
                    metrics = data.get('metrics') if isinstance(data.get('metrics'), dict) else {}
                    call.input_stats.update({
                        'audio_ms': max(0, int(metrics.get('audio_ms') or 0)),
                        'recognition_ms': max(0, int(metrics.get('recognition_ms') or 0)),
                    })
                    call.input_stats['turns'] += 1
                elif kind == 'voice-input-end':
                    turn = turns.get(data.get('turn_id'))
                    if not turn or data.get('sequence') != turn['sequence']:
                        raise ValueError('La transcripción no está completa.')
                    await finish(data['turn_id'])
                elif kind == 'voice-input-cancel':
                    await finish(data.get('turn_id'))
                elif kind == 'voice-input-error':
                    await finish(data.get('turn_id'), failed=str(data.get('error') or 'Falló la transcripción local.'))
            except (TypeError, ValueError) as error:
                send({'type': 'error', 'data': {'message': str(error)}})
    finally:
        for turn_id in list(turns):
            await finish(turn_id, failed='La llamada terminó durante la transcripción.')
        call.disconnect()
        sender.cancel()

def mount_browser_call(app):
    @app.websocket('/api/presentation/ws')
    async def browser_socket(websocket: WebSocket):
        try:
            require_same_origin(websocket)
        except HTTPException:
            await websocket.close(code=1008)  # Policy violation: not this room's own page.
            return
        await websocket.accept()
        await browser_call(websocket)


if __name__ == "__main__":
    import argparse
    import uvicorn
    from fastapi import FastAPI
    parser = argparse.ArgumentParser(description="Sidevoice room: browser voice in, durable delivery out.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8767)
    arguments = parser.parse_args()
    app = FastAPI()
    mount_presentation(app)
    mount_connector_control(app, hub)
    mount_browser_call(app)
    uvicorn.run(app, host=arguments.host, port=arguments.port)
