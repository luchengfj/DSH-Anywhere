// DSH Anywhere: decode DSH session.v4.jsonl.zstd (concatenated zstd frames of JSONL).
// Zero third-party deps: Node 24 has zlib.zstdDecompressSync; older Node falls back to system zstd CLI.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import cp from 'node:child_process';

export const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function zstdDecode(buf) {
  if (typeof zlib.zstdDecompressSync === 'function') {
    try { return zlib.zstdDecompressSync(buf); } catch (e) { /* strict builds reject trailing bytes */ }
  }
  // Fallback: zstd skippable-frame decoder. A DSH frame is a normal zstd frame
  // optionally followed by skippable frames (magic 0x184D2A5?), so we decompress
  // the leading normal frame only.
  try {
    if (buf.length >= 6 && (buf[0] & 0xf0) === 0x20) {
      let p = 0;
      while (p + 8 <= buf.length && (buf[p] & 0xf0) === 0x50) p += 8 + buf.readUInt32LE(p + 4);
      if (p + 6 <= buf.length && (buf[p] & 0xf0) === 0x20) {
        let q = p + 6;
        const fhd = buf[p + 4];
        if (fhd & 0x03) q += (fhd & 0x04) ? 4 : 1;
        const winDesc = buf[p + 5];
        const exponent = (winDesc >> 3) & 0x1f;
        const mantissa = winDesc & 0x07;
        let winLog = 10 + exponent;
        if (winLog > 24) winLog = 24;
        let windowSize = (1 << winLog);
        windowSize += (windowSize / 8) * mantissa;
        if (fhd & 0x20) q += 1;
        const b1 = buf[q];
        const blockType = (b1 >> 1) & 0x03;
        const blockSize = (b1 >> 3) | (buf[q + 1] << 5) | (buf[q + 2] << 13);
        let blockStart = q + 3;
        if (blockType === 1) blockStart += 1;
        const frameEnd = blockStart + blockSize;
        if (frameEnd <= buf.length) {
          const single = buf.subarray(p, frameEnd);
          if (typeof zlib.zstdDecompressSync === 'function') {
            const d = zlib.zstdDecompressSync(single);
            if (d) return d;
          }
          return cp.execFileSync('zstd', ['-d', '-c'], { input: single, maxBuffer: 256 * 1024 * 1024 });
        }
      }
    }
  } catch (e) { /* fall through */ }
  try {
    return cp.execFileSync('zstd', ['-d', '-c'], { input: buf, maxBuffer: 256 * 1024 * 1024 });
  } catch (e) { return null; }
}

function magicPositions(buf) {
  const p = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) p.push(i);
  }
  return p;
}

// Decode leading complete zstd frames. Returns { frames:[Buffer], consumed:number }.
// DSH appends one frame per write; a trailing partial frame (mid-write) is left unconsumed.
// Spurious magic bytes inside compressed data are handled by extending the candidate slice.
export function decodeFrames(buf) {
  const positions = magicPositions(buf);
  const frames = [];
  let consumed = 0;
  let i = 0;
  while (i < positions.length) {
    const start = positions[i];
    if (start < consumed) { i++; continue; }
    let out = null;
    let end = -1;
    let next = i + 1;
    for (let j = i + 1; j <= positions.length; j++) {
      const e = (j < positions.length) ? positions[j] : buf.length;
      const d = zstdDecode(buf.subarray(start, e));
      if (d) { out = d; end = e; next = j; break; }
    }
    if (!out) break;
    frames.push(out);
    consumed = end;
    i = next;
  }
  return { frames: frames, consumed: consumed };
}

