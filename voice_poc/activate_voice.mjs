/** Run directly with Codex's signed Node runtime in the invoking conversation. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const owner = process.env.CODEX_THREAD_ID;
if (!owner || !/^[a-f0-9-]{36}$/.test(owner)) throw new Error('Run activation from the actual Codex conversation. CODEX_THREAD_ID is required.');
const registry = fileURLToPath(new URL('../.voice-poc/gateways/', import.meta.url));
fs.mkdirSync(registry, { recursive: true });
const record = `${registry}${owner}.json`;
async function reuse() {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(record, 'utf8'));
    const identity = await fetch(saved.url + '/identity', { signal: AbortSignal.timeout(1500) }).then(r => r.json());
    if (identity.thread_id !== owner || identity.instance_id !== saved.instance_id) return false;
  } catch { return false; }
  // A live owner's activation error must not launch a duplicate gateway.
  const response = await fetch(saved.url + '/activate', { method: 'POST', signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Activation failed');
  console.log(JSON.stringify(result));
  return true;
}
if (await reuse()) process.exit(0);
const lock = `${registry}${owner}.lock`;
try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
catch {
  const pid = Number(fs.readFileSync(lock, 'utf8'));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  if (alive) throw new Error('The conversation gateway is starting or unavailable. Retry activation after it finishes.');
  fs.unlinkSync(lock);
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
}
process.on('exit', () => { try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); } catch {} });
process.env.VOICE_DESKTOP_PORT = '0';
process.env.VOICE_ACTIVATE_ON_START = '1';
await import('./desktop_gateway.mjs');
