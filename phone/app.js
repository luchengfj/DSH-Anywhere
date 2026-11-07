/* =====================================================================
 * DSH Anywhere - phone PWA client
 * Vanilla ES module, zero third-party dependencies.
 *
 * Contract: SPEC.md (single source of truth).
 *  - REST  : Authorization: Bearer <token> header
 *  - SSE   : EventSource(/api/stream?role=phone&token=<token>)  (no headers possible)
 *
 * Implemented requirements:
 *  1. Pairing screen (relay URL + 6-digit code) -> POST /api/pair -> token in localStorage
 *  2. GET /api/bootstrap -> host list + session list + host switcher
 *  3. EventSource live stream, Last-Event-ID tracking, reconnect replay via
 *     /api/events?since=lastCursor
 *  4. Timeline rendering (messages/reasoning, collapsed tool blocks, status bars)
 *     filtered by selected hostId + sessionId
 *  5. Composer -> POST /api/command (message/steer/interrupt/command) + ack display
 *  6. Offline outbox queue + cached events in localStorage
 *  7. Responsive mobile dark UI + manifest + service worker app-shell cache
 * ===================================================================== */

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */
const PREFIX = "dshAnywhere.";
const MAX_EVENTS = 2000;      // cap the localStorage event cache
const MAX_DOM_EVENTS = 600;   // cap live DOM nodes
const REPLAY_LIMIT = 500;     // page size for /api/events
const HEARTBEAT_TIMEOUT = 35000;
const SSE_TYPES = ["hello", "host", "session", "event", "command", "ack", "heartbeat"];
const STATUS_TYPES = new Set([
  "turn/start", "turn/end", "session/title", "todo/write", "model/selection",
]);
const PLACEHOLDERS = {
  message: "发送消息…",
  steer: "转向指令（引导当前回合）…",
  interrupt: "可留空，直接中断当前回合",
  command: "斜杠指令，例如 /compact",
};
const KIND_LABEL = { message: "消息", steer: "转向", interrupt: "中断", command: "指令" };
const CONN_LABEL = { offline: "离线", connecting: "连接中…", online: "已连接", replay: "同步中…" };

/* ------------------------------------------------------------------ *
 * State (single mutable store; all render functions are derived views)
 * ------------------------------------------------------------------ */
const state = {
  relayUrl: "",
  token: "",
  relayVersion: "",
  cursor: 0,            // last GLOBAL cursor we have ingested (SSE id / replay)
  helloCursor: 0,       // cursor advertised by the latest hello
  bootstrapCursor: 0,
  hosts: [],            // Host[]
  sessions: {},         // { hostId: Session[] }
  events: [],           // Evt[] cached (all hosts / all sessions)
  seen: new Set(),      // Evt.id dedupe set
  knownSessions: new Set(), // "hostId/sessionId"
  titles: {},           // "hostId/sessionId" -> title
  outbox: [],           // Command[] waiting to be delivered
  acks: [],             // Ack[] (most recent first) for display
  selectedHostId: "",
  selectedSessionId: "",
  kind: "message",
  connection: "offline",
  es: null,
  replaying: false,
  flushing: false,
  lastTraffic: 0,
  lastHeartbeat: 0,
  authFailed: false,   // 401/403 seen -> stop auto-reconnect until re-pair
};

/* ------------------------------------------------------------------ *
 * Small pure helpers
 * ------------------------------------------------------------------ */
const $ = (sel) => document.querySelector(sel);
const pad2 = (n) => String(n).padStart(2, "0");
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const oneLine = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const truncate = (s, n) => (String(s).length > n ? String(s).slice(0, n) + "…" : String(s));

function fmtClock(ms) {
  const d = new Date(num(ms, Date.now()));
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}
function safeParse(s) {
  if (s == null) return null;
  if (typeof s === "object") return s;
  try { return JSON.parse(s); } catch { return null; }
}
function jsonPreview(v) {
  let s;
  try { s = typeof v === "string" ? v : JSON.stringify(v, null, 2); }
  catch { s = String(v); }
  if (s == null) s = "";
  return s.length > 6000 ? s.slice(0, 6000) + "\n…（已截断）" : s;
}
function newId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return "cm-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}
function platformLabel(p) {
  const s = String(p || "").toLowerCase();
  if (s.includes("win")) return "Windows";
  if (s.includes("deck") || s.includes("linux") || s.includes("steamos")) return "SteamDeck";
  if (s.includes("darwin") || s.includes("mac")) return "macOS";
  return p ? String(p) : "";
}
function apiUrl(path) {
  return state.relayUrl.replace(/\/+$/, "") + path;
}
function evId(ev) {
  return String(ev.id || (ev.hostId + "/" + ev.sessionId + "/" + (ev.seq ?? ev.time ?? "x")));
}
function validEvt(ev) {
  return !!ev && typeof ev === "object" && typeof ev.type === "string";
}
function bySeq(a, b) {
  const d = num(a.seq, -1) - num(b.seq, -1);
  return d !== 0 ? d : num(a.time) - num(b.time);
}

