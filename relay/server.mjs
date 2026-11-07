// DSH Anywhere relay/hub: REST + SSE + static PWA host. Zero third-party deps.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, defaultHome, ensureDir, readText, writeText, randomToken, pairCode } from '../shared/protocol.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PHONE_DIR = path.join(HERE, '..', 'phone');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, last-event-id');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-expose-headers', '*');
}
function sendJson(res, status, obj) {
  cors(res);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export function createRelay(opts) {
  opts = opts || {};
  const home = opts.home || defaultHome();
  ensureDir(home);
  const token = opts.token || readText(path.join(home, 'secret')) || randomToken();
  writeText(path.join(home, 'secret'), token);
  const code = pairCode();
  writeText(path.join(home, 'pair-code.txt'), code);
  const quiet = !!opts.quiet;

  const state = {
    hosts: new Map(),
    sessions: new Map(),
    events: [],
    eventIds: new Set(),
    cursor: 0,
    commands: new Map(),
    sse: new Set(),
  };

  const eventsPath = path.join(home, 'events.ndjson');
  const metaPath = path.join(home, 'meta.json');
  try {
    if (fs.existsSync(eventsPath)) {
      for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
        const t = line.trim(); if (!t) continue;
        try { const e = JSON.parse(t); state.events.push(e); if (e.id) state.eventIds.add(e.id); if (e.cursor > state.cursor) state.cursor = e.cursor; } catch (err) {}
      }
    }
    if (fs.existsSync(metaPath)) {
      const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (m.cursor > state.cursor) state.cursor = m.cursor;
      for (const h of (m.hosts || [])) state.hosts.set(h.hostId, h);
      for (const hid of Object.keys(m.sessions || {})) {
        const mp = new Map(); for (const s of (m.sessions[hid] || [])) mp.set(s.sessionId, s);
        state.sessions.set(hid, mp);
      }
    }
  } catch (e) {}

  let saveTimer = null;
  function flushMeta() {
    const sessions = {};
    for (const [hid, mp] of state.sessions) sessions[hid] = Array.from(mp.values());
    try { writeText(metaPath, JSON.stringify({ cursor: state.cursor, hosts: Array.from(state.hosts.values()), sessions })); } catch (e) {}
  }
  function saveMeta() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; flushMeta(); }, 400);
  }
  function broadcast(name, obj, cursor, filter) {
    const data = JSON.stringify(obj);
    for (const cl of state.sse) {
      if (filter && !filter(cl)) continue;
      try {
        let s = '';
        if (cursor != null) s += 'id: ' + cursor + '\n';
        s += 'event: ' + name + '\ndata: ' + data + '\n\n';
        cl.res.write(s);
      } catch (e) {}
    }
  }
  function appendEvents(evts) {
    let fd = null;
    try { fd = fs.openSync(eventsPath, 'a'); } catch (e) {}
    for (const e of evts) {
      if (e.id && state.eventIds.has(e.id)) continue;
      if (e.id) state.eventIds.add(e.id);
      const c = ++state.cursor;
      const rec = Object.assign({}, e, { cursor: c });
      state.events.push(rec);
      if (fd) try { fs.writeSync(fd, JSON.stringify(rec) + '\n'); } catch (err) {}
      broadcast('event', rec, c, (cl) => cl.role !== 'host');
    }
    if (fd) try { fs.closeSync(fd); } catch (e) {}
  }
  function setTitle(e) {
    if (!e.data || !e.data.title) return;
    let mp = state.sessions.get(e.hostId);
    if (!mp) { mp = new Map(); state.sessions.set(e.hostId, mp); }
    let s = mp.get(e.sessionId);
    if (!s) { s = { hostId: e.hostId, sessionId: e.sessionId, title: '', cwd: e.cwd || '', updatedAt: Date.now(), eventCount: 0, lastSeq: -1 }; mp.set(e.sessionId, s); }
    s.title = e.data.title;
  }
  function upsertSession(s) {
    let mp = state.sessions.get(s.hostId);
    if (!mp) { mp = new Map(); state.sessions.set(s.hostId, mp); }
    const prev = mp.get(s.sessionId);
    const merged = Object.assign({}, prev || {}, s, { updatedAt: Date.now() });
    const changed = !prev || prev.title !== merged.title || prev.cwd !== merged.cwd;
    mp.set(s.sessionId, merged);
    if (changed) { broadcast('session', merged, null, (cl) => cl.role !== 'host'); saveMeta(); }
    return merged;
  }
  function takeCommands(hostId) {
    const q = state.commands.get(hostId) || [];
    state.commands.set(hostId, []);
    return q;
  }

  const server = http.createServer(async (req, res) => {
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
    const pathname = u.pathname;
    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
    if (pathname === '/api/health') return sendJson(res, 200, { ok: true, name: 'dsh-anywhere', version: VERSION, protocol: 'dsh-anywhere/1', time: Date.now() });
    if (pathname === '/api/pair' && req.method === 'POST') {
      let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
      if (String(body.code || '') === code) return sendJson(res, 200, { ok: true, token, relayVersion: VERSION, protocol: 'dsh-anywhere/1' });
      return sendJson(res, 401, { ok: false, error: 'bad pairing code' });
    }
    if (pathname.startsWith('/api/')) {
      const tk = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || u.searchParams.get('token');
      if (tk !== token) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }
    if (pathname === '/api/stream' && req.method === 'GET') {
      const role = u.searchParams.get('role') || 'phone';
      const hostId = u.searchParams.get('hostId') || '';
      const since = parseInt(u.searchParams.get('since') || (req.headers['last-event-id'] || '0'), 10) || 0;
      cors(res);
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const cl = { res, role, hostId };
      state.sse.add(cl);
      res.write('event: hello\ndata: ' + JSON.stringify({ relayVersion: VERSION, cursor: state.cursor, role, hostId }) + '\n\n');
      for (const e of state.events) {
        if (e.cursor <= since) continue;
        if (role === 'host' && hostId && e.hostId !== hostId) continue;
        res.write('id: ' + e.cursor + '\nevent: event\ndata: ' + JSON.stringify(e) + '\n\n');
      }
      const ka = setInterval(() => { try { res.write('event: heartbeat\ndata: ' + JSON.stringify({ time: Date.now() }) + '\n\n'); } catch (e) {} }, 15000);
      const cleanup = () => { clearInterval(ka); state.sse.delete(cl); };
      req.on('close', cleanup); res.on('close', cleanup);
      return;
    }
    if (pathname === '/api/bootstrap' && req.method === 'GET') {
      const sessions = {};
      for (const [hid, mp] of state.sessions) sessions[hid] = Array.from(mp.values());
      return sendJson(res, 200, { ok: true, hosts: Array.from(state.hosts.values()), sessions, cursor: state.cursor, events: state.events.slice(-300) });
    }
    if (pathname === '/api/events' && req.method === 'GET') {
      const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
      const hostId = u.searchParams.get('hostId') || '';
      const sessionId = u.searchParams.get('sessionId') || '';
      let limit = parseInt(u.searchParams.get('limit') || '500', 10) || 500;
      if (limit > 5000) limit = 5000;
      const events = state.events.filter(e => e.cursor > since && (!hostId || e.hostId === hostId) && (!sessionId || e.sessionId === sessionId)).slice(0, limit);
      return sendJson(res, 200, { ok: true, events, cursor: state.cursor });
    }
    if (pathname === '/api/register' && req.method === 'POST') {
      let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
      if (!body.hostId) return sendJson(res, 400, { ok: false, error: 'hostId required' });
      const h = Object.assign({}, state.hosts.get(body.hostId) || {}, body, { online: true, lastSeen: Date.now() });
      state.hosts.set(body.hostId, h);
      broadcast('host', h, null, null);
      saveMeta();
      return sendJson(res, 200, { ok: true, host: h });
    }
    if (pathname === '/api/ingest' && req.method === 'POST') {
      let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
      const evts = Array.isArray(body.events) ? body.events : [];
      const hostId = body.hostId || (evts[0] && evts[0].hostId) || '';
      for (const e of evts) if (e.type === 'session/title') setTitle(e);
      if (Array.isArray(body.sessions)) for (const s of body.sessions) upsertSession(s);
      appendEvents(evts);
      saveMeta();
      return sendJson(res, 200, { ok: true, cursor: state.cursor, commands: takeCommands(hostId) });
    }
    if (pathname === '/api/command' && req.method === 'POST') {
      let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
      if (!body.targetHostId || !body.clientMessageId) return sendJson(res, 400, { ok: false, error: 'targetHostId + clientMessageId required' });
      const cmd = Object.assign({ kind: 'message', time: Date.now() }, body);
      const q = state.commands.get(cmd.targetHostId) || [];
      q.push(cmd); state.commands.set(cmd.targetHostId, q);
      broadcast('command', cmd, null, (cl) => cl.role === 'host' && cl.hostId === cmd.targetHostId);
      return sendJson(res, 200, { ok: true, queued: true, cursor: state.cursor });
    }
    if (pathname === '/api/command-result' && req.method === 'POST') {
      let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
      const ack = Object.assign({ time: Date.now() }, body);
      broadcast('ack', ack, null, null);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'not found' });
    let rel = pathname === '/' ? '/index.html' : pathname;
    if (rel.indexOf('/app/') === 0) rel = rel.slice(4);
    if (rel.charAt(0) === '/') rel = rel.slice(1);
    rel = rel.replace(/\\/g, '/');
    if (rel.indexOf('..') >= 0) rel = 'index.html';
    const file = path.join(PHONE_DIR, rel || 'index.html');
    let data;
    let served = file;
    try { data = fs.readFileSync(file); }
    catch (e) {
      served = path.join(PHONE_DIR, 'index.html');
      try { data = fs.readFileSync(served); }
      catch (e2) { return sendJson(res, 404, { ok: false, error: 'phone app not built' }); }
    }
    cors(res);
    res.writeHead(200, { 'content-type': MIME[path.extname(served)] || 'application/octet-stream' });
    return res.end(data);
  });
  server.on('clientError', (err, socket) => { try { socket.destroy(); } catch (e) {} });

  return {
    server, state, token, pairCode: code, home,
    listen(port, host) {
      port = port == null ? 0 : port; host = host || '127.0.0.1';
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          const p = server.address().port;
          const url = 'http://' + host + ':' + p;
          if (!quiet) {
            console.log('[dsh-anywhere] listening ' + url);
            console.log('[dsh-anywhere] pairing code: ' + code);
            console.log('[dsh-anywhere] token: ' + token);
          }
          resolve({ port: p, url, token, pairCode: code });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        for (const cl of state.sse) { try { cl.res.end(); } catch (e) {} }
        state.sse.clear();
        flushMeta();
        server.close(() => resolve());
        setTimeout(resolve, 1000);
      });
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = parseInt(process.env.PORT || '8787', 10);
  const host = process.env.HOST || '0.0.0.0';
  const r = createRelay({ token: process.env.DSH_ANYWHERE_TOKEN || undefined, home: process.env.DSH_ANYWHERE_HOME || undefined });
  r.listen(port, host).then((info) => {
    console.log('[dsh-anywhere] phone URL: ' + info.url + '/');
    console.log('[dsh-anywhere] open that URL on your phone, enter pairing code ' + info.pairCode);
  }).catch((e) => { console.error('[dsh-anywhere] failed to listen: ' + e.message); process.exit(1); });
  const stop = () => r.close().then(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
