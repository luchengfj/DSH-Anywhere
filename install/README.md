# DSH Anywhere — 安装说明

## 一、一键安装包（推荐，零配置）

**只想直接用？看 [直接安装.md](../直接安装.md)：双击 / 解压 / 扫码，三步就能用。** 安装包里已内置 Node.js 24 运行时与全部源码，**不需要安装 Node.js、不需要 `npm install`、不需要拷贝 token、不需要敲命令**。

| 平台 | 安装包 | 启动 |
|---|---|---|
| Windows | `DSH-Anywhere-Setup.exe`（单文件，内置 Node 24 + 全部源码） | 双击 → 安装并启动 → 自动创建桌面 / 开始菜单快捷方式 |
| SteamDeck / Linux x64 | `DSH-Anywhere-Linux-x64.tar.gz`（自包含，内含 `bin/node` 与 `app/`） | 解压后 `./start.sh`，或双击 `DSH-Anywhere.desktop` |
| 手机（仅遥控器 / 镜像） | 浏览器 / PWA | 扫终端 / 桌面二维码页的二维码 → 自动配对 → 「添加到主屏幕」；**工作流跑在电脑 / SteamDeck 上，而不是手机上**，手机上不装任何东西 |

Windows 启动器 `DSH Anywhere.exe` 会自动起 relay + 本机 host（`all` 模式，自动生成共享 token），并自动打开二维码页 `/qr.html?u=<手机URL>&code=<6位码>`，手机扫码打开 `http://<LAN-IP>:8787/?pair=<6位码>` 自动配对。Linux 包终端里打印手机 URL、二维码页地址与 6 位配对码；在电脑浏览器打开二维码页即可用手机扫码。

要点：首次启动 Windows 防火墙弹窗选「**专用网络**」；手机与电脑连**同一个 Wi-Fi**；跨网用 Tailscale / HTTPS 反代（见根 [README.md](../README.md)）。之后再打开：Windows 用桌面快捷方式 / 开始菜单，Linux 再跑 `./start.sh` 或双击 `.desktop`（终端 `Ctrl-C` 停止）。卸载：Windows「设置 → 应用」或安装目录的 `卸载.cmd`；Linux 删目录 + 删 `.desktop`。常见问题（扫不出来 / 连不上 / 端口占用 / 换 Wi-Fi / 回执异常排查）见 [直接安装.md](../直接安装.md)。首次启动 host 会自动把内置注入桥 `@local/dsh-anywhere-inject` 幂等部署进 DSH profile（DSH HMR 免重启热加载），把手机命令注入正在运行的 live agent——详细原理见 [../dsh-anywhere-inject/README.md](../dsh-anywhere-inject/README.md)。

### Linux 一键包结构（`start.sh` 说明）

```text
DSH-Anywhere-Linux-x64/
├── start.sh                  # 由 install/start-linux.sh 复制而来（打包时重命名）
├── DSH-Anywhere.desktop      # 桌面入口；@@ROOT@@ 由打包脚本替换为基于 %k 的相对定位并 chmod +x
├── bin/node                  # 内置 Node 24 运行时
├── app/                      # 项目源码根：relay/ host/ shared/ bin/ phone/ dsh-anywhere-inject/ install/ package.json
│   ├── dsh-anywhere-inject/  # 注入桥插件（DSH profile bundle），host 启动时部署进 ~/.dsh
│   └── install/deploy-inject.mjs  # 幂等部署脚本（复制副本 + junction + 编辑 profile manifest）
└── state/                    # 运行时自动创建，便携：secret / pair-code.txt / events.ndjson / meta.json
```

`start.sh`（源文件 [install/start-linux.sh](start-linux.sh)）从**脚本自身所在目录**定位包根 `ROOT`；优先用 `"$ROOT/bin/node"`，缺失时回退系统 `node` 并校验 >= 22；把 `DSH_ANYWHERE_HOME="$ROOT/state"`（便携，不写家目录、兼容 SteamOS 只读根文件系统）；`PORT` 默认 8787、被占用自动 +1（最多试 20 个）、`HOST=0.0.0.0` 并 `export`；随后后台拉起 `"$NODE" "$ROOT/app/bin/cli.mjs" all`（`all` 模式由 `bin/cli.mjs` 自动生成共享 token，脚本不自行生成），轮询读取 `state/pair-code.txt` 里的 6 位配对码并打印**手机链接 / 二维码页地址 / 配对码**，最后 `wait` 子进程（`trap` 透传 INT/TERM，Ctrl-C 停止）。桌面会话有 `xdg-open` 时自动打开二维码页。host 进程启动时还会顺带部署内置注入桥到 DSH profile（DSH 正在运行时经 HMR 热加载）。

