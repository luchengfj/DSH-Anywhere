#!/bin/sh
# DSH Anywhere - Linux / SteamDeck / Termux installer
# POSIX sh (dash / ash / bash / busybox). Zero third-party dependencies.
#
# Operates on an EXISTING checkout of this repository. It does not clone
# anything and does not run npm install (the project has no dependencies).
#
# Usage:
#   sh install/install.sh                  # relay + host on one box
#   sh install/install.sh --relay-only     # relay (+ systemd user unit)
#   sh install/install.sh --host-only      # host adapter only
#   sh install/install.sh --no-systemd     # never touch systemd
#   sh install/install.sh --enable         # also: systemctl --user enable --now
#   sh install/install.sh --src /path/to/dsh-anywhere
#   sh install/install.sh --home /path/to/state
#   sh install/install.sh --help
#
# Everything is written under $HOME/.dsh-anywhere (or --home). On SteamOS the
# root filesystem stays read-only: no sudo, no system packages, no changes
# outside the home directory are needed.

set -eu

MODE=all
USE_SYSTEMD=1
ENABLE_UNIT=0
SRC_OVERRIDE=
HOME_OVERRIDE=
RELAY_PORT=8787
RELAY_BIND=0.0.0.0

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARN:  %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
DSH Anywhere installer (Linux / SteamDeck / Termux)

Usage: sh install/install.sh [options]

  --relay-only    install relay + start script (+ systemd user unit when available)
  --host-only     install host adapter start script + host.env config only
  --no-systemd    do not install or enable a systemd user unit
  --enable        also run: systemctl --user enable --now dsh-anywhere
  --src DIR       path to the dsh-anywhere checkout (default: parent of this script)
  --home DIR      state dir (default: $HOME/.dsh-anywhere = DSH_ANYWHERE_HOME)
  --port N        relay port baked into relay-start.sh (default 8787)
  --bind ADDR     relay bind address (default 0.0.0.0; use 127.0.0.1 behind a proxy)
  --help          show this help

No npm install is needed: the project has zero third-party npm dependencies.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --relay-only) MODE=relay ;;
    --host-only)  MODE=host ;;
    --no-systemd) USE_SYSTEMD=0 ;;
    --enable)     ENABLE_UNIT=1 ;;
    --src)        shift; [ "$#" -gt 0 ] || die "--src needs a value"; SRC_OVERRIDE=$1 ;;
    --home)       shift; [ "$#" -gt 0 ] || die "--home needs a value"; HOME_OVERRIDE=$1 ;;
    --port)       shift; [ "$#" -gt 0 ] || die "--port needs a value"; RELAY_PORT=$1 ;;
    --bind)       shift; [ "$#" -gt 0 ] || die "--bind needs a value"; RELAY_BIND=$1 ;;
    -h|--help)    usage; exit 0 ;;
    *)            die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

if [ "$ENABLE_UNIT" -eq 1 ] && [ "$USE_SYSTEMD" -eq 0 ]; then
  warn "--enable ignored because --no-systemd was given"
fi

# ---------------------------------------------------------------- platform ---
UNAME_S=$(uname -s 2>/dev/null || printf unknown)
UNAME_O=$(uname -o 2>/dev/null || printf '')
IS_STEAMDECK=0
IS_TERMUX=0

case "$UNAME_O" in
  *Android*) IS_TERMUX=1 ;;
esac
if [ -d /data/data/com.termux ] || [ -n "$(command -v termux-wake-lock 2>/dev/null || printf '')" ]; then
  IS_TERMUX=1
fi

if [ -f /etc/steamdeck-release ] || [ -f /etc/steamos-release ]; then IS_STEAMDECK=1; fi
if [ -r /etc/os-release ] && grep -qiE 'steamos|steamdeck' /etc/os-release 2>/dev/null; then
  IS_STEAMDECK=1
fi
if [ -r /sys/devices/virtual/dmi/id/product_name ]; then
  PRODUCT=$(cat /sys/devices/virtual/dmi/id/product_name 2>/dev/null || printf '')
  case "$PRODUCT" in
    *Galileo*|*Jupiter*|*Neptune*|*Steam*Deck*) IS_STEAMDECK=1 ;;
  esac
fi

PLATFORM_LABEL=$UNAME_S
[ "$IS_STEAMDECK" -eq 0 ] || PLATFORM_LABEL="$PLATFORM_LABEL (SteamDeck / SteamOS)"
[ "$IS_TERMUX" -eq 0 ] || PLATFORM_LABEL="$PLATFORM_LABEL (Termux / Android)"
say "platform: $PLATFORM_LABEL"

# -------------------------------------------------------------------- node ---
NODE_BIN=$(command -v node 2>/dev/null || printf '')
[ -n "$NODE_BIN" ] || die "node not found in PATH. Install Node.js >= 22 first (see install/README.md)."
NODE_RAW=$(node --version 2>/dev/null || printf '')
[ -n "$NODE_RAW" ] || die "cannot run: node --version"
NODE_MAJOR=$(printf '%s' "$NODE_RAW" | sed 's/^v//' | cut -d. -f1)
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "cannot parse node version '$NODE_RAW'" ;;
esac
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js >= 22 is required, found $NODE_RAW. Upgrade node."
say "node:     $NODE_RAW ($NODE_BIN)"

