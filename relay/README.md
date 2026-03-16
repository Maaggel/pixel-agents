# Pixel Agents Relay Server

WebSocket relay that bridges VS Code extension state to remote browser viewers. Run it on a server (e.g. Raspberry Pi) so you can watch your pixel office from any device.

## How it works

```
VS Code  --(WebSocket)-->  Relay Server  <--(WebSocket)--  Browser/Tablet
(publisher)                (your server)                   (viewer)
```

- **Publishers** (VS Code extensions) push agent state over WebSocket
- **Viewers** (browsers) connect and receive live updates
- Assets (sprites, furniture) are loaded from PNGs at server startup
- Layout edits sync bidirectionally between all connected clients
- Simple shared token for authentication

## Prerequisites

- Node.js 18+ (`node --version`)
- The built extension (`npm run build` in the project root)
- Apache with `mod_proxy` and `mod_proxy_wstunnel` (if using a reverse proxy)

## Quick start (local test)

```bash
# From the project root
npm run build

# Install relay dependencies
cd relay && npm install && cd ..

# Start the relay
RELAY_TOKEN=my-secret-key npm run relay
```

Open `http://localhost:7601` in a browser. You'll see a token prompt — enter `my-secret-key`.

## Server deployment

### 1. Copy files to the server

```bash
# From your dev machine
scp -r dist/ relay/ user@yourserver:~/pixel-agents/
```

You need:
- `dist/webview/` — the built web UI
- `dist/assets/` — sprite PNGs, furniture catalog, default layout
- `relay/` — the relay server code

### 2. Install dependencies on the server

```bash
ssh user@yourserver
cd ~/pixel-agents/relay
npm install
```

### 3. Run with systemd (auto-start on boot)

Create `/etc/systemd/system/pixel-agents-relay.service`:

```ini
[Unit]
Description=Pixel Agents Relay
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/pixel-agents
ExecStart=/usr/bin/node relay/server.mjs --port 7601
Environment=RELAY_TOKEN=your-secret-key-here
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable pixel-agents-relay
sudo systemctl start pixel-agents-relay

# Check status
sudo systemctl status pixel-agents-relay

# View logs
sudo journalctl -u pixel-agents-relay -f
```

### 4. Apache reverse proxy

Enable required modules:

```bash
sudo a2enmod proxy proxy_wstunnel proxy_http
sudo systemctl restart apache2
```

Add to your Apache site config (e.g. for `apps.blommemix.dk`):

```apache
<VirtualHost *:443>
    ServerName apps.blommemix.dk

    # ... your existing SSL config ...

    # Pixel Agents relay — WebSocket MUST come before HTTP proxy
    ProxyPass /pixelagents/ws ws://127.0.0.1:7601/ws
    ProxyPassReverse /pixelagents/ws ws://127.0.0.1:7601/ws

    ProxyPass /pixelagents http://127.0.0.1:7601
    ProxyPassReverse /pixelagents http://127.0.0.1:7601
</VirtualHost>
```

Reload Apache:

```bash
sudo systemctl reload apache2
```

The viewer is now available at `https://apps.blommemix.dk/pixelagents`.

### 5. Configure VS Code

In your VS Code settings (JSON):

```json
{
  "pixel-agents.relayUrl": "wss://apps.blommemix.dk/pixelagents/ws",
  "pixel-agents.relayToken": "your-secret-key-here"
}
```

The extension will start pushing agent state to the relay as soon as these are set.

## Viewer authentication

When a browser opens the relay URL for the first time, a token prompt appears. After entering the correct key, it's saved in `localStorage` — no prompt on future visits.

If the token is wrong, the server rejects the WebSocket connection (code 4001) and the prompt reappears with an error message.

To reset a stored token, clear `localStorage` for the site or open the browser console and run:
```js
localStorage.removeItem('pa-relay-token');
location.reload();
```

## Health check

```bash
curl http://localhost:7601/health
```

Returns:
```json
{"ok": true, "publishers": 1, "viewers": 2, "agents": 3}
```

## Updating

When you update the extension:

```bash
# On your dev machine
npm run build

# Copy updated files to server
scp -r dist/ relay/ user@yourserver:~/pixel-agents/

# Restart the relay
ssh user@yourserver sudo systemctl restart pixel-agents-relay
```

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `RELAY_TOKEN` | Shared authentication token | _(none — warning printed, no auth)_ |

## CLI options

| Option | Description | Default |
|--------|-------------|---------|
| `--port <number>` | HTTP/WebSocket listen port | `7601` |
