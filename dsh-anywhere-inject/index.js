// @local/dsh-anywhere-inject — DSH Anywhere 手机端命令注入桥
//
// 背景：DSH Anywhere 的 host 适配器 (app/host/cli.mjs) 每 ~12s 重跑
// discoverBridge(DSH_HOME, HOME)，其 v1 newline-JSON-RPC 客户端完整可用，
// 但当前磁盘上只有 v2 (meshcall) 桥 → 手机命令返回 unsupported。
//
// 本插件在 DSH Host 进程内热加载，做两件事：
//   1. 监听 127.0.0.1:8788，说 v1 wire protocol，把业务方法翻译成官方
//      sessionController.prompt({sessionId, requestId, mode, content}) 调用。
//   2. 监听成功后，把 v1 endpoint.json 写到适配器首个扫描路径
//      <dshHome>/agents-anywhere/bridge/endpoint.json。适配器 ~12s 内自动
//      发现并改用 version:1 → 命令真正注入 live agent。
//
// 全程零重启、零适配器源码改动、零 token/配对码变更、零 relay 中断。
// 仅使用 Node 内置模块。apply() 同步返回、绝不抛异常；listen 延迟到下一 tick。

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const name = '@local/dsh-anywhere-inject';

const WIRE_VERSION = 1;
const DEFAULT_HOST = '127.0.0.1';

// 适配器使用 defaultDshHome() = DSH_HOME || ~/.dsh。两个进程可能 env 不同，
// 因此同时覆盖「env 指定」与「固定 ~/.dsh」两套 home，去重后全部写入。
function candidateHomes() {
  const list = [];
  if (process.env.DSH_HOME) list.push(path.resolve(process.env.DSH_HOME));
  list.push(path.join(os.homedir(), '.dsh'));
  return [...new Set(list)];
}

function endpointTargets() {
  const out = [];
  for (const home of candidateHomes()) {
    // 与 host/bridge-inject.mjs discoverBridge 的 v1 候选前两项逐字一致
    out.push(path.join(home, 'agents-anywhere', 'bridge', 'endpoint.json'));
    out.push(path.join(home, 'agents-anywhere', 'endpoint.json'));
  }
  return [...new Set(out)];
}

/**
 * @param {import('cordis').Context} ctx
 * @param {Record<string, any>} config - row.config from the patch
 */
