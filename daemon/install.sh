#!/usr/bin/env bash
# Pixel Agents daemon installer — run ON the machine where Claude Code runs,
# AS the user that runs Claude Code. Installs the bundle, writes the config,
# and registers a systemd service that starts on boot.
#
#   ./install.sh --relay-url wss://host/pixelagents/ws --relay-token SECRET [--include ~/projects]
#   ./install.sh --system ...     # system-wide unit (needs sudo) instead of a user unit
#   ./install.sh --uninstall
#
# Re-running with a new bundle upgrades in place and restarts the service.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${PIXEL_AGENTS_HOME:-$HOME/.local/share/pixel-agents-daemon}"
CONFIG_DIR="$HOME/.pixel-agents"
CONFIG_FILE="$CONFIG_DIR/daemon.json"
UNIT_NAME="pixel-agents-daemon"
BUNDLE="pixel-agents-daemon.cjs"
MIN_NODE_MAJOR=18

RELAY_URL="" RELAY_TOKEN="" INCLUDE=() EXCLUDE=() FOLDERS=() MODE="user" UNINSTALL=0

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --relay-url)   RELAY_URL="$2"; shift 2 ;;
    --relay-token) RELAY_TOKEN="$2"; shift 2 ;;
    --include)     INCLUDE+=("$2"); shift 2 ;;
    --exclude)     EXCLUDE+=("$2"); shift 2 ;;
    --folder)      FOLDERS+=("$2"); shift 2 ;;
    --system)      MODE="system"; shift ;;
    --uninstall)   UNINSTALL=1; shift ;;
    -h|--help)     usage ;;
    *) echo "Unknown option: $1"; usage 2 ;;
  esac
done

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ── Uninstall ────────────────────────────────────────────────
if [ "$UNINSTALL" = 1 ]; then
  if [ "$MODE" = system ]; then
    sudo systemctl disable --now "$UNIT_NAME" 2>/dev/null || true
    sudo rm -f "/etc/systemd/system/$UNIT_NAME.service"; sudo systemctl daemon-reload
  else
    systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/$UNIT_NAME.service"; systemctl --user daemon-reload
  fi
  rm -rf "$INSTALL_DIR"
  log "Removed service and $INSTALL_DIR (config kept at $CONFIG_FILE)"
  exit 0
fi

# ── Preflight ────────────────────────────────────────────────
[ "$(id -u)" -ne 0 ] || die "Run as the user that runs Claude Code, not root (discovery reads that user's ~/.claude)."
# Bundle lives next to install.sh in the tarball; when run from a repo checkout, fall back to dist/
BUNDLE_SRC="$SRC_DIR/$BUNDLE"
[ -f "$BUNDLE_SRC" ] || BUNDLE_SRC="$SRC_DIR/../dist/$BUNDLE"
[ -f "$BUNDLE_SRC" ] || die "$BUNDLE not found next to install.sh (or in ../dist) — run 'npm run package:daemon' and upload the tarball."
command -v systemctl >/dev/null || die "systemd not found; start the daemon another way (see README)."
# `systemctl --user` needs the user bus; non-login shells (ssh host 'cmd', cron) often lack these.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
if [ "$MODE" = user ] && ! systemctl --user is-system-running >/dev/null 2>&1; then
  die "No systemd user manager for $USER (is this a login-capable account?). Use --system to install a system-wide unit instead."
fi

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "Node.js not found. Install Node $MIN_NODE_MAJOR+ (e.g. https://github.com/nvm-sh/nvm or your distro package) and re-run."
NODE_BIN="$(readlink -f "$NODE_BIN")"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] || die "Node $NODE_MAJOR found at $NODE_BIN; need $MIN_NODE_MAJOR+."
log "Node $("$NODE_BIN" -v) at $NODE_BIN"

if [ ! -d "$HOME/.claude" ]; then
  warn "$HOME/.claude does not exist — has Claude Code ever run as $USER on this machine? The daemon will find nothing until it does."
fi

# ── Files ────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR" "$CONFIG_DIR"
install -m 755 "$BUNDLE_SRC" "$INSTALL_DIR/$BUNDLE"
[ -f "$SRC_DIR/README.md" ] && install -m 644 "$SRC_DIR/README.md" "$INSTALL_DIR/README.md"
log "Installed $INSTALL_DIR/$BUNDLE"

# ── Config ───────────────────────────────────────────────────
json_array() { # prints a JSON array from args
  local out="[" first=1 v
  for v in "$@"; do
    [ $first = 1 ] || out+=","
    out+="\"${v//\"/\\\"}\""; first=0
  done
  printf '%s]' "$out"
}
expand_home() { printf '%s' "${1/#\~/$HOME}"; }

