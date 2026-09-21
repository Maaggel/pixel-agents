# Pixel Agents Daemon (headless publisher)

Run Pixel Agents without VS Code. The daemon runs on the machine where Claude Code
runs, finds every live `claude` process through Claude Code's own session registry,
follows each session's JSONL transcript, and pushes agent state to the relay server.
Any browser connected to the relay sees the office live.

```
Linux server                          Relay server                 Any device
┌──────────────────────┐   WebSocket  ┌─────────────┐  WebSocket   ┌─────────┐
│ claude (CLI)         │ ───────────► │ relay/      │ ◄─────────── │ browser │
│ pixel-agents-daemon  │  publisher   │ server.mjs  │   viewer     │         │
└──────────────────────┘              └─────────────┘              └─────────┘
```

The daemon and the relay can run on the same machine or on different ones.
The relay serves the web UI + assets; the daemon only sends JSON state.

## What runs where

| Machine | What you need there | Size |
|---------|--------------------|------|
| **Claude Code server** | `pixel-agents-daemon.cjs` + `install.sh` (this tarball) and Node.js 18+ | ~60 KB |
| **Viewer/relay server** (can be the same box or elsewhere) | the full `dist/` + `relay/` - see [relay/README.md](../relay/README.md) | - |
| **Dev machine** (only to build) | this repo with `npm install` | - |

The daemon is a single self-contained file: no `node_modules`, no repo checkout,
no webview build on the Claude Code server.

## Step-by-step install

### 1. Build the tarball (dev machine)

```bash
git clone https://github.com/pablodelucca/pixel-agents.git
cd pixel-agents
npm install
npm run package:daemon
# → build/pixel-agents-daemon-<version>.tar.gz
```

No dev machine? Do the same on the server - it just needs `git` and `npm` there.

### 2. Upload it

```bash
scp build/pixel-agents-daemon-*.tar.gz you@claude-server:~
```

### 3. Install as a service (Claude Code server)

