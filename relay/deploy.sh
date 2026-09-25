#!/usr/bin/env bash
# Deploy the built web UI (and relay code) to the relay host over FTP, then tell
# open viewers to reload. Run from the repo root after `npm run build`.
#
#   PIXEL_AGENTS_FTP_NETRC=~/.pixel-agents/relay-ftp.netrc \
#   PIXEL_AGENTS_RELAY_HTTP=https://apps.example.com/pixelagents \
#   PIXEL_AGENTS_RELAY_TOKEN=... \
#   PIXEL_AGENTS_RELAY_SSH=pixelagents-deploy \
#   relay/deploy.sh [--ui-only] [--dry-run]
#
# PIXEL_AGENTS_RELAY_SSH is an ssh alias for the restricted gate on the relay host
# (allow-listed: sudo systemctl restart pixel-agents-relay). When set and relay
# code was uploaded, the script restarts the service, waits for /api/build to
# report the new build, then triggers the viewer reload. Without it, it tells
# you to restart by hand.
#
# Netrc file (mode 600):  machine <ftp-host> login <user> password <pass>
# Reads FTP host from the netrc's `machine` line. Upload order matters: assets
# first, index.html last, so a viewer that loads mid-deploy never references a
# bundle that isn't there yet. Stale content-hashed bundles are deleted.
# Relay code (relay/server.mjs, package.json) only takes effect after
# `systemctl restart pixel-agents-relay` on the host - the script tells you.
set -euo pipefail
cd "$(dirname "$0")/.."

NETRC="${PIXEL_AGENTS_FTP_NETRC:-$HOME/.pixel-agents/relay-ftp.netrc}"
RELAY_HTTP="${PIXEL_AGENTS_RELAY_HTTP:-}"
TOKEN="${PIXEL_AGENTS_RELAY_TOKEN:-}"
GATE="${PIXEL_AGENTS_RELAY_SSH:-}"
UI_ONLY=0; DRY=0; ALLOW_SAME=0
for a in "$@"; do case "$a" in --ui-only) UI_ONLY=1;; --dry-run) DRY=1;; --allow-same-version) ALLOW_SAME=1;; --restart) FORCE_RESTART=1;; *) echo "unknown arg $a"; exit 2;; esac; done

[ -f "$NETRC" ] || { echo "netrc not found: $NETRC"; exit 1; }
FTP_HOST="$(awk '/^machine/{print $2; exit}' "$NETRC")"
[ -n "$FTP_HOST" ] || { echo "no 'machine' line in $NETRC"; exit 1; }
[ -f dist/webview/index.html ] || { echo "dist/webview/index.html missing - run npm run build"; exit 1; }
# Config from the relay host (relay reads ~/.pixel-agents/daemon.json's token too)
if [ -z "$TOKEN" ] && [ -f "$HOME/.pixel-agents/daemon.json" ]; then
  TOKEN="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).relayToken||""' "$HOME/.pixel-agents/daemon.json")"
fi

BASE="ftp://$FTP_HOST"
TMP_HASH="$(mktemp)"
trap 'rm -f "$TMP_HASH"' EXIT
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
  echo "ERROR: cannot overwrite $2 and remote content differs - fix ownership/permissions on the host (chmod 666 or chown to the FTP user)." >&2
  exit 1
}
del() { if [ "$DRY" = 1 ]; then echo "  DEL $1"; return; fi; "${C[@]}" -Q "DELE $1" "$BASE/" >/dev/null; }
listdir() { "${C[@]}" "$BASE/$1/" | awk '{print $NF}'; }

echo "==> Deploying to $FTP_HOST (ui-only=$UI_ONLY dry-run=$DRY)"

# Build id as the relay will compute it for what we are about to upload
expected="$(node -e '
  const {createHash}=require("crypto"),fs=require("fs");
  const srv=createHash("sha256").update(fs.readFileSync("relay/server.mjs")).digest("hex").slice(0,8);
  const v=JSON.parse(fs.readFileSync("package.json","utf8")).version;
  process.stdout.write(createHash("sha256").update(fs.readFileSync("dist/webview/index.html","utf8")).update(srv).update(v).digest("hex").slice(0,12))')"
live_build() { curl -s -m 10 "$RELAY_HTTP/api/build" 2>/dev/null | sed -n 's/.*"buildId":"\([a-f0-9]*\)".*/\1/p'; }
live_version() { curl -s -m 10 "$RELAY_HTTP/api/build" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }

