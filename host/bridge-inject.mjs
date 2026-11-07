// Best-effort injection of a phone command into the LOCAL running DSH agent.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';

export function discoverBridge(dshHome, anywhereHome) {
  const candidates = [
    path.join(dshHome, 'agents-anywhere', 'bridge', 'endpoint.json'),
    path.join(dshHome, 'agents-anywhere', 'endpoint.json'),
    path.join(os.homedir(), '.agents-anywhere', 'bridge', 'endpoint.json'),
  ];
  for (const p of candidates) {
    try {
      const o = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (o && o.host && o.port) return { version: o.version || 1, host: o.host, port: Number(o.port), token: o.token || '', file: p };
    } catch (e) {}
  }
  const v2 = [
    path.join(dshHome, 'agents-anywhere', 'bridge', 'rendezvous.json'),
    path.join(dshHome, 'agents-anywhere', 'rendezvous.json'),
  ];
  for (const p of v2) if (fs.existsSync(p)) return { version: 2, file: p };
  try { if (fs.existsSync(path.join(dshHome, 'agents-anywhere'))) return { version: 2, note: 'agents-anywhere present (meshcall)' }; } catch (e) {}
  return null;
}

function rpc(sock, method, params) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n';
    let buf = '';
    const timer = setTimeout(() => { cleanup(); reject(new Error('rpc timeout')); }, 4000);
    const onData = (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
        if (msg.id === id) { cleanup(); resolve(msg); }
      }
    };
    const cleanup = () => { clearTimeout(timer); sock.removeListener('data', onData); sock.removeListener('error', onErr); };
    const onErr = (e) => { cleanup(); reject(e); };
    sock.on('data', onData); sock.on('error', onErr);
    sock.write(payload);
  });
}

export async function inject(command, bridgeInfo, anywhereHome) {
  try {
    fs.mkdirSync(anywhereHome, { recursive: true });
    fs.appendFileSync(path.join(anywhereHome, 'command-inbox.jsonl'), JSON.stringify({ time: Date.now(), command }) + '\n');
  } catch (e) {}
  if (!bridgeInfo) return { status: 'unsupported', detail: 'No local DSH bridge discovered. Command saved to command-inbox.jsonl. Use the desktop GUI or enable the DSH IM channel.' };
  if (bridgeInfo.version !== 1 || !bridgeInfo.port) return { status: 'unsupported', detail: 'Detected DSH v2 (meshcall) bridge: direct message injection is not supported by this adapter. Command saved to command-inbox.jsonl.' };
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: bridgeInfo.host, port: bridgeInfo.port }, async () => {
      try {
        const init = await rpc(sock, 'initialize', {
          protocolVersion: '1.0', runtime: 'dsh', connectorId: 'dsh-anywhere',
          sessionNamespace: 'dsh-anywhere', authToken: bridgeInfo.token,
          clientInfo: { name: 'dsh-anywhere-host', version: '1.0' },
        });
        if (init && init.error) { try { sock.destroy(); } catch (e) {} return resolve({ status: 'error', detail: 'initialize failed: ' + JSON.stringify(init.error) }); }
        const method = command.kind === 'steer' ? 'session.steer' : command.kind === 'interrupt' ? 'session.interrupt' : command.kind === 'command' ? 'session.command.execute' : 'session.send_message';
        const params = { sessionId: command.sessionId, content: command.text, text: command.text, command: command.text };
        const r = await rpc(sock, method, params);
        try { sock.destroy(); } catch (e) {}
        if (r && r.error) return resolve({ status: 'error', detail: String(r.error.message || JSON.stringify(r.error)) });
        return resolve({ status: 'ok', detail: 'Delivered to local DSH v1 bridge via ' + method });
      } catch (e) { try { sock.destroy(); } catch (x) {} return resolve({ status: 'error', detail: e.message }); }
    });
    sock.on('error', (e) => resolve({ status: 'error', detail: 'bridge connect: ' + e.message }));
    sock.setTimeout(6000, () => { try { sock.destroy(); } catch (e) {} });
  });
}
