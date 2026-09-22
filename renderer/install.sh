#!/usr/bin/env bash
# Install the frame renderer as a user systemd service on the box that runs it (needs Node 22+,
# and `npm install` in renderer/ once). Same account as the daemon: it reads the relay token from
# ~/.pixel-agents/daemon.json unless renderer.json sets one.
#   renderer/install.sh            # install/upgrade + (re)start the native renderer (no browser)
#   renderer/install.sh --chrome   # the headless-Chrome renderer instead (fallback, ~5x the CPU)
#   renderer/install.sh --uninstall
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT=pixel-agents-renderer
SCRIPT=native-publisher.mjs
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now $UNIT 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/$UNIT.service"; systemctl --user daemon-reload
  echo "removed $UNIT"; exit 0
fi
if [ "${1:-}" = "--chrome" ]; then
  SCRIPT=frame-publisher.mjs
  [ -d "$DIR/node_modules/puppeteer" ] || { echo "run 'npm install' in $DIR first (downloads Chrome for puppeteer)"; exit 1; }
else
  [ -d "$DIR/node_modules/@napi-rs/canvas" ] || { echo "run 'npm install' in $DIR first"; exit 1; }
  [ -f "$DIR/native/engine.mjs" ] || { echo "missing $DIR/native/engine.mjs - run 'npm run build' (or 'node esbuild.js --headless-only') in the repo root first"; exit 1; }
fi
NODE_BIN="$(readlink -f "$(command -v node)")"
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/$UNIT.service" <<UNIT
[Unit]
Description=Pixel Agents frame renderer (legacy tablet stream)
After=network-online.target pixel-agents-daemon.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$NODE_BIN $DIR/$SCRIPT
Restart=always
RestartSec=10
Nice=10
# One physical core's hyperthread pair (i3-4150T: cores 0+2 and 1+3); the other core stays free for the owner's sessions
CPUAffinity=1 3
# Config: ~/.pixel-agents/renderer.json (viewerUrl, relayWs, token, width, height, maxFps, upscale, nametag*, keyframeSec)

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable $UNIT >/dev/null
systemctl --user restart $UNIT
sleep 3
systemctl --user is-active --quiet $UNIT && echo "$UNIT running (journalctl --user -u $UNIT -f)" || { echo "$UNIT failed:"; journalctl --user -u $UNIT -n 20 --no-pager; exit 1; }