/* DOM builder — never uses innerHTML (event text is untrusted data). */
function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = String(v);
      else if (k === "text") node.textContent = String(v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    node.appendChild(kid && kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

/* ------------------------------------------------------------------ *
 * localStorage (all writes are quota-safe)
 * ------------------------------------------------------------------ */
function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); return true; }
  catch { return false; }
}
function persistEvents() {
  let ok = lsSet("events", state.events);
  while (!ok && state.events.length > 50) {
    state.events = state.events.slice(Math.floor(state.events.length / 2));
    rebuildIndex();
    ok = lsSet("events", state.events);
  }
}
const persistOutbox = () => lsSet("outbox", state.outbox);
const persistHosts = () => lsSet("hosts", state.hosts);
const persistSessions = () => lsSet("sessions", state.sessions);
const persistCursor = () => lsSet("cursor", state.cursor);
const persistSelection = () => lsSet("selection", {
  hostId: state.selectedHostId, sessionId: state.selectedSessionId,
});
function persistConfig() {
  lsSet("relayUrl", state.relayUrl);
  lsSet("token", state.token);
  lsSet("relayVersion", state.relayVersion);
}

/* ------------------------------------------------------------------ *
 * Derived indexes
 * ------------------------------------------------------------------ */
function rebuildIndex() {
  state.seen = new Set();
  state.knownSessions = new Set();
  state.titles = {};
  for (const ev of state.events) {
    state.seen.add(evId(ev));
    const key = ev.hostId + "/" + ev.sessionId;
    state.knownSessions.add(key);
    if (ev.type === "session/title") {
      const t = ev.data && (ev.data.title ?? ev.data.text);
      if (typeof t === "string" && t) state.titles[key] = t;
    }
  }
}
function trimEvents() {
  if (state.events.length > MAX_EVENTS) {
    state.events = state.events.slice(state.events.length - MAX_EVENTS);
    rebuildIndex();
  }
}
function setCursor(n) {
  const v = num(n, 0);
  if (v > state.cursor) { state.cursor = v; persistCursor(); }
}
function findHost(hostId) {
  return state.hosts.find((x) => x.hostId === hostId) || null;
}
function sessionsFor(hostId) {
  if (!hostId) return [];
  const map = new Map();
  for (const s of (state.sessions[hostId] || [])) {
    if (!s || !s.sessionId) continue;
    const key = hostId + "/" + s.sessionId;
    map.set(s.sessionId, {
      sessionId: s.sessionId,
      title: state.titles[key] || s.title || s.sessionId,
      updatedAt: num(s.updatedAt),
      count: num(s.eventCount),
      cwd: s.cwd || "",
    });
  }
  for (const ev of state.events) {
    if (ev.hostId !== hostId) continue;
    const key = hostId + "/" + ev.sessionId;
    let row = map.get(ev.sessionId);
    if (!row) {
      row = {
        sessionId: ev.sessionId,
        title: state.titles[key] || ev.sessionId,
        updatedAt: 0, count: 0, cwd: ev.cwd || "",
      };
      map.set(ev.sessionId, row);
    }
    row.count += 1;
    row.updatedAt = Math.max(row.updatedAt, num(ev.time));
    if (state.titles[key]) row.title = state.titles[key];
    if (!row.cwd && ev.cwd) row.cwd = ev.cwd;
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
function visibleEvents() {
  if (!state.selectedHostId) return [];
  return state.events
    .filter((ev) => ev.hostId === state.selectedHostId &&
      (!state.selectedSessionId || ev.sessionId === state.selectedSessionId))
    .slice().sort(bySeq);
}

/* ------------------------------------------------------------------ *
 * Event content extraction (tolerant of the real DSH shapes)
 * ------------------------------------------------------------------ */
function contentParts(data) {
  if (typeof data === "string") return [{ type: "text", text: data }];
  if (!data || typeof data !== "object") return [];
  let c = data.message && data.message.content != null ? data.message.content : null;
  if (c == null) c = data.content;
  if (c == null) c = data.message;
  if (c == null) c = data.parts;
  if (typeof c === "string") return [{ type: "text", text: c }];
  if (Array.isArray(c)) return c.filter((p) => p && typeof p === "object");
  if (c && typeof c === "object") {
    if (typeof c.text === "string") return [{ type: "text", text: c.text }];
    if (Array.isArray(c.parts)) return c.parts.filter((p) => p && typeof p === "object");
  }
  return [];
}
function partText(p) {
  if (typeof p === "string") return p;
  if (!p || typeof p !== "object") return "";
  if (typeof p.text === "string") return p.text;
  if (typeof p.content === "string") return p.content;
  if (Array.isArray(p.content)) return p.content.map(partText).join("");
  return "";
}
function splitMessage(ev) {
  let text = "", reasoning = "";
  for (const p of contentParts(ev.data)) {
    const t = partText(p);
    if (!t) continue;
    const type = String((p && p.type) || "text");
    if (/reason|think|analysis/i.test(type)) {
      reasoning += (reasoning ? "\n" : "") + t;
    } else {
      text += (text ? "\n" : "") + t;
    }
  }
  if (!text && !reasoning && ev.data && typeof ev.data.text === "string") text = ev.data.text;
  return { text, reasoning };
}
function prettyArgs(raw) {
  if (raw == null || raw === "") return "(无)";
  let s = typeof raw === "string" ? raw : jsonPreview(raw);
  if (typeof raw === "string") {
    try { s = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* keep as-is */ }
  }
  return s || "(无)";
}

/* ------------------------------------------------------------------ *
 * Timeline renderers (pure-ish: Evt -> DOM element)
 * ------------------------------------------------------------------ */
function evHead(ev, role) {
  return h("div", { class: "ev-head" },
    h("span", { class: "ev-role", text: role }),
    h("span", { class: "ev-seq", text: "#" + (ev.seq ?? "?") }),
    h("span", { class: "ev-time", text: fmtClock(ev.time) }));
}
function messageCard(ev, isUser) {
  const { text, reasoning } = splitMessage(ev);
  const card = h("div", { class: "ev-card" },
    h("div", { class: "ev-text", text: text || (reasoning ? "" : "（无文本内容）") }));
  if (reasoning) {
    card.appendChild(h("details", { class: "ev-reasoning" },
      h("summary", { text: "🧠 推理过程" }),
      h("div", { class: "reasoning-body", text: reasoning })));
  }
  return h("div", { class: "ev " + (isUser ? "ev-user" : "ev-assistant") },
    evHead(ev, isUser ? "你" : "助手"), card);
}
function toolCard(ev) {
  const isCall = ev.type === "tool/call";
  const d = ev.data || {};
  const isError = !!d.isError;
  const name = String(d.name || d.toolName || d.tool || (isCall ? "tool/call" : "tool/result"));
  let detail;
  if (isCall) {
    detail = prettyArgs(d.arguments ?? d.args ?? d.input);
  } else {
    detail = splitMessage(ev).text || jsonPreview(d.message || d.output || d);
  }
  const preview = truncate(oneLine(detail), 100);
  const body = h("div", { class: "tool-body" });
  if (isCall) {
    body.appendChild(h("div", { class: "tool-label", text: "参数" }));
    body.appendChild(h("pre", { class: "tool-pre", text: detail }));
    if (d.callId) {
      body.appendChild(h("div", { class: "tool-label", text: "callId" }));
      body.appendChild(h("pre", { class: "tool-pre", text: String(d.callId) }));
    }
  } else {
    if (d.toolCallId) {
      body.appendChild(h("div", { class: "tool-label", text: "toolCallId" }));
      body.appendChild(h("pre", { class: "tool-pre", text: String(d.toolCallId) }));
    }
    body.appendChild(h("div", { class: "tool-label", text: "输出" + (isError ? " · 错误" : "") }));
    body.appendChild(h("pre", { class: "tool-pre" + (isError ? " tool-err" : ""), text: detail }));
  }
  return h("div", { class: "ev ev-tool" },
    evHead(ev, isCall ? "工具调用" : "工具结果"),
    h("div", { class: "ev-card" },
      h("details", {},
        h("summary", {},
          h("span", { class: "tool-badge", text: (isCall ? "⚙ " : "↳ ") + name }),
          h("span", { class: "tool-summary" + (isError ? " tool-err" : ""), text: preview || "（空）" })),
        body)));
}
function todoSummary(d) {
  const list = Array.isArray(d && d.todos) ? d.todos : (Array.isArray(d) ? d : null);
  if (!list) return truncate(oneLine(jsonPreview(d)), 90);
  const done = list.filter((t) => t && (t.status === "completed" || t.done)).length;
  const first = list.slice(0, 2).map((t) => (t && (t.content ?? t.text ?? t.title)) || "").filter(Boolean);
  return done + "/" + list.length + " 完成" + (first.length ? " · " + truncate(oneLine(first.join(" / ")), 60) : "");
}
function statusInfo(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case "turn/start":
      return { icon: "▶", title: "轮次开始", detail: "Turn " + (d.turn ?? "?"), cls: "status-turn-start" };
    case "turn/end": {
      const reason = d.reason && (d.reason.kind || d.reason.type);
      return { icon: "✓", title: "轮次结束", detail: "Turn " + (d.turn ?? "?") + (reason ? " · " + reason : ""), cls: "status-turn-end" };
    }
    case "session/title":
      return { icon: "✎", title: "会话标题", detail: String(d.title ?? d.text ?? ""), cls: "status-title" };
    case "todo/write":
      return { icon: "☑", title: "任务清单", detail: todoSummary(d), cls: "status-todo" };
    case "model/selection":
      return { icon: "◆", title: "模型选择", detail: truncate(oneLine(String(d.model ?? d.modelId ?? d.name ?? jsonPreview(d))), 90), cls: "status-model" };
    default:
      return { icon: "•", title: ev.type, detail: "", cls: "" };
  }
}
function statusCard(ev) {
  const info = statusInfo(ev);
  return h("div", { class: "ev ev-status" },
    h("div", { class: "status-bar " + info.cls },
      h("span", { class: "st-icon", text: info.icon }),
      h("span", { class: "st-title", text: info.title }),
      info.detail ? h("span", { text: truncate(info.detail, 120) }) : null,
      h("span", { class: "st-time", text: fmtClock(ev.time) })));
}
function minorCard(ev) {
  return h("div", { class: "ev ev-minor" },
    h("div", { class: "ev-card" },
      h("details", {},
        h("summary", { text: (ev.type || "event") + " · #" + (ev.seq ?? "?") + " · " + fmtClock(ev.time) }),
        h("pre", { text: jsonPreview(ev.data) }))));
}
function renderEvent(ev) {
  const t = ev.type || "event";
  if (t === "user/message" || t === "assistant/message") return messageCard(ev, t === "user/message");
  if (t === "tool/call" || t === "tool/result") return toolCard(ev);
  if (STATUS_TYPES.has(t)) return statusCard(ev);
  return minorCard(ev);
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */
function renderTimeline() {
  const box = $("#timeline");
  const prevTop = box.scrollTop;
  const prevHeight = box.scrollHeight;
  const stick = prevHeight - prevTop - box.clientHeight < 100;
  const frag = document.createDocumentFragment();
  const evs = visibleEvents();
  if (!evs.length) {
    frag.appendChild(h("div", { class: "empty-state" },
      h("p", { text: "暂无事件" }),
      h("p", { class: "muted tiny", text: "选择主机与会话，或等待桌面端推送。" })));
  } else {
    for (const ev of evs) frag.appendChild(renderEvent(ev));
  }
  box.replaceChildren(frag);
  box.scrollTop = stick ? box.scrollHeight : Math.min(prevTop, box.scrollHeight);
}
function appendIfVisible(ev) {
  if (ev.hostId !== state.selectedHostId) return;
  if (state.selectedSessionId && ev.sessionId !== state.selectedSessionId) return;
  const box = $("#timeline");
  const empty = box.querySelector(".empty-state");
  if (empty) empty.remove();
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
  box.appendChild(renderEvent(ev));
  while (box.children.length > MAX_DOM_EVENTS) box.removeChild(box.firstChild);
  if (stick) box.scrollTop = box.scrollHeight;
}
function renderHosts() {
  const sel = $("#host-select");
  const hosts = state.hosts.slice().sort((a, b) =>
    String(a.hostName || a.hostId || "").localeCompare(String(b.hostName || b.hostId || "")));
  const ids = new Set(hosts.map((x) => x.hostId));
  for (const key of state.knownSessions) {
    const hid = key.slice(0, key.indexOf("/"));
    if (hid && !ids.has(hid)) {
      hosts.push({ hostId: hid, hostName: hid, platform: "", online: false, lastSeen: 0 });
      ids.add(hid);
    }
  }
  sel.replaceChildren(...hosts.map((ho) => {
    const plat = platformLabel(ho.platform);
    const label = (ho.hostName || ho.hostId) + (plat ? " · " + plat : "") + (ho.online ? "" : " · 离线");
    return h("option", { value: ho.hostId, text: label });
  }));
  if (!hosts.some((x) => x.hostId === state.selectedHostId)) {
    state.selectedHostId = hosts.length ? hosts[0].hostId : "";
  }
  sel.value = state.selectedHostId;
}
function renderSessions() {
  const sel = $("#session-select");
  const list = sessionsFor(state.selectedHostId);
  sel.replaceChildren(...list.map((s) =>
    h("option", { value: s.sessionId, text: truncate(s.title || s.sessionId, 70) + " · " + s.count })));
  if (!list.some((s) => s.sessionId === state.selectedSessionId)) {
    state.selectedSessionId = list.length ? list[0].sessionId : "";
  }
  sel.value = state.selectedSessionId;
}
function chip(text) {
  return h("span", { class: "chip", text: String(text), title: String(text) });
}
function renderStatusStrip() {
  const chips = [];
  if (state.relayVersion) chips.push(chip("relay v" + state.relayVersion));
  chips.push(chip("cursor #" + state.cursor));
  const host = findHost(state.selectedHostId);
  if (host) chips.push(chip((host.hostName || host.hostId) + " " + (host.online ? "在线" : "离线")));
  const sess = sessionsFor(state.selectedHostId).find((s) => s.sessionId === state.selectedSessionId);
  if (sess) chips.push(chip("会话 " + truncate(sess.title || "", 24) + " · " + sess.count + " 事件"));
  if (state.lastHeartbeat) chips.push(chip("心跳 " + fmtClock(state.lastHeartbeat)));
  chips.push(chip(state.events.length + " 条已缓存"));
  $("#status-strip").replaceChildren(...chips);
}
function renderOutbox() {
  const banner = $("#outbox-banner");
  const n = state.outbox.length;
  banner.hidden = n === 0;
  if (!n) { banner.replaceChildren(); return; }
  banner.replaceChildren(
    h("span", { text: "⚠ " + n + " 条待发送（离线队列）" }),
    h("button", { type: "button", text: "立即重发", onclick: flushOutbox }));
}
function ackIcon(status) {
  return status === "ok" ? "✓" : status === "error" ? "✕" :
    status === "unsupported" ? "⚠" : status === "pending" ? "…" : "•";
}
function renderAcks() {
  $("#ack-strip").replaceChildren(...state.acks.slice(0, 5).map((a) => {
    const parts = [a.detail, a.deliveredVia, a.clientMessageId && a.clientMessageId.slice(0, 8)]
      .filter(Boolean).map(String);
    return h("div", { class: "ack-item ack-" + (a.status || "pending") },
      h("span", { class: "ack-icon", text: ackIcon(a.status) }),
      h("span", { class: "ack-text", text: parts.join(" · ") || (a.status || "") }),
      h("span", { class: "ack-time", text: fmtClock(a.time) }));
  }));
}
function pushAck(a) {
  state.acks.unshift(a);
  if (state.acks.length > 30) state.acks.length = 30;
  renderAcks();
}
function renderAll() {
  renderHosts();
  renderSessions();
  renderTimeline();
  renderStatusStrip();
  renderOutbox();
  renderAcks();
  updateKindUI();
}
function setConnection(kind, label) {
  state.connection = kind;
  const el = $("#conn");
  el.className = "conn conn-" + kind;
  $("#conn-label").textContent = label || CONN_LABEL[kind] || kind;
}
function touch() { state.lastTraffic = Date.now(); }

/* ------------------------------------------------------------------ *
 * HTTP API
 * ------------------------------------------------------------------ */
async function api(path, opts = {}, baseOverride) {
  const root = baseOverride || state.relayUrl;
  const url = root.replace(/\/+$/, "") + path;
  const headers = Object.assign({}, opts.headers || {});
  if (opts.auth !== false) headers["Authorization"] = "Bearer " + state.token;
  let body;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, {
    method: opts.method || "GET", headers, body, cache: "no-store",
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON response */ }
  if (!res.ok) {
    const err = new Error((data && (data.error || data.detail)) || "HTTP " + res.status);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  touch();
  return data || {};
}

/* ------------------------------------------------------------------ *
 * Ingestion (the ONLY place that mutates the event cache)
 * ------------------------------------------------------------------ */
function bumpCursorFromEvent(id) {
  const n = num(id, 0);
  if (n > 0) setCursor(n);
}
function ingestOne(ev, append) {
  if (!validEvt(ev)) return false;
  const id = evId(ev);
  if (ev.cursor != null) bumpCursorFromEvent(ev.cursor);
  if (state.seen.has(id)) return false;
  state.seen.add(id);
  state.events.push(ev);
  const key = String(ev.hostId) + "/" + String(ev.sessionId);
  state.knownSessions.add(key);
  if (ev.type === "session/title") {
    const t = ev.data && (ev.data.title ?? ev.data.text);
    if (typeof t === "string" && t) state.titles[key] = t;
  }
  trimEvents();
  if (append) appendIfVisible(ev);
  return true;
}
function ingestMany(evts) {
  if (!Array.isArray(evts) || !evts.length) return 0;
  let added = 0;
  for (const ev of evts.slice().sort((a, b) => num(a && a.cursor) - num(b && b.cursor))) {
    if (ingestOne(ev, false)) added += 1;
  }
  if (added) { persistEvents(); scheduleRender(); }
  return added;
}

/* rAF-coalesced render: many SSE frames -> one DOM rebuild. */
let renderPending = false;
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  const run = () => {
    renderPending = false;
    renderHosts();
    renderSessions();
    renderTimeline();
    renderStatusStrip();
    renderOutbox();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 16);
}

/* ------------------------------------------------------------------ *
 * Host / Session upserts (from bootstrap or SSE)
 * ------------------------------------------------------------------ */
function upsertHost(ho) {
  if (!ho || !ho.hostId) return;
  const i = state.hosts.findIndex((x) => x && x.hostId === ho.hostId);
  if (i < 0) state.hosts.push(ho);
  else state.hosts[i] = Object.assign({}, state.hosts[i], ho);
  persistHosts();
  scheduleRender();
}
function upsertSession(s) {
  if (!s || !s.sessionId || !s.hostId) return;
  if (!state.sessions[s.hostId]) state.sessions[s.hostId] = [];
  const arr = state.sessions[s.hostId];
  const i = arr.findIndex((x) => x && x.sessionId === s.sessionId);
  if (i < 0) arr.push(s);
  else arr[i] = Object.assign({}, arr[i], s);
  persistSessions();
  scheduleRender();
}

/* ------------------------------------------------------------------ *
 * Bootstrap + replay
 * ------------------------------------------------------------------ */
async function bootstrap() {
  try {
    const r = await api("/api/bootstrap");
    if (Array.isArray(r.hosts)) { state.hosts = r.hosts; persistHosts(); }
    if (r.sessions && typeof r.sessions === "object") { state.sessions = r.sessions; persistSessions(); }
    state.bootstrapCursor = num(r.cursor);
    if (r.relayVersion) state.relayVersion = String(r.relayVersion);
    // The relay ships a recent-events tail. Seed the offline cache with it,
    // but DO NOT let those events advance our cursor: they are a tail, not a
    // contiguous replay. replay() must still page through /api/events from
    // our persisted cursor, otherwise a long offline gap would be skipped.
    const savedCursor = state.cursor;
    if (Array.isArray(r.events)) ingestMany(r.events);
    state.cursor = savedCursor;
    persistCursor();
    scheduleRender();
    return true;
  } catch (err) {
    if (err.status === 401 || err.status === 403) showAuthError("令牌无效 (" + err.status + ")");
    else pushAck({ status: "error", detail: "获取主机列表失败：" + err.message, time: Date.now() });
    return false;
  }
}

/* Incremental catch-up. Pages until the relay watermark is reached so a
   truncated /api/events page can never make us skip history. */
async function replay() {
  if (state.replaying || state.authFailed || !state.token || !state.relayUrl) return;
  state.replaying = true;
  const prev = state.connection;
  setConnection("replay");
  try {
    let since = state.cursor;
    for (let page = 0; page < 40; page += 1) {
      const r = await api("/api/events?since=" + encodeURIComponent(since) + "&limit=" + REPLAY_LIMIT);
      const evs = Array.isArray(r.events) ? r.events : [];
      ingestMany(evs);
      const watermark = num(r.cursor, since);
      if (evs.length < REPLAY_LIMIT || state.cursor >= watermark) break;
      const next = Math.max(since + 1, state.cursor);
      if (next <= since) break;
      since = next;
    }
  } catch (err) {
    if (err.status === 401 || err.status === 403) showAuthError("令牌无效 (" + err.status + ")");
    // Network failures are expected while offline; the outbox + next
    // reconnect will retry. Cached events stay readable.
  } finally {
    state.replaying = false;
    if (state.connection === "replay") setConnection(prev === "offline" ? "offline" : "online");
  }
}

/* ------------------------------------------------------------------ *
 * SSE stream
 * ------------------------------------------------------------------ */
function closeStream() {
  if (state.es) {
    try { state.es.close(); } catch { /* already closed */ }
    state.es = null;
  }
}
function openStream() {
  if (!state.token || !state.relayUrl || state.authFailed) return;
  closeStream();
  const q = new URLSearchParams({ role: "phone", token: state.token });
  const url = apiUrl("/api/stream") + "?" + q.toString();
  setConnection("connecting");
  let es;
  try {
    es = new EventSource(url);
  } catch (err) {
    setConnection("offline", "无法建立事件流");
    return;
  }
  state.es = es;

  es.onopen = () => {
    if (state.es !== es) return;
    touch();
    setConnection("online");
    replay();        // SPEC 3: replay missed events after (re)connect
    flushOutbox();   // SPEC 6: resend anything queued while offline
  };
  es.onerror = () => {
    if (state.es !== es) return;
    setConnection("offline", "连接断开 · 自动重连");
    if (typeof EventSource !== "undefined" && es.readyState === EventSource.CLOSED) {
      closeStream();
      setTimeout(() => { if (!state.es) openStream(); }, 2000);
    }
  };
  es.onmessage = (e) => handleSse("", e); // unnamed SSE frames
  for (const type of SSE_TYPES) {
    es.addEventListener(type, (e) => handleSse(type, e));
  }
}

/* Handle every documented SSE event name:
   hello | host | session | event | command | ack | heartbeat (+ message) */
function handleSse(type, e) {
  touch();
  bumpCursorFromEvent(e.lastEventId);   // only event frames carry an id
  const data = safeParse(e.data);
  switch (type) {
    case "hello":
      if (data) {
        if (data.relayVersion) state.relayVersion = String(data.relayVersion);
        state.helloCursor = num(data.cursor);
      }
      renderStatusStrip();
      break;
    case "host":
      upsertHost(data);
      break;
    case "session":
      upsertSession(data);
      break;
    case "event":
      if (ingestOne(data, true)) {
        persistEvents();
        scheduleRender();
      }
      break;
    case "command":
      // Commands are broadcast to host clients only. A phone that happens
      // to receive one just reflects it in the ack strip for transparency.
      if (data && data.clientMessageId) {
        pushAck({
          clientMessageId: data.clientMessageId, targetHostId: data.targetHostId,
          status: "pending", detail: "指令已下发至主机", time: num(data.time, Date.now()),
        });
      }
      break;
    case "ack":
      onAck(data);
      break;
    case "heartbeat":
      state.lastHeartbeat = num(data && data.time, Date.now());
      renderStatusStrip();
      break;
    case "":
    case "message":
      if (validEvt(data) && ingestOne(data, true)) {
        persistEvents();
        scheduleRender();
      }
      break;
    default:
      if (validEvt(data) && ingestOne(data, true)) {
        persistEvents();
        scheduleRender();
      }
  }
}

/* Heartbeat watchdog: EventSource reconnects on its own, but a silently
   dead TCP connection needs an explicit nudge. */
let watchdog = null;
function startWatchdog() {
  if (watchdog) clearInterval(watchdog);
  watchdog = setInterval(() => {
    if (!state.token) return;
    if (state.connection === "online" && Date.now() - state.lastTraffic > HEARTBEAT_TIMEOUT) {
      setConnection("connecting", "心跳超时 · 重连中…");
      closeStream();
      openStream();
    }
    if (state.outbox.length && navigator.onLine && state.connection === "online") flushOutbox();
  }, 10000);
}

/* ------------------------------------------------------------------ *
 * Ack handling + offline outbox (SPEC 5 + 6)
 * ------------------------------------------------------------------ */
function onAck(ack) {
  if (!ack || !ack.clientMessageId) return;
  const id = ack.clientMessageId;
  const before = state.outbox.length;
  state.outbox = state.outbox.filter((c) => c.clientMessageId !== id);
  if (state.outbox.length !== before) { persistOutbox(); renderOutbox(); }
  pushAck(Object.assign({ time: Date.now() }, ack));
}

async function flushOutbox() {
  if (state.flushing || state.authFailed || !state.outbox.length) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    renderOutbox();
    return;
  }
  state.flushing = true;
  const queue = state.outbox.slice();
  try {
    for (const cmd of queue) {
      try {
        const r = await api("/api/command", { method: "POST", body: cmd });
        state.outbox = state.outbox.filter((c) => c.clientMessageId !== cmd.clientMessageId);
        persistOutbox();
        if (r && r.cursor != null) setCursor(r.cursor);
        pushAck({
          clientMessageId: cmd.clientMessageId, targetHostId: cmd.targetHostId,
          status: "pending",
          detail: (KIND_LABEL[cmd.kind] || cmd.kind) + "已入队，等待主机回执",
          deliveredVia: "relay", time: Date.now(),
        });
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          showAuthError("令牌无效 (" + err.status + ")");
          break;                     // keep queued; user can re-pair
        }
        if (!err.status) break;      // offline / network: keep queued, retry later
        // A definite 4xx (bad request etc.) will never succeed on retry.
        state.outbox = state.outbox.filter((c) => c.clientMessageId !== cmd.clientMessageId);
        persistOutbox();
        pushAck({
          clientMessageId: cmd.clientMessageId, targetHostId: cmd.targetHostId,
          status: "error", detail: "发送失败：" + err.message, time: Date.now(),
        });
      }
    }
  } finally {
    state.flushing = false;
    renderOutbox();
    renderStatusStrip();
  }
}

