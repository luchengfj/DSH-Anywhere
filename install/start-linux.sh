#!/bin/sh
# DSH Anywhere - self-contained Linux/SteamDeck launcher (copied to package root as start.sh).
# Prefers the bundled bin/node; falls back to a system node >= 22.
# All state stays inside the package ("state/"), so it is fully portable / read-only-root friendly.
set -u

# Locate the package root from this script's own path (no dirname dependency).
case "$0" in
	*/*) ROOT=$(CDPATH= cd -- "${0%/*}" && pwd) ;;
	*)   ROOT=$(pwd) ;;
esac
APP="$ROOT/app"
STATE="$ROOT/state"

PORT=${PORT:-8787}
HOST=${HOST:-0.0.0.0}
NODE=""

usage() {
	printf '%s\n' \
		'DSH Anywhere - 一键启动 (Linux / Steam Deck)' \
		'' \
		'用法: ./start.sh [--port N] [--host ADDR] [--help]' \
		'' \
		'  --port N     指定 relay 端口 (默认 8787; 被占用会自动 +1, 最多试 20 个)' \
		'  --host ADDR  绑定地址 (默认 0.0.0.0; 仅本机用可填 127.0.0.1)' \
		'  --help       显示本帮助' \
		'' \
		'也可直接用环境变量: PORT=9000 HOST=127.0.0.1 ./start.sh' \
		'DSH_ANYWHERE_HOME 固定为包内 state/ (便携, 不写家目录)。'
}

while [ $# -gt 0 ]; do
	case "$1" in
		--port)
			[ $# -ge 2 ] || { echo "start.sh: --port 需要一个端口号" >&2; exit 2; }
			PORT=$2; shift 2 ;;
		--host)
			[ $# -ge 2 ] || { echo "start.sh: --host 需要一个地址" >&2; exit 2; }
			HOST=$2; shift 2 ;;
		-h|--help) usage; exit 0 ;;
		*) echo "start.sh: 未知参数: $1 (用 --help 查看用法)" >&2; exit 2 ;;
	esac
done

case "$PORT" in
	""|*[!0-9]*) echo "start.sh: 端口必须是数字, 收到: $PORT" >&2; exit 2 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
	echo "start.sh: 端口超出范围 (1-65535): $PORT" >&2; exit 2;
fi

# --- 选择 Node 运行时 ---
if [ -x "$ROOT/bin/node" ]; then
	NODE="$ROOT/bin/node"
else
	if ! command -v node >/dev/null 2>&1; then
		echo "start.sh: 找不到 Node.js。" >&2
		echo "  本包应自带 bin/node; 若缺失, 请安装 Node.js >= 22 后重试。" >&2
		exit 1;
	fi
	NODE=$(command -v node)
	ver=$($NODE -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
	case "$ver" in ""|*[!0-9]*) ver=0 ;; esac
	if [ "$ver" -lt 22 ]; then
		echo "start.sh: 系统 node 版本过低 ($($NODE -v 2>/dev/null)), 需要 >= 22。" >&2
		echo "  请使用包内自带的 bin/node, 或升级系统 Node。" >&2
		exit 1;
	fi
fi

if [ ! -f "$APP/bin/cli.mjs" ]; then
	echo "start.sh: 找不到 $APP/bin/cli.mjs, 包结构不完整。" >&2
	exit 1;
fi

mkdir -p "$STATE" || { echo "start.sh: 无法创建状态目录 $STATE" >&2; exit 1; }

# --- 端口被占用则自动 +1, 最多试 20 个 (主判据用 node 真实绑定一次) ---
port_free() {
	if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q "[:.]$1[[:space:]]"; then return 1; fi
	if command -v netstat >/dev/null 2>&1 && netstat -ltn 2>/dev/null | grep -q "[:.]$1[[:space:]]"; then return 1; fi
	$NODE -e "const s=require('net').createServer();s.once('error',()=>process.exit(1));s.listen(Number(process.argv[1]),process.argv[2]||'0.0.0.0',()=>s.close(()=>process.exit(0)));" "$1" "$HOST" 2>/dev/null
}

base=$PORT; i=0
while [ "$i" -lt 20 ]; do
	if port_free "$PORT"; then break; fi
	echo "start.sh: 端口 $PORT 已被占用, 尝试 $((PORT + 1)) ..." >&2
	PORT=$((PORT + 1)); i=$((i + 1));
	if [ "$PORT" -gt 65535 ]; then PORT=$base; break; fi
done
if [ "$i" -ge 20 ]; then
	echo "start.sh: $base 起连续 20 个端口都被占用, 请用 --port 指定空闲端口。" >&2
	exit 1;
fi

# --- 便携环境变量 ---
DSH_ANYWHERE_HOME="$STATE"
export DSH_ANYWHERE_HOME PORT HOST

# --- 取一个非回环 IPv4 作为手机链接地址 (无则回退 127.0.0.1) ---
lan_ip() {
	$NODE -e "const o=require('os').networkInterfaces();for(const k in o)for(const a of o[k])if(a&&a.family==='IPv4'&&!a.internal){console.log(a.address);process.exit(0)}" 2>/dev/null
}
ip=$(lan_ip)
ip=${ip:-127.0.0.1}

# --- 启动: 后台拉起, 读取 relay 生成的 6 位配对码, 再打印完整扫码链接 ---
# relay 在 createRelay() 里把配对码同步写入 state/pair-code.txt; 先删掉旧码,
# 避免轮询时误读到上一次运行的码。
rm -f "$STATE/pair-code.txt"
"$NODE" "$APP/bin/cli.mjs" all &
PID=$!
trap 'kill -INT "$PID" 2>/dev/null' INT
trap 'kill -TERM "$PID" 2>/dev/null' TERM

CODE=""
i=0
while [ "$i" -lt 20 ]; do
  if [ -s "$STATE/pair-code.txt" ]; then CODE=$(cat "$STATE/pair-code.txt" 2>/dev/null); break; fi
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  sleep 1; i=$((i + 1));
done

phone="http://$ip:$PORT/?pair=$CODE"
# URL-encode the phone link for the qr.html ?u= parameter (no external deps).
enc=$($NODE -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$phone" 2>/dev/null || printf '%s' "$phone")
qrpage="http://127.0.0.1:$PORT/qr.html?u=$enc&code=$CODE"

echo "================================================================"
echo "  DSH Anywhere  一键启动"
echo "  运行时 : $NODE"
echo "  状态目录: $STATE"
echo "  监听   : $HOST:$PORT"
echo "================================================================"
if [ -n "$CODE" ]; then
  echo "  配对码   : $CODE"
  echo "  手机打开 : $phone"
  echo "  二维码页 : $qrpage"
  echo "  在电脑浏览器打开上面的「二维码页」, 用手机扫码即可自动配对。"
else
  echo "  配对码尚未就绪(服务可能启动失败), 请查看下面的输出与 $STATE 目录。"
fi
echo "  手机与电脑连同一个 Wi-Fi; 若扫码失败, 直接打开「手机打开」链接。"
echo "  首次启动 Windows 防火墙请选「专用网络」(Linux 请放行 $PORT/tcp)。"
echo "  按 Ctrl-C 停止。文档见 直接安装.md / README.md。"
echo "================================================================"
echo ""

# 桌面环境有图形会话时, 尝试自动打开二维码页(失败不影响服务)。
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
  (sleep 1; xdg-open "$qrpage" >/dev/null 2>&1) &
fi

# 前台等待, Ctrl-C / 终止信号由上面的 trap 透传给 node 进程组。
wait "$PID" 2>/dev/null
status=$?
trap - INT TERM
exit "$status"
