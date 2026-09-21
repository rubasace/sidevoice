/** The link to the room, as one interface with two implementations.
 *
 *  `open`, `close`, `send(route, data)` for what needs no answer, `request(route, data)` for what
 *  does, and three callbacks: `onConnected` when the room has welcomed this connector,
 *  `onRequest` for what the room asks of it, `onLost` when the connection is gone. Everything
 *  above this — bindings, the outbox, the harness, the façades — is written against that and
 *  never learns which link is underneath.
 *
 *  `ws` is the hand-rolled protocol the room has always spoken: one JSON object per message, and
 *  an answer is another message matched back by whatever field correlates it. `rsocket` is
 *  RSocket 1.0, where the answer belongs to the request's own stream and nothing has to be
 *  matched. Which one a machine uses is written in its credential when it pairs. */
import { RSocketConnection } from './rsocket.mjs';

export const LINKS = ['rsocket', 'ws'];
export const DEFAULT_LINK = 'ws';   // A credential from before the choice existed means the old link.

/** The room's socket address for a link, from the address the credential stores for another. */
export function linkUrl(url, link) {
  const address = new URL(url);
  address.pathname = `/api/connectors/${link}`;
  return address.toString();
}

/** What the old protocol's reply to each request looks like, and what correlates it. Nothing here
 *  is needed for RSocket, where a reply is on the stream that asked. */
const WS_REPLIES = {
  'binding.register': { correlate: frame => frame.client_ref, reply: 'binding.registered', refusal: 'binding.rejected' },
  'speech.publish': { correlate: frame => frame.event_id, reply: 'speech.published' },
};
/** What the room asks of the connector, and whether it is waiting for an answer. */
const WS_ASKS = { 'input.deliver': 'input.ack', 'binding.close': null, 'connector.error': null };

class Link {
  constructor(options) {
    this.options = options;
    this.connected = false;
    this.closed = false;
    this.waiting = new Map();
  }

  /** Every wait ends when the connection does: a request whose answer can no longer arrive must
   *  fail now, not in ten seconds. */
  lost(reason) {
    if (this.closed) return;
    this.closed = true;
    const established = this.connected;
    this.connected = false;
    const gone = new Error(reason?.error || 'The room connection closed');
    for (const [key, pending] of this.waiting) { this.waiting.delete(key); pending.reject(gone); }
    // A link that had been welcomed and then simply ended says nothing new about the room; only a
    // connection that never got that far is worth reporting as a reason it is unreachable.
    this.options.onLost?.(established && !reason?.error ? null : reason);
  }

  expect(key, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(key); reject(new Error('The room did not answer')); }, timeout);
      this.waiting.set(key, {
        resolve: value => { clearTimeout(timer); this.waiting.delete(key); resolve(value); },
        reject: error => { clearTimeout(timer); this.waiting.delete(key); reject(error); },
      });
    });
  }
}

class WebSocketLink extends Link {
  open() {
    const socket = this.socket = new WebSocket(this.options.url);
    socket.addEventListener('open', () => this.write({
      type: 'connector.hello', protocol: this.options.protocol,
      connector_id: this.options.connector_id, token: this.options.token, host: this.options.host,
    }));
    socket.addEventListener('message', event => {
      try { this.receive(JSON.parse(String(event.data))); }
      catch (error) { this.options.log?.(`unreadable frame from the room: ${error.message}`); }
    });
    // A refused connection surfaces as 'error' with no 'close', and the dead socket stays
    // CONNECTING forever: whatever the runtime says about it is kept, because "not reachable"
    // alone told a person nothing (2026-09-21).
    socket.addEventListener('close', event => this.lost({ close_code: event.code, reason: event.reason || null }));
    socket.addEventListener('error', event => this.lost({ error: event.error?.message || event.message || 'connection failed' }));
    return this;
  }

  close() { this.closed = true; try { this.socket?.close(); } catch {} }

  write(frame) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  send(route, data) { return this.write({ type: route, ...data }); }

  request(route, data, { timeout = 10_000 } = {}) {
    const correlation = WS_REPLIES[route];
    if (!correlation) return Promise.reject(new Error(`Nothing correlates a reply to ${route}`));
    if (!this.connected) return Promise.reject(new Error('The room is unreachable; retrying in the background'));
    const key = `${route}:${correlation.correlate(data)}`;
    const answer = this.expect(key, timeout);
    if (!this.write({ type: route, ...data })) return Promise.reject(new Error('The room is unreachable; retrying in the background'));
    return answer;
  }

  receive(frame) {
    if (frame.type === 'connector.welcome') { this.connected = true; this.options.onConnected?.(frame); return; }
    if (frame.type === 'heartbeat') { this.write({ type: 'heartbeat.ack', nonce: frame.nonce }); return; }
    for (const [route, correlation] of Object.entries(WS_REPLIES)) {
      const key = `${route}:${correlation.correlate(frame)}`;
      if (frame.type === correlation.reply) { this.waiting.get(key)?.resolve(frame); return; }
      if (frame.type === correlation.refusal) { this.waiting.get(key)?.reject(new Error(frame.error || 'Refused by the room')); return; }
    }
    if (frame.type in WS_ASKS) this.answer(frame).catch(error => this.options.log?.(`answering ${frame.type} failed: ${error.message}`));
  }

  async answer(frame) {
    const { type, ...data } = frame;
    const reply = await this.options.onRequest?.(type, data);
    if (WS_ASKS[type]) this.write({ type: WS_ASKS[type], event_id: frame.event_id, ...reply });
  }
}

class RSocketLink extends Link {
  open() {
    this.connection = new RSocketConnection(this.options.url, {
      auth: { username: this.options.connector_id, password: this.options.token },
      setup: { protocol: this.options.protocol, host: this.options.host, version: this.options.version },
      keepAliveMs: this.options.keepAliveMs,
      onRequest: (route, data) => this.options.onRequest?.(route, data),
      onOpen: () => this.hello(),
      onClose: reason => this.lost(reason),
    });
    this.connection.open();
    return this;
  }

  /** SETUP said who this connector is; `connector.hello` is what the room answers with, and only
   *  then is this link usable. */
  async hello() {
    try {
      const welcome = await this.connection.requestResponse('connector.hello', {
        protocol: this.options.protocol, host: this.options.host, version: this.options.version,
      });
      this.connected = true;
      this.options.onConnected?.(welcome);
    } catch (error) {
      if (!this.closed) this.options.log?.(`the room did not welcome this connector: ${error.message}`);
    }
  }

  close() { this.closed = true; this.connection?.close(); }

  send(route, data) { return this.connected && this.connection.fireAndForget(route, data); }

  request(route, data, { timeout = 10_000 } = {}) {
    if (!this.connected) return Promise.reject(new Error('The room is unreachable; retrying in the background'));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    return this.connection.requestResponse(route, data, { signal: abort.signal })
      .catch(error => { throw abort.signal.aborted ? new Error('The room did not answer') : error; })
      .finally(() => clearTimeout(timer));
  }
}

/** One link to the room, of the kind the credential names. */
export function roomLink(kind, options) {
  return kind === 'rsocket' ? new RSocketLink(options) : new WebSocketLink(options);
}
