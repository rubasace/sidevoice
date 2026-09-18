"""The room's journal, in memory, and the little that must outlive the process, in one small file.

Nothing anyone says is written to disk by the room: transcripts, the outbox and
the state of every spoken reply live only while the room runs (issue #1). What
survives a restart or a redeploy is what would otherwise have to be redone by
hand: connector credentials, one pairing per machine (issue #12). Bindings are
not kept: every connector re-registers its own on reconnect, and closing a
conversation's voice from the room simply removes its binding.
"""
import hashlib
import json
import os
import secrets
import sqlite3
import time
import uuid
from collections import OrderedDict
from pathlib import Path

# Seconds before the next delivery attempt after the n-th failure; the last value repeats.
RETRY_BACKOFF = (2, 5, 15, 60)
HISTORY_KEYS = ('seq', 'id', 'thread', 'role', 'text', 'name', 'session', 'revision', 'time', 'status', 'audio_reason')


def _hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


class RoomHistory:
    MAX_MESSAGES = 2000

    def __init__(self, path):
        # `path` names where the room keeps its durable state; a legacy database next to it is read once.
        self.path = Path(path)
        self.state_path = self.path if self.path.suffix == '.json' else self.path.with_name('room-state.json')
        self.messages = OrderedDict()   # id -> row
        self.seq = 0
        self._bindings = {}             # id -> binding
        self.pairing_codes = {}         # code -> {'expires', 'redeemed'}
        self.connectors = {}            # id -> {'token_hash', 'host', 'created', 'last_seen', 'revoked'}
        self._load_state()

    # ----- the durable file -----

    def _load_state(self):
        try:
            data = json.loads(self.state_path.read_text())
        except (OSError, ValueError):
            data = None
        if isinstance(data, dict):
            self.connectors = {k: v for k, v in (data.get('connectors') or {}).items() if isinstance(v, dict)}
            return
        self._import_legacy()

    def _import_legacy(self):
        """A room that kept a database gets its pairings back, once; the database is not read again."""
        legacy = self.state_path.with_name('room-history.sqlite3')
        if not legacy.exists():
            return
        try:
            db = sqlite3.connect(f'file:{legacy}?mode=ro', uri=True)
            db.row_factory = sqlite3.Row
            try:
                for row in db.execute('SELECT id, token_hash, host, created, last_seen, revoked FROM connectors'):
                    self.connectors[row['id']] = {'token_hash': row['token_hash'], 'host': row['host'], 'created': row['created'],
                                                  'last_seen': row['last_seen'], 'revoked': int(row['revoked'] or 0)}
            finally:
                db.close()
        except sqlite3.Error:
            return
        self._save_state()

    def _save_state(self):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_suffix('.tmp')
        temporary.write_text(json.dumps({'connectors': self.connectors}, indent=1))
        temporary.chmod(0o600)
        os.replace(temporary, self.state_path)

    # ----- transcript and outbox (memory only) -----

    def put(self, *, id, thread, role, text, name, session, revision, status, language=None, payload=None):
        previous = self.messages.get(id)
        if previous:
            if (previous['thread'], previous['text'], previous['revision'], previous['language']) != (thread, text, revision, language):
                raise ValueError('Identificador de mensaje ya usado con otro contenido')
            return {**previous, '_existing': True}
        self.seq += 1
        row = {'seq': self.seq, 'id': id, 'thread': thread, 'role': role, 'text': text, 'name': name, 'session': session,
               'revision': revision, 'time': int(time.time() * 1000), 'status': status, 'language': language,
               'payload': json.dumps(payload) if payload else None, 'audio_reason': None, 'attempts': 0, 'next_attempt': 0}
        self.messages[id] = row
        while len(self.messages) > self.MAX_MESSAGES:
            oldest = next(iter(self.messages))
            if self.messages[oldest]['status'] in {'pending', 'sending'}:
                break   # never drop input that has not reached its harness
            del self.messages[oldest]
        return dict(row)

    def get(self, id):
        row = self.messages.get(id)
        return dict(row) if row else None

    def update(self, id, status, reason=None):
        row = self.messages.get(id)
        if row:
            row['status'], row['audio_reason'] = status, reason

    def defer(self, id, *, immediate=False):
        """A delivery attempt failed or was lost: schedule the next one. At-least-once while the room runs."""
        row = self.messages.get(id)
        if not row:
            return
        row['attempts'] = (row['attempts'] or 0) + 1
        delay = 0 if immediate else RETRY_BACKOFF[min(row['attempts'], len(RETRY_BACKOFF)) - 1]
        row['status'], row['next_attempt'] = 'pending', int(time.time()) + delay

    def recover(self):
        # The journal starts empty with the process; a delivery in flight when it died is gone with it.
        for row in self.messages.values():
            if row['role'] == 'user' and row['status'] == 'sending':
                row['status'] = 'pending'
            elif row['role'] == 'assistant' and row['status'] in {'queued', 'synthesizing', 'playing', 'waiting_for_turn', 'waiting_for_pause'}:
                row['status'], row['audio_reason'] = 'interrupted', 'service_restarted'

    def pending(self, now=None):
        now = int(now if now is not None else time.time())
        rows = [row for row in self.messages.values()
                if row['role'] == 'user' and row['status'] == 'pending' and (row['next_attempt'] or 0) <= now]
        return [dict(row) for row in rows[:32]]

    def history(self, thread=None):
        rows = [row for row in self.messages.values() if thread is None or row['thread'] == thread]
        return [{key: row[key] for key in HISTORY_KEYS} for row in rows[-1000:]]

    # ----- connectors: pairing and credentials (durable) -----

    def create_pairing_code(self, ttl=600):
        now = int(time.time())
        self.pairing_codes = {code: entry for code, entry in self.pairing_codes.items() if entry['expires'] >= now}
        code = secrets.token_hex(4).upper()
        self.pairing_codes[code] = {'expires': now + ttl, 'redeemed': False}
        return code

    def redeem_pairing_code(self, code, host=''):
        """One-time exchange: a valid code becomes a connector credential. Returns (id, token) or None."""
        entry = self.pairing_codes.get((code or '').strip().upper())
        if not entry or entry['redeemed'] or entry['expires'] < int(time.time()):
            return None
        entry['redeemed'] = True
        connector_id, token = str(uuid.uuid4()), secrets.token_urlsafe(32)
        now = int(time.time())
        self.connectors[connector_id] = {'token_hash': _hash(token), 'host': (host or '')[:200], 'created': now, 'last_seen': now, 'revoked': 0}
        self._save_state()
        return connector_id, token

    def authenticate_connector(self, connector_id, token):
        if not isinstance(connector_id, str) or not isinstance(token, str) or not token:
            return False
        entry = self.connectors.get(connector_id)
        if not entry or entry.get('revoked') or not secrets.compare_digest(entry['token_hash'], _hash(token)):
            return False
        entry['last_seen'] = int(time.time())
        self._save_state()
        return True

    def revoke_connector(self, connector_id):
        entry = self.connectors.get(connector_id)
        if entry:
            entry['revoked'] = 1
            self._save_state()
        for binding in self._bindings.values():
            if binding['connector'] == connector_id:
                binding['active'] = 0

    def connectors(self):
        return [{'id': cid, 'host': e.get('host'), 'created': e.get('created'), 'last_seen': e.get('last_seen'), 'revoked': e.get('revoked', 0)}
                for cid, e in sorted(self.connectors.items(), key=lambda item: item[1].get('created') or 0)]

    # ----- bindings: which connector serves which conversation (memory only) -----

    def register_binding(self, connector, *, harness, thread, title=None, binding_id=None, inbound=None):
        """Server-minted ids. Reusing another connector's binding is refused; an id this room no longer
        knows (it restarted) is simply a fresh registration, so a façade never stays joined to nothing."""
        if not isinstance(thread, str) or not thread or len(thread) > 200:
            raise ValueError('A conversation identifier is required')
        row = self._bindings.get(binding_id) if binding_id else None
        if row and row['connector'] != connector:
            raise ValueError('Unknown or foreign binding')
        if row is None:
            candidates = [b for b in self._bindings.values() if b['connector'] == connector and b['thread'] == thread and b['active']]
            row = max(candidates, key=lambda b: b['created']) if candidates else None
        if row:
            row['active'], row['harness'] = 1, harness
            if title:
                row['title'] = title
            if inbound is not None:
                row['inbound'] = json.dumps(inbound)
            return dict(row)
        new = {'id': str(uuid.uuid4()), 'connector': connector, 'harness': harness, 'thread': thread, 'title': title,
               'created': int(time.time()), 'active': 1, 'inbound': json.dumps(inbound) if inbound is not None else None}
        self._bindings[new['id']] = new
        return dict(new)

    def binding(self, binding_id):
        row = self._bindings.get(binding_id)
        return dict(row) if row else None

    def binding_for_thread(self, thread):
        candidates = [b for b in self._bindings.values() if b['thread'] == thread and b['active']]
        return dict(max(candidates, key=lambda b: b['created'])) if candidates else None

    def bindings(self):
        return [dict(b) for b in sorted(self._bindings.values(), key=lambda b: b['created']) if b['active']]

    def deactivate_binding(self, connector, binding_id):
        row = self._bindings.get(binding_id)
        if row and row['connector'] == connector:
            row['active'] = 0
