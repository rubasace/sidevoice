// Local transport bridge to the app's official signed-runtime tool socket.
// Start with the app-bundled Node runtime from a Codex terminal, independently
// of the Python audio process. The app retains its native peer authorization.
import http from 'node:http';
import { TaskWatchService } from './task_watch.mjs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH;
if (!pipe) throw new Error('CODEX_APP_TOOLS_PIPE_PATH is required');
let port = Number(process.env.VOICE_DESKTOP_PORT || 8769);
const instanceId = randomUUID();
let catalog;
const selections = new Map();
const presentationMessages = new Map();
const watchOwner = process.env.CODEX_THREAD_ID;
const taskWatches = watchOwner ? new TaskWatchService({
  callApp, caller: { threadId: watchOwner },
  storePath: fileURLToPath(new URL('../.voice-poc/task-watch-' + watchOwner + '.json', import.meta.url)),
}) : null;
const localTools = [
  { name: 'voice_select_thread', description: 'Select an existing task for this voice conversation. Validates the task and enables reading its later results; does not send it an instruction.',
    inputSchema: { type: 'object', properties: { threadId: { type: 'string' } }, required: ['threadId'], additionalProperties: false } },
  { name: 'voice_clear_thread', description: 'Unlink the selected task and return to free conversation. Does not stop the task.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'voice_session_state', description: 'Read the task currently selected for this voice conversation.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];
function appRequest(method, params) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let bytes = Buffer.alloc(0), settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; socket.destroy();
      error ? reject(error) : resolve(result);
    };
    socket.setTimeout(120000, () => finish(new Error('App tool request timed out')));
    socket.on('error', e => finish(e));
    socket.on('close', () => finish(new Error('Codex app tools pipe closed')));
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    });
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4) return;
      const length = bytes.readUInt32LE();
      if (length > 8 * 1024 * 1024) return finish(new Error('App response too large'));
      if (bytes.length < 4 + length) return;
      try {
        const result = JSON.parse(bytes.subarray(4, 4 + length));
        finish(result.error ? new Error(result.error.message) : null, result.result);
      } catch (e) { finish(e); }
    });
  });
}
async function tools() {
  catalog = (await appRequest('tools/list', { threadStartKind: 'all' })).tools;
  return [...catalog.map(({ namespace, ...tool }) => ({
    ...tool, inputSchema: { type: 'object', ...tool.inputSchema },
  })), ...localTools];
}
function metadata(params) {
  const meta = params._meta || {};
  let turn = meta['x-codex-turn-metadata'] || {};
  if (typeof turn === 'string') { try { turn = JSON.parse(turn); } catch { turn = {}; } }
  const threadId = meta['openai/threadId'] || meta['openai/thread_id'] ||
    meta.codexThreadId || meta.codex_thread_id || meta.threadId || meta.thread_id ||
    turn.thread_id || meta.thread?.id;
  if (!threadId) throw new Error('The caller must supply its own Codex thread metadata');
  return { threadId, turnId: meta['openai/turnId'] || meta.turnId || turn.turn_id || randomUUID() };
}
function parsedContent(result) {
  return (result.contentItems || []).flatMap(item => {
    if (item.type !== 'inputText') return [];
    try { return [JSON.parse(item.text)]; } catch { return []; }
  });
}
async function callApp(name, args, caller) {
  if (!catalog) await tools();
  const tool = catalog.find(t => t.name === name);
  if (!tool) throw new Error('Unknown app tool');
  return appRequest('tools/call', { ...caller, turnId: caller.turnId || randomUUID(), arguments: args, callId: randomUUID(),
    namespace: tool.namespace, tool: tool.name });
}
function sessionState(threadId) {
  return { threadId, target: selections.get(threadId) || null };
}
async function selectThread(caller, threadId) {
  if (typeof threadId !== 'string' || !threadId.trim()) throw new Error('A threadId is required');
  const result = await callApp('read_thread', { threadId, turnLimit: 1, includeOutputs: false }, caller);
  if (!result.success) throw new Error('Could not read the selected task');
  const thread = parsedContent(result).map(item => item.thread).find(item => item?.id === threadId);
  if (!thread) throw new Error('The app did not confirm the selected task');
  selections.set(caller.threadId, { threadId: thread.id, hostId: thread.hostId,
    title: thread.title, selectedAt: Date.now() });
  return sessionState(caller.threadId);
}
async function dispatch(request) {
  switch (request.method) {
    case 'initialize': return { protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'voice-desktop-gateway', version: '0.1.0' } };
    case 'ping': return {};
    case 'tools/list': return { tools: await tools() };
    case 'tools/call': {
      if (!catalog) await tools();
      const params = request.params;
      const caller = metadata(params);
      if (['voice_session_state', 'voice_select_thread', 'voice_clear_thread'].includes(params.name)) {
        if (params.name === 'voice_clear_thread') selections.delete(caller.threadId);
        const result = params.name === 'voice_select_thread'
          ? await selectThread(caller, params.arguments?.threadId) : sessionState(caller.threadId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      const result = await callApp(params.name, params.arguments || {}, caller);
      return { isError: !result.success, content: result.contentItems.map(item => {
        if (item.type === 'inputText') return { type: 'text', text: item.text };
        const url = item.imageUrl || item.audioUrl;
        const match = /^data:([^;,]+);base64,(.*)$/s.exec(url || '');
        return match ? { type: item.type === 'inputImage' ? 'image' : 'audio',
          mimeType: match[1], data: match[2] } : { type: 'text', text: url || '' };
      }) };
    }
    default: throw new Error('Unsupported MCP method');
  }
}
async function activatePresentation() {
  if (!watchOwner) throw new Error('The real launching conversation is required');
  const result = await callApp('read_thread', { threadId: watchOwner, turnLimit: 1, includeOutputs: false }, { threadId: watchOwner });
  const thread = parsedContent(result).map(x => x.thread).find(x => x?.id === watchOwner);
  if (!result.success || !thread) throw new Error('Could not validate the invoking conversation');
  await writeFile(new URL('../.voice-poc/gateways/' + watchOwner + '.json', import.meta.url), JSON.stringify({thread_id: watchOwner, title: thread.title, url: `http://127.0.0.1:${port}`, instance_id: instanceId}));
  const response = await fetch('http://127.0.0.1:8767/api/presentation/activate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_id: watchOwner, title: thread.title,
      gateway_url: `http://127.0.0.1:${port}`, gateway_instance: instanceId }),
    signal: AbortSignal.timeout(12000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || 'Audio activation failed');
  return { ...data, url: 'http://127.0.0.1:8767/voice/' };
}
async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8 * 1024 * 1024) throw new Error('Request too large');
  }
  return JSON.parse(body);
}
const server = http.createServer(async (req, res) => {
  const validHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  let localOrigin = true;
  if (req.headers.origin) {
    try { localOrigin = ['127.0.0.1', 'localhost'].includes(new URL(req.headers.origin).hostname); }
    catch { localOrigin = false; }
  }
  if (!validHosts.has(req.headers.host) || !localOrigin) { res.writeHead(403).end(); return; }
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/identity' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ thread_id: watchOwner, instance_id: instanceId, durable_delivery: true, room_control: true })); return;
  }
  if (url.pathname === '/activate' && req.method === 'POST') {
    try { const result = await activatePresentation(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); }
    catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
    return;
  }
  if (['/tasks/state', '/tasks/watch', '/tasks/unwatch'].includes(url.pathname)) {
    try {
      const isState = url.pathname === '/tasks/state';
      if (req.method !== (isState ? 'GET' : 'POST')) { res.writeHead(405).end(); return; }
      const input = isState ? { thread_id: url.searchParams.get('thread_id') } : await readJson(req);
      if (!taskWatches || input.thread_id !== watchOwner) throw new Error('Only the actual coordinating conversation may manage its watches');
      const result = isState ? taskWatches.list(watchOwner)
        : url.pathname === '/tasks/unwatch' ? await taskWatches.unwatch(watchOwner, input.target_id)
        : await taskWatches.register(watchOwner, input.target_id, {
            includeCurrent: input.include_current === true, rearm: input.rearm === true,
            expectedTurnId: input.expected_turn_id || null,
          });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (url.pathname === '/presentation/message') {
    try {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      const input = await readJson(req);
      const callerId = process.env.CODEX_THREAD_ID;
      if (!callerId) throw new Error('Start this bridge from its actual Codex conversation');
      if (typeof input.thread_id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(input.thread_id) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 12000)
        throw new Error('Invalid voice destination or transcript');
      if (typeof input.message_id !== 'string' || !input.message_id) throw new Error('message_id required');
      if (typeof input.session_id !== 'string' || !(input.channel === 'room-control' || /^SmallWebRTCConnection#[0-9]+-[a-zA-Z0-9]+$/.test(input.session_id)) || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error('Valid voice session and revision required');
      // A registered room participant remains a valid destination after focus moves.
      // Any live bridge can deliver, using its own real caller identity.
      if (input.thread_id !== watchOwner) {
        const destination = JSON.parse(await readFile(new URL('../.voice-poc/gateways/' + input.thread_id + '.json', import.meta.url), 'utf8'));
        if (destination.thread_id !== input.thread_id) throw new Error('Unregistered voice destination');
      }
      const key = input.thread_id + ':' + input.message_id;
      const fingerprint = JSON.stringify([input.thread_id, input.session_id, input.revision, input.text]);
      if (presentationMessages.has(key) && presentationMessages.get(key).fingerprint !== fingerprint) throw new Error('message_id already used for different content');
      if (!presentationMessages.has(key)) {
        const prompt = JSON.stringify({
          channel: input.channel === 'room-control' ? 'room-control' : 'voice', session_id: input.session_id, revision: input.revision,
          message_id: input.message_id,
        }) + '\n\n' + input.text;
        // The bridge uses its real launching conversation as caller, never an invented agent identity.
        presentationMessages.set(key, { fingerprint, promise: callApp('send_message_to_thread', { threadId: input.thread_id, prompt },
          { threadId: callerId, turnId: randomUUID() }) });
        if (presentationMessages.size > 512) presentationMessages.delete(presentationMessages.keys().next().value);
      }
      const result = await presentationMessages.get(key).promise;
      if (!result.success) throw new Error('Codex did not confirm delivery');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'sent', message_id: input.message_id }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (url.pathname === '/voice/state' || url.pathname === '/voice/poll') {
    try {
      const isState = url.pathname === '/voice/state';
      if (req.method !== (isState ? 'GET' : 'POST')) { res.writeHead(405).end(); return; }
      const input = isState ? { thread_id: url.searchParams.get('thread_id') } : await readJson(req);
      if (typeof input.thread_id !== 'string' || !input.thread_id.trim()) throw new Error('The voice caller thread_id is required');
      const state = sessionState(input.thread_id);
      let result = null;
      if (!isState && state.target) {
        const target = { threadId: state.target.threadId, hostId: state.target.hostId };
        if (input.cursor) target.afterCursor = input.cursor;
        result = await callApp('wait_threads', { targets: [target], timeoutMs: 1000 },
          { threadId: input.thread_id, turnId: randomUUID() });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(isState ? state : { ...state, result }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let request;
  try {
    request = await readJson(req);
    if (request.id === undefined) { res.writeHead(202).end(); return; }
    const result = await dispatch(request);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } catch (error) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null,
      error: { code: -32603, message: error.message } }));
  }
});
// Verify the actual app connection before announcing readiness.
await tools();
taskWatches?.start();
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
port = server.address().port;
if (watchOwner) {
  const directory = new URL('../.voice-poc/gateways/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const file = new URL(watchOwner + '.json', directory);
  const temporary = new URL(watchOwner + '.' + instanceId + '.tmp', directory);
  let title; try { title = JSON.parse(await readFile(file, 'utf8')).title; } catch {}
  await writeFile(temporary, JSON.stringify({ title, url: `http://127.0.0.1:${port}`, thread_id: watchOwner, instance_id: instanceId }), { mode: 0o600 });
  await rename(temporary, file);
}
console.log(`Voice desktop MCP ready on 127.0.0.1:${port}`);
if (process.env.VOICE_ACTIVATE_ON_START === '1') {
  try { console.log(JSON.stringify(await activatePresentation())); }
  catch (error) { console.error('Audio activation failed: ' + error.message); }
}