# DSH session logs are concatenated zstd frames. Node >= 23/24 has
# zlib.zstdDecompressSync built in; Node 22 needs the zstd -d CLI fallback.
if [ "$NODE_MAJOR" -ge 23 ]; then
  say "zstd:     built-in zlib.zstdDecompressSync (no system zstd needed)"
elif command -v zstd >/dev/null 2>&1; then
  say "zstd:     $(zstd --version 2>&1 | head -n 1) (CLI fallback OK)"
else
  warn "Node $NODE_RAW has no built-in zstd decoder. Install the zstd CLI or the"
  warn "host adapter cannot decode ~/.dsh/sessions/*.jsonl.zstd files."
  warn "  Debian/Ubuntu: sudo apt install zstd   |   Arch/SteamOS: sudo pacman -S zstd"
  warn "  Termux: pkg install zstd"
fi

# ------------------------------------------------------------------ source ---
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SRC_PARENT=$(dirname -- "$SCRIPT_DIR")
if [ -n "$SRC_OVERRIDE" ]; then
  SRC_IN=$SRC_OVERRIDE
elif [ -n "$(printenv DSH_ANYWHERE_SRC 2>/dev/null || printf '')" ]; then
  SRC_IN=$(printenv DSH_ANYWHERE_SRC)
else
  SRC_IN=$SRC_PARENT
fi
SRC=$(CDPATH= cd -- "$SRC_IN" && pwd -P) || die "source directory not found: $SRC_IN (pass --src /path/to/dsh-anywhere)"
say "source:   $SRC"

if [ "$MODE" != host ]; then
  [ -f "$SRC/relay/server.mjs" ] || die "relay/server.mjs missing in $SRC (use --src /path/to/checkout)"
  [ -d "$SRC/phone" ] || warn "phone/ missing in $SRC: relay will have no PWA to serve until it exists"
fi
if [ "$MODE" != relay ]; then
  [ -f "$SRC/host/cli.mjs" ] || die "host/cli.mjs missing in $SRC (use --src /path/to/checkout)"
fi

# -------------------------------------------------------------- state dir ---
if [ -n "$HOME_OVERRIDE" ]; then
  STATE=$HOME_OVERRIDE
elif [ -n "$(printenv DSH_ANYWHERE_HOME 2>/dev/null || printf '')" ]; then
  STATE=$(printenv DSH_ANYWHERE_HOME)
else
  STATE=$HOME/.dsh-anywhere
fi
mkdir -p "$STATE" || die "cannot create state dir: $STATE"
chmod 700 "$STATE" 2>/dev/null || warn "could not chmod 700 $STATE"
say "state:    $STATE"

# ------------------------------------------------------- relay start script ---
if [ "$MODE" != host ]; then
  cat > "$STATE/relay-start.sh" <<GEN
#!/bin/sh
# Generated by install/install.sh - re-run the installer to refresh it.
# Starts the relay (REST + SSE + hosted phone PWA). Run from any cwd.
set -e
cd '$SRC' || exit 1
[ -n "\$DSH_ANYWHERE_HOME" ] || DSH_ANYWHERE_HOME='$STATE'
[ -n "\$PORT" ] || PORT='$RELAY_PORT'
[ -n "\$HOST" ] || HOST='$RELAY_BIND'
export DSH_ANYWHERE_HOME PORT HOST
exec node relay/server.mjs
GEN
  chmod 755 "$STATE/relay-start.sh"
  say "wrote:    $STATE/relay-start.sh"
fi

# -------------------------------------------------------- host start script ---
if [ "$MODE" != relay ]; then
  cat > "$STATE/host-start.sh" <<GEN
#!/bin/sh
# Generated by install/install.sh. Config lives in \$DSH_ANYWHERE_HOME/host.env
set -e
cd '$SRC' || exit 1
[ -n "\$DSH_ANYWHERE_HOME" ] || DSH_ANYWHERE_HOME='$STATE'
export DSH_ANYWHERE_HOME
CFG="\$DSH_ANYWHERE_HOME/host.env"
if [ -f "\$CFG" ]; then . "\$CFG"; fi
# On a box that also runs the relay, reuse its auto-generated token.
if [ -z "\$DSH_ANYWHERE_TOKEN" ] && [ -f "\$DSH_ANYWHERE_HOME/secret" ]; then
  DSH_ANYWHERE_TOKEN=\$(cat "\$DSH_ANYWHERE_HOME/secret")
  export DSH_ANYWHERE_TOKEN
fi
if [ -z "\$DSH_ANYWHERE_RELAY" ]; then
  printf 'ERROR: DSH_ANYWHERE_RELAY is empty. Edit %s\n' "\$CFG" >&2
  exit 1