export function parseEvents(frameBuffers, ctx) {
  ctx = ctx || {};
  const hostId = ctx.hostId || 'unknown';
  const sessionId = ctx.sessionId || 'unknown';
  const cwd = ctx.cwd || '';
  const out = [];
  for (const fb of frameBuffers) {
    const text = fb.toString('utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let obj;
      try { obj = JSON.parse(t); } catch (e) { continue; }
      const seq = (typeof obj.seq === 'number') ? obj.seq : -1;
      out.push({
        hostId: hostId,
        sessionId: sessionId,
        seq: seq,
        time: (typeof obj.time === 'number') ? obj.time : (obj.createdAt || Date.now()),
        type: obj.type || 'unknown',
        data: (obj.data !== undefined) ? obj.data : obj,
        cwd: cwd || obj.cwd || '',
        id: hostId + '/' + sessionId + '/' + (seq >= 0 ? seq : 'meta'),
      });
    }
  }
  return out;
}

export function discoverSessions(dshHome) {
  const root = path.join(dshHome, 'sessions');
  const out = [];
  let workspaces = [];
  try { workspaces = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return out; }
  for (const w of workspaces) {
    if (!w.isDirectory()) continue;
    const wdir = path.join(root, w.name);
    let subs = [];
    try { subs = fs.readdirSync(wdir, { withFileTypes: true }); } catch (e) { continue; }
    for (const s of subs) {
      if (!s.isDirectory()) continue;
      const f = path.join(wdir, s.name, 'session.v4.jsonl.zstd');
      let st;
      try { st = fs.statSync(f); } catch (e) { continue; }
      out.push({ sessionId: s.name, workspace: w.name, path: f, mtime: st.mtimeMs, size: st.size });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export class SessionTailer {
  constructor(file, ctx) {
    ctx = ctx || {};
    this.file = file;
    this.hostId = ctx.hostId || 'unknown';
    this.sessionId = ctx.sessionId || path.basename(path.dirname(file));
    this.offset = 0;
    this.cwd = ctx.cwd || '';
    this.title = '';
    this.lastSeq = -1;
    this.eventCount = 0;
  }
  meta() {
    return { cwd: this.cwd, title: this.title, lastSeq: this.lastSeq, eventCount: this.eventCount };
  }
  poll() {
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch (e) { return { events: [], meta: this.meta() }; }
    if (size < this.offset) this.offset = 0;
    if (size <= this.offset) return { events: [], meta: this.meta() };
    const len = size - this.offset;
    const buf = Buffer.allocUnsafe(len);
    let fd = null;
    try {
      fd = fs.openSync(this.file, 'r');
      fs.readSync(fd, buf, 0, len, this.offset);
      fs.closeSync(fd); fd = null;
    } catch (e) {
      try { if (fd) fs.closeSync(fd); } catch (x) {}
      return { events: [], meta: this.meta() };
    }
    const decoded = decodeFrames(buf);
    const events = parseEvents(decoded.frames, { hostId: this.hostId, sessionId: this.sessionId, cwd: this.cwd });
    this.offset += decoded.consumed;
    for (const e of events) {
      if (e.type === 'session' && e.data && e.data.cwd) this.cwd = e.data.cwd;
      if (e.type === 'session/title' && e.data && e.data.title) this.title = e.data.title;
      if (e.seq > this.lastSeq) this.lastSeq = e.seq;
      this.eventCount++;
    }
    return { events: events, meta: this.meta() };
  }
}

export function sessionInfo(tailer, meta) {
  meta = meta || tailer.meta();
  return {
    hostId: tailer.hostId,
    sessionId: tailer.sessionId,
    title: meta.title || tailer.sessionId,
    cwd: meta.cwd || '',
    updatedAt: Date.now(),
    eventCount: meta.eventCount || 0,
    lastSeq: (meta.lastSeq != null) ? meta.lastSeq : -1,
  };
}

export function decodeSessionFile(file, ctx) {
  const buf = fs.readFileSync(file);
  const decoded = decodeFrames(buf);
  return {
    events: parseEvents(decoded.frames, ctx),
    frames: decoded.frames.length,
    consumed: decoded.consumed,
    bytes: buf.length,
  };
}