Log in **as the user that runs `claude`** (not root - session discovery reads
that user's `~/.claude/` and `/proc/<pid>/cwd`).

```bash
tar xzf pixel-agents-daemon-*.tar.gz
cd pixel-agents-daemon-*/
./install.sh --relay-url wss://yourserver.com/pixelagents/ws --relay-token your-secret-key-here
```

The installer:

1. checks for Node 18+ (`node` on your PATH; the absolute path is baked into the unit),
2. copies the bundle to `~/.local/share/pixel-agents-daemon/`,
3. writes `~/.pixel-agents/daemon.json` (mode 600) with your relay settings,
4. creates and starts the **user** systemd unit `pixel-agents-daemon`,
5. enables *linger* so the unit starts at boot and survives logout.

If step 5 prints a warning (polkit often requires root for it), run once:

```bash
sudo loginctl enable-linger $USER
```

Useful flags: `--include ~/projects` (only track sessions under that path),
`--exclude`, `--folder` (pin a project so it is always shown), `--system`
(system-wide unit under `/etc/systemd/system` running as your user - needs
`sudo`, doesn't need linger), `--uninstall`.

### 4. Check it

```bash
systemctl --user status pixel-agents-daemon
journalctl --user -u pixel-agents-daemon -f
```

You should see `Session discovery via ~/.claude/sessions registry` followed by one
`Project discovered:` and `[Registry] Bound pid ...` line per running `claude`.
Open the relay in a browser - the characters are there.

### 5. Upgrade later

Build a new tarball, upload it, and run `./install.sh` again - it replaces the
bundle, keeps your config, and restarts the service.

## Manual alternatives

**Without the installer** (any init system):

```bash
mkdir -p ~/.pixel-agents
cp daemon.example.json ~/.pixel-agents/daemon.json   # edit relayUrl / relayToken
node pixel-agents-daemon.cjs                          # foreground; Ctrl-C to stop
```

**System-wide unit by hand** (`/etc/systemd/system/pixel-agents-daemon.service`):

```ini
[Unit]
Description=Pixel Agents daemon
After=network-online.target
Wants=network-online.target

[Service]
User=you
Environment=HOME=/home/you
ExecStart=/usr/bin/node /home/you/.local/share/pixel-agents-daemon/pixel-agents-daemon.cjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then `sudo systemctl daemon-reload && sudo systemctl enable --now pixel-agents-daemon`.

**tmux/nohup** works too, but won't survive a reboot.

## Configuration

Precedence: CLI flags → environment variables → `~/.pixel-agents/daemon.json`.

| Flag | Env var | Config key | Notes |
|------|---------|------------|-------|
| `--folder <path>` (repeatable) | `PIXEL_AGENTS_FOLDERS` (`:`-separated) | `folders[]` | pinned projects (always shown) |
| `--include <prefix>` (repeatable) | `PIXEL_AGENTS_INCLUDE` (`:`-separated) | `include[]` | only track cwds under these |
| `--exclude <prefix>` (repeatable) | `PIXEL_AGENTS_EXCLUDE` (`:`-separated) | `exclude[]` | never track cwds under these |
| `--relay-url <url>` | `PIXEL_AGENTS_RELAY_URL` | `relayUrl` | omit to run local-only |
| `--relay-token <token>` | `PIXEL_AGENTS_RELAY_TOKEN` | `relayToken` | must match relay's `RELAY_TOKEN` |
| `--project-name <name>` | `PIXEL_AGENTS_PROJECT_NAME` | `projectName` | nametag prefix override |
| `--config <file>` | | | default `~/.pixel-agents/daemon.json` |

See [daemon.example.json](daemon.example.json).

## How sessions are found

The daemon does **not** guess from file timestamps. It uses the registry Claude
Code maintains for its own processes:

```
~/.claude/sessions/<pid>.json
  { "pid": 1215, "sessionId": "ad73...", "cwd": "/home/you/projects/app",
    "procStart": "6758", "name": "App (Tally)", "nameSource": "user", "status": "idle", ... }
```

Every 2 s (and immediately on any change to that directory) the daemon:

1. Reads each entry and keeps it only if the pid is **alive and its kernel start
   time (`/proc/<pid>/stat`) equals `procStart`** - a leftover file from a crashed
   or rebooted machine whose pid was reused never produces a phantom agent.
2. Collapses duplicates on `sessionId` (`claude --continue` on an existing session).
3. Maps `cwd` → `~/.claude/projects/<cwd with / → ->/` and binds the agent to
   `<sessionId>.jsonl` there. If the transcript doesn't exist yet (fresh session,
   no prompt sent) it is polled until it appears.
4. Within a project, the first session binds the `main` definition (the "Lead");
   further concurrent sessions become extra characters. A session named via
   Claude Code (`nameSource: "user"`) uses that name on its nametag.
5. When a process exits, its definition agent goes idle (stays in the office) and
   ad-hoc agents are removed - within one poll interval.

**Fallback:** if `~/.claude/sessions` doesn't exist (older Claude Code), the daemon
scans `/proc` for `claude` processes, takes each one's cwd, and pairs it with the
newest non-ended transcript whose records carry that cwd. The log line
`Session discovery via ...` tells you which mode is active.

Because discovery is per-user (`/proc/<pid>/cwd` and `~/.claude` are only readable
by the owner), run the daemon **as the user that runs Claude Code**.

## State files

- `~/.pixel-agents/daemon-state/<folder>.json` - per-folder persisted agents
  (replaces VS Code `workspaceState`)
- `~/.pixel-agents/projects/<hash>.json` - per-folder agent config (palette, seat)
- `~/.pixel-agents/sync/` - sync files also readable by the local standalone viewer
- `~/.pixel-agents/layout.json` - office layout (relay layout edits are written here)

## Troubleshooting

- **"No relay configured"** - pass `--relay-url` and `--relay-token` (or set them in the config file).
- **Relay says "bad token"** - the daemon token must equal the relay's `RELAY_TOKEN`.
- **No agents appear** - `ls ~/.claude/sessions/` should list one `<pid>.json` per
  running `claude`. If it's empty, Claude Code is running as a different user or
  the daemon's `--include`/`--exclude` filters exclude the cwd. Send `SIGUSR1` to
  the daemon (`systemctl --user kill -s USR1 pixel-agents-daemon`) to log what it
  is tracking.
- **A project shows but its character never moves** - the transcript hasn't been
  written yet (no prompt sent); the daemon polls for it and binds automatically.
- **Service dies after a Node upgrade via nvm** - the unit has the absolute node path
  baked in; re-run `./install.sh` to refresh it.
- **Stops when you log out** - linger isn't enabled: `sudo loginctl enable-linger $USER`,
  or install with `--system`.
