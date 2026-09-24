#!/bin/sh
# Rebuild the engine the tablet renderer draws with, and restart it.
#
# Run as part of `npm run deploy`: the renderer is a local service and nothing else restarts it, so
# without this the tablet keeps drawing with the engine it started with - and the version stamp in
# the corner of its picture would claim a build it is not running.
set -e
cd "$(dirname "$0")/.."
node esbuild.js --headless-only
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then XDG_RUNTIME_DIR=/run/user/$(id -u); export XDG_RUNTIME_DIR; fi
if systemctl --user list-unit-files pixel-agents-renderer.service >/dev/null 2>&1 \
  && systemctl --user is-enabled pixel-agents-renderer >/dev/null 2>&1; then
  systemctl --user restart pixel-agents-renderer
  echo "==> Tablet renderer restarted on $(node -p 'require("./package.json").version')"
else
  echo "==> No tablet renderer installed here, skipping"
fi
