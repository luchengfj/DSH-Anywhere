# DSH Anywhere

把**正在运行的 DeepSeek Harness（DSH）桌面会话**同步到手机，并让手机远程控制多台 Windows / SteamDeck 主机。

- 零第三方 npm 依赖，只用 Node 内置模块（`http` / `fs` / `crypto` / `os` / `path` / `zlib` / `url` / `child_process`）。
- 无构建步骤，不需要 `npm install`；**一键安装包已内置 Node 24 运行时**，开箱即用；仅「从源码运行 / 手动部署」才要求 **Node.js >= 22**（见 `package.json` 的 `engines`）。
- 四部分组成：**relay**（一个 Node 进程，REST + SSE，并直接托管手机 PWA 静态文件）、**host adapter**（每台桌面一个，增量读取 DSH 会话日志）、**phone PWA**（纯静态，由 relay 托管，开一个 URL 即可）、**注入桥插件 `dsh-anywhere-inject`**（DSH profile bundle，随 host 自动部署、经 DSH HMR 热加载，把手机命令注入正在运行的 live agent）。
- 跨 Windows / Linux（Steam Deck / SteamOS）/ Termux / VPS / 手机浏览器；规范以 [SPEC.md](SPEC.md) 为单一事实来源。

> **执行位置（重要）**：工作流与 agent **跑在电脑 / SteamDeck 上正在运行的 DSH 会话里，而不是手机上**。手机只是遥控器 + 实时同步视图（纯静态 PWA，不安装任何软件、不运行任何 agent 逻辑）：命令经注入桥进入桌面 live 会话，工具调用 / 文件读写 / 构建都发生在桌面主机，结果以 SSE 镜像回手机。手机关机、不打开页面，桌面工作流照常继续；要继续干活，在这台电脑的 DSH 里直接说即可，不必切到手机。

---

## 一、直接安装 / 一键启动（推荐，零配置）

**不想看技术细节？直接看 [直接安装.md](直接安装.md)：双击 / 解压 / 扫码，三步就能用。**

一句话：安装包里已经带好了 Node.js 运行时和全部源码，你**不需要安装 Node.js、不需要 `npm install`、不需要拷贝 token、不需要敲命令**。

| 平台 | 安装包 | 启动方式 | 自动完成的事 |
|---|---|---|---|
| Windows | `DSH-Anywhere-Setup.exe` | 双击安装并启动 | 自动创建桌面 / 开始菜单快捷方式；启动器 `DSH Anywhere.exe` 自动起 relay + 本机 host（无需装 Node、无需配 token、无需敲命令）；桌面自动打开二维码页 `/qr.html?u=<手机URL>&code=<6位码>` |
| SteamDeck / Linux x64 | `DSH-Anywhere-Linux-x64.tar.gz` | 解压后 `./start.sh`，或双击 `DSH-Anywhere.desktop` | 零配置；终端打印手机 URL、二维码页地址与 6 位配对码（在电脑浏览器打开二维码页即可扫码）；状态写在包内 `state/`（便携，兼容 SteamOS 只读根文件系统） |
| 手机 | 浏览器 / PWA | 扫二维码打开 `http://<LAN-IP>:8787/?pair=<6位码>` | 自动配对（`POST /api/pair` 换 token）；浏览器菜单「添加到主屏幕」即可当 App 用 |

要点：

- 首次启动 **Windows 防火墙**弹窗请勾选「**专用网络**」并允许访问（不要选公用网络）；Linux / SteamDeck 放行对应 TCP 端口。
- 手机与电脑连**同一个 Wi-Fi**（局域网直连）；跨网 / 外出用 Tailscale 或 HTTPS 反代，见后文「局域网 vs 外网」。
- 之后再打开：Windows 用**桌面快捷方式 / 开始菜单**；Linux 再跑 `./start.sh` 或双击 `.desktop`（终端里 `Ctrl-C` 停止）。
- 卸载：Windows「设置 → 应用」或安装目录里的 `卸载.cmd`；Linux 直接删目录 + 删 `.desktop`，系统无残留、无需 root。
- 常见问题（扫不出来 / 连不上 / 端口占用 / 换 Wi-Fi / 回执异常排查）、完整三步图解与卸载细节：[直接安装.md](直接安装.md)。

