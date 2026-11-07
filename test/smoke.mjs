// Smoke test: decode a REAL DSH session log with our decoder. Zero deps.
import os from 'node:os';
import path from 'node:path';
import { discoverSessions, decodeSessionFile, SessionTailer } from '../shared/session-log.mjs';
import { defaultDshHome } from '../shared/protocol.mjs';

const dshHome = defaultDshHome();
const files = discoverSessions(dshHome);
console.log('[smoke] DSH_HOME=' + dshHome);
console.log('[smoke] discovered ' + files.length + ' sessions');
if (!files.length) {
  console.log('[smoke] no DSH sessions found - nothing to decode (not a failure)');
  process.exit(0);
}

let failures = 0;
const show = files.slice(0, 3);
for (const f of show) {
  const r = decodeSessionFile(f.path, { hostId: 'smoke', sessionId: f.sessionId });
  const types = {};
  for (const e of r.events) types[e.type] = (types[e.type] || 0) + 1;
  console.log('[smoke] ' + f.sessionId + ': bytes=' + r.bytes + ' frames=' + r.frames + ' consumed=' + r.consumed + ' events=' + r.events.length);
  console.log('[smoke]   types=' + JSON.stringify(types));
  if (r.frames === 0) { console.error('[smoke]   FAIL: decoded zero frames'); failures++; }
  if (r.events.length === 0) { console.error('[smoke]   FAIL: decoded zero events'); failures++; }
  if (r.consumed !== r.bytes && r.consumed < r.bytes - 1) {
    // A partial trailing frame is allowed only if small; otherwise report.
    console.log('[smoke]   note: trailing ' + (r.bytes - r.consumed) + ' bytes not consumed (partial frame mid-write is OK)');
  }
  // Validate normalized event shape.
  const bad = r.events.filter(e => !e.hostId || !e.sessionId || !e.type || !e.id || typeof e.seq !== 'number');
  if (bad.length) { console.error('[smoke]   FAIL: ' + bad.length + ' malformed normalized events'); failures++; }
  const first = r.events[0];
  if (first && first.type !== 'session') { console.log('[smoke]   note: first event is ' + first.type + ' (multi-appended file, OK)'); }
}

// Incremental tail validation: create a tailer over the largest file and verify
// that a fresh tailer replaying the whole file yields the same event count.
const big = files[0];
const full = decodeSessionFile(big.path, { hostId: 'smoke', sessionId: big.sessionId });
const t = new SessionTailer(big.path, { hostId: 'smoke', sessionId: big.sessionId });
const p = t.poll();
console.log('[smoke] tailer full-file poll: events=' + p.events.length + ' (decodeSessionFile=' + full.events.length + ')');
if (p.events.length !== full.events.length) {
  console.error('[smoke] FAIL: SessionTailer poll disagrees with decodeSessionFile');
  failures++;
}
// Second poll must be empty (no re-delivery).
const p2 = t.poll();
if (p2.events.length !== 0) { console.error('[smoke] FAIL: second poll re-delivered ' + p2.events.length + ' events'); failures++; }

if (failures) { console.error('[smoke] ' + failures + ' check(s) FAILED'); process.exit(1); }
console.log('[smoke] OK');
