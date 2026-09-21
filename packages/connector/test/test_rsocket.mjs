import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authenticationOf, authenticationMetadata, cancelFrame, compositeMetadata, decodeFrame, errorFrame,
  keepAliveFrame, parseCompositeMetadata, payloadFrame, requestFrame, routingMetadata, routeOf,
  setupFrame, ERROR_CODE, FRAME, MIME, RSocketConnection,
} from '../rsocket.mjs';
import { createRSocketServer } from './rsocket-server.mjs';

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(check, timeout = 3000) { const start = Date.now(); while (Date.now() - start < timeout) { const value = await check(); if (value) return value; await wait(10); } throw new Error('timed out waiting'); }

/* Every expected value below was produced by rsocket-py 0.4.20 — the implementation the room runs —
 * and pasted here. They are the contract: if this module ever stops writing these exact bytes, the
 * room stops understanding it, and no amount of self-consistency would say so. */
const VECTORS = {
  setup: '0000000005000001000000003a980000afc8276d6573736167652f782e72736f636b65742e636f6d706f736974652d6d657461646174612e7630106170706c69636174696f6e2f6a736f6e00000dfc000009800003632d31742d317b2270726f746f636f6c223a317d',
  keepalive: '000000000c800000000000000000',
  requestResponse: '000000011100000015fe0000111062696e64696e672e72656769737465727b2261223a317d',
  fireAndForget: '00000003150000000ffe00000b0a696e7075742e726561647b2262223a327d',
  payload: '0000000228607b22737461747573223a226163636570746564227d',
  error: '000000052c0000000201496e76616c696420636f6e766572736174696f6e206964656e746966696572',
  cancel: '000000072400',
  routeMetadata: 'fe0000100f636f6e6e6563746f722e68656c6c6f',
  authMetadata: 'fc000009800003632d31742d31',
};

test('rsocket: the frames are the bytes rsocket-py writes, to the byte', () => {
  const credential = compositeMetadata(authenticationMetadata('c-1', 't-1'));
  assert.equal(setupFrame({ keepAliveMs: 15_000, maxLifetimeMs: 45_000, metadata: credential, data: Buffer.from('{"protocol":1}') }).toString('hex'), VECTORS.setup);
  assert.equal(keepAliveFrame({ respond: true }).toString('hex'), VECTORS.keepalive);
  assert.equal(requestFrame(FRAME.REQUEST_RESPONSE, 1, { metadata: compositeMetadata(routingMetadata('binding.register')), data: Buffer.from('{"a":1}') }).toString('hex'), VECTORS.requestResponse);
  assert.equal(requestFrame(FRAME.REQUEST_FNF, 3, { metadata: compositeMetadata(routingMetadata('input.read')), data: Buffer.from('{"b":2}') }).toString('hex'), VECTORS.fireAndForget);
  assert.equal(payloadFrame(2, { data: Buffer.from('{"status":"accepted"}'), complete: true }).toString('hex'), VECTORS.payload);
  assert.equal(errorFrame(5, ERROR_CODE.APPLICATION_ERROR, 'Invalid conversation identifier').toString('hex'), VECTORS.error);
  assert.equal(cancelFrame(7).toString('hex'), VECTORS.cancel);
  assert.equal(compositeMetadata(routingMetadata('connector.hello')).toString('hex'), VECTORS.routeMetadata);
  assert.equal(compositeMetadata(authenticationMetadata('c-1', 't-1')).toString('hex'), VECTORS.authMetadata);
});

