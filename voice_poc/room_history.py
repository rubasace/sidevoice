"""Durable room transcript, outbox and participant registry; audio focus never owns delivery."""
import hashlib
import json
import secrets
import sqlite3
import time
import uuid
from pathlib import Path
from contextlib import contextmanager

# Seconds before the next delivery attempt after the n-th failure; the last value repeats.
RETRY_BACKOFF = (2, 5, 15, 60)


def _hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


class RoomHistory:
    def __init__(self, path):
        self.path = Path(path)
        self.ready = False

    @contextmanager
    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        if not self.ready:
            db.execute('''CREATE TABLE IF NOT EXISTS messages (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, thread TEXT,
                role TEXT, text TEXT, name TEXT, session TEXT, revision INTEGER,
                time INTEGER, status TEXT, language TEXT, payload TEXT)''')
            columns = {r['name'] for r in db.execute('PRAGMA table_info(messages)')}
            for column, ddl in (('audio_reason', 'TEXT'), ('attempts', 'INTEGER DEFAULT 0'), ('next_attempt', 'INTEGER DEFAULT 0')):
                if column not in columns:
                    db.execute(f'ALTER TABLE messages ADD COLUMN {column} {ddl}')
            db.execute('CREATE TABLE IF NOT EXISTS closed_channels (thread TEXT PRIMARY KEY, notification TEXT)')
            db.execute('''CREATE TABLE IF NOT EXISTS connectors (
                id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, host TEXT, created INTEGER,
                last_seen INTEGER, revoked INTEGER DEFAULT 0)''')
            db.execute('CREATE TABLE IF NOT EXISTS pairing_codes (code TEXT PRIMARY KEY, expires INTEGER, redeemed INTEGER DEFAULT 0)')
            db.execute('''CREATE TABLE IF NOT EXISTS bindings (
                id TEXT PRIMARY KEY, connector TEXT NOT NULL, harness TEXT, thread TEXT NOT NULL,
                title TEXT, created INTEGER, active INTEGER DEFAULT 1)''')
            db.commit(); self.ready = True
        try:
            with db:
                yield db
        finally:
            db.close()

    # ----- transcript and outbox -----

    def put(self, *, id, thread, role, text, name, session, revision, status,
            language=None, payload=None):
        with self.connect() as db:
            previous = db.execute('SELECT * FROM messages WHERE id=?', (id,)).fetchone()
            if previous:
                if (previous['thread'], previous['text'], previous['revision'], previous['language']) != (thread, text, revision, language):
                    raise ValueError('Identificador de mensaje ya usado con otro contenido')
                return {**dict(previous), '_existing': True}
            db.execute('INSERT INTO messages(id,thread,role,text,name,session,revision,time,status,language,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                       (id,thread,role,text,name,session,revision,int(time.time()*1000),status,language,json.dumps(payload) if payload else None))
            return dict(db.execute('SELECT * FROM messages WHERE id=?',(id,)).fetchone())

    def get(self, id):
        with self.connect() as db:
            row = db.execute('SELECT * FROM messages WHERE id=?', (id,)).fetchone()
            return dict(row) if row else None

    def update(self, id, status, reason=None):
        with self.connect() as db:
            db.execute('UPDATE messages SET status=?,audio_reason=? WHERE id=?',(status,reason,id))

    def defer(self, id, *, immediate=False):
        """A delivery attempt failed or was lost: schedule the next one. At-least-once, never dropped."""
        with self.connect() as db:
            row = db.execute('SELECT attempts FROM messages WHERE id=?', (id,)).fetchone()
            if not row:
                return
            attempts = (row['attempts'] or 0) + 1
            delay = 0 if immediate else RETRY_BACKOFF[min(attempts, len(RETRY_BACKOFF)) - 1]
            db.execute("UPDATE messages SET status='pending', attempts=?, next_attempt=? WHERE id=?",
                       (attempts, int(time.time()) + delay, id))

    def recover(self):
        # A delivery that was in flight when we died is retried: the harness dedups by message_id.
        with self.connect() as db:
            db.execute("UPDATE messages SET status='pending' WHERE role='user' AND status='sending'")
            db.execute("UPDATE messages SET status='interrupted',audio_reason='service_restarted' WHERE role='assistant' AND status IN ('queued','synthesizing','playing','waiting_for_turn','waiting_for_pause')")

    def pending(self, now=None):
        now = int(now if now is not None else time.time())
        with self.connect() as db:
            rows = db.execute("SELECT * FROM messages WHERE role='user' AND status='pending' AND COALESCE(next_attempt,0)<=? ORDER BY seq LIMIT 32", (now,)).fetchall()
            return [dict(r) for r in rows]

    def history(self, thread=None):
        with self.connect() as db:
            rows = db.execute('SELECT * FROM messages '+('WHERE thread=? ' if thread else '')+'ORDER BY seq DESC LIMIT 1000', (thread,) if thread else ()).fetchall()
            return [{k:r[k] for k in ('seq','id','thread','role','text','name','session','revision','time','status','audio_reason')} for r in reversed(rows)]

    def closed_channels(self):
        with self.connect() as db:
            return {r['thread']: r['notification'] for r in db.execute('SELECT * FROM closed_channels')}

    def close_channel(self, thread, notification):
        with self.connect() as db:
            db.execute('INSERT OR IGNORE INTO closed_channels VALUES(?,?)', (thread, notification))

    def open_channel(self, thread):
        with self.connect() as db:
            db.execute('DELETE FROM closed_channels WHERE thread=?', (thread,))

    # ----- connectors: pairing and credentials -----

    def create_pairing_code(self, ttl=600):
        code = secrets.token_hex(4).upper()
        with self.connect() as db:
            db.execute('DELETE FROM pairing_codes WHERE expires<?', (int(time.time()),))
            db.execute('INSERT INTO pairing_codes VALUES(?,?,0)', (code, int(time.time()) + ttl))
        return code

    def redeem_pairing_code(self, code, host=''):
        """One-time exchange: a valid code becomes a connector credential. Returns (id, token) or None."""
        with self.connect() as db:
            row = db.execute('SELECT * FROM pairing_codes WHERE code=?', ((code or '').strip().upper(),)).fetchone()
            if not row or row['redeemed'] or row['expires'] < int(time.time()):
                return None
            db.execute('UPDATE pairing_codes SET redeemed=1 WHERE code=?', (row['code'],))
            connector_id, token = str(uuid.uuid4()), secrets.token_urlsafe(32)
            db.execute('INSERT INTO connectors(id,token_hash,host,created,last_seen,revoked) VALUES(?,?,?,?,?,0)',
                       (connector_id, _hash(token), host[:200], int(time.time()), int(time.time())))
            return connector_id, token

    def authenticate_connector(self, connector_id, token):
        if not isinstance(connector_id, str) or not isinstance(token, str) or not token:
            return False
        with self.connect() as db:
            row = db.execute('SELECT token_hash, revoked FROM connectors WHERE id=?', (connector_id,)).fetchone()
            if not row or row['revoked'] or not secrets.compare_digest(row['token_hash'], _hash(token)):
                return False
            db.execute('UPDATE connectors SET last_seen=? WHERE id=?', (int(time.time()), connector_id))
            return True

    def revoke_connector(self, connector_id):
        with self.connect() as db:
            db.execute('UPDATE connectors SET revoked=1 WHERE id=?', (connector_id,))
            db.execute('UPDATE bindings SET active=0 WHERE connector=?', (connector_id,))

    def connectors(self):
        with self.connect() as db:
            return [dict(r) for r in db.execute('SELECT id, host, created, last_seen, revoked FROM connectors ORDER BY created')]

    # ----- bindings: which connector serves which conversation -----

    def register_binding(self, connector, *, harness, thread, title=None, binding_id=None):
        """Server-minted ids. Re-registering an existing binding requires owning it."""
        if not isinstance(thread, str) or not thread or len(thread) > 200:
            raise ValueError('A conversation identifier is required')
        with self.connect() as db:
            if binding_id:
                row = db.execute('SELECT * FROM bindings WHERE id=?', (binding_id,)).fetchone()
                if not row or row['connector'] != connector:
                    raise ValueError('Unknown or foreign binding')
            else:
                row = db.execute('SELECT * FROM bindings WHERE connector=? AND thread=? AND active=1 ORDER BY created DESC', (connector, thread)).fetchone()
            if row:
                db.execute('UPDATE bindings SET active=1, harness=?, title=COALESCE(?, title) WHERE id=?', (harness, title, row['id']))
                return self.binding(row['id'])
            binding_id = str(uuid.uuid4())
            db.execute('INSERT INTO bindings(id,connector,harness,thread,title,created,active) VALUES(?,?,?,?,?,?,1)',
                       (binding_id, connector, harness, thread, title, int(time.time())))
        return self.binding(binding_id)

    def binding(self, binding_id):
        with self.connect() as db:
            row = db.execute('SELECT * FROM bindings WHERE id=?', (binding_id,)).fetchone()
            return dict(row) if row else None

    def binding_for_thread(self, thread):
        with self.connect() as db:
            row = db.execute('SELECT * FROM bindings WHERE thread=? AND active=1 ORDER BY created DESC', (thread,)).fetchone()
            return dict(row) if row else None

    def bindings(self):
        with self.connect() as db:
            return [dict(r) for r in db.execute('SELECT * FROM bindings WHERE active=1 ORDER BY created')]

    def deactivate_binding(self, connector, binding_id):
        with self.connect() as db:
            db.execute('UPDATE bindings SET active=0 WHERE id=? AND connector=?', (binding_id, connector))
