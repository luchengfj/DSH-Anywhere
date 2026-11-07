// Integration test: 2 hosts + 2 phones against an in-process relay.
// Verifies: register, ingest/sync, host switching, command queue + ack, offline catch-up.
// Zero third-party deps.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRelay } from '../relay/server.mjs';
import { randomId } from '../shared/protocol.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-anywhere-test-'));
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('[test] PASS ' + name);
  else { console.error('[test] FAIL ' + name + (extra ? ' :: ' + extra : '')); failures++; }
}
function req(base, pathname, opts) {
  opts = opts || {};
  const u = new URL(pathname, base);
  const token = opts.token || '';
  if (token) u.searchParams.set('token', token);
  const body = opts.body == null ? null : Buffer.from(JSON.stringify(opts.body));
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = 'Bearer ' + token;
  return new Promise((resolve, reject) => {
    const r = http.request(u, { method: opts.method || 'GET', headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => buf += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (e) {} resolve({ status: res.statusCode, json: j, text: buf }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
function evt(hostId, sessionId, seq, type, data) {
  return {
    hostId, sessionId, seq, time: Date.now() + seq, type, data: data || {},
    cwd: 'C:\\work', id: hostId + '/' + sessionId + '/' + seq,
  };
}

// SSE reader: collect events until predicate or timeout.
function openSSE(base, urlPath, token, onEvent, done) {
  const u = new URL(urlPath, base);
  u.searchParams.set('token', token);
  const r = http.request(u, { method: 'GET', headers: { accept: 'text/event-stream' } }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let name = '', data = '', id = null;
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) data = line.slice(5).trim();
          else if (line.startsWith('id:')) id = parseInt(line.slice(3).trim(), 10);
        }
        let obj = null; try { obj = JSON.parse(data); } catch (e) {}
        onEvent(name, obj, id);
      }
    });
    res.on('end', () => done());
  });
  r.on('error', done);
  r.end();
  return r;
}

const relay = createRelay({ home: tmp, token: 'test-token-abc', quiet: true });
const info = await relay.listen(0, '127.0.0.1');
const base = info.url;
const token = info.token;
console.log('[test] relay at ' + base + ' home=' + tmp);

// 1. health (no auth) + auth enforcement
let r = await req(base, '/api/health');
check('health is public + ok', r.status === 200 && r.json.ok === true, JSON.stringify(r.json));
r = await req(base, '/api/bootstrap');
check('bootstrap requires token', r.status === 401);
r = await req(base, '/api/pair', { method: 'POST', body: { code: relay.pairCode } });
check('pair with correct code returns token', r.status === 200 && r.json.token === token, JSON.stringify(r.json));
r = await req(base, '/api/pair', { method: 'POST', body: { code: '000000' } });
check('pair rejects wrong code', r.status === 401);

// 2. two hosts register
const hosts = [
  { hostId: 'win-1', hostName: 'Windows PC', platform: 'win32', online: true, dshHome: 'C:\\users\\x\\.dsh', bridge: { version: 1, endpoint: '127.0.0.1:65219' }, adapterVersion: '1.0.0' },
  { hostId: 'deck-1', hostName: 'SteamDeck', platform: 'linux', online: true, dshHome: '/home/deck/.dsh', bridge: { version: 2, endpoint: 'meshcall' }, adapterVersion: '1.0.0' },
];
for (const h of hosts) {
  r = await req(base, '/api/register', { method: 'POST', token, body: h });
  check('register ' + h.hostId, r.status === 200 && r.json.ok === true);
}

// 3. SSE from both phones, connected before ingest
const phoneA = [], phoneB = [];
const sseA = openSSE(base, '/api/stream?role=phone', token, (n, o) => phoneA.push({ n, o }), () => {});
const sseB = openSSE(base, '/api/stream?role=phone', token, (n, o) => phoneB.push({ n, o }), () => {});
await new Promise((res) => setTimeout(res, 250));

