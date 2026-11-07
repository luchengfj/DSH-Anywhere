# DSH Anywhere - 组件契约 (SPEC)

本文件是唯一契约源。所有组件 (relay / host / inject / phone / install / test) 必须遵守。
目标：把现有 DeepSeek Harness 桌面会话实时同步到手机；手机可切换 Windows / SteamDeck 主机并发送消息/指令让桌面继续干活；离线可补拉历史。

## 运行形态
- relay (hub): 一个 Node 进程，零第三方依赖。同时提供 REST + SSE，并直接托管 phone PWA 静态文件。可跑在任意一台机器 (Windows 主机 / SteamDeck / 小 VPS / Termux)。
- host (adapter): 每台桌面主机跑一个 (Windows + SteamDeck)。读取本机 `~/.dsh/sessions/` 下的会话日志，增量 tail，推送到 relay；并接收 relay 下发的 command 注入本机 DSH。
- phone: 纯静态 PWA，由 relay 托管，手机浏览器打开一个 URL 即可，可"添加到主屏幕"。
- inject (bridge): DSH profile bundle `@local/dsh-anywhere-inject`，随 host 启动经 `install/deploy-inject.mjs` 幂等部署、由 DSH HMR 免重启热加载；在 DSH 进程内监听 `127.0.0.1:8788` 说 v1 newline-JSON-RPC，把 command 经 `sessionController.prompt` 注入正在运行的 live agent。

## 执行位置（重要边界）
- **Agent 与工作流跑在桌面主机（Windows / SteamDeck）上，而不是手机上。** 注入桥运行在 DSH Host 进程内，调用的 `sessionController` 属于桌面端 live 会话；命令作为一条用户消息进入桌面会话日志，agent 的工具调用、文件读写、构建、子任务全部发生在桌面主机。
- 手机是**纯静态遥控器 + 会话镜像**：`phone/` 只含 DOM / `fetch` / `EventSource` / `localStorage`，没有任何执行能力（无 `sessionController`、无 `prompt`、无 `child_process` / `spawn` / `require`）。它只发 `POST /api/command` 与接收 SSE 事件；`selectedSessionId` 只是用来筛选镜像哪个桌面会话。
- 两个安装包都安装在**桌面主机**上；手机上不安装任何东西，只用浏览器打开 PWA。手机离线 / 不打开页面不影响桌面工作流继续运行；桌面端始终是「连接来做工作流」的主场。

## 会话日志 (DSH 真实格式)
路径: `<DSH_HOME>/sessions/<workspace-encoded>/<sessionId>/session.v4.jsonl.zstd`
- 文件是**拼接的多个 zstd frame** (每次 append 一个 frame)，magic = 28 b5 2f fd。
- 每个 frame 解压后是 **newline-delimited JSON**。事件形如:
```json
{"type":"user/message","seq":16,"time":1793966477811,"data":{...},"surfaceOp":"append"}
{"type":"assistant/message","seq":25,"time":...,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"..."},{"type":"reasoning","text":"..."}]}}}
{"type":"tool/call","seq":26,"time":...,"data":{"name":"run_code","arguments":"...","callId":"..."}}
{"type":"tool/result","seq":39,"time":...,"data":{"message":{"content":[{"type":"text","text":"..."}]},"toolCallId":"...","isError":false}}
{"type":"turn/start","seq":11,"time":...,"data":{"turn":1}}
{"type":"turn/end","seq":131,"time":...,"data":{"turn":1,"reason":{"kind":"completed"}}}
{"type":"session","version":4,"id":"session-...","createdAt":...,"cwd":"C:\\...","agentPreset":"standard"}
{"type":"session/title","seq":23,"time":...,"data":{"title":"..."}}
```
- 首行 `type:"session"` 无 seq；其后事件 `seq` 从 0 单调递增。
- Node >= 23/24 内置 `zlib.zstdDecompressSync`；旧 Node 回退到系统 `zstd -d` CLI。