> 一键包内部仍是同一套代码：`all` 模式（`node bin/cli.mjs all`）自动拉起 relay + 指向本机 relay 的 host，并**自动生成共享 token**；Linux 包的 `start.sh` 优先用包内 `bin/node`，把 `DSH_ANYWHERE_HOME` 指向包内 `state/`，`PORT` 默认 8787、被占用自动 +1（最多试 20 个），`HOST=0.0.0.0`，并用 `exec` 透传信号。host 首次启动还会把内置注入桥部署进 DSH profile（DSH HMR 免重启热加载），因此新装机器同样开箱即打通「手机发令 → live agent」闭环。详见 [install/README.md](install/README.md)。

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| 会话同步 | host 增量 tail `~/.dsh/sessions/` 下的 zstd 会话日志，推给 relay；手机按时间线实时看用户消息、助手消息、工具调用/结果、回合开始/结束、标题 |
| 多主机切换 | 手机一个下拉框在任意台 Windows / SteamDeck 主机之间切换，只看该主机的会话 |
| 离线补放 | 手机断网/关页面期间的事件不丢，重连后按事件游标增量补放；SSE 支持 `Last-Event-ID` 续传 |
| 远程发令（闭环） | 底部输入 `message` / `steer` / `interrupt` / `command` → host 经内置 v1 注入桥调用 DSH `sessionController.prompt` 注入**正在运行的 live agent**；手机显示 `ack`（`ok` / `error`），`ok` 时 `deliveredVia=bridge-v1`；agent 的回复经会话日志 → SSE 实时回到手机时间线 |
| 离线队列 | 手机离线时先把命令排队在 localStorage，恢复后重发 |

---

## 架构图（文本）

```text
                           同一局域网 / Tailscale / HTTPS 反代
    ┌────────────────────────┐        ┌──────────────────────────────┐        ┌────────────────────┐
    │  Windows 桌面 ①        │        │  relay（任意一台，建议常开） │        │  手机浏览器 / PWA   │
    │  ┌──────────────────┐  │        │  单 Node 进程，零依赖         │        │  只开一个 URL       │
    │  │ DSH 会话日志     │  │  POST  │  REST  /api/*                │  SSE   │  6 位配对码 → token│
    │  │ *.jsonl.zstd     │──┼───────>│  SSE   /api/stream           │───────>│  主机切换器         │
    │  └──────────────────┘  │ /ingest│  托管  phone/ 静态 PWA        │ 事件流 │  会话时间线         │
    │  host adapter        │<────────┤  secret / pair-code.txt       │<───────┤  发消息 / 看 ack   │
    └────────────────────────┘ command└──────────────────────────────┘  POST  └────────────────────┘
                                      ▲                    │
    ┌────────────────────────┐        │                    │ command-result (Ack)
    │  SteamDeck 桌面 ②      │  push  │                    ▼
    │  host adapter        │────────┘          注入结果回传 → SSE ack → 手机显示状态
    └────────────────────────┘
         ...可再加 N 台，全部指向同一个 relay、使用同一个 TOKEN
```

数据流：

1. host 读取 `<DSH_HOME>/sessions/<workspace-encoded>/<sessionId>/session.v4.jsonl.zstd`（**多个 zstd 帧拼接**，逐帧解出换行分隔的 JSON 事件），增量上报 `POST /api/ingest`。首次启动会回放全部历史会话（可达数万条、数十 MB）；host 按 ~6 MB 自动分批顺序上报，避免超出 relay 单次请求体上限，分批期间同样会取走排队的手机指令。
2. relay 给每条事件追加单调 `cursor`，按主机/会话索引，通过 `GET /api/stream?role=phone&token=...` 推给手机；每 15 秒一次 heartbeat。
3. 手机 `POST /api/command` → relay 排队 → 下一轮 host `/api/ingest` 响应里的 `commands` 取走 → host 通过内置 v1 注入桥（`127.0.0.1:8788` 的 newline-JSON-RPC）调用 DSH `sessionController.prompt` 把命令作为用户消息注入 live agent → `POST /api/command-result` 回传 `Ack` → relay 推 `ack` 给手机；注入产生的 user/message 与 agent 的回复再经步骤 1 的日志 tail → SSE 回到手机时间线，形成闭环。
4. 断线后手机用 `GET /api/events?since=<lastCursor>` 补放，SSE 也可用 `Last-Event-ID` 续传。