test('rsocket: those same bytes read back as what they were', () => {
  const setup = decodeFrame(Buffer.from(VECTORS.setup, 'hex'));
  assert.equal(setup.type, FRAME.SETUP);
  assert.equal(setup.streamId, 0);
  assert.deepEqual([setup.majorVersion, setup.minorVersion], [1, 0]);
  assert.deepEqual([setup.keepAliveMs, setup.maxLifetimeMs], [15_000, 45_000]);
  assert.deepEqual([setup.metadataMime, setup.dataMime], [MIME.composite, MIME.json]);
  assert.deepEqual(JSON.parse(setup.data.toString()), { protocol: 1 });
  assert.deepEqual(authenticationOf(setup.metadata), { username: 'c-1', password: 't-1' });

  const keepalive = decodeFrame(Buffer.from(VECTORS.keepalive, 'hex'));
  assert.equal(keepalive.type, FRAME.KEEPALIVE);
  assert.equal(keepalive.respond, true);
  assert.equal(keepalive.lastReceivedPosition, 0n);

  const request = decodeFrame(Buffer.from(VECTORS.requestResponse, 'hex'));
  assert.equal(request.streamId, 1);
  assert.equal(routeOf(request.metadata), 'binding.register');
  assert.deepEqual(JSON.parse(request.data.toString()), { a: 1 });

  const forget = decodeFrame(Buffer.from(VECTORS.fireAndForget, 'hex'));
  assert.equal(forget.type, FRAME.REQUEST_FNF);
  assert.equal(routeOf(forget.metadata), 'input.read');

  const payload = decodeFrame(Buffer.from(VECTORS.payload, 'hex'));
  assert.equal(payload.streamId, 2);
  assert.deepEqual([payload.complete, payload.next], [true, true]);
  assert.deepEqual(JSON.parse(payload.data.toString()), { status: 'accepted' });

  const error = decodeFrame(Buffer.from(VECTORS.error, 'hex'));
  assert.equal(error.errorCode, ERROR_CODE.APPLICATION_ERROR);
  assert.equal(error.data.toString(), 'Invalid conversation identifier');

  assert.equal(decodeFrame(Buffer.from(VECTORS.cancel, 'hex')).type, FRAME.CANCEL);
  assert.equal(decodeFrame(Buffer.from(VECTORS.cancel, 'hex')).streamId, 7);
});

test('rsocket: composite metadata carries several entries, reserved ids and spelled-out types alike', () => {
  const metadata = compositeMetadata(routingMetadata('speech.publish'), authenticationMetadata('who', 'secret'), { mime: 'text/plain', content: Buffer.from('note') });
  const entries = parseCompositeMetadata(metadata);
  assert.deepEqual(entries.map(entry => entry.mime), [MIME.routing, MIME.authentication, 'text/plain']);
  assert.equal(routeOf(metadata), 'speech.publish');
  assert.deepEqual(authenticationOf(metadata), { username: 'who', password: 'secret' });
  assert.equal(entries[2].content.toString(), 'note');
  // A route of no entries is nothing, not a guess, and neither is a credential nobody sent.
  assert.equal(routeOf(compositeMetadata()), null);
  assert.equal(routeOf(null), null);
  assert.equal(authenticationOf(compositeMetadata(routingMetadata('x'))), null);
});

test('rsocket: a request is answered on its own stream, a refusal is an ERROR, and nothing comes back from fire-and-forget', async () => {
  const room = createRSocketServer({
    onRequest: (route, data) => {
      if (route === 'boom') throw new Error('not that one');
      return { route, echoed: data };
    },
  });
  const url = await room.listen();
  const rs = new RSocketConnection(url, { auth: { username: 'c-1', password: 't-1' }, setup: { protocol: 1 } });
  rs.open();
  try {
    await until(() => room.seen.some(frame => frame.type === FRAME.SETUP));
    assert.deepEqual(await rs.requestResponse('binding.register', { thread: 'sess-1' }), { route: 'binding.register', echoed: { thread: 'sess-1' } });
    // Two requests in flight at once get their own streams, odd and ascending from the client.
    const [first, second] = await Promise.all([rs.requestResponse('one', { n: 1 }), rs.requestResponse('two', { n: 2 })]);
    assert.deepEqual([first.echoed.n, second.echoed.n], [1, 2]);
    const streams = room.seen.filter(frame => frame.type === FRAME.REQUEST_RESPONSE).map(frame => frame.streamId);
    assert.deepEqual(streams, [1, 3, 5]);
    assert.ok(streams.every(id => id % 2 === 1), 'odd from the client');

    await assert.rejects(rs.requestResponse('boom', {}), error => {
      assert.equal(error.name, 'RSocketError');
      assert.equal(error.code, ERROR_CODE.APPLICATION_ERROR);
      assert.equal(error.message, 'not that one');
      assert.equal(error.rejectedSetup, false);
      return true;
    });

    rs.fireAndForget('input.read', { message_id: 'm1' });
    const forgotten = await until(() => room.seen.find(frame => frame.type === FRAME.REQUEST_FNF));
    assert.equal(routeOf(forgotten.metadata), 'input.read');
    await wait(50);
    assert.equal(room.seen.filter(f => f.streamId === forgotten.streamId).length, 1, 'and nothing more is said about it');
  } finally { rs.close(); await room.close(); }
});