if [ -n "$RELAY_URL" ] || [ -n "$RELAY_TOKEN" ] || [ ${#INCLUDE[@]} -gt 0 ] || [ ${#EXCLUDE[@]} -gt 0 ] || [ ${#FOLDERS[@]} -gt 0 ] || [ ! -f "$CONFIG_FILE" ]; then
  if [ ! -f "$CONFIG_FILE" ] && { [ -z "$RELAY_URL" ] || [ -z "$RELAY_TOKEN" ]; }; then
    echo "Relay settings (from relay/server.mjs: its URL and RELAY_TOKEN):"
    [ -n "$RELAY_URL" ]   || read -r -p "  Relay WebSocket URL (e.g. wss://host/pixelagents/ws): " RELAY_URL
    [ -n "$RELAY_TOKEN" ] || read -r -s -p "  Relay token: " RELAY_TOKEN; echo
  fi
  # Merge with existing config so a partial re-run keeps old values
  if [ -f "$CONFIG_FILE" ]; then
    OLD_URL="$("$NODE_BIN" -p 'try{JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).relayUrl||""}catch{""}' "$CONFIG_FILE")"
    OLD_TOKEN="$("$NODE_BIN" -p 'try{JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).relayToken||""}catch{""}' "$CONFIG_FILE")"
    [ -n "$RELAY_URL" ]   || RELAY_URL="$OLD_URL"
    [ -n "$RELAY_TOKEN" ] || RELAY_TOKEN="$OLD_TOKEN"
  fi
  INC=(); for v in "${INCLUDE[@]+"${INCLUDE[@]}"}"; do INC+=("$(expand_home "$v")"); done
  EXC=(); for v in "${EXCLUDE[@]+"${EXCLUDE[@]}"}"; do EXC+=("$(expand_home "$v")"); done
  FLD=(); for v in "${FOLDERS[@]+"${FOLDERS[@]}"}"; do FLD+=("$(expand_home "$v")"); done
  umask 077
  cat > "$CONFIG_FILE" <<JSON
{
  "relayUrl": "${RELAY_URL}",
  "relayToken": "${RELAY_TOKEN}",
  "include": $(json_array "${INC[@]+"${INC[@]}"}"),
  "exclude": $(json_array "${EXC[@]+"${EXC[@]}"}"),
  "folders": $(json_array "${FLD[@]+"${FLD[@]}"}")
}
JSON
  umask 022
  log "Wrote $CONFIG_FILE"
else
  log "Keeping existing $CONFIG_FILE"
  RELAY_URL="$("$NODE_BIN" -p 'try{JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).relayUrl||""}catch{""}' "$CONFIG_FILE")"
fi
[ -n "$RELAY_URL" ] || warn "No relay URL configured — daemon runs local-only. Edit $CONFIG_FILE and restart."

# ── Service ──────────────────────────────────────────────────
UNIT_BODY="[Unit]
Description=Pixel Agents daemon (Claude Code → relay publisher)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/$BUNDLE
Restart=always
RestartSec=5
# Config lives in $CONFIG_FILE; env vars here override it.
#Environment=PIXEL_AGENTS_RELAY_URL=wss://host/pixelagents/ws
#Environment=PIXEL_AGENTS_RELAY_TOKEN=secret
"

if [ "$MODE" = system ]; then
  UNIT_FILE="/etc/systemd/system/$UNIT_NAME.service"
  printf '%s\nUser=%s\nEnvironment=HOME=%s\n\n[Install]\nWantedBy=multi-user.target\n' "$UNIT_BODY" "$USER" "$HOME" | sudo tee "$UNIT_FILE" >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable "$UNIT_NAME" >/dev/null
  sudo systemctl restart "$UNIT_NAME"
  log "System service installed and started ($UNIT_FILE)"
  SYSCTL="sudo systemctl"; LOGS="sudo journalctl -u $UNIT_NAME -f"
else
  mkdir -p "$HOME/.config/systemd/user"
  UNIT_FILE="$HOME/.config/systemd/user/$UNIT_NAME.service"
  printf '%s\n[Install]\nWantedBy=default.target\n' "$UNIT_BODY" > "$UNIT_FILE"
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT_NAME" >/dev/null
  systemctl --user restart "$UNIT_NAME"
  log "User service installed and started ($UNIT_FILE)"
  # Without linger the user manager (and this service) stops when the last login ends.
  if loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
    log "Linger already enabled — service survives logout and starts at boot"
  elif loginctl enable-linger "$USER" 2>/dev/null; then
    log "Enabled linger for $USER — service survives logout and starts at boot"
  else
    warn "Could not enable linger. Run once:  sudo loginctl enable-linger $USER   (otherwise the daemon stops when you log out)"
  fi
  SYSCTL="systemctl --user"; LOGS="journalctl --user -u $UNIT_NAME -f"
fi

sleep 1
$SYSCTL is-active --quiet "$UNIT_NAME" && ok=1 || ok=0
if [ "$ok" = 1 ]; then
  log "Daemon is running. Tracking $(ls "$HOME/.claude/sessions" 2>/dev/null | grep -c '\.json$' || echo 0) registered Claude Code process(es) right now."
else
  warn "Service is not active — check: $LOGS"
fi
echo
echo "  Status:   $SYSCTL status $UNIT_NAME"
echo "  Logs:     $LOGS"
echo "  Restart:  $SYSCTL restart $UNIT_NAME"
echo "  Config:   $CONFIG_FILE  (edit, then restart)"
echo "  Upgrade:  upload a new tarball and run ./install.sh again"
echo "  Remove:   ./install.sh --uninstall"