/* ------------------------------------------------------------------ *
 * Composer
 * ------------------------------------------------------------------ */
function updateKindUI() {
  for (const btn of document.querySelectorAll(".kind")) {
    btn.classList.toggle("active", btn.dataset.kind === state.kind);
  }
  const input = $("#composer-input");
  input.placeholder = PLACEHOLDERS[state.kind] || PLACEHOLDERS.message;
  input.setAttribute("aria-label", KIND_LABEL[state.kind] + "内容");
  const send = $("#send-btn");
  send.title = "发送" + KIND_LABEL[state.kind];
  send.setAttribute("aria-label", send.title);
  renderOutbox();
}
function autoResize() {
  const el = $("#composer-input");
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 140) + "px";
}
function submitCommand(ev) {
  ev.preventDefault();
  const input = $("#composer-input");
  const text = input.value.trim();
  if (state.kind !== "interrupt" && !text) {
    input.focus();
    return;
  }
  if (!state.selectedHostId) {
    pushAck({ status: "error", detail: "请先选择一个在线主机", time: Date.now() });
    return;
  }
  const cmd = {
    clientMessageId: newId(),
    targetHostId: state.selectedHostId,
    sessionId: state.selectedSessionId || "",
    kind: state.kind,
    text,
    time: Date.now(),
  };
  // Unified path: ALWAYS enqueue first, then try to flush. If we are offline
  // (or the POST fails) the command simply stays in the localStorage outbox.
  state.outbox.push(cmd);
  persistOutbox();
  input.value = "";
  autoResize();
  renderOutbox();
  pushAck({
    clientMessageId: cmd.clientMessageId, targetHostId: cmd.targetHostId,
    status: "pending", detail: (KIND_LABEL[state.kind] || state.kind) + "排队中…",
    time: Date.now(),
  });
  flushOutbox();
}