---

## 进阶：从源码运行（已有 Node 环境 / 手动部署 / 开发者）

> 只想像普通软件一样使用？回到第一章「直接安装 / 一键启动」。本章把从源码 / 手动部署 / 环境变量 / 开发者相关的内容集中在一起。
> **前置条件：Node.js >= 22**（`package.json` 的 `engines`）。Node >= 23/24 内置 `zlib.zstdDecompressSync`，可直接解码 DSH 会话日志；Node 22 的 host adapter 需要系统 `zstd -d` CLI（Debian/Ubuntu `sudo apt install zstd`，Arch/SteamOS `sudo pacman -S zstd`，Termux `pkg install zstd`，Windows `winget install --id facebook.zstd`），**只跑 relay 不需要 zstd**。项目零第三方依赖、无构建步骤。
> 按平台安装器（Linux / Steam Deck DeckUI / Windows / Docker / Termux / systemd）：[install/README.md](install/README.md)。

### A. 单机演示（一条命令）

在本仓库根目录：

```sh
npm start
# 等价于
node bin/cli.mjs all
```

`all` 会同时拉起 relay + 指向本机 relay 的 host adapter（`child_process.spawn`，转发 SIGINT）。终端打印 **6 位配对码**与 URL：

```text
relay  : http://127.0.0.1:8787
pairing code: 483920      # 同时写入 ~/.dsh-anywhere/pair-code.txt
token       : ~/.dsh-anywhere/secret
```

同一台机器的浏览器（或同一 Wi-Fi 下手机填 `http://<本机IP>:8787`）打开该 URL → 输入配对码 → 立即看到本机 DSH 会话时间线。可用 `node bin/cli.mjs help` 看子命令，`Ctrl-C` 一起停。

> 单机模式只是演示：真实价值在于 relay 常开、多台桌面各自装 host、手机随时切换。

### B. 真实三设备部署（推荐）

**第 1 步：在一台常开机器上跑 relay（SteamDeck 或 VPS）**

Steam Deck（桌面模式 / SSH，见 [install/README.md](install/README.md)）：

```sh
sh install/install.sh --relay-only --enable
# 无 systemd 的 VPS：sh install/install.sh --relay-only --no-systemd
# 然后 sh ~/.dsh-anywhere/relay-start.sh（前台看配对码，或放 tmux/nohup）
```

VPS / Docker：

```sh
docker build -f install/Dockerfile -t dsh-anywhere:local .
docker run -d --name dsh-anywhere -p 8787:8787 \
  -v dsh-anywhere-state:/app/state \
  -e DSH_ANYWHERE_TOKEN='换成一长串随机值' \
  dsh-anywhere:local
docker logs dsh-anywhere      # 配对码
```

也可以直接 `node relay/server.mjs` / `npm run relay`。记下三样东西：**relay URL**、**6 位配对码**（`pair-code.txt`）、**token**（`secret`，每台 host 要用同一个）。

**第 2 步：每台 Windows / SteamDeck 桌面装 host adapter**

Windows（PowerShell，无需管理员）：

```powershell
powershell -ExecutionPolicy Bypass -File install\install-windows.ps1 -Mode Host
# 想让本机 relay 也开机自启： -Mode All -Task   或   -Mode All -Startup
```

编辑 `%USERPROFILE%\.dsh-anywhere\host-config.ps1`，填 `DSH_ANYWHERE_RELAY`（指向第 1 步的 relay）和 `DSH_ANYWHERE_TOKEN`（与 relay 的 secret 完全一致）。

Linux / SteamDeck：

```sh
sh install/install.sh --host-only
# 编辑 ~/.dsh-anywhere/host.env 后：
sh ~/.dsh-anywhere/host-start.sh
```

同一台机器既跑 relay 又跑 host 时，host 启动脚本会自动从状态目录的 `secret` 读 token，`DSH_ANYWHERE_TOKEN` 可留空。安装器各平台细节见 [install/README.md](install/README.md)。

**第 3 步：手机**

