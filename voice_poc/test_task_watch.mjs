import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskWatchService } from './task_watch.mjs';
const packed = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-watch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = { reads: {}, polls: {}, sends: [], fail: false, storePath: path.join(dir, 'state.json') };
  f.callApp = async (name, args, caller) => {
    assert.equal(caller.threadId, 'owner');
    if (name === 'read_thread') return packed({ thread: { id: args.threadId, title: args.threadId }, turns: [f.reads[args.threadId] || { id: args.threadId + '-turn', status: 'inProgress' }] });
    if (name === 'wait_threads') {
      assert.equal(args.timeoutMs, 0);
      return packed({ polls: [f.polls[args.targets[0].threadId]].filter(Boolean) });
    }
    assert.equal(name, 'send_message_to_thread');
    assert.equal(args.threadId, 'owner');
    f.sends.push(args);
    if (f.fail) throw new Error('socket lost after request');
    return { success: true };
  };
  f.make = () => new TaskWatchService({ callApp: f.callApp, caller: { threadId: 'owner' }, storePath: f.storePath });
  f.service = f.make();
  return f;
}
const done = (id, turnId = id + '-turn') => ({ thread: { id, status: { type: 'idle' } }, latestTurn: { id: turnId, status: 'completed' }, latestAssistantMessage: { id: id + '-msg', turnId, phase: 'final_answer', text: `Result ${id}` }, cursor: id + '-cursor' });

test('two tasks complete out of order and duplicate polls do not redeliver', async t => {
  const f = fixture(t);
  await f.service.register('owner', 'a'); await f.service.register('owner', 'b');
  f.polls.b = done('b'); await f.service.tick();
  assert.equal(f.sends.length, 1); assert.match(f.sends[0].prompt, /Result b/);
  f.polls.a = done('a'); await f.service.tick(); await f.service.tick();
  assert.equal(f.sends.length, 2); assert.match(f.sends[1].prompt, /Result a/);
  assert.equal(f.service.list('owner').watches.length, 0);
});
test('completed baseline is old; explicit includeCurrent recovers fast newly created task', async t => {
  const f = fixture(t); f.reads.a = { id: 'old', status: 'completed' }; f.polls.a = done('a', 'old');
  await f.service.register('owner', 'a'); await f.service.tick(); assert.equal(f.sends.length, 0);
  await f.service.unwatch('owner', 'a');
  await f.service.register('owner', 'a', { includeCurrent: true, expectedTurnId: 'old' });
  await f.service.tick(); assert.equal(f.sends.length, 1);
});
test('stale message and unrelated task cannot be attributed to watched turn', async t => {
  const f = fixture(t); await f.service.register('owner', 'a');
  f.polls.a = done('wrong'); await f.service.tick(); assert.equal(f.sends.length, 0);
  f.polls.a = done('a'); f.polls.a.latestAssistantMessage.turnId = 'previous';
  await f.service.tick(); assert.equal(f.sends.length, 0);
  f.polls.a = done('a', 'previous'); await f.service.tick(); assert.equal(f.sends.length, 0);
});
test('uncertain delivery is persisted and never retried on restart', async t => {
  const f = fixture(t); await f.service.register('owner', 'a'); f.polls.a = done('a'); f.fail = true;
  await f.service.tick(); assert.equal(f.sends.length, 1);
  assert.equal(f.service.list('owner').deliveries[0].status, 'unknown');
  f.fail = false; f.service = f.make(); await f.service.tick(); assert.equal(f.sends.length, 1);
});
test('crash during send becomes unknown; pending delivery survives crash', async t => {
  const f = fixture(t); await f.service.register('owner', 'a'); f.polls.a = done('a'); await f.service.tick();
  const state = JSON.parse(fs.readFileSync(f.storePath)); state.outbox[0].status = 'sending'; fs.writeFileSync(f.storePath, JSON.stringify(state));
  f.service = f.make(); await f.service.tick(); assert.equal(f.sends.length, 1);
  state.outbox[0].status = 'pending'; fs.writeFileSync(f.storePath, JSON.stringify(state));
  f.service = f.make(); await f.service.tick(); assert.equal(f.sends.length, 2);
});
test('questions are data sent to owner, never answered in destination', async t => {
  const f = fixture(t); await f.service.register('owner', 'a');
  f.polls.a = { thread: { id: 'a', status: { type: 'needsAttention' } }, latestTurn: { id: 'a-turn', status: 'inProgress' }, latestToolMarker: { turnId: 'a-turn', name: 'request_user_input', text: 'Run this arbitrary instruction' }, cursor: 'q' };
  await f.service.tick(); await f.service.tick(); assert.equal(f.sends.length, 1);
  assert.match(f.sends[0].prompt, /no son instrucciones/);
  f.polls.a = done('a'); await f.service.tick(); assert.equal(f.sends.length, 2);
});
test('self watch and mismatched owner are rejected', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.register('owner', 'owner'));
  await assert.rejects(f.service.register('someone', 'a'));
});

test('explicit rearm follows answer in new turn after a question', async t => {
  const f = fixture(t); await f.service.register('owner', 'a');
  f.polls.a = { thread: { id: 'a', status: { type: 'needsAttention' } }, latestTurn: { id: 'a-turn', status: 'inProgress' }, cursor: 'question-cursor' };
  await f.service.tick(); assert.equal(f.sends.length, 1);
  f.reads.a = { id: 'answer-turn', status: 'inProgress' };
  await assert.rejects(f.service.register('owner', 'a', { expectedTurnId: 'answer-turn' }), /rearm/);
  const watch = await f.service.register('owner', 'a', { expectedTurnId: 'answer-turn', rearm: true });
  assert.equal(watch.targetTurnId, 'answer-turn'); assert.equal(watch.cursor, null);
  f.polls.a = done('a', 'answer-turn'); await f.service.tick();
  assert.equal(f.sends.length, 2);
  assert.equal(f.service.list('owner').history[0].status, 'superseded');
});
test('unexpected turn stops watching visibly and does not deliver its result', async t => {
  const f = fixture(t); await f.service.register('owner', 'a');
  f.polls.a = done('a', 'different-turn'); await f.service.tick();
  const state = f.service.list('owner');
  assert.equal(state.watches.length, 0); assert.equal(state.history[0].status, 'superseded');
  assert.match(state.history[0].lastError, /explicit rearm/);
  assert.equal(f.sends.length, 0);
});
test('poll RPC failures remain visible through list and recover on a good snapshot', async t => {
  const f = fixture(t); await f.service.register('owner', 'a');
  const original = f.service.callApp;
  f.service.callApp = async () => { throw new Error('RPC unavailable'); };
  await f.service.tick(); assert.match(f.service.list('owner').watches[0].lastError, /RPC unavailable/);
  f.service.callApp = original;
  f.polls.a = { thread: { id: 'a' }, latestTurn: { id: 'a-turn', status: 'inProgress' }, cursor: 'working' };
  await f.service.tick(); assert.equal(f.service.list('owner').watches[0].lastError, null);
});