/* ------------------------------------------------------------------ *
 * Screens + pairing (SPEC 1)
 * ------------------------------------------------------------------ */
function showPairing() {
  closeStream();
  setConnection("offline", "未连接");
  $("#app").hidden = true;
  $("#pairing").hidden = false;
  const urlEl = $("#relay-url");
  if (!urlEl.value) urlEl.value = state.relayUrl || location.origin;
  const errEl = $("#pair-error");
  errEl.hidden = true;
  errEl.textContent = "";
  $("#pair-code").value = "";
}
async function showApp() {
  $("#pairing").hidden = true;
  $("#app").hidden = false;
  setConnection("connecting");
  renderAll();
  startWatchdog();
  const ok = await bootstrap();
  if (!ok && state.authFailed) return;
  openStream();
  flushOutbox();
}
function showAuthError(msg) {
  state.authFailed = true;
  closeStream();
  setConnection("offline", "令牌失效 · 请重新配对");
  pushAck({ status: "error", detail: msg + " · 点击右上角 ⚙ 重新配对", time: Date.now() });
}
function normalizeRelay(raw) {
  let s = String(raw || "").trim();
  if (!s) s = location.origin;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "http://" + s;
  const u = new URL(s);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("仅支持 http/https 地址");
  }
  const path = u.pathname.replace(/\/+$/, "");
  return u.origin + (path === "/" ? "" : path);
}
async function onPairSubmit(ev) {
  ev.preventDefault();
  const errEl = $("#pair-error");
  const btn = $("#pair-submit");
  const code = $("#pair-code").value.trim();
  errEl.hidden = true;
  if (!/^\d{6}$/.test(code)) {
    errEl.textContent = "请输入 6 位数字配对码";
    errEl.hidden = false;
    return;
  }
  let base;
  try { base = normalizeRelay($("#relay-url").value); }
  catch (err) {
    errEl.textContent = "Relay 地址无效：" + err.message;
    errEl.hidden = false;
    return;
  }
  btn.disabled = true;
  btn.textContent = "配对中…";
  try {
    // /api/pair is unauthenticated and may live on a different host than the
    // current page, hence baseOverride + auth:false.
    const r = await api("/api/pair", { method: "POST", auth: false, body: { code } }, base);
    if (!r || !r.token) throw new Error("响应缺少 token");
    state.relayUrl = base;
    state.token = String(r.token);
    state.authFailed = false;
    if (r.relayVersion) state.relayVersion = String(r.relayVersion);
    persistConfig();
    $("#relay-url").value = base;
    $("#pair-code").value = "";
    await showApp();
  } catch (err) {
    errEl.textContent = err.status === 401
      ? "配对码错误，请重新输入"
      : "配对失败：" + err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "配对连接";
  }
}
function onRepair() {
  // Keep the old token until a successful re-pair so cached events remain
  // readable; the pairing screen is purely additive.
  showPairing();
}