## 归一化事件 Evt (relay 存储与广播的单位)
```json
{
  "hostId": "win-AB12",          // 主机稳定 id (持久化随机)
  "sessionId": "session-...",
  "seq": 25,                     // DSH 原始 seq；首行 session 事件用 -1
  "time": 1793966477811,
  "type": "assistant/message",   // 原样保留 DSH type
  "data": { ... },                // 原样保留 DSH data (或整条首行对象)
  "cwd": "C:\\...",
  "id": "win-AB12/session-.../25" // 去重键
}
```
relay 收到后附加自增 `cursor` (全局单调整数)，用于 SSE 的 `id:` 与增量补拉。

## 其它数据结构
```json
Host    = { hostId, hostName, platform, online, lastSeen, dshHome, bridge: { version, endpoint } , adapterVersion }
Session = { hostId, sessionId, title, cwd, updatedAt, eventCount, lastSeq }
Command = { clientMessageId, targetHostId, sessionId, kind, text, time }
           kind ∈ "message" | "steer" | "interrupt" | "command"
Ack     = { clientMessageId, targetHostId, status, detail, deliveredVia, time }
           status ∈ "ok" | "error"  （注入桥已内置；ok 时 deliveredVia="bridge-v1"）
```

## HTTP API (relay)
除 `/api/health` 与 `/api/pair` 外，所有 `/api/*` 需要鉴权：
- 头 `Authorization: Bearer <TOKEN>`，或 (SSE/EventSource 无法设头时) 查询 `?token=<TOKEN>`。
- TOKEN = 环境变量 `DSH_ANYWHERE_TOKEN`，否则首次启动随机生成并持久化到 `~/.dsh-anywhere/secret`。
- 启动时打印一个 6 位配对码 (也写入 `~/.dsh-anywhere/pair-code.txt`)。手机输入配对码换取 token。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 返回 `{ok:true,name:"dsh-anywhere",version,time}`，无需鉴权 |
| POST | `/api/pair` | body `{code}` -> `{ok,token,relayVersion}`；code 为启动时 6 位码 |
| GET | `/api/bootstrap` | -> `{ok, hosts:[Host], sessions:{hostId:[Session]}, cursor, events:[Evt]}`；events 为最近 300 条事件尾，供手机冷启动填充离线缓存 |
| GET | `/api/events?since=&hostId=&sessionId=&limit=` | -> `{events:[Evt], cursor}`；since 为 cursor(不含)，用于离线补拉 |
| GET | `/api/stream?role=phone|host&hostId=` | SSE 文本流，见下 |
| POST | `/api/register` | body: Host -> 标记在线，广播 `host`；返回 `{ok}` |
| POST | `/api/ingest` | body `{hostId, events:[Evt], sessions?:[Session]}` -> `{ok,cursor,commands:[Command]}`；host 推送事件，relay 存储+广播 `event`/`session`，并顺带返回该 host 待执行命令。单次请求体上限 32 MB（按 Buffer 累计、UTF-8 安全）；host 首次全量回放按 ~6 MB 分多次 POST，并保证每批都能取走指令 |
| POST | `/api/command` | body: Command (phone) -> 入队并广播 `command` 给目标 host；返回 `{ok,queued:true,cursor}` |
| POST | `/api/command-result` | body: Ack (host) -> 广播 `ack` 给 phone；返回 `{ok}` |
| GET | `/` , `/app/*` | 托管 phone PWA 静态文件 (无需鉴权；app 自己调 /api/pair) |

SSE 事件 (每条尽量带 `id: <cursor>`，客户端断线用 Last-Event-ID 续传)：
- `event: hello` -> `{relayVersion,cursor}`
- `event: host` -> Host
- `event: session` -> Session
- `event: event` -> Evt (归一化会话事件)
- `event: command` -> Command (仅 role=host 且 hostId 匹配)
- `event: ack` -> Ack (role=phone)
- `event: heartbeat` -> `{time}` (每 15s keepalive)