```sh
./start.sh                    # 默认 8787
./start.sh --port 9000        # 指定端口
./start.sh --host 127.0.0.1   # 只监听本机
./start.sh --help             # 查看用法
PORT=9000 HOST=127.0.0.1 ./start.sh   # 也可用环境变量
```

> 源文件 [install/DSH-Anywhere.desktop](DSH-Anywhere.desktop) 里 `Exec=sh -c 'cd @@ROOT@@ && exec sh ./start.sh'` 的 `@@ROOT@@` 是占位符：打包脚本生成 Linux 包时把它替换为**可移植的相对定位表达式**（基于桌面项 `%k`，见下），并对文件 `chmod +x`。这样解压到任意目录都能用，不需要预先知道绝对路径。

---

## 二、进阶：已有 Node 环境时用脚本安装

下面的安装器都基于一个`已经存在的仓库检出`（不会 clone、不会联网、不跑 `npm install`——本项目零第三方 npm 依赖）。所有脚本只写入状态目录 `~/.dsh-anywhere`（Windows 为 `%USERPROFILE%\.dsh-anywhere`），不改动系统目录、不需要 sudo/管理员权限。**与一键包不同，这一章要求你机器上有 Node.js。**

前置条件：**Node.js >= 22**（`package.json` 的 `engines` 要求）。

- Node >= 23/24 内置 `zlib.zstdDecompressSync`，可直接解码 DSH 会话日志。
- Node 22 没有内置 zstd 解码器，**host adapter 需要系统 `zstd -d` CLI**：
  - Debian/Ubuntu：`sudo apt install zstd`
  - Arch / SteamOS：`sudo pacman -S zstd`（SteamOS 只读根文件系统，见下）
  - Termux：`pkg install zstd`
  - Windows：`winget install --id facebook.zstd` 或 `choco install zstd`
- 仅跑 relay（只存/转发 JSON 事件）不需要 zstd。

### 文件一览

| 文件 | 用途 |
|---|---|
| `install/install.sh` | Linux / SteamDeck / Termux 安装器（POSIX sh） |
| `install/install-windows.ps1` | Windows 安装器（PowerShell） |
| `install/dsh-anywhere.service` | relay 的 systemd **user** unit（由 install.sh 安装） |
| `install/Dockerfile` | 最小 Node 镜像，只跑 relay |
| `install/Dockerfile.dockerignore` | 构建上下文精简（配合 `docker build -f install/Dockerfile .`） |
| `install/start-linux.sh` | 一键 Linux 包根目录 `start.sh` 的模板（见第一章） |
| `install/DSH-Anywhere.desktop` | 一键 Linux 包桌面入口模板（`@@ROOT@@` 打包时替换，见第一章） |
| `install/deploy-inject.mjs` | 幂等部署注入桥到 DSH profile（host 启动时 in-process 调用；可手动 `node install/deploy-inject.mjs` 重跑） |
| `install/README.md` | 本文件 |

安装器生成（都在状态目录里，可反复重跑覆盖）：

- `relay-start.sh` / `relay-start.ps1` — 启动 relay
- `host-start.sh` / `host-start.ps1` — 启动 host adapter
- `host.env`（POSIX `KEY=value`）/ `host-config.ps1`（PowerShell `$env:VAR = ...`）— host 配置：**第一次安装后必须编辑**，填入 `DSH_ANYWHERE_RELAY` 与 `DSH_ANYWHERE_TOKEN`

### Linux（桌面 / VPS）

在仓库根目录执行：

```sh
sh install/install.sh                 # 同时配置 relay + host
sh install/install.sh --relay-only    # 只跑 relay（VPS 推荐）
sh install/install.sh --host-only     # 只跑 host adapter（指向别的 relay）
sh install/install.sh --enable        # 额外执行 systemctl --user enable --now
sh install/install.sh --no-systemd    # 不碰 systemd，纯手动启动
sh install/install.sh --help          # 完整选项
```

安装器会：检测 node 版本 → 建立 `~/.dsh-anywhere` → 生成启动脚本 → 若存在 `systemctl --user` 则把 `dsh-anywhere.service` 装到 `~/.config/systemd/user/` 并 `daemon-reload`。没有 systemd（容器 / 无图形会话）时自动退回打印手动启动命令。