/* ------------------------------------------------------------------ *
 * Service worker (SPEC 7) — best effort; PWA works without it too.
 * ------------------------------------------------------------------ */
function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    // document.baseURI is the hosting directory for both "/" and "/app/*".
    const swUrl = new URL("sw.js", document.baseURI).href;
    navigator.serviceWorker.register(swUrl).catch(() => {});
  } catch { /* insecure context / unsupported */ }
}

/* ------------------------------------------------------------------ *
 * UI wiring
 * ------------------------------------------------------------------ */
function bindUI() {
  $("#pair-form").addEventListener("submit", onPairSubmit);
  $("#pair-code").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
  });
  $("#btn-repair").addEventListener("click", onRepair);

  $("#host-select").addEventListener("change", (e) => {
    state.selectedHostId = e.target.value;
    state.selectedSessionId = "";
    persistSelection();
    renderSessions();
    renderTimeline();
    renderStatusStrip();
  });
  $("#session-select").addEventListener("change", (e) => {
    state.selectedSessionId = e.target.value;
    persistSelection();
    renderTimeline();
    renderStatusStrip();
  });

  for (const btn of document.querySelectorAll(".kind")) {
    btn.addEventListener("click", () => {
      state.kind = btn.dataset.kind || "message";
      updateKindUI();
      $("#composer-input").focus();
    });
  }
  $("#send-form").addEventListener("submit", submitCommand);
  $("#composer-input").addEventListener("input", autoResize);
  $("#composer-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("#send-form").requestSubmit();
    }
  });

  window.addEventListener("online", () => {
    setConnection("connecting", "网络恢复 · 正在同步");
    if (!state.es) openStream();
    else replay();
    flushOutbox();
  });
  window.addEventListener("offline", () => {
    setConnection("offline", "离线 · 可查看缓存");
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.token) { replay(); flushOutbox(); }
  });
}

