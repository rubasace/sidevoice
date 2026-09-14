"""Durable control plane for outbound Sidevoice connectors.

This module has no knowledge of Codex, Claude or browser audio. A connector
authenticates, registers bindings and receives queued `input.deliver` events.
The harness acknowledgement removes only that exact event from the outbox.
"""
import asyncio
import json
import os
import sqlite3
import time
import uuid
from pathlib import Path
from fastapi import HTTPException, WebSocket, WebSocketDisconnect, Request
from pydantic import BaseModel, Field


class Delivery(BaseModel):
    text: str = Field(min_length=1, max_length=12000)
    session_id: str
    revision: int = Field(ge=0)


class ConnectorControl:
    def __init__(self, database: Path, token: str | None):
        self.database, self.token = database, token
        self.sockets: dict[str, WebSocket] = {}
        self.bindings: dict[str, str] = {}  # binding_id -> connector_id
        self.lock = asyncio.Lock()
        database.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(database) as db:
            db.execute("""create table if not exists connector_events (
                event_id text primary key, binding_id text not null, payload text not null,
                status text not null, created_at real not null)""")

    def authorized(self, token: str | None):
        # Empty configuration deliberately disables the endpoint instead of
        # accidentally accepting a development credential in production.
        return bool(self.token) and token == self.token

    def pending(self, binding_id: str):
        with sqlite3.connect(self.database) as db:
            return [json.loads(row[0]) for row in db.execute(
                "select payload from connector_events where binding_id=? and status='pending' order by created_at", (binding_id,))]

    async def send_pending(self, binding_id: str):
        connector_id = self.bindings.get(binding_id)
        socket = self.sockets.get(connector_id or '')
        if not socket:
            return
        for event in self.pending(binding_id):
            await socket.send_json(event)

    async def queue(self, binding_id: str, delivery: Delivery):
        event = {"type": "input.deliver", "event_id": str(uuid.uuid4()), "binding_id": binding_id,
                 "text": delivery.text, "session_id": delivery.session_id, "revision": delivery.revision}
        with sqlite3.connect(self.database) as db:
            db.execute("insert into connector_events values (?, ?, ?, 'pending', ?)",
                       (event['event_id'], binding_id, json.dumps(event), time.time()))
        await self.send_pending(binding_id)
        return event

    async def acknowledge(self, event_id: str, status: str):
        if status != 'accepted':
            return
        with sqlite3.connect(self.database) as db:
            db.execute("update connector_events set status='accepted' where event_id=?", (event_id,))

    async def connect(self, socket: WebSocket):
        await socket.accept()
        connector_id = None
        try:
            while True:
                message = await socket.receive_json()
                kind = message.get('type')
                if kind == 'connector.hello':
                    if not self.authorized(message.get('token')):
                        await socket.close(code=1008); return
                    connector_id = message.get('connector_id')
                    if not isinstance(connector_id, str) or not connector_id:
                        await socket.close(code=1008); return
                    self.sockets[connector_id] = socket
                elif not connector_id:
                    await socket.close(code=1008); return
                elif kind == 'binding.register':
                    binding_id = message.get('binding_id')
                    if not isinstance(binding_id, str) or not binding_id:
                        continue
                    self.bindings[binding_id] = connector_id
                    await self.send_pending(binding_id)
                elif kind == 'binding.unregister':
                    if self.bindings.get(message.get('binding_id')) == connector_id:
                        self.bindings.pop(message['binding_id'], None)
                elif kind == 'input.ack':
                    await self.acknowledge(message.get('event_id', ''), message.get('status', ''))
                elif kind == 'heartbeat':
                    await socket.send_json({'type': 'heartbeat.ack', 'nonce': message.get('nonce')})
        except WebSocketDisconnect:
            pass
        finally:
            if connector_id and self.sockets.get(connector_id) is socket:
                self.sockets.pop(connector_id, None)
                self.bindings = {key: value for key, value in self.bindings.items() if value != connector_id}


def mount_connector_control(app, database: Path):
    control = ConnectorControl(database, os.getenv('SIDEVOICE_CONNECTOR_TOKEN'))

    @app.websocket('/api/connectors/ws')
    async def connector_socket(websocket: WebSocket):
        await control.connect(websocket)

    @app.post('/api/connectors/{binding_id}/deliver')
    async def deliver(binding_id: str, delivery: Delivery, request: Request):
        if not control.authorized(request.headers.get('authorization', '').removeprefix('Bearer ')):
            raise HTTPException(401, 'Invalid connector credential.')
        return await control.queue(binding_id, delivery)

    @app.get('/api/connectors/{binding_id}/status')
    async def status(binding_id: str, request: Request):
        if not control.authorized(request.headers.get('authorization', '').removeprefix('Bearer ')):
            raise HTTPException(401, 'Invalid connector credential.')
        return {'connected': binding_id in control.bindings, 'pending': len(control.pending(binding_id))}

    return control
