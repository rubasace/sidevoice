/** RSocket 1.0 over a WebSocket: the subset this connector needs, and nothing else.
 *
 *  Written here rather than taken from npm because the JavaScript ecosystem has no maintained
 *  client — `@rsocket/core` stopped at 1.0.0-alpha.3 and `rsocket-core` at 0.0.29-alpha, both in
 *  2024, neither with a WebSocket transport anyone keeps — and because this package's promise is
 *  Node 22+ with no dependencies. The spec is stable and the subset is small: SETUP, KEEPALIVE,
 *  REQUEST_RESPONSE, REQUEST_FNF, PAYLOAD, ERROR, CANCEL, with composite metadata carrying the
 *  route and, once, the credential. Interop is proven against rsocket-py by tests, not assumed.
 *
 *  Not implemented, because nothing here asks for them: resumption, lease, fragmentation,
 *  streams, channels, metadata push. A frame this module does not know is ignored, as the spec
 *  requires of a frame whose stream nobody is holding.
 *
 *  It knows nothing about rooms, connectors or bindings: routes and JSON go in, routes and JSON
 *  come out. */

export const FRAME = {
  SETUP: 0x01, KEEPALIVE: 0x03, REQUEST_RESPONSE: 0x04, REQUEST_FNF: 0x05,
  CANCEL: 0x09, PAYLOAD: 0x0a, ERROR: 0x0b,
};

export const FLAG = { IGNORE: 0x200, METADATA: 0x100, FOLLOWS: 0x80, RESUME: 0x80, RESPOND: 0x80, LEASE: 0x40, COMPLETE: 0x40, NEXT: 0x20 };

export const ERROR_CODE = {
  INVALID_SETUP: 0x00000001, UNSUPPORTED_SETUP: 0x00000002, REJECTED_SETUP: 0x00000003,
  CONNECTION_ERROR: 0x00000101, CONNECTION_CLOSE: 0x00000102,
  APPLICATION_ERROR: 0x00000201, REJECTED: 0x00000202, CANCELED: 0x00000203, INVALID: 0x00000204,
};
const ERROR_NAME = Object.fromEntries(Object.entries(ERROR_CODE).map(([name, code]) => [code, name]));

export const MIME = {
  json: 'application/json',
  routing: 'message/x.rsocket.routing.v0',
  authentication: 'message/x.rsocket.authentication.v0',
  composite: 'message/x.rsocket.composite-metadata.v0',
};
/** The ids the spec reserves, so a one-byte header stands for a whole MIME string. */
const WELL_KNOWN_MIME = { [MIME.json]: 0x05, [MIME.authentication]: 0x7c, [MIME.routing]: 0x7e, [MIME.composite]: 0x7f };
const MIME_BY_ID = Object.fromEntries(Object.entries(WELL_KNOWN_MIME).map(([name, id]) => [id, name]));
const AUTHENTICATION_SIMPLE = 0x00;

const MAJOR_VERSION = 1, MINOR_VERSION = 0;

/* ---------- frames ---------- */

function header(streamId, type, flags) {
  const buffer = Buffer.alloc(6);
  buffer.writeUInt32BE(streamId >>> 0, 0);
  buffer[4] = (type << 2) | ((flags >> 8) & 0x03);
  buffer[5] = flags & 0xff;
  return buffer;
}

/** Metadata is length-prefixed on 24 bits and comes first; data takes whatever is left, which is
 *  why neither needs a length of its own. */
function body(metadata, data) {
  const parts = [];
  if (metadata?.length) { const length = Buffer.alloc(3); length.writeUIntBE(metadata.length, 0, 3); parts.push(length, metadata); }
  if (data?.length) parts.push(data);
  return Buffer.concat(parts);
}

function mimeString(name) {
  const text = Buffer.from(name, 'ascii');
  return Buffer.concat([Buffer.from([text.length]), text]);
}

export function setupFrame({ keepAliveMs, maxLifetimeMs, metadataMime = MIME.composite, dataMime = MIME.json, metadata = null, data = null }) {
  const middle = Buffer.alloc(12);
  middle.writeUInt16BE(MAJOR_VERSION, 0);
  middle.writeUInt16BE(MINOR_VERSION, 2);
  middle.writeUInt32BE(keepAliveMs, 4);
  middle.writeUInt32BE(maxLifetimeMs, 8);
  const flags = metadata?.length ? FLAG.METADATA : 0;
  return Buffer.concat([header(0, FRAME.SETUP, flags), middle, mimeString(metadataMime), mimeString(dataMime), body(metadata, data)]);
}