## 手机 PWA 必须实现
1. 首次打开：输入 relay URL (默认 `location.origin`) + 6 位配对码 -> `POST /api/pair` -> 保存 token (localStorage)。
2. `GET /api/bootstrap` 拿到主机列表与会话列表；顶部**主机切换器** (Windows / SteamDeck)。
3. `EventSource(/api/stream?role=phone&token=...)` 实时追加事件；EventSource 断开自动重连，重连后用 `/api/events?since=lastCursor` 补拉。
4. 时间线渲染：user/message 与 assistant/message 的文本/推理；tool/call 与 tool/result 折叠为"工具调用"块；turn/start、turn/end、session/title、todo/write、model/selection 作为状态条；其余次要事件折叠。按 hostId+sessionId 过滤当前选中会话。
5. 底部输入框发送消息：`POST /api/command` {kind:"message",text,...}；另有"中断/转向/斜杠指令"按钮对应 steer/interrupt/command。收到 `ack` 显示送达状态。
6. 离线：无网络时把待发消息排队到 localStorage，恢复后重发；已收事件缓存到 localStorage 便于离线查看。
7. 响应式移动端 UI，深色主题，可"添加到主屏幕" (manifest + service worker 缓存 app shell)。

## 约束
- 全程零第三方 npm 依赖 (仅 Node 内置模块：http, fs, crypto, os, path, zlib, url, child_process)。

## 进程 / 启动契约 (CLI)
三个入口都可以 `node <file>` 直接运行，靠环境变量配置 (无 CLI 参数解析库)：
- `node relay/server.mjs`  -> 启动 relay。env: PORT(默认 8787), HOST(默认 0.0.0.0), DSH_ANYWHERE_TOKEN, DSH_ANYWHERE_HOME(默认 ~/.dsh-anywhere)。启动打印配对码与 URL。
- `node host/cli.mjs`      -> 启动 host adapter。env: DSH_ANYWHERE_RELAY(必填, 如 http://127.0.0.1:8787), DSH_ANYWHERE_TOKEN, DSH_ANYWHERE_HOST_NAME(默认 os.hostname), DSH_ANYWHERE_HOST_ID(缺省时持久化随机), DSH_HOME(默认 ~/.dsh)。启动时 in-process 调用 `install/deploy-inject.mjs` 幂等部署注入桥（DSH HMR 热加载，免重启）。
- `node bin/cli.mjs <all|relay|host|help>` -> 便捷启动器。`all` 同时拉起 relay + host 并自动把 host 指向本机 relay (单机演示/一键体验)；其余转发到对应入口；`help` 打印用法。用 child_process.spawn，stdio 继承，转发 SIGINT。
- `node test/integration.mjs` -> 集成测试：临时目录起 relay，模拟 2 个 host + 2 个 phone，验证注册/事件同步/主机切换/命令回执/离线补拉，退出码非 0 表示失败。
- `node test/smoke.mjs` -> 针对真实 DSH 会话文件跑解码器，打印事件统计。

relay/server.mjs 额外导出 `createRelay(opts) -> { server, state, token, pairCode, home, listen(port, host), close() }` 供测试内嵌启动；`await listen(0)` 返回 `{ port, url, token, pairCode }`（port=0 取随机空闲端口）；直接运行时自动 listen。
- 生成文件里不要引入构建步骤；relay 直接以静态文件托管 phone/。
- Windows / Linux (SteamDeck) / 手机浏览器都要能跑。
- 安全：token 鉴权；建议 LAN 直连，WAN 走 Tailscale 或 HTTPS 反代 (见 README)。
- 闭环：手机 -> relay -> host -> 内置 v1 注入桥 -> DSH `sessionController.prompt` -> live agent -> 会话日志 -> SSE -> 手机，本机已实测 (`ack status:"ok", deliveredVia:"bridge-v1"`)。注入桥 `@local/dsh-anywhere-inject` 由 `install/deploy-inject.mjs` 幂等部署、DSH HMR 免重启热加载；依赖 DSH 正在运行且 profile 可写，否则优雅回退到自动发现 (v1 endpoint.json TCP / v2 检测) + `command-inbox.jsonl` 文件回退，并始终给手机回执状态 (含 `deliveredVia`/`detail`)。
