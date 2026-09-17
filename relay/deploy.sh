#!/usr/bin/env bash
# Deploy the built web UI (and relay code) to the relay host over FTP, then tell
# open viewers to reload. Run from the repo root after `npm run build`.
#
#   PIXEL_AGENTS_FTP_NETRC=~/.pixel-agents/relay-ftp.netrc \
#   PIXEL_AGENTS_RELAY_HTTP=https://apps.example.com/pixelagents \
#   PIXEL_AGENTS_RELAY_TOKEN=… \
#   relay/deploy.sh [--ui-only] [--dry-run]
#
# Netrc file (mode 600):  machine <ftp-host> login <user> password <pass>
# Reads FTP host from the netrc's `machine` line. Upload order matters: assets
# first, index.html last, so a viewer that loads mid-deploy never references a
# bundle that isn't there yet. Stale content-hashed bundles are deleted.
# Relay code (relay/server.mjs, package.json) only takes effect after
# `systemctl restart pixel-agents-relay` on the host — the script tells you.
set -euo pipefail
cd "$(dirname "$0")/.."

NETRC="${PIXEL_AGENTS_FTP_NETRC:-$HOME/.pixel-agents/relay-ftp.netrc}"
RELAY_HTTP="${PIXEL_AGENTS_RELAY_HTTP:-}"
TOKEN="${PIXEL_AGENTS_RELAY_TOKEN:-}"
UI_ONLY=0; DRY=0
for a in "$@"; do case "$a" in --ui-only) UI_ONLY=1;; --dry-run) DRY=1;; *) echo "unknown arg $a"; exit 2;; esac; done

[ -f "$NETRC" ] || { echo "netrc not found: $NETRC"; exit 1; }
FTP_HOST="$(awk '/^machine/{print $2; exit}' "$NETRC")"
[ -n "$FTP_HOST" ] || { echo "no 'machine' line in $NETRC"; exit 1; }
[ -f dist/webview/index.html ] || { echo "dist/webview/index.html missing — run npm run build"; exit 1; }
# Config from the relay host (relay reads ~/.pixel-agents/daemon.json's token too)
if [ -z "$TOKEN" ] && [ -f "$HOME/.pixel-agents/daemon.json" ]; then
  TOKEN="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).relayToken||""' "$HOME/.pixel-agents/daemon.json")"
fi

BASE="ftp://$FTP_HOST"
C=(curl -sS --netrc-file "$NETRC" -m 120 --ftp-create-dirs)
put() { # put <local> <remote-path>
  if [ "$DRY" = 1 ]; then echo "  PUT $2"; return; fi
  if "${C[@]}" -T "$1" "$BASE/$2" 2>/dev/null; then return; fi
  # Upload refused (typically 553: existing file owned by another user, mode 644).
  # Fine if the remote copy is already identical; otherwise stop before index.html goes live.
  local remote_sum local_sum
  remote_sum="$("${C[@]}" "$BASE/$2" 2>/dev/null | sha1sum | cut -d' ' -f1)"
  local_sum="$(sha1sum "$1" | cut -d' ' -f1)"
  if [ "$remote_sum" = "$local_sum" ]; then
    echo "  skip $2 (not writable, but identical)"
    return
  fi
  echo "ERROR: cannot overwrite $2 and remote content differs — fix ownership/permissions on the host (chmod 666 or chown to the FTP user)." >&2
  exit 1
}
del() { if [ "$DRY" = 1 ]; then echo "  DEL $1"; return; fi; "${C[@]}" -Q "DELE $1" "$BASE/" >/dev/null; }
listdir() { "${C[@]}" "$BASE/$1/" | awk '{print $NF}'; }

echo "==> Deploying to $FTP_HOST (ui-only=$UI_ONLY dry-run=$DRY)"

# 1. Sprite/catalog assets (dist/assets) and webview static files — everything except index.html
n=0
while IFS= read -r -d '' f; do
  rel="${f#./}"
  [ "$rel" = "dist/webview/index.html" ] && continue
  put "$f" "$rel"; n=$((n+1))
done < <(find ./dist/assets ./dist/webview -type f -print0 | sort -z)
echo "==> Uploaded $n asset/static files"

# 2. Remove stale content-hashed bundles no longer referenced by this build
for remote in $(listdir dist/webview/assets | grep -E '^index-[A-Za-z0-9_-]+\.(js|css)$' || true); do
  [ -f "dist/webview/assets/$remote" ] || { del "dist/webview/assets/$remote"; echo "  removed stale $remote"; }
done

# 3. index.html last — the moment the new UI goes live
put dist/webview/index.html dist/webview/index.html
echo "==> index.html live"

# 4. Relay code (inactive until the service restarts)
RELAY_CHANGED=0
if [ "$UI_ONLY" = 0 ]; then
  put relay/server.mjs relay/server.mjs
  put package.json package.json
  put relay/package.json relay/package.json
  RELAY_CHANGED=1
  echo "==> relay/server.mjs + package.json uploaded (needs: sudo systemctl restart pixel-agents-relay)"
fi

# 5. Tell viewers to reload (only works once the build-id relay is running)
if [ "$DRY" = 1 ]; then exit 0; fi
if [ -n "$RELAY_HTTP" ] && [ -n "$TOKEN" ]; then
  live="$(curl -s -m 10 "$RELAY_HTTP/api/build" || true)"
  if echo "$live" | grep -q buildId; then
    res="$(curl -s -m 10 -X POST -H "Authorization: Bearer $TOKEN" "$RELAY_HTTP/api/reload")"
    echo "==> Viewers told to reload: $res"
  else
    echo "==> Relay on $RELAY_HTTP predates auto-reload (no /api/build) — restart it; viewers must refresh once by hand this time."
  fi
else
  echo "==> Set PIXEL_AGENTS_RELAY_HTTP (+ token) to trigger viewer reload automatically."
fi
[ "$RELAY_CHANGED" = 1 ] && echo "==> Remember: ssh pixelagents-deploy 'sudo systemctl restart pixel-agents-relay'"
exit 0