test('rsocket: the client answers what the room asks it, and a cancel takes the question back', async () => {
  let release = null;
  const asked = [];
  const room = createRSocketServer({});
  const url = await room.listen();
  const rs = new RSocketConnection(url, {
    auth: { username: 'c-1', password: 't-1' },
    onRequest: async (route, data) => {
      asked.push([route, data]);
      if (route === 'input.deliver' && data.slow) await new Promise(resolve => { release = resolve; });
      if (route === 'binding.close') return;
      return { status: 'accepted', detail: data.text };
    },
  });
  rs.open();
  try {
    await until(() => room.seen.some(frame => frame.type === FRAME.SETUP));
    assert.deepEqual(await room.request('input.deliver', { text: 'hola' }).answer, { status: 'accepted', detail: 'hola' });

    // Fire-and-forget from the room reaches the client and is answered with silence.
    room.send('binding.close', { binding_id: 'b-1' });
    await until(() => asked.some(([route]) => route === 'binding.close'));

    // A question the room takes back is never answered, even once the client is ready to.
    const slow = room.request('input.deliver', { text: 'tarde', slow: true });
    let settled = false;
    slow.answer.then(() => { settled = true; }, () => { settled = true; });
    await until(() => release);
    room.cancel(slow.streamId);
    await wait(50);
    release();
    await wait(50);
    assert.equal(settled, false, 'a cancelled stream gets no payload and no error');
  } finally { rs.close(); await room.close(); }
});

test('rsocket: keepalive goes both ways, and a room that stops answering is a room that is gone', async () => {
  let answering = true;
  const room = createRSocketServer({});
  const url = await room.listen();
  const lost = [];
  const rs = new RSocketConnection(url, { auth: { username: 'c-1', password: 't-1' }, keepAliveMs: 60, misses: 2, onClose: reason => lost.push(reason) });
  rs.open();
  try {
    await until(() => room.seen.some(frame => frame.type === FRAME.SETUP));
    // The client asks and the room answers: the connection stays up.
    await until(() => room.seen.filter(frame => frame.type === FRAME.KEEPALIVE && frame.respond).length >= 2);
    assert.deepEqual(lost, []);
    // The room asks, and the client answers without being asked twice.
    const before = room.seen.length;
    room.conn.send(keepAliveFrame({ respond: true, data: Buffer.from('ping') }));
    await until(() => room.seen.slice(before).some(frame => frame.type === FRAME.KEEPALIVE && !frame.respond && frame.data.toString() === 'ping'));
    // Then it goes quiet.
    answering = false;
    room.conn.onBinary = data => { const frame = decodeFrame(data); room.seen.push(frame); if (answering) throw new Error('unreachable'); };
    const reason = await until(() => lost[0], 2000);
    assert.match(reason.error, /keepalive/);
  } finally { rs.close(); await room.close(); }
});

test('rsocket: a setup the room refuses says why, once, and closes', async () => {
  const room = createRSocketServer({
    onSetup: ({ auth, data }) => {
      assert.deepEqual(auth, { username: 'c-1', password: 'wrong' });
      assert.deepEqual(data, { protocol: 1, host: 'laptop' });
      throw new Error('Unknown connector or token');
    },
  });
  const url = await room.listen();
  const lost = [];
  const rs = new RSocketConnection(url, { auth: { username: 'c-1', password: 'wrong' }, setup: { protocol: 1, host: 'laptop' }, onClose: reason => lost.push(reason) });
  rs.open();
  try {
    const reason = await until(() => lost[0]);
    assert.deepEqual(reason, { error: 'Unknown connector or token', error_code: 'REJECTED_SETUP', rejected_setup: true });
    assert.equal(lost.length, 1, 'said once, not once per event the socket happens to fire');
    await assert.rejects(rs.requestResponse('connector.hello', {}), /not open/);
  } finally { rs.close(); await room.close(); }
});

test('link: the room says which links it serves, the machine chooses once, and the address follows', async () => {
  const { chosenLink } = await import('../pair.mjs');
  const { linkUrl, DEFAULT_LINK } = await import('../link.mjs');
  assert.equal(chosenLink(['rsocket', 'ws']), 'rsocket', 'best first, and this machine knows that one');
  assert.equal(chosenLink(['ws']), 'ws');
  assert.equal(chosenLink(['quic', 'ws']), 'ws', 'a link this machine cannot speak is not chosen');
  assert.equal(chosenLink(['quic']), DEFAULT_LINK, 'nor is one it cannot speak at all');
  assert.equal(chosenLink(undefined), DEFAULT_LINK, 'a room from before the choice existed serves the old link');
  assert.equal(linkUrl('wss://room.example/api/connectors/ws', 'rsocket'), 'wss://room.example/api/connectors/rsocket');
  assert.equal(linkUrl('ws://127.0.0.1:9/api/connectors/rsocket', 'ws'), 'ws://127.0.0.1:9/api/connectors/ws');
});