export function keepAliveFrame({ respond = false, lastReceivedPosition = 0, data = null } = {}) {
  const position = Buffer.alloc(8);
  position.writeBigUInt64BE(BigInt(lastReceivedPosition) & 0x7fffffffffffffffn);
  return Buffer.concat([header(0, FRAME.KEEPALIVE, respond ? FLAG.RESPOND : 0), position, data || Buffer.alloc(0)]);
}

export function requestFrame(type, streamId, { metadata = null, data = null } = {}) {
  return Buffer.concat([header(streamId, type, metadata?.length ? FLAG.METADATA : 0), body(metadata, data)]);
}

export function payloadFrame(streamId, { metadata = null, data = null, complete = false, next = true } = {}) {
  let flags = metadata?.length ? FLAG.METADATA : 0;
  if (complete) flags |= FLAG.COMPLETE;
  if (next) flags |= FLAG.NEXT;
  return Buffer.concat([header(streamId, FRAME.PAYLOAD, flags), body(metadata, data)]);
}

export function errorFrame(streamId, code, message = '') {
  const middle = Buffer.alloc(4);
  middle.writeUInt32BE(code >>> 0, 0);
  return Buffer.concat([header(streamId, FRAME.ERROR, 0), middle, Buffer.from(message, 'utf8')]);
}

export function cancelFrame(streamId) {
  return header(streamId, FRAME.CANCEL, 0);
}

export function decodeFrame(buffer) {
  if (buffer.length < 6) throw new Error(`RSocket frame too short: ${buffer.length} bytes`);
  const streamId = buffer.readUInt32BE(0) & 0x7fffffff;
  const type = buffer[4] >> 2;
  const flags = ((buffer[4] & 0x03) << 8) | buffer[5];
  const frame = { type, streamId, flags, metadata: null, data: null };
  let offset = 6;
  const payload = () => {
    if (flags & FLAG.METADATA) { const length = buffer.readUIntBE(offset, 3); offset += 3; frame.metadata = buffer.subarray(offset, offset + length); offset += length; }
    frame.data = buffer.subarray(offset);
  };
  switch (type) {
    case FRAME.SETUP: {
      frame.majorVersion = buffer.readUInt16BE(offset); frame.minorVersion = buffer.readUInt16BE(offset + 2);
      frame.keepAliveMs = buffer.readUInt32BE(offset + 4); frame.maxLifetimeMs = buffer.readUInt32BE(offset + 8);
      offset += 12;
      if (flags & FLAG.RESUME) { const length = buffer.readUInt16BE(offset); offset += 2 + length; }
      const metadataMime = buffer.readUInt8(offset); frame.metadataMime = buffer.toString('ascii', offset + 1, offset + 1 + metadataMime); offset += 1 + metadataMime;
      const dataMime = buffer.readUInt8(offset); frame.dataMime = buffer.toString('ascii', offset + 1, offset + 1 + dataMime); offset += 1 + dataMime;
      payload();
      break;
    }
    case FRAME.KEEPALIVE:
      frame.respond = Boolean(flags & FLAG.RESPOND);
      frame.lastReceivedPosition = buffer.readBigUInt64BE(offset) & 0x7fffffffffffffffn;
      offset += 8;
      frame.data = buffer.subarray(offset);
      break;
    case FRAME.ERROR:
      frame.errorCode = buffer.readUInt32BE(offset); offset += 4;
      frame.data = buffer.subarray(offset);
      break;
    case FRAME.PAYLOAD:
      frame.complete = Boolean(flags & FLAG.COMPLETE);
      frame.next = Boolean(flags & FLAG.NEXT);
      payload();
      break;
    case FRAME.REQUEST_RESPONSE:
    case FRAME.REQUEST_FNF:
      payload();
      break;
    case FRAME.CANCEL:
      break;
    default:
      frame.unknown = true;
  }
  return frame;
}

/* ---------- composite metadata ---------- */

/** One entry: the MIME type as a reserved id when there is one, a length-prefixed string when
 *  there is not, then the entry's own 24-bit length. */
export function compositeMetadata(...entries) {
  return Buffer.concat(entries.flatMap(({ mime, content }) => {
    const id = WELL_KNOWN_MIME[mime];
    const head = id === undefined
      ? Buffer.concat([Buffer.from([(Buffer.byteLength(mime, 'ascii') - 1) & 0x7f]), Buffer.from(mime, 'ascii')])
      : Buffer.from([0x80 | id]);
    const length = Buffer.alloc(3); length.writeUIntBE(content.length, 0, 3);
    return [head, length, content];
  }));
}

