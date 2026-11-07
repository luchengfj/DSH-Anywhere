# @local/dsh-anywhere-inject

DSH Anywhere 的「手机命令 → 正在运行的 DSH agent」注入桥。它是一个标准的
DSH profile bundle（插件），通过 DSH 自带的 HMR 热加载，**不需要重启 DSH**、
不需要改 host adapter 源码、不需要换 token / 配对码。

## 为什么需要它

`host/bridge-inject.mjs` 的 `discoverBridge()` 会优先找 v1
`endpoint.json` TCP 端点，找不到时若检测到 DSH v2（meshcall）就返回
`unsupported`，手机命令只落盘到 `command-inbox.jsonl`。本机 DSH 只有 v2
桥，因此需要一个**运行在 DSH 进程内**的插件来提供 v1 端点 —— 会话控制器
`sessionController` 无法从外部进程取得。

## 它做什么

1. 在 DSH Host 进程内监听 `127.0.0.1:8788`（被占用时回退 8791/8792/8793），
   说 v1 newline-JSON-RPC，逐字匹配 `host/bridge-inject.mjs` 的客户端：
   同一 socket 顺序处理 `initialize` + 一条业务方法，原样回显请求 `id`，
   成功响应绝不带 `error` 键，并在 4s 内回复。
2. 业务方法翻译成官方调用
   `ctx.get('sessionController').prompt({sessionId, requestId, mode, content}, signal)`，
   随后 best-effort `ctx.sessions.flush(agent.session)`。
   `session.send_message` / `session.command.execute` → `mode:'queue'`（排队），
   `session.steer` / `session.interrupt` → `mode:'steer'`（打断）。
3. 监听成功后把
   `{"version":1,"host":"127.0.0.1","port":<实际端口>,"token":""}`
   写到 `<dshHome>/agents-anywhere/bridge/endpoint.json` 与
   `<dshHome>/agents-anywhere/endpoint.json`。运行中的 host adapter 每
   ~12s 重跑 `discoverBridge()`，自动改用 `version:1`，命令即真正注入。
4. 注入结果经 DSH 写出的 zstd 会话日志 → host tail → `/api/ingest` →
   SSE → 手机 PWA，闭环成立。

> 闭环的「执行」始终在桌面主机完成：`sessionController` 属于桌面 DSH
> 进程，注入的是桌面 live 会话，agent 的工具调用 / 文件读写都发生在桌面；
> 手机只是发令与看镜像，**工作流跑在电脑 / SteamDeck 上，而不是手机上**，
> 手机离线也不影响桌面继续干活。

## 部署

由 `install/deploy-inject.mjs` 自动完成（`host/cli.mjs` 每次启动会
in-process 调用一次）：

- 把本目录 3 个文件复制到 `<dshHome>/dsh-anywhere-inject/`（稳定副本）；
- 在 `<profileDir>/node_modules/@local/dsh-anywhere-inject` 建
  junction(Windows) / symlink(Linux) 指向该副本；
- 幂等编辑 `<profileDir>/package.json`：加 `link:` 依赖、把包名追加到
  `dsh.profile.bundles`、写一个内容 hash 标记（记录已部署的插件版本）；
- 首次改 `package.json` 的 `bundles` 会触发 dsh-hmr
  `refresh(true) → reconcileProfile → recompose`，插件随即热加载；
  之后每次运行只负责在插件文件变化时重新复制副本，新代码在 DSH 下次重启时生效。

也可手动运行 `node install/deploy-inject.mjs`（`--help` 看选项）。

## 安全 / 兼容性

- 只监听 `127.0.0.1`，不暴露到 LAN，无需防火墙放行。
- `package.json` **故意省略 `engines.dsh` 与 `peerDependencies`**：
  app-boot 的兼容预检对没有这两项的包返回 `{}`，不会被拒绝。
- `apply()` 同步返回且绝不抛异常，`server.listen` 延迟到下一 tick
  （recompose 的 introduced-failures 检查会让抛异常的插件加载失败）。
- `DSH_HOME` 若自定义，请让 DSH 桌面端与 DSH Anywhere host adapter 使用
  同一个值；默认情况下两者都是 `~/.dsh`。
- 日志：`~/.dsh/dsh-anywhere-inject.log`。

## 验收

```sh
# 端口由 DSH Host 进程自己监听
Get-NetTCPConnection -LocalPort 8788   # Windows
# 或 ss -ltnp | grep 8788            # Linux

# v1 协议探测（任意能连 127.0.0.1:8788 的 JSON-RPC 客户端）
# {"jsonrpc":"2.0","id":"p","method":"bridge.ping","params":{}}
# -> {"result":{"ok":true,"hasController":true,"wire":"v1",...}}

# 端到端：手机 POST /api/command -> ack status:"ok" deliveredVia:"bridge-v1"
```