浏览器打开 relay 的 URL（局域网 `http://192.168.x.x:8787`，外网 `https://your-domain`）→ 输入 6 位配对码（`POST /api/pair` 换取 token 并存入 localStorage）→ 用顶部主机切换器选主机 → 看实时时间线、发消息、看 ack 状态。浏览器菜单里「添加到主屏幕」即可当 PWA 用。一键包用户直接扫二维码即可，无需手输。

### C. HTTP API 一览（relay）

除 `GET /api/health` 与 `POST /api/pair` 外，所有 `/api/*` 都要鉴权：头 `Authorization: Bearer <TOKEN>`，或（EventSource 不能设头时）查询参数 `?token=<TOKEN>`。TOKEN = 环境变量 `DSH_ANYWHERE_TOKEN`，否则首次启动随机生成并持久化到 `<DSH_ANYWHERE_HOME>/secret`。启动时打印 6 位配对码（也写入 `pair-code.txt`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 返回 `{ok:true,name:"dsh-anywhere",version,time}`，无需鉴权 |
| POST | `/api/pair` | body `{code}` → `{ok,token,relayVersion}`；code 为启动时 6 位码；二维码 `/?pair=<6位码>` 会自动调用它 |
| GET | `/api/bootstrap` | → `{hosts:[Host], sessions:{hostId:[Session]}, cursor, events:[Evt]}`；events 为最近 300 条事件尾，供手机冷启动填充离线缓存 |
| GET | `/api/events?since=&hostId=&sessionId=&limit=` | → `{events:[Evt], cursor}`；since 为 cursor（不含），用于离线补拉 |
| GET | `/api/stream?role=phone|host&hostId=` | SSE 文本流，见下 |
| POST | `/api/register` | body: Host → 标记在线，广播 `host`；返回 `{ok}` |
| POST | `/api/ingest` | body `{hostId, events:[Evt], sessions?:[Session]}` → `{ok,cursor,commands:[Command]}`；host 推送事件，relay 存储+广播 `event`/`session`，并顺带返回该 host 待执行命令；单次请求体上限 32 MB（按 Buffer 累计、UTF-8 安全），host 首次全量回放按 ~6 MB 分多次 POST |
| POST | `/api/command` | body: Command (phone) → 入队并广播 `command` 给目标 host；返回 `{ok,queued:true,cursor}` |
| POST | `/api/command-result` | body: Ack (host) → 广播 `ack` 给 phone；返回 `{ok}` |
| GET | `/` , `/app/*` | 托管 phone PWA 静态文件（无需鉴权；app 自己调 `/api/pair`），含 `/qr.html` 桌面扫码页 |

SSE 事件（每条尽量带 `id: <cursor>`，客户端断线用 `Last-Event-ID` 续传）：`hello` → `{relayVersion,cursor}`；`host` → Host；`session` → Session；`event` → Evt；`command` → Command（仅 role=host 且 hostId 匹配）；`ack` → Ack（role=phone）；`heartbeat` → `{time}`（每 15s keepalive）。

核心数据结构（详见 [SPEC.md](SPEC.md)）：

```text
Evt     = {hostId,sessionId,seq,time,type,data,cwd,id:"hostId/sessionId/seq"}
Host    = {hostId,hostName,platform,online,lastSeen,dshHome,bridge:{version,endpoint},adapterVersion}
Session = {hostId,sessionId,title,cwd,updatedAt,eventCount,lastSeq}
Command = {clientMessageId,targetHostId,sessionId,kind,text,time}   kind ∈ message|steer|interrupt|command
Ack     = {clientMessageId,targetHostId,status,detail,deliveredVia,time}   status ∈ ok|error（注入桥已内置，ok 时 deliveredVia=bridge-v1）
```

### D. 局域网 vs 外网

