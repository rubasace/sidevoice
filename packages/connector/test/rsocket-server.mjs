/** A tiny RSocket server for tests, built out of the same module the client uses.
 *
 *  It exists so the requester and the responder can be exercised without a room: what proves the
 *  bytes are right is the vectors rsocket-py wrote, and what proves the whole link works is the
 *  interop test against the real room. This is the middle — behaviour, in one process. */
import { createWsServer } from './ws-server.mjs';
import {
  authenticationOf, cancelFrame, decodeFrame, errorFrame, keepAliveFrame, payloadFrame,
  requestFrame, compositeMetadata, routingMetadata, routeOf, ERROR_CODE, FRAME,
} from '../rsocket.mjs';

const json = value => Buffer.from(JSON.stringify(value ?? {}), 'utf8');
const unjson = buffer => (buffer?.length ? JSON.parse(buffer.toString('utf8')) : {});

/** @param {{onSetup?: (setup: object) => void, onRequest?: (route: string, data: object) => any}} handlers */
export function createRSocketServer(handlers = {}) {
  const seen = [];        // every frame the server decoded, for tests that want to look
  let connection = null, nextStreamId = 2;
  const answers = new Map();   // server-initiated stream id -> { resolve, reject }

  const server = createWsServer(conn => {
    connection = conn;
    conn.onBinary = async data => {
      const frame = decodeFrame(data);
      seen.push(frame);
      try {
        await handle(conn, frame);
      } catch (error) {
        conn.send(errorFrame(frame.streamId || 0, ERROR_CODE.APPLICATION_ERROR, String(error.message)));
      }
    };
  });

  async function handle(conn, frame) {
    switch (frame.type) {
      case FRAME.SETUP:
        try {
          handlers.onSetup?.({ auth: authenticationOf(frame.metadata), data: unjson(frame.data), frame });
        } catch (error) {
          conn.send(errorFrame(0, ERROR_CODE.REJECTED_SETUP, String(error.message)));
          setTimeout(() => conn.close(), 10);
        }
        return;
      case FRAME.KEEPALIVE:
        if (frame.respond) conn.send(keepAliveFrame({ respond: false, data: frame.data }));
        return;
      case FRAME.REQUEST_RESPONSE:
      case FRAME.REQUEST_FNF: {
        const answer = await handlers.onRequest?.(routeOf(frame.metadata), unjson(frame.data));
        if (frame.type === FRAME.REQUEST_RESPONSE) conn.send(payloadFrame(frame.streamId, { data: json(answer), complete: true }));
        return;
      }
      case FRAME.PAYLOAD: {
        const waiting = answers.get(frame.streamId);
        if (!waiting) return;
        answers.delete(frame.streamId);
        waiting.resolve(unjson(frame.data));
        return;
      }
      case FRAME.ERROR: {
        const waiting = answers.get(frame.streamId);
        if (!waiting) return;
        answers.delete(frame.streamId);
        waiting.reject(Object.assign(new Error(frame.data?.toString('utf8')), { code: frame.errorCode }));
        return;
      }
      default:
        return;
    }
  }

  return {
    server, seen,
    get conn() { return connection; },
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`ws://127.0.0.1:${server.address().port}/api/connectors/rsocket`))),
    close: () => new Promise(resolve => server.close(resolve)),
    /** Ask the client something, the way the room asks for a delivery. */
    request(route, data) {
      const streamId = nextStreamId; nextStreamId += 2;
      connection.send(requestFrame(FRAME.REQUEST_RESPONSE, streamId, { metadata: compositeMetadata(routingMetadata(route)), data: json(data) }));
      return { streamId, answer: new Promise((resolve, reject) => answers.set(streamId, { resolve, reject })) };
    },
    send(route, data) {
      const streamId = nextStreamId; nextStreamId += 2;
      connection.send(requestFrame(FRAME.REQUEST_FNF, streamId, { metadata: compositeMetadata(routingMetadata(route)), data: json(data) }));
    },
    cancel(streamId) { connection.send(cancelFrame(streamId)); },
  };
}