// 4. host 1 ingests events + session info
const winEvents = [
  evt('win-1', 's-win', -1, 'session', { version: 4, id: 's-win', createdAt: 1, cwd: 'C:\\work', agentPreset: 'standard' }),
  evt('win-1', 's-win', 0, 'user/message', { content: [{ type: 'text', text: 'hello from phone' }] }),
  evt('win-1', 's-win', 1, 'session/title', { title: 'Windows build task' }),
  evt('win-1', 's-win', 2, 'assistant/message', { message: { content: [{ type: 'text', text: 'working on it' }] } }),
  evt('win-1', 's-win', 3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
];
r = await req(base, '/api/ingest', { method: 'POST', token, body: {
  hostId: 'win-1', events: winEvents,
  sessions: [{ hostId: 'win-1', sessionId: 's-win', title: 'Windows build task', cwd: 'C:\\work', updatedAt: Date.now(), eventCount: 5, lastSeq: 3 }],
} });
check('ingest win-1 accepted', r.status === 200 && r.json.ok === true && r.json.cursor === 5, JSON.stringify(r.json));

// 5. host 2 ingests events (host switching)
const deckEvents = [
  evt('deck-1', 's-deck', -1, 'session', { version: 4, id: 's-deck', createdAt: 2, cwd: '/home/deck', agentPreset: 'standard' }),
  evt('deck-1', 's-deck', 0, 'user/message', { content: [{ type: 'text', text: 'deploy on deck' }] }),
  evt('deck-1', 's-deck', 1, 'session/title', { title: 'Deck deploy' }),
];
r = await req(base, '/api/ingest', { method: 'POST', token, body: {
  hostId: 'deck-1', events: deckEvents,
  sessions: [{ hostId: 'deck-1', sessionId: 's-deck', title: 'Deck deploy', cwd: '/home/deck', updatedAt: Date.now(), eventCount: 3, lastSeq: 1 }],
} });
check('ingest deck-1 accepted', r.status === 200 && r.json.cursor === 8, JSON.stringify(r.json));

await new Promise((res) => setTimeout(res, 250));
const sseEvtA = phoneA.filter(x => x.n === 'event');
const sseEvtB = phoneB.filter(x => x.n === 'event');
check('phone A received all 8 events via SSE', sseEvtA.length === 8, 'got ' + sseEvtA.length);
check('phone B received all 8 events via SSE', sseEvtB.length === 8, 'got ' + sseEvtB.length);
check('SSE hello delivered', phoneA.some(x => x.n === 'hello'));

// 6. bootstrap shows both hosts + both sessions (host switcher source)
r = await req(base, '/api/bootstrap', { token });
check('bootstrap lists 2 hosts', r.status === 200 && r.json.hosts.length === 2, JSON.stringify(r.json.hosts));
check('bootstrap lists sessions for win-1', r.json.sessions['win-1'] && r.json.sessions['win-1'].length === 1);
check('bootstrap lists sessions for deck-1', r.json.sessions['deck-1'] && r.json.sessions['deck-1'].length === 1);
check('session/title reflected in bootstrap', r.json.sessions['win-1'][0].title === 'Windows build task', r.json.sessions['win-1'][0].title);

// 7. offline catch-up: /api/events?since=5 should return only deck events
r = await req(base, '/api/events?since=5', { token });
check('offline catch-up returns events after cursor', r.status === 200 && r.json.events.length === 3, 'got ' + r.json.events.length);
check('catch-up events are deck-1 only', r.json.events.every(e => e.hostId === 'deck-1'));
r = await req(base, '/api/events?hostId=win-1', { token });
check('filter by hostId', r.json.events.length === 5 && r.json.events.every(e => e.hostId === 'win-1'), 'got ' + r.json.events.length);
r = await req(base, '/api/events?sessionId=s-deck', { token });
check('filter by sessionId', r.json.events.length === 3 && r.json.events.every(e => e.sessionId === 's-deck'));

// 8. dedup: re-ingest same event ids -> cursor must not advance
r = await req(base, '/api/ingest', { method: 'POST', token, body: { hostId: 'win-1', events: [winEvents[1]] } });
check('duplicate event id is deduped', r.status === 200 && r.json.cursor === 8, 'cursor=' + r.json.cursor);

// 9. command queue: phone sends to deck-1, SSE host stream receives it
const hostSSE = [];
const sseHost = openSSE(base, '/api/stream?role=host&hostId=deck-1', token, (n, o) => hostSSE.push({ n, o }), () => {});
await new Promise((res) => setTimeout(res, 200));
const cmd = { clientMessageId: randomId('m-'), targetHostId: 'deck-1', sessionId: 's-deck', kind: 'message', text: 'please continue', time: Date.now() };
r = await req(base, '/api/command', { method: 'POST', token, body: cmd });
check('command queued', r.status === 200 && r.json.queued === true, JSON.stringify(r.json));
await new Promise((res) => setTimeout(res, 200));
check('host SSE received command', hostSSE.some(x => x.n === 'command' && x.o.clientMessageId === cmd.clientMessageId), JSON.stringify(hostSSE));

// host polls ingest -> gets the queued command back
r = await req(base, '/api/ingest', { method: 'POST', token, body: { hostId: 'deck-1', events: [] } });
check('ingest returns queued command to host', r.json.commands && r.json.commands.length === 1 && r.json.commands[0].clientMessageId === cmd.clientMessageId, JSON.stringify(r.json.commands));
r = await req(base, '/api/ingest', { method: 'POST', token, body: { hostId: 'deck-1', events: [] } });
check('command queue drained (no duplicate)', r.json.commands.length === 0, JSON.stringify(r.json.commands));

// 10. ack broadcast to phone
const ack = { clientMessageId: cmd.clientMessageId, targetHostId: 'deck-1', status: 'unsupported', detail: 'v2 meshcall: saved to inbox', deliveredVia: 'inbox', time: Date.now() };
r = await req(base, '/api/command-result', { method: 'POST', token, body: ack });
check('command-result accepted', r.status === 200 && r.json.ok === true);
await new Promise((res) => setTimeout(res, 200));
check('phone A received ack', phoneA.some(x => x.n === 'ack' && x.o.clientMessageId === cmd.clientMessageId), JSON.stringify(phoneA.filter(x => x.n === 'ack')));
check('phone B received ack', phoneB.some(x => x.n === 'ack' && x.o.clientMessageId === cmd.clientMessageId));

// 11. command goes ONLY to the matching host
r = await req(base, '/api/command', { method: 'POST', token, body: Object.assign({}, cmd, { clientMessageId: randomId('m-'), targetHostId: 'win-1' }) });
await new Promise((res) => setTimeout(res, 150));
check('deck host SSE did NOT receive win-1 command', !hostSSE.some(x => x.n === 'command' && x.o.targetHostId === 'win-1'));

// 12. persistence: close + reopen relay in same home, events survive
await relay.close();
const relay2 = createRelay({ home: tmp, token: 'test-token-abc', quiet: true });
const info2 = await relay2.listen(0, '127.0.0.1');
r = await req(info2.url, '/api/events?since=0', { token });
check('events persisted across relay restart', r.status === 200 && r.json.events.length === 8, 'got ' + (r.json.events ? r.json.events.length : 'null'));
r = await req(info2.url, '/api/bootstrap', { token });
check('sessions persisted across restart', r.json.sessions['win-1'] && r.json.sessions['win-1'].length === 1);
await relay2.close();

for (const s of [sseA, sseB, sseHost]) { try { s.destroy(); } catch (e) {} }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log('[test] ' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
