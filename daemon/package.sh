#!/usr/bin/env bash
# Build the standalone daemon tarball for upload to the Claude Code server.
# Called by `npm run package:daemon` after `node esbuild.js --daemon-only`.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(node -p 'require("./package.json").version')"
NAME="pixel-agents-daemon-$VERSION"
STAGE="build/$NAME"
[ -f dist/pixel-agents-daemon.cjs ] || { echo "dist/pixel-agents-daemon.cjs missing — run npm run build:daemon"; exit 1; }
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp dist/pixel-agents-daemon.cjs daemon/install.sh daemon/README.md daemon/daemon.example.json "$STAGE/"
chmod +x "$STAGE/install.sh" "$STAGE/pixel-agents-daemon.cjs"
tar -C build -czf "build/$NAME.tar.gz" "$NAME"
rm -rf "$STAGE"
echo "✓ build/$NAME.tar.gz ($(du -h "build/$NAME.tar.gz" | cut -f1))"
echo "  scp build/$NAME.tar.gz user@server:~  &&  ssh user@server 'tar xzf $NAME.tar.gz && cd $NAME && ./install.sh --relay-url wss://… --relay-token …'"