| 场景 | 做法 | 要点 |
|---|---|---|
| **局域网（同一 Wi-Fi）** | 直接 `http://<relay内网IP>:8787` | relay 默认 `HOST=0.0.0.0`；Windows 防火墙选「专用网络」；路由器给 relay 绑静态 DHCP；明文 HTTP 仅限可信内网 |
| **外网方案一（推荐）：Tailscale / WireGuard** | 所有设备装 Tailscale，用 tailnet IP（`http://100.x.y.z:8787`） | VPN 已加密，无需再配 TLS；**不要把 8787 端口映射到公网**；手机装 Tailscale 客户端即可 |
| **外网方案二：HTTPS 反向代理** | Caddy / Nginx 终止 TLS，反代到 relay | relay 用 `--bind 127.0.0.1`（或 `HOST=127.0.0.1`）只监听本机；代理必须关闭 SSE 缓冲、透传 `Authorization` 头与 `?token=` 查询参数；手机开 `https://域名`（PWA 默认 relay 地址就是 `location.origin`） |

反向代理示例（Nginx，注意 `proxy_buffering off` 是 SSE 必需的）：

```nginx
location / {
    proxy_pass         http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   Authorization     $http_authorization;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   Connection        "";
    proxy_buffering    off;          # SSE /api/stream 必须实时 flush
    proxy_read_timeout 3600s;        # 长连接，短于 15s 会被 heartbeat 误判断线
    proxy_cache        off;
}
```

Caddy 一行即可（自动 TLS）：`reverse_proxy 127.0.0.1:8787`（Caddy 默认不缓冲 SSE）。

> **没有 TLS 就不要把 relay 暴露到公网。** relay 自身刻意不实现 TLS（零依赖原则），TLS 是 VPN 或反代的职责；SSE 的 token 走查询参数，明文公网会直接泄露。

### E. 环境变量参考

| 变量 | 作用对象 | 默认值 | 说明 |
|---|---|---|---|
| `PORT` | relay | `8787` | 监听端口 |
| `HOST` | relay | `0.0.0.0` | 监听地址；放在反代后面时改成 `127.0.0.1` |
| `DSH_ANYWHERE_TOKEN` | relay / host | 空 | relay 未设置时首次启动随机生成并写 `<DSH_ANYWHERE_HOME>/secret`；**每台 host 必须填同一个值**（也可由启动脚本自动从 secret 读取） |
| `DSH_ANYWHERE_HOME` | relay / host | `~/.dsh-anywhere` | 状态目录：secret、pair-code.txt、事件/游标持久化、生成的启动脚本；一键 Linux 包改为包内 `state/` |
| `DSH_ANYWHERE_RELAY` | host | 无（必填） | relay 完整基址，如 `http://100.1.2.3:8787` 或 `https://dsh.example.com`，不带尾斜杠 |
| `DSH_ANYWHERE_HOST_NAME` | host | `os.hostname()` | 手机切换器里显示的名字 |
| `DSH_ANYWHERE_HOST_ID` | host | 持久化随机值 | 主机唯一 ID，重跑保持同一台 |
| `DSH_HOME` | host | `~/.dsh` | DSH 会话日志根目录，内含 `sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd` |
| `DSH_ANYWHERE_SRC` | 安装器 | 脚本上级目录 | 指定仓库检出路径（对应 `--src`） |
| `NODE_TAG` | Docker 构建 | `22-alpine` | 构建参数；要容器里也跑 host 可换 `24-alpine`（内置 zstd） |

手机端不读环境变量：relay 地址默认当前页 `location.origin`，配对码换来的 token 存在 localStorage。

CLI 速查：`node bin/cli.mjs <all|relay|host|help>`、`node relay/server.mjs`、`node host/cli.mjs`、`npm run check`（解码真实会话日志并打印事件统计）、`npm test`（集成测试，由项目维护者运行）。`relay/server.mjs` 还导出 `createRelay(opts) -> {server, state, token, pairCode, home, listen(port, host), close()}` 供嵌入；`await listen(0)` 会返回 `{port, url, token, pairCode}`（`port=0` 即随机空闲端口，集成测试就是这么起的）。

### F. 安全说明

