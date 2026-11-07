// DSH Anywhere host adapter: tails local DSH session logs into the relay, executes phone commands.
import os from 'node:os';
import path from 'node:path';
import { defaultHome, defaultDshHome, ensureDir, readText, writeText, randomId, request, sleep } from '../shared/protocol.mjs';
import { discoverSessions, SessionTailer, sessionInfo } from '../shared/session-log.mjs';
import { discoverBridge, inject } from './bridge-inject.mjs';
import { deployInject } from '../install/deploy-inject.mjs';

const RELAY = process.env.DSH_ANYWHERE_RELAY;
if (!RELAY) { console.error('[host] DSH_ANYWHERE_RELAY is required, e.g. http://127.0.0.1:8787'); process.exit(2); }
const HOME = defaultHome();
const TOKEN = process.env.DSH_ANYWHERE_TOKEN || readText(path.join(HOME, 'secret'));
const DSH_HOME = defaultDshHome();
ensureDir(HOME);
const HOST_ID = process.env.DSH_ANYWHERE_HOST_ID || readText(path.join(HOME, 'host-id')) || randomId('host-');
writeText(path.join(HOME, 'host-id'), HOST_ID);
const HOST_NAME = process.env.DSH_ANYWHERE_HOST_NAME || os.hostname();
const PLATFORM = process.platform;
const MAX_SESSIONS = parseInt(process.env.DSH_ANYWHERE_MAX_SESSIONS || '12', 10);
const POLL_MS = parseInt(process.env.DSH_ANYWHERE_POLL_MS || '1500', 10);

// Deploy the in-DSH injection bridge once per host start. Idempotent and
// best-effort (never throws): DSH HMR hot-loads @local/dsh-anywhere-inject on
// first install, so phone commands reach the live agent with no DSH restart,
// no token change, and no relay interruption. See install/deploy-inject.mjs.
try {
  const dep = deployInject({ quiet: true });
  if (dep && dep.ok) console.log('[host] injection bridge ready (' + dep.profiles.length + ' profile(s))');
} catch (e) {
  console.error('[host] injection bridge deploy skipped: ' + (e && e.message ? e.message : String(e)));
}

const tailers = new Map();
let bridge = discoverBridge(DSH_HOME, HOME);
let running = true;

function describe() {
  return {
    hostId: HOST_ID, hostName: HOST_NAME, platform: PLATFORM, online: true,
    dshHome: DSH_HOME,
    bridge: bridge ? { version: bridge.version, endpoint: bridge.host ? (bridge.host + ':' + bridge.port) : (bridge.file || 'meshcall') } : null,
    adapterVersion: '1.0.0',
  };
}
async function register() {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await request(RELAY, '/api/register', { method: 'POST', token: TOKEN, body: describe(), timeout: 8000 });
      if (r.status === 200) return;
    } catch (e) {}
    await sleep(500);
  }
}
// A first poll can backfill tens of thousands of historical events (tens of MB),
// which exceeds the relay's single-request body limit. Split by serialized size
// and POST sequentially; each batch also drains queued phone commands.
const INGEST_BATCH_BYTES = 6 * 1024 * 1024;
async function push(events, sessions) {
  const commands = [];
  let batch = [];
  let batchBytes = 0;
  let pushed = 0;
  let firstBatch = true;
  async function flush() {
    if (!batch.length && !firstBatch) return;
    const body = { hostId: HOST_ID, events: batch, sessions: firstBatch ? sessions : [] };
    firstBatch = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await request(RELAY, '/api/ingest', { method: 'POST', token: TOKEN, body, timeout: 30000 });
        if (r.json && Array.isArray(r.json.commands)) for (const c of r.json.commands) commands.push(c);
        pushed += batch.length;
        return;
      } catch (e) { if (attempt < 2) await sleep(300); }
    }
  }
  for (const e of events) {
    const n = Buffer.byteLength(JSON.stringify(e));
    if (batch.length && batchBytes + n > INGEST_BATCH_BYTES) {
      await flush();
      batch = []; batchBytes = 0;
    }
    batch.push(e); batchBytes += n;
  }
  await flush(); // also drains pending commands when events is empty
  return { commands, pushed };
}
async function handleCommands(commands) {
  for (const cmd of commands) {
    const res = await inject(cmd, bridge, HOME);
    console.log('[host] command ' + cmd.clientMessageId + ' -> ' + res.status + ' (' + res.detail + ')');
    try {
      await request(RELAY, '/api/command-result', { method: 'POST', token: TOKEN, body: {
        clientMessageId: cmd.clientMessageId, targetHostId: HOST_ID, status: res.status,
        detail: res.detail, deliveredVia: res.status === 'ok' ? ('bridge-v' + (bridge ? bridge.version : '?')) : 'inbox',
        time: Date.now(),
      }, timeout: 8000 });
    } catch (e) {}
  }
}
function syncSessions() {
  const list = discoverSessions(DSH_HOME).slice(0, MAX_SESSIONS);
  for (const s of list) {
    if (!tailers.has(s.sessionId)) {
      const t = new SessionTailer(s.path, { hostId: HOST_ID, sessionId: s.sessionId, cwd: s.cwd });
      tailers.set(s.sessionId, { tailer: t, file: s.path, cwd: s.cwd });
      console.log('[host] watching session ' + s.sessionId + ' (' + s.workspace + ')');
    }
  }
}
let firstPoll = true;
async function pollOnce() {
  const events = [];
  const sessions = [];
  for (const obj of tailers.values()) {
    const r = obj.tailer.poll();
    for (const e of r.events) events.push(e);
    if (firstPoll || r.events.length) sessions.push(sessionInfo(obj.tailer, r.meta));
  }
  firstPoll = false;
  events.sort((a, b) => a.time - b.time || a.seq - b.seq);
  const { commands, pushed } = await push(events, sessions);
  if (pushed) console.log('[host] pushed ' + pushed + ' events');
  await handleCommands(commands);
}

async function main() {
  console.log('[host] hostId=' + HOST_ID + ' name=' + HOST_NAME + ' platform=' + PLATFORM);
  console.log('[host] relay=' + RELAY + ' dshHome=' + DSH_HOME);
  console.log('[host] bridge=' + (bridge ? JSON.stringify({ version: bridge.version, endpoint: bridge.host ? bridge.host + ':' + bridge.port : bridge.file }) : 'none'));
  if (!bridge) console.log('[host] WARNING: no local DSH bridge found; phone commands will be saved to command-inbox.jsonl only.');
  syncSessions();
  await register();
  let ticks = 0;
  while (running) {
    try { await pollOnce(); } catch (e) { console.error('[host] poll error: ' + e.message); }
    ticks++;
    if (ticks % 8 === 0) { bridge = discoverBridge(DSH_HOME, HOME); await register(); }
    if (ticks % 10 === 0) syncSessions();
    await sleep(POLL_MS);
  }
}
process.on('SIGINT', () => { running = false; setTimeout(() => process.exit(0), 200); });
process.on('SIGTERM', () => { running = false; setTimeout(() => process.exit(0), 200); });
main().catch((e) => { console.error('[host] fatal: ' + e.stack); process.exit(1); });