```sh
# 手动 / 验证
sh ~/.dsh-anywhere/relay-start.sh           # 前台，看配对码
cat ~/.dsh-anywhere/pair-code.txt           # 6 位配对码
cat ~/.dsh-anywhere/secret                  # token（每台 host 都要用同一个）
curl http://127.0.0.1:8787/api/health       # {"ok":true,...}

# systemd（用户级，无需 root）
systemctl --user enable --now dsh-anywhere
journalctl --user -u dsh-anywhere -f        # 启动日志 / 配对码
systemctl --user status dsh-anywhere
```

> 无 systemd 的 VPS 想后台常驻：用 `nohup sh ~/.dsh-anywhere/relay-start.sh >~/.dsh-anywhere/relay.log 2>&1 &`，或用 Docker（见下）/ tmux / supervisord。

### Steam Deck（SteamOS / DeckUI）

SteamOS 的**根文件系统只读**，官方不建议 `sudo pacman`（系统更新会覆盖、可能破坏系统）。本安装器**只写 `$HOME`**，天然兼容；一键 Linux 包更彻底（连 Node 都在包内 `bin/node`，完全不碰系统）。

1. 切到**桌面模式**（DeckUI 游戏模式里按 `STEAM` → 电源 → 切换到桌面），或直接从另一台机器 SSH 进去（`ssh deck@<deck-ip>`）。DeckUI 游戏模式下无法开终端，也无法让 systemd user unit 正常登录运行。
2. 桌面模式的 Konsole 里执行：

   ```sh
   sh install/install.sh --relay-only --enable
   ```

   Steam Deck 很适合当**常在线的 relay**（家里通电、连着 Wi-Fi）。一键包用户则直接解压后 `./start.sh`。
3. 关于 zstd：SteamOS 自带 `zstd` CLI 一般已可用；若 node 是 22 且报缺 `zstd`，优先把 node 升到 24（用 nvm / 官方 tarball 解压到 `$HOME`，不碰 `/usr`），而不是改系统包。一键包内置 Node 24，无此问题。
4. 想让它同时上报本机 DSH 会话：再跑一次 `sh install/install.sh --host-only`，编辑 `~/.dsh-anywhere/host.env` 把 `DSH_ANYWHERE_RELAY` 指向本机 relay（`http://127.0.0.1:8787`），token 会自动从 `secret` 读取。
5. **游戏模式（DeckUI）**：relay 作为 user unit 在桌面模式登录后才会运行。纯游戏模式下要常驻，推荐把 relay 放到家里另一台 Linux / VPS / Docker，或者用 SSH 让 Deck 保持桌面会话。手机 PWA 只是浏览器页面，与 DeckUI/Steam 客户端无关，直接开 URL 即可。一键包的 `.desktop` 在桌面模式双击即可，游戏模式同样建议放 VPS / 常开 PC。
6. 固定局域网地址：路由器里给 Deck 绑定静态 DHCP，手机填 `http://<deck-ip>:8787`。

### Windows（PowerShell）

在 PowerShell（无需管理员）里，从仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File install\install-windows.ps1 -Mode All
powershell -ExecutionPolicy Bypass -File install\install-windows.ps1 -Mode Relay -Task
powershell -ExecutionPolicy Bypass -File install\install-windows.ps1 -Mode Relay -Startup
powershell -ExecutionPolicy Bypass -File install\install-windows.ps1 -Mode Host -StateHome D:\dsh-state
powershell -ExecutionPolicy Bypass -File install\install-windows.ps1 -Help
```

- `-Task`：注册登录时自动运行的 **用户级计划任务** `DSH Anywhere Relay`（`Register-ScheduledTask -Force`，无需管理员）。立即启动：`Start-ScheduledTask -TaskName 'DSH Anywhere Relay'`；删除：`Unregister-ScheduledTask -TaskName 'DSH Anywhere Relay' -Confirm:$false`。
- `-Startup`：在当前用户的「启动」文件夹放一个最小化的 `dsh-anywhere-relay.cmd`（同样无需管理员，比计划任务更轻）。
- 两者都不加就只生成脚本，手动跑：

  ```powershell
  powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh-anywhere\relay-start.ps1"
  type "$env:USERPROFILE\.dsh-anywhere\pair-code.txt"
  type "$env:USERPROFILE\.dsh-anywhere\secret"
  ```

- 远程 host 必须编辑 `%USERPROFILE%\.dsh-anywhere\host-config.ps1`，填 `DSH_ANYWHERE_RELAY` 与 `DSH_ANYWHERE_TOKEN`；本机同时跑 relay 时 token 留空即可（脚本自动读 `secret`）。
- Windows 防火墙：首次监听 `0.0.0.0:8787` 会弹「允许访问」，选**专用网络**即可；不要放行公用网络。一键包同样如此。

### Docker（relay 专用）

从**仓库根目录**构建（`-f` 路径相对根目录，上下文 `.` 必须包含 `relay/ shared/ phone/ bin/ package.json`）：

```sh
docker build -f install/Dockerfile -t dsh-anywhere:local .
docker run -d --name dsh-anywhere \
  -p 8787:8787 \
  -v dsh-anywhere-state:/app/state \
  -e DSH_ANYWHERE_TOKEN='换成一长串随机值' \
  dsh-anywhere:local