- **token 就是密码**：除 `GET /api/health` 与 `POST /api/pair` 外，所有 `/api/*` 都要 `Authorization: Bearer <TOKEN>`；因为 EventSource 不能设请求头，SSE 用 `?token=<TOKEN>` 查询参数。**不要**把 token 贴进聊天记录、截图或公开仓库。
- **6 位配对码**只用于手机首次 `POST /api/pair` 换 token，等同临时口令：只在可信环境里念给自己的手机，别在群里发。relay 启动时打印并写入 `pair-code.txt`。
- **不要在没有 TLS 的情况下把 relay 暴露到公网**：优先局域网直连 / Tailscale，其次 HTTPS 反代；见上节。
- 轮换凭据：若用环境变量 `DSH_ANYWHERE_TOKEN` 指定，改它并重启 relay 即可；否则删除状态目录里的 `secret` 与 `pair-code.txt` 再重启 relay（会生成新 token 与新配对码），随后**更新所有 host 的 token 并让手机重新配对**。
- 安装器把状态目录设为 `chmod 700`、`host.env` / `host-config.ps1` 设为 `chmod 600`（Windows 用当前用户目录权限）；systemd unit 带 `NoNewPrivileges` / `ProtectHome=read-only` 且只放行状态目录。别把状态目录提交到版本库。
- relay 是单进程、单 token、无用户分级 / 无审计日志的轻量服务：适合个人自用，不适合多人共享或生产多租户。PWA 无第三方代码，但 token 存于 localStorage，请勿在该域下混跑不可信页面。

### G. 诚实的能力边界 / 限制

**完整可用、已实测**：会话同步（zstd 多帧增量解码、事件游标、SSE 实时推送、断线重连与 `/api/events?since=` 补放）、多主机注册与切换、手机离线补放、命令排队与 `Ack` 状态回传（`ok` / `error`），以及**手机命令 → live agent → 回复回到手机**的端到端闭环（本机已实测 `ack status:ok`、`deliveredVia:bridge-v1`、会话日志新增 user/message 与 assistant/message、SSE 回传）。

**闭环怎么来的（内置注入桥）**：

- 随包附带 DSH profile bundle `@local/dsh-anywhere-inject`。host 每次启动经 `install/deploy-inject.mjs` 幂等部署它（复制稳定副本 → 在 profile `node_modules/@local/` 建 junction/symlink → 把包名追加进 `dsh.profile.bundles`），DSH 自带的 HMR 监测到 `package.json` 变化 → `reconcileProfile` → **免重启热加载**插件；全程不改 token / 配对码、不中断 relay。
- 插件运行在 **DSH 进程内**，监听 `127.0.0.1:8788`（v1 newline-JSON-RPC），说 host `discoverBridge()` 优先找的 v1 协议，并把 `endpoint.json` 写到 `<DSH_HOME>/agents-anywhere/bridge/`。host 每 ~12s 重发现一次，自动改用 `version:1`。
- 业务方法翻译成官方 `ctx.get('sessionController').prompt({sessionId, requestId, mode, content}, signal)`：`message`/`command` → `mode:'queue'`（排队），`steer`/`interrupt` → `mode:'steer'`（打断）。注入是作为**一条用户消息**进入当前会话，不是独立 RPC；`interrupt` 没有独立 RPC，也落成一条打断用的用户消息。
- 只监听 `127.0.0.1`，不暴露 LAN、无需防火墙；插件 `package.json` 省略 `engines.dsh`，`apply()` 同步不抛、`listen` 延迟下一 tick，避免 DSH 插件预检/加载失败。

**仍需如实说明的边界**：

- **注入桥依赖 DSH 正在运行且 profile 可写**：首次部署靠改 `package.json` 触发 HMR；若 DSH 未安装 / 未运行 / profile 目录只读 / `DSH_HOME` 与桌面端不一致，部署脚本会优雅跳过，host 回退到旧的自动发现（找不到 v1 `endpoint.json` 时返回 `unsupported`，命令落盘 `command-inbox.jsonl`），此时才需要桌面 GUI / DSH IM 通道。手机**永远会收到一个 ack 状态**（含 `deliveredVia` / `detail`），不会把「没注入成功」伪装成成功——请按 ack 判断。
- host 只是**只读增量**解析 DSH 写出的日志，不改动 DSH 自身数据；日志格式绑定 `session.v4.jsonl.zstd`（多 zstd 帧 + NDJSON，`seq` 从 0 单调）。DSH 若改格式，host 需跟着更新。
- **zstd 解码**：Node >= 23/24 用内置 `zlib.zstdDecompressSync`；Node 22 必须装系统 `zstd -d` CLI（只跑 relay 不需要）。一键包内置 Node 24，已包含该能力，无需额外安装 zstd。
- 离线补放指**手机离线期间** relay 保存的事件流与游标。relay 会把事件流追加写入状态目录的 `events.ndjson`、把游标/主机/会话写入 `meta.json`，**重启后自动恢复、历史不丢**（集成测试 `events persisted across relay restart` 已覆盖）。只要保留该状态目录（Docker 用卷挂载、一键 Linux 包是包内 `state/`），历史即可长期留存；只有删除状态目录才会清空。
- PWA 依赖浏览器支持 EventSource / service worker；iOS「添加到主屏幕」后系统仍可能不保活后台，前台使用正常。
- 零依赖、无集群、无 TLS 内置、无多用户与权限分级；跨公网请务必走 Tailscale 或 HTTPS 反代。

