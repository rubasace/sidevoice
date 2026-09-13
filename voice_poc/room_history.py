"""Durable room transcript and outbox; audio focus never owns message delivery."""
import json
import sqlite3
import time
from pathlib import Path
from contextlib import contextmanager

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
            if 'audio_reason' not in {r['name'] for r in db.execute('PRAGMA table_info(messages)')}:
                db.execute('ALTER TABLE messages ADD COLUMN audio_reason TEXT')
            db.execute('CREATE TABLE IF NOT EXISTS closed_channels (thread TEXT PRIMARY KEY, notification TEXT)')
            db.commit(); self.ready = True
        try:
            with db:
                yield db
        finally:
            db.close()

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

    def recover(self):
        # An interrupted POST may have succeeded. Never resend uncertain work.
        with self.connect() as db:
            db.execute("UPDATE messages SET status='uncertain' WHERE role='user' AND status='sending'")
            db.execute("UPDATE messages SET status='interrupted',audio_reason='service_restarted' WHERE role='assistant' AND status IN ('queued','synthesizing','playing','waiting_for_turn','waiting_for_pause')")

    def pending(self):
        with self.connect() as db:
            rows = db.execute("SELECT * FROM messages WHERE role='user' AND status='pending' ORDER BY seq LIMIT 32").fetchall()
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