docker logs dsh-anywhere        # 打印 6 位配对码与 URL
```

- `DSH_ANYWHERE_HOME=/app/state` 是卷，持久化 `secret` / `pair-code.txt` / 事件日志；**不设 `DSH_ANYWHERE_TOKEN` 时首次启动会随机生成并写进卷**，读 `docker exec dsh-anywhere cat /app/state/secret` 取到它，再填进每台 host。
- `PORT` / `HOST` 可用 `-e` 覆盖；镜像带 `HEALTHCHECK` 打 `/api/health`。
- 只跑 relay，故用 `node:22-alpine` 即可（不需要 zstd）。若要在此镜像里也跑 host adapter，请在 Dockerfile 里 `apk add --no-cache zstd` 或换 `ARG NODE_TAG=24-alpine`，并挂载真实的 `~/.dsh/sessions/` 进来。
- 生产环境把容器放在 **Tailscale / HTTPS 反代**后面，不要把 8787 直接映射到公网（见根 [README.md](../README.md)）。

### Termux（把 Android 手机当 relay）

可以：relay 只是一个零依赖的 Node 进程，Termux 完全跑得动（适合临时/外出场景）。

```sh
pkg update && pkg install nodejs-lts zstd   # 或用 nodejs 取得 >= 22
termux-wake-lock                             # 防止 Android 杀后台（重要）
cd ~/dsh-anywhere                            # 把仓库拷/同步到这里
sh install/install.sh --relay-only --no-systemd
sh ~/.dsh-anywhere/relay-start.sh            # 前台常驻；建议放在 tmux 里
```

- Termux 没有 systemd，安装器会自动跳过 unit 并打印手动启动命令；`--no-systemd` 可显式关闭。
- 配对码 / token：`cat ~/.dsh-anywhere/pair-code.txt` 与 `cat ~/.dsh-anywhere/secret`。
- 同一局域网：`http://<手机IP>:8787`；跨网用 Tailscale（Termux 装 `tailscale` 较麻烦，更推荐把 relay 放 VPS）。
- 注意：手机息屏 / 省电策略仍可能挂起进程；长期稳定请放 VPS / SteamDeck / 常开 PC。
- 手机**同时**当控制端时，PWA 直接开 `http://127.0.0.1:8787` 即可（Termux 与浏览器同机）。

---

## 三、通用收尾（所有平台）

1. relay 启动后记下**配对码**（`pair-code.txt`）与 **token**（`secret`）；一键包无需手动记录，扫码即可。
2. 每台 Windows / SteamDeck 桌面跑 host adapter，配置 `DSH_ANYWHERE_RELAY` 指向 relay，并使用**同一个 token**（一键包的 `all` 模式已自动完成）。host 启动时会自动把内置注入桥部署进本机 DSH profile（需 DSH 桌面端正在运行，DSH HMR 免重启热加载），此后手机发令才会真正注入 live agent；DSH 未装 / 未运行 / profile 只读时优雅跳过并回退文件队列，不影响会话同步。
3. 手机浏览器打开 `http://<relay>:8787`，输入 6 位配对码换取 token → 选主机 → 看实时会话；可「添加到主屏幕」。
4. 安全：token / 配对码等同密码，勿泄露；**不要在没有 TLS 的情况下把 relay 暴露到公网**（LAN 直连 / Tailscale / HTTPS 反代，见根 [README.md](../README.md)）。
5. 卸载：
   - **一键包**：Windows「设置 → 应用」或安装目录的 `卸载.cmd`；Linux 直接删除解压目录（含 `state/`）+ 删 `.desktop`，系统无残留、无需 root。
   - **脚本安装**：删除状态目录 + 用户 unit（`systemctl --user disable --now dsh-anywhere; rm ~/.config/systemd/user/dsh-anywhere.service`）/ 计划任务 / 启动项即可，系统无残留。