### H. 验证结果

- 集成测试 `node test/integration.mjs`：临时目录起 relay，模拟 2 个 host + 2 个 phone，验证注册 / 事件同步 / 主机切换 / 命令回执 / 离线补拉，以及 `events persisted across relay restart`（退出码非 0 表示失败）。上节「完整可用」即指这些被覆盖的能力。
- 冒烟检查 `node test/smoke.mjs` / `npm run check`：针对真实 DSH 会话文件跑解码器，打印事件统计（多 zstd 帧 + NDJSON 解析）。
- 安装器与文档校验（本仓库维护记录）：`install/install.sh` 与 `install/start-linux.sh` 通过 `sh -n`；`install/install-windows.ps1` 及生成的 `relay-start.ps1` / `host-start.ps1` 通过 PowerShell `Parser.ParseFile`；`install/start-linux.sh` 的 `all` 模式实测可起 relay（`GET /api/health` 返回 `{"ok":true,...}`）、托管 `/qr.html`（200）、并把 `events.ndjson` / `meta.json` 写入便携 `state/`。
- 集成测试由项目维护者 / lead 运行，文档与安装器改动不替代集成测试。
- **端到端闭环实测（本机，DSH 0.2.2-rc.1）**：热加载注入桥 → `127.0.0.1:8788` 由 DSH Host 进程监听、`bridge.ping` 返回 `hasController:true` → 适配器注册 `bridge.version=1` → 经 `POST /api/command` 发真实小消息 → SSE 收到 `ack {"status":"ok","deliveredVia":"bridge-v1"}` → 会话日志新增 `agent/inbox/spliced`（含注入的用户消息）与 `assistant/message` → `/api/events` 可查。闭环成立。
- **部署脚本隔离测试**：`_build/test-deploy-inject.mjs` 在临时 DSH home 连跑两次，验证复制 / junction / manifest 编辑 / 备份 / 幂等（第二次 `link=unchanged`、`filesWritten=0`、manifest 不变）全部通过。

### I. 故障排查