/* ------------------------------------------------------------------ *
 * Restore persisted state + boot
 * ------------------------------------------------------------------ */
function loadState() {
  state.token = String(lsGet("token", "") || "");
  state.relayUrl = String(lsGet("relayUrl", "") || "") || location.origin;
  state.relayVersion = String(lsGet("relayVersion", "") || "");
  state.cursor = num(lsGet("cursor", 0));
  const hosts = lsGet("hosts", []);
  state.hosts = Array.isArray(hosts) ? hosts.filter((x) => x && x.hostId) : [];
  const sessions = lsGet("sessions", {});
  state.sessions = sessions && typeof sessions === "object" && !Array.isArray(sessions) ? sessions : {};
  const events = lsGet("events", []);
  state.events = Array.isArray(events) ? events.filter(validEvt) : [];
  const outbox = lsGet("outbox", []);
  state.outbox = Array.isArray(outbox) ? outbox.filter((c) => c && c.clientMessageId) : [];
  const sel = lsGet("selection", {});
  state.selectedHostId = String((sel && sel.hostId) || "");
  state.selectedSessionId = String((sel && sel.sessionId) || "");
  rebuildIndex();
  trimEvents();
}
/* ------------------------------------------------------------------ *
 * Scan-to-pair (QR): ?pair=123456[&relay=https://host]
 * Desktop /qr.html encodes an /?pair= link; the phone opens it and this
 * completes POST /api/pair without any manual URL / code entry.
 * ------------------------------------------------------------------ */