export function parseCompositeMetadata(buffer) {
  const entries = [];
  let offset = 0;
  while (offset < buffer.length) {
    const first = buffer[offset];
    let mime;
    if (first & 0x80) { mime = MIME_BY_ID[first & 0x7f] || `id:${first & 0x7f}`; offset += 1; }
    else { const length = (first & 0x7f) + 1; mime = buffer.toString('ascii', offset + 1, offset + 1 + length); offset += 1 + length; }
    const length = buffer.readUIntBE(offset, 3); offset += 3;
    entries.push({ mime, content: buffer.subarray(offset, offset + length) });
    offset += length;
  }
  return entries;
}

/** Routing metadata is a list of tags, each one byte of length then the tag; the route is the first. */
export function routingMetadata(route) {
  const tag = Buffer.from(route, 'utf8');
  if (tag.length > 255) throw new Error('Route longer than 255 bytes');
  return { mime: MIME.routing, content: Buffer.concat([Buffer.from([tag.length]), tag]) };
}

export function authenticationMetadata(username, password) {
  const user = Buffer.from(username, 'utf8'), secret = Buffer.from(password, 'utf8');
  const length = Buffer.alloc(2); length.writeUInt16BE(user.length, 0);
  return { mime: MIME.authentication, content: Buffer.concat([Buffer.from([0x80 | AUTHENTICATION_SIMPLE]), length, user, secret]) };
}

/** The route a request carries, or null. */
export function routeOf(metadata) {
  if (!metadata?.length) return null;
  const entry = parseCompositeMetadata(metadata).find(item => item.mime === MIME.routing);
  if (!entry || !entry.content.length) return null;
  return entry.content.toString('utf8', 1, 1 + entry.content[0]);
}

/** The simple credential a SETUP carries, or null. */
export function authenticationOf(metadata) {
  if (!metadata?.length) return null;
  const entry = parseCompositeMetadata(metadata).find(item => item.mime === MIME.authentication);
  if (!entry || entry.content.length < 4 || entry.content[0] !== (0x80 | AUTHENTICATION_SIMPLE)) return null;
  const length = entry.content.readUInt16BE(1);
  return { username: entry.content.toString('utf8', 3, 3 + length), password: entry.content.toString('utf8', 3 + length) };
}

/* ---------- the connection ---------- */

export class RSocketError extends Error {
  constructor(code, message) {
    super(message || ERROR_NAME[code] || `RSocket error ${code}`);
    this.name = 'RSocketError';
    this.code = code;
    this.rejectedSetup = code === ERROR_CODE.REJECTED_SETUP || code === ERROR_CODE.INVALID_SETUP || code === ERROR_CODE.UNSUPPORTED_SETUP;
  }
}

const json = value => Buffer.from(JSON.stringify(value ?? {}), 'utf8');
const unjson = buffer => { if (!buffer?.length) return {}; const value = JSON.parse(buffer.toString('utf8')); return value && typeof value === 'object' ? value : {}; };

/** One RSocket connection over one WebSocket. Both sides may ask: `request`/`send` go out,
 *  `onRequest` answers what comes in. A connection is used once — a reconnect opens a new one,
 *  which is also why resumption is not implemented. */