| 现象 | 排查 |
|---|---|
| 手机打不开页面 | `curl http://<relay>:8787/api/health` 应返回 `{"ok":true,...}`；确认 relay 进程在、防火墙放行「专用网络」、`HOST` 没被误设成不可达地址、端口没被占用（改 `PORT` 或重新生成启动脚本） |
| 配对码无效 | 码来自**同一个 relay** 的启动输出 / `pair-code.txt`；relay 重启会换码；确认手机填的 relay URL 就是打印该码的那台 |
| SSE 一直连不上 / 反复重连 | 检查 `?token=` 是否与 relay 的 secret 一致；反代必须 `proxy_buffering off` 且 `proxy_read_timeout` 远大于 15s（heartbeat）；浏览器控制台看 `/api/stream` 状态码 |
| 手机看不到某台主机 | 看 `GET /api/bootstrap` 的 `hosts[].online/lastSeen`；99% 是 host 的 `DSH_ANYWHERE_TOKEN` 与 relay 不一致（`401` 时 host 日志会报）；确认 `DSH_ANYWHERE_RELAY` 无尾斜杠、协议/端口正确 |
| 主机在线但没有任何会话 | 确认 `DSH_HOME` 指向真实目录且存在 `session.v4.jsonl.zstd`；Node 22 需 `zstd` CLI；跑 `npm run check` 解码真实日志看事件统计 |
| 发消息后 ack 是 `unsupported` / `error` | 说明内置注入桥没部署成功：① 确认 DSH 桌面端**正在运行**、`~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 含 `@local/dsh-anywhere-inject`；② 看 `~/.dsh/dsh-anywhere-inject.log` 与 `Get-NetTCPConnection -LocalPort 8788`（应由 DSH Host 进程监听）；③ 确认 `<DSH_HOME>/agents-anywhere/bridge/endpoint.json` 存在且 `port` 正确、host 与 DSH 用同一个 `DSH_HOME`；④ 手动重跑 `node install/deploy-inject.mjs` 再等 ~12s（host 周期重发现）。命令仍会落盘 `command-inbox.jsonl`，看 ack 的 `detail` / `deliveredVia`；同步与查看功能不受影响 |
| Windows 计划任务没起来 | `Start-ScheduledTask -TaskName 'DSH Anywhere Relay'` 手动触发；或改用 `-Startup` 启动文件夹方式；确认 `-ExecutionPolicy Bypass`、host-config.ps1 已填 |
| SteamDeck 游戏模式里 relay 不自启 | systemd user unit 需要登录会话：切**桌面模式**或 SSH 登录后再 `systemctl --user enable --now dsh-anywhere`；纯 DeckUI 游戏模式建议把 relay 放 VPS / 家里常开 PC |
| Termux 里 relay 过一会儿被杀 | `termux-wake-lock` + 关闭电池优化 + 放 tmux；长期稳定还是放 VPS / SteamDeck |
| 改了源码不生效 | 项目无构建步骤，但**要重启进程**；安装器生成的 `relay-start.sh` / `host-start.sh` 里烤入了源码路径与端口，换目录/换端口后重跑安装器刷新 |
| 怀疑凭据泄露 | 立即按「安全说明」轮换 token，更新所有 host，手机重新配对；检查是否把 8787 直接映射到了公网 |
| 一键包扫码扫不出来 | 手机与电脑连同一 Wi-Fi、关掉访客网络 / AP 隔离；在二维码页把「手机链接」改成电脑实际局域网 IP（终端也打印了），二维码会实时更新；或手动打开该链接输入 6 位码 |
| 一键包端口被占用 | `start.sh` 默认 8787 被占会自动 +1（最多 20 个），终端打印实际端口；也可 `./start.sh --port 9000`，手机链接请用**实际端口** |
| 换 Wi-Fi / 电脑 IP 变了 | 手机点齿轮「重新配对 / 改地址」填新 relay URL；建议路由器绑定静态 DHCP 或改用 Tailscale |

### J. 目录结构

```text
dsh-anywhere/
├── 直接安装.md          # 小白三步：双击 / 解压 / 扫码（推荐入口）
├── SPEC.md              # 单一事实来源：运行形态、HTTP API、事件模型、约束
├── package.json         # scripts / engines / bin（零 dependencies）
├── bin/cli.mjs          # all | relay | host | help（单机演示入口）
├── relay/server.mjs     # REST + SSE + 托管 phone/ 静态；导出 createRelay(opts)
├── host/cli.mjs         # 会话日志增量上报 + 命令注入适配（启动时部署注入桥）
├── shared/              # relay / host 共用代码
├── phone/               # 纯静态 PWA（manifest + service worker + qr.html），由 relay 托管
├── dsh-anywhere-inject/ # 注入桥插件（DSH profile bundle，HMR 热加载）：package.json / cordis.patch.yml / index.js / README.md
├── test/                # integration.mjs（集成测试）/ smoke.mjs（日志解码）
└── install/             # 各平台安装器、systemd unit、Dockerfile、按平台说明
    ├── deploy-inject.mjs # 幂等部署注入桥到 DSH profile（host 启动时 in-process 调用）
    ├── install.sh / install-windows.ps1 / dsh-anywhere.service / Dockerfile
    ├── start-linux.sh   # 一键 Linux 包根目录 start.sh 的模板（包内 bin/node + app/）
    ├── DSH-Anywhere.desktop  # Linux 桌面入口（@@ROOT@@ 由打包脚本替换为基于 %k 的相对定位）
    └── README.md
```

更多按平台细节（Linux / Steam Deck DeckUI / Windows / Docker / Termux）：[install/README.md](install/README.md)。