function cleanPairUrl(url) {
  url.searchParams.delete("pair");
  url.searchParams.delete("relay");
  // Strip the trailing "?" / "&" artifacts so the address bar looks clean.
  const qs = url.searchParams.toString();
  return url.pathname + (qs ? "?" + qs : "") + url.hash;
}
async function tryAutoPair() {
  const params = new URL(location.href).searchParams;
  const code = (params.get("pair") || "").trim();
  if (!/^\d{6}$/.test(code)) return false;

  const errEl = $("#pair-error");
  const rawRelay = (params.get("relay") || "").trim();
  let base;
  try {
    base = rawRelay ? normalizeRelay(rawRelay) : location.origin;
  } catch (err) {
    base = location.origin;
  }

  try {
    // /api/pair is unauthenticated; the QR link may point at a different
    // host than the page serving the PWA, hence baseOverride.
    const r = await api("/api/pair", { method: "POST", auth: false, body: { code } }, base);
    if (!r || !r.token) throw new Error("响应缺少 token");
    state.relayUrl = base;
    state.token = String(r.token);
    state.relayVersion = r.relayVersion ? String(r.relayVersion) : "";
    state.authFailed = false;
    persistConfig();
    $("#relay-url").value = base;
    $("#pair-code").value = "";
    // Remove the one-time code from history/address bar so a reload or share
    // does not replay an already-consumed pair code.
    try { history.replaceState(null, "", cleanPairUrl(new URL(location.href))); } catch { /* ignore */ }
    await showApp();
    return true;
  } catch (err) {
    // Never dead-end: fall through to the manual pairing screen with a hint.
    const msg = err.status === 401
      ? "二维码配对码已失效，请输入新的 6 位配对码"
      : "自动配对失败：" + (err.message || "网络错误") + "，请手动输入";
    showPairing();
    errEl.textContent = msg;
    errEl.hidden = false;
    return false;
  }
}
async function init() {
  loadState();
  bindUI();
  registerSW();
  $("#relay-url").value = state.relayUrl;
  updateKindUI();
  autoResize();
  // A ?pair= link is a one-shot auto-pair attempt. On failure tryAutoPair()
  // already shows the pairing screen with the error; never override it here
  // with showApp() just because an older token happens to be cached.
  const hadPair = /^\d{6}$/.test((new URL(location.href).searchParams.get("pair") || "").trim());
  if (await tryAutoPair()) return;   // success: showApp() done, URL cleaned
  if (hadPair) return;               // failure: manual pairing stays available
  if (state.token) showApp();        // no ?pair: original behaviour
  else showPairing();
}
init();