fi
if [ -z "\$DSH_ANYWHERE_TOKEN" ]; then
  printf 'ERROR: DSH_ANYWHERE_TOKEN is empty. Copy it from the relay secret.\n' >&2
  exit 1
fi
exec node host/cli.mjs
GEN
  chmod 755 "$STATE/host-start.sh"
  say "wrote:    $STATE/host-start.sh"

  if [ ! -f "$STATE/host.env" ]; then
    cat > "$STATE/host.env" <<'GEN'
# DSH Anywhere host adapter config - sourced by host-start.sh (POSIX KEY=value).
# No spaces around '='; wrap values in single quotes only if they contain spaces.
#
# 1) Full base URL of the relay (http:// or https://, no trailing slash):
DSH_ANYWHERE_RELAY=http://127.0.0.1:8787
#
# 2) The SAME token the relay uses. On the relay box:
#      cat ~/.dsh-anywhere/secret
#    Paste its exact contents here. On a single box host-start.sh reads the
#    secret from the state dir automatically, so you may leave it empty there.
DSH_ANYWHERE_TOKEN=
#
# 3) Optional overrides:
# DSH_ANYWHERE_HOST_NAME=win-study
# DSH_ANYWHERE_HOST_ID=
# DSH_HOME=/home/deck/.dsh
GEN
    chmod 600 "$STATE/host.env" 2>/dev/null || warn "could not chmod 600 $STATE/host.env"
    say "wrote:    $STATE/host.env  <-- EDIT THIS before starting a remote host"
  else
    say "kept:     $STATE/host.env (already exists)"
  fi
fi

# ------------------------------------------------------- systemd user unit ---
UNIT_INSTALLED=0
if [ "$MODE" != host ] && [ "$USE_SYSTEMD" -eq 1 ] && [ "$IS_TERMUX" -eq 0 ]; then
  UNIT_SRC="$SCRIPT_DIR/dsh-anywhere.service"
  if command -v systemctl >/dev/null 2>&1 && [ -f "$UNIT_SRC" ]; then
    if systemctl --user show-environment >/dev/null 2>&1; then
      UNIT_DIR="$HOME/.config/systemd/user"
      mkdir -p "$UNIT_DIR"
      # The shipped unit uses systemd's %h specifier for the default home.
      # If --home was used, bake the absolute state dir into the copy instead.
      if [ "$STATE" = "$HOME/.dsh-anywhere" ]; then
        cp "$UNIT_SRC" "$UNIT_DIR/dsh-anywhere.service"
      else
        sed "s|%h/.dsh-anywhere|$STATE|g" "$UNIT_SRC" > "$UNIT_DIR/dsh-anywhere.service"
      fi
      chmod 644 "$UNIT_DIR/dsh-anywhere.service"
      UNIT_INSTALLED=1
      systemctl --user daemon-reload 2>/dev/null || warn "systemctl --user daemon-reload failed"
      say "unit:     $UNIT_DIR/dsh-anywhere.service"
      if [ "$ENABLE_UNIT" -eq 1 ]; then
        systemctl --user enable --now dsh-anywhere.service \
          && say "enabled:  systemctl --user enable --now dsh-anywhere" \
          || warn "could not enable the unit; run the command above manually"
      fi
    else
      warn "no systemd --user bus (container / headless session): skipping unit."
    fi
  else
    [ -f "$UNIT_SRC" ] || warn "install/dsh-anywhere.service not found next to this script: skipping unit."
    command -v systemctl >/dev/null 2>&1 || warn "systemctl not found: skipping unit."
  fi
fi

# ------------------------------------------------------------------ summary ---
say ""
say "== DSH Anywhere install complete =="
say "  mode      : $MODE"
say "  platform  : $PLATFORM_LABEL"
say "  source    : $SRC"
say "  state dir : $STATE"
say ""
say "Manual launch (works everywhere, no systemd required):"
[ "$MODE" = host ]  || say "  relay : sh '$STATE/relay-start.sh'"
[ "$MODE" = relay ] || say "  host  : edit '$STATE/host.env', then  sh '$STATE/host-start.sh'"
if [ "$MODE" != host ] && [ "$UNIT_INSTALLED" -eq 1 ]; then
  say ""
  say "Or use the user unit:"
  say "  systemctl --user enable --now dsh-anywhere"
  say "  journalctl --user -u dsh-anywhere -f     # startup log / pairing code"
fi
say ""
say "Phone PWA    : http://<relay-host>:$RELAY_PORT/"
say "Pairing code : cat '$STATE/pair-code.txt'   (also printed on relay stdout)"
say "Token        : cat '$STATE/secret'          (same value on every host)"
say ""
say "Security: keep the token and pairing code private; do not expose the relay"
say "          on the public internet without TLS (Tailscale or HTTPS proxy)."
[ "$IS_TERMUX" -eq 0 ] || say "Termux: run 'termux-wake-lock' so Android does not kill the relay."
[ "$IS_STEAMDECK" -eq 0 ] || say "SteamDeck: run this from Desktop Mode or over SSH; \$HOME is writable, the root fs stays read-only."