# Version gate (playbook 2.2): a code change must carry a version bump. Same version + different
# build = someone forgot. Docs-only/refactor deploys pass with --allow-same-version, deliberately.
if [ -n "$RELAY_HTTP" ] && [ "$DRY" = 0 ]; then
  local_version="$(node -p 'require("./package.json").version')"
  lv="$(live_version)"; lb="$(live_build)"
  if [ -n "$lv" ] && [ "$lv" = "$local_version" ] && [ -n "$lb" ] && [ "$lb" != "$expected" ] && [ "$ALLOW_SAME" = 0 ]; then
    echo "ERROR: live relay is already v$local_version (build $lb) and this build differs ($expected) - bump the version in package.json and add a CHANGELOG entry, or pass --allow-same-version for a docs/refactor-only deploy." >&2
    exit 1
  fi
fi

# 1. Sprite/catalog assets (dist/assets) and webview static files - everything except index.html
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

# 3. index.html last - the moment the new UI goes live
put dist/webview/index.html dist/webview/index.html
echo "==> index.html live"

# 4. Relay code (inactive until the service restarts)
# Only a change to the relay's own code needs a restart, and a restart drops every tablet's
# stream for the minute or so their app takes to reconnect. A version bump alone does not: the
# relay re-reads package.json whenever it recomputes the build id.
RELAY_CHANGED=${FORCE_RESTART:-0}
if [ "$RELAY_CHANGED" = 1 ]; then
  echo "==> --restart given: the relay will be restarted whether or not its code changed"
fi
if [ "$UI_ONLY" = 0 ]; then
  for f in relay/*.mjs; do put "$f" "$f"; done   # server.mjs and every module it imports
  put package.json package.json
  put relay/package.json relay/package.json
  RELAY_HASH="$(cat relay/*.mjs relay/package.json | sha1sum | cut -d' ' -f1)"
  PREV_HASH="$("${C[@]}" "$BASE/relay/.deployed-code" 2>/dev/null || true)"
  if [ "$RELAY_HASH" != "$PREV_HASH" ]; then
    RELAY_CHANGED=1
    printf '%s' "$RELAY_HASH" > "$TMP_HASH"
    put "$TMP_HASH" relay/.deployed-code
    echo "==> relay code changed - it will be restarted"
  elif [ "$RELAY_CHANGED" = 0 ]; then
    echo "==> relay code unchanged - leaving it running (tablets keep their stream)"
  fi
fi

# 5. Restart the relay through the SSH gate if its code changed, or --restart was given.
# The relay reads the furniture catalog, the sprites and the character parts once at startup, so a
# deploy that only adds assets needs --restart before they appear.
if [ "$DRY" = 1 ]; then exit 0; fi

if [ "$RELAY_CHANGED" = 1 ]; then
  if [ -n "$GATE" ]; then
    echo "==> Restarting relay via ssh $GATE"
    if ssh -o BatchMode=yes -o ConnectTimeout=10 "$GATE" 'sudo systemctl restart pixel-agents-relay'; then
      for i in $(seq 1 20); do
        sleep 1
        if [ -n "$RELAY_HTTP" ] && [ "$(live_build)" = "$expected" ]; then
          echo "==> Relay is back with build $expected"
          break
        fi
        [ "$i" = 20 ] && echo "WARNING: relay did not report build $expected within 20s - check: ssh $GATE 'sudo journalctl -u pixel-agents-relay -n 200 --no-pager'" >&2
      done
    else
      echo "WARNING: gate restart failed - restart by hand: sudo systemctl restart pixel-agents-relay" >&2
    fi
  else
    echo "==> relay code changed and no PIXEL_AGENTS_RELAY_SSH set - restart by hand: sudo systemctl restart pixel-agents-relay"
  fi
fi

# 6. Tell viewers to reload (a restart already made them reload on reconnect; this covers UI-only deploys)
if [ -n "$RELAY_HTTP" ] && [ -n "$TOKEN" ]; then
  if [ -n "$(live_build)" ]; then
    res="$(curl -s -m 10 -X POST -H "Authorization: Bearer $TOKEN" "$RELAY_HTTP/api/reload")"
    echo "==> Viewers told to reload: $res"
    [ "$(live_build)" = "$expected" ] && echo "==> Live build matches local build ($expected)" || echo "WARNING: live build $(live_build) != local $expected" >&2
  else
    echo "==> Relay on $RELAY_HTTP predates auto-reload (no /api/build) - restart it; viewers must refresh once by hand this time."
  fi
else
  echo "==> Set PIXEL_AGENTS_RELAY_HTTP (+ token) to trigger viewer reload automatically."
fi
exit 0