export function apply(ctx, config) {
  const cfg = config || {};
  const host = cfg.host || DEFAULT_HOST;
  const ports = [
    Number(cfg.port) || 8788,
    ...(Array.isArray(cfg.fallbackPorts)
      ? cfg.fallbackPorts.map((p) => Number(p)).filter((n) => Number.isFinite(n))
      : [8791, 8792, 8793]),
  ];
  const home = path.join(os.homedir(), '.dsh');
  const logFile = path.join(home, 'dsh-anywhere-inject.log');
  const targets = endpointTargets();

  const log = (msg) => {
    const line = `[${new Date().toISOString()}] [dsh-anywhere-inject] ${msg}`;
    try {
      fs.mkdirSync(home, { recursive: true });
      fs.appendFileSync(logFile, line + '\n');
    } catch { /* 日志失败绝不影响主线 */ }
    try {
      if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info(line);
    } catch { /* ignore */ }
  };

  // ctx.get 是官方读取已注册服务的 sanctioned 方式；服务未就绪返回 null。
  const pick = (n) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(n) : (ctx[n] ?? null);
    } catch {
      return null;
    }
  };

  ctx.effect(() => {
    let stopped = false;
    let server = null;
    let activePort = null;
    const sockets = new Set();

    const writeEndpoints = (port) => {
      const body = JSON.stringify(
        { version: WIRE_VERSION, host, port, token: '' },
        null,
        2,
      );
      for (const file of targets) {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, body);
          log(`endpoint 已写入 ${file} (port=${port})`);
        } catch (e) {
          log(`写 endpoint 失败 ${file}: ${e && e.message ? e.message : e}`);
        }
      }
    };

    const removeEndpoints = (port) => {
      for (const file of targets) {
        try {
          const o = JSON.parse(fs.readFileSync(file, 'utf8'));
          // 只删自己写的那份，避免与另一个实例/另一个端口互相踩踏
          if (o && Number(o.port) === port && o.host === host) {
            fs.unlinkSync(file);
            log(`endpoint 已移除 ${file}`);
          }
        } catch { /* 文件不存在或已被删，忽略 */ }
      }
    };

    // 成功响应绝不能带 error 键；原样回显请求 id；4s 内回复。
    const send = (sock, id, result, error) => {
      const msg = error
        ? {
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: String((error && error.message) || error) },
          }
        : { jsonrpc: '2.0', id, result: result === undefined ? { ok: true } : result };
      try {
        sock.write(JSON.stringify(msg) + '\n');
      } catch { /* socket 已关闭 */ }
    };

    const BUSINESS = {
      'session.send_message': 'queue',
      'session.steer': 'steer',
      'session.interrupt': 'steer',
      'session.command.execute': 'queue',
    };

    const handle = async (sock, req) => {
      const id = req && req.id !== undefined ? req.id : null;
      const method = req && req.method;
      const params = (req && req.params) || {};
      try {
        if (method === 'initialize') {
          return send(sock, id, {
            protocolVersion: '1.0',
            runtime: 'dsh',
            connectorId: 'dsh-anywhere',
            sessionNamespace: 'dsh-anywhere',
            serverInfo: { name: 'dsh-anywhere-inject', version: '1.0.0' },
          });
        }
        if (method === 'bridge.ping') {
          return send(sock, id, {
            ok: true,
            hasController: !!pick('sessionController'),
            wire: 'v1',
            port: activePort,
            time: Date.now(),
          });
        }
        if (!Object.prototype.hasOwnProperty.call(BUSINESS, String(method))) {
          return send(sock, id, null, new Error('unknown method: ' + method));
        }

        // 服务可能晚于插件就绪 → 每请求 lazy pick，不在 apply 时缓存
        const controller = pick('sessionController');
        if (!controller || typeof controller.prompt !== 'function') {
          return send(sock, id, null, new Error('sessionController unavailable'));
        }
        const sessionId = String(params.sessionId || '');
        if (!sessionId) return send(sock, id, null, new Error('sessionId required'));

        let text = params.text ?? params.content ?? params.command ?? '';
        if (typeof text !== 'string') text = String(text ?? '');
        if (!text.trim()) {
          // hasPromptContent 要求非空文本；interrupt 允许空 text（phone/app.js:884）
          if (method === 'session.interrupt') text = '[手机端] 请求中断当前任务';
          else return send(sock, id, null, new Error('empty prompt text'));
        }

        const mode = BUSINESS[String(method)];
        // 唯一 requestId 保证 hasPromptRequest 幂等去重不会吞掉新命令
        const requestId =
          'inject-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        const signal = new AbortController().signal;

        await controller.prompt(
          { sessionId, requestId, mode, content: [{ type: 'text', text }] },
          signal,
        );

        send(sock, id, { ok: true, accepted: true, sessionId, requestId, mode });
        log(
          `注入成功 session=${sessionId} mode=${mode} method=${method} req=${requestId} len=${text.length}`,
        );

        // 官方 bridge-next 在 prompt 后 best-effort flush；放后台跑，避免拖过客户端 4s 超时
        (async () => {
          try {
            const resolved =
              typeof controller.resolveAgent === 'function'
                ? await controller.resolveAgent(sessionId)
                : null;
            const agent = resolved && resolved.agent;
            const sessions = pick('sessions');
            if (agent && sessions && typeof sessions.flush === 'function') {
              await sessions.flush(agent.session);
            }
          } catch (e) {
            log(`flush 跳过: ${e && e.message ? e.message : e}`);
          }
        })();
      } catch (e) {
        log(`处理 ${method} 失败: ${e && e.message ? e.message : String(e)}`);
        send(sock, id, null, e);
      }
    };

    const onConnection = (sock) => {
      sockets.add(sock);
      try { sock.setNoDelay(true); } catch { /* ignore */ }
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let req;
          try { req = JSON.parse(line); } catch { continue; }
          Promise.resolve(handle(sock, req)).catch((e) => {
            log(`handle 异常: ${e && e.message ? e.message : e}`);
          });
        }
      });
      sock.on('error', () => { /* 客户端断开 */ });
      sock.on('close', () => sockets.delete(sock));
    };

    const start = (i) => {
      if (stopped) return;
      if (i >= ports.length) {
        log('所有候选端口均不可用，放弃监听');
        return;
      }
      const port = ports[i];
      const srv = net.createServer(onConnection);
      let settled = false;
      srv.on('error', (e) => {
        if (settled) {
          log(`服务运行错误 ${host}:${port}: ${e && e.message ? e.message : e}`);
          return;
        }
        settled = true;
        log(`端口 ${port} 不可用 (${e && e.code ? e.code : e.message})，尝试下一个`);
        try { srv.close(); } catch { /* ignore */ }
        start(i + 1);
      });
      try {
        srv.listen(port, host, () => {
          if (settled || stopped) {
            try { srv.close(); } catch { /* ignore */ }
            return;
          }
          settled = true;
          server = srv;
          activePort = port;
          log(`v1 注入桥已监听 ${host}:${port}`);
          writeEndpoints(port);
        });
      } catch (e) {
        settled = true;
        log(`listen(${port}) 抛异常: ${e && e.message ? e.message : e}`);
        start(i + 1);
      }
    };

    // apply() 必须同步返回；真正的 listen 放到下一 tick
    queueMicrotask(() => {
      try { start(0); } catch (e) { log(`启动失败: ${e && e.message ? e.message : e}`); }
    });

    return () => {
      if (stopped) return;
      stopped = true;
      log('正在关闭 v1 注入桥…');
      if (activePort !== null) removeEndpoints(activePort);
      if (server) { try { server.close(); } catch { /* ignore */ } }
      for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } }
      sockets.clear();
    };
  }, 'dsh-anywhere-inject: v1 本地注入桥');
}