export class RSocketConnection {
  /** @param {string} url  @param {{auth?: {username: string, password: string}, setup?: object,
   *  keepAliveMs?: number, maxLifetimeMs?: number, misses?: number,
   *  onRequest?: (route: string, data: object) => any, onOpen?: () => void,
   *  onClose?: (reason: object|null) => void}} options */
  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.keepAliveMs = options.keepAliveMs ?? 15_000;
    this.maxLifetimeMs = options.maxLifetimeMs ?? this.keepAliveMs * ((options.misses ?? 2) + 1);
    this.socket = null;
    this.nextStreamId = 1;          // odd from the client, even from the server
    this.pending = new Map();       // stream id -> { resolve, reject }
    this.responding = new Map();    // stream id -> AbortController, so a CANCEL can be honoured
    this.keepAliveTimer = null;
    this.misses = 0;
    this.closed = false;
    this.error = null;              // the ERROR frame that ended it, when one did
  }

  open() {
    const socket = this.socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => {
      const auth = this.options.auth;
      const metadata = auth ? compositeMetadata(authenticationMetadata(auth.username, auth.password)) : null;
      this.write(setupFrame({ keepAliveMs: this.keepAliveMs, maxLifetimeMs: this.maxLifetimeMs, metadata, data: json(this.options.setup) }));
      this.startKeepAlive();
      this.options.onOpen?.();
    });
    socket.addEventListener('message', event => {
      this.misses = 0;
      try { this.receive(decodeFrame(Buffer.from(event.data))); } catch (error) { this.fail({ error: error.message }); }
    });
    socket.addEventListener('close', event => this.lost(this.error || { close_code: event.code, reason: event.reason || null }));
    socket.addEventListener('error', event => this.lost({ error: event.error?.message || event.message || 'connection failed' }));
    return this;
  }

  write(frame) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(frame);
    return true;
  }

  /** Ask, and wait for the answer on that stream. */
  requestResponse(route, data, { signal } = {}) {
    return new Promise((resolve, reject) => {
      const streamId = this.allocate();
      if (!this.write(requestFrame(FRAME.REQUEST_RESPONSE, streamId, { metadata: compositeMetadata(routingMetadata(route)), data: json(data) }))) {
        reject(new Error('The RSocket connection is not open'));
        return;
      }
      this.pending.set(streamId, { resolve, reject });
      signal?.addEventListener('abort', () => {
        if (!this.pending.delete(streamId)) return;
        this.write(cancelFrame(streamId));
        reject(new Error('Cancelled'));
      }, { once: true });
    });
  }

  /** Say it, and never learn whether it arrived. */
  fireAndForget(route, data) {
    return this.write(requestFrame(FRAME.REQUEST_FNF, this.allocate(), { metadata: compositeMetadata(routingMetadata(route)), data: json(data) }));
  }

  close() {
    this.closed = true;
    clearInterval(this.keepAliveTimer);
    try { this.socket?.close(); } catch {}
  }

  /* ----- internals ----- */

  allocate() {
    const streamId = this.nextStreamId;
    this.nextStreamId = (this.nextStreamId + 2) & 0x7fffffff || 1;
    return streamId;
  }

  startKeepAlive() {
    clearInterval(this.keepAliveTimer);
    // Anything at all coming in resets the count: the point is whether the room is there, not
    // whether it answered this particular probe.
    this.keepAliveTimer = setInterval(() => {
      if (++this.misses > (this.options.misses ?? 2)) { this.fail({ error: 'the room stopped answering keepalive' }); return; }
      this.write(keepAliveFrame({ respond: true }));
    }, this.keepAliveMs);
    this.keepAliveTimer.unref?.();
  }

  receive(frame) {
    switch (frame.type) {
      case FRAME.KEEPALIVE:
        if (frame.respond) this.write(keepAliveFrame({ respond: false, data: frame.data }));
        return;
      case FRAME.PAYLOAD: {
        const waiting = this.pending.get(frame.streamId);
        if (!waiting) return;
        if (frame.next) waiting.value = unjson(frame.data);
        if (frame.complete) { this.pending.delete(frame.streamId); waiting.resolve(waiting.value ?? {}); }
        return;
      }
      case FRAME.ERROR: {
        const error = new RSocketError(frame.errorCode, frame.data?.toString('utf8'));
        const waiting = this.pending.get(frame.streamId);
        if (waiting) { this.pending.delete(frame.streamId); waiting.reject(error); return; }
        // Stream 0: the connection itself is refused. Nothing will work on this socket again.
        this.error = { error: error.message, error_code: ERROR_NAME[frame.errorCode] || frame.errorCode, rejected_setup: error.rejectedSetup };
        this.failAll(error);
        this.close();
        return;
      }
      case FRAME.REQUEST_RESPONSE:
      case FRAME.REQUEST_FNF:
        this.respond(frame);
        return;
      case FRAME.CANCEL:
        this.responding.get(frame.streamId)?.abort();
        this.responding.delete(frame.streamId);
        return;
      default:
        return;   // A frame whose stream nobody holds is ignored, as the spec asks.
    }
  }

  async respond(frame) {
    const wantsAnswer = frame.type === FRAME.REQUEST_RESPONSE;
    const route = routeOf(frame.metadata);
    const controller = new AbortController();
    if (wantsAnswer) this.responding.set(frame.streamId, controller);
    try {
      const answer = await this.options.onRequest?.(route, unjson(frame.data), { signal: controller.signal });
      if (wantsAnswer && this.responding.delete(frame.streamId)) {
        this.write(payloadFrame(frame.streamId, { data: json(answer), complete: true, next: true }));
      }
    } catch (error) {
      if (wantsAnswer && this.responding.delete(frame.streamId)) {
        this.write(errorFrame(frame.streamId, ERROR_CODE.APPLICATION_ERROR, String(error?.message || error).slice(0, 400)));
      }
    }
  }

  fail(reason) {
    this.error = this.error || reason;
    this.close();
    this.lost(reason);
  }

  failAll(error) {
    for (const [streamId, waiting] of this.pending) { this.pending.delete(streamId); waiting.reject(error); }
    for (const controller of this.responding.values()) controller.abort();
    this.responding.clear();
  }

  lost(reason) {
    if (this.reported) return;
    this.reported = true;
    clearInterval(this.keepAliveTimer);
    this.failAll(new Error(reason?.error || 'The RSocket connection closed'));
    this.options.onClose?.(reason);
  }
}
