#!/usr/bin/env node
/**
 * Pixel Agents Relay Server
 *
 * WebSocket-based relay that bridges VS Code extension state to remote browser viewers.
 * Publishers (VS Code) push agent state; viewers (browsers) receive live updates.
 *
 * Usage:  RELAY_TOKEN=secret node relay/server.mjs [--port 7601]
 */

import { createServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { join, extname, resolve } from 'path'
import { PNG } from 'pngjs'
import { WebSocketServer } from 'ws'
import { URL } from 'url'

// ── Config ──────────────────────────────────────────────────
const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '7601', 10)
const RELAY_TOKEN = process.env.RELAY_TOKEN || ''
const PROJECT_ROOT = resolve(import.meta.dirname, '..')
const PKG = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8'))
const VERSION = PKG.version || '?.?.?'
const WEBVIEW_DIST = join(PROJECT_ROOT, 'dist', 'webview')
const ASSETS_DIR = join(PROJECT_ROOT, 'dist', 'assets')
// Fallback to webview-ui/public/assets if dist/assets doesn't exist (dev mode)
const ASSETS_ROOT = existsSync(ASSETS_DIR) ? join(PROJECT_ROOT, 'dist') : join(PROJECT_ROOT, 'webview-ui', 'public')
const DEFAULT_LAYOUT = join(ASSETS_ROOT, 'assets', 'default-layout.json')

const PNG_ALPHA_THRESHOLD = 128

if (!RELAY_TOKEN) {
  console.warn('WARNING: No RELAY_TOKEN set. Anyone can connect. Set RELAY_TOKEN env var for authentication.')
}

// ── PNG parsing (mirrors assetLoader.ts) ────────────────────
function pngToSpriteData(buffer, width, height) {
  try {
    const png = PNG.sync.read(buffer)
    const sprite = []
    for (let y = 0; y < height; y++) {
      const row = []
      for (let x = 0; x < width; x++) {
        const idx = (y * png.width + x) * 4
        const r = png.data[idx], g = png.data[idx + 1], b = png.data[idx + 2], a = png.data[idx + 3]
        if (a < PNG_ALPHA_THRESHOLD) { row.push('') }
        else { row.push(`#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase()) }
      }
      sprite.push(row)
    }
    return sprite
  } catch { return Array.from({ length: height }, () => Array(width).fill('')) }
}

// ── Asset loading ───────────────────────────────────────────
function loadCharacterSprites() {
  const charDir = join(ASSETS_ROOT, 'assets', 'characters')
  const characters = []
  const DIRECTIONS = ['down', 'up', 'right']
  const FRAME_W = 16, FRAME_H = 32, FRAMES = 7
  for (let ci = 0; ci < 6; ci++) {
    const fp = join(charDir, `char_${ci}.png`)
    if (!existsSync(fp)) return null
    const png = PNG.sync.read(readFileSync(fp))
    const charData = { down: [], up: [], right: [] }
    for (let di = 0; di < 3; di++) {
      const frames = []
      for (let f = 0; f < FRAMES; f++) {
        const sprite = []
        for (let y = 0; y < FRAME_H; y++) {
          const row = []
          for (let x = 0; x < FRAME_W; x++) {
            const idx = ((di * FRAME_H + y) * png.width + (f * FRAME_W + x)) * 4
            const r = png.data[idx], g = png.data[idx + 1], b = png.data[idx + 2], a = png.data[idx + 3]
            if (a < PNG_ALPHA_THRESHOLD) row.push('')
            else row.push(`#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase())
          }
          sprite.push(row)
        }
        frames.push(sprite)
      }
      charData[DIRECTIONS[di]] = frames
    }
    characters.push(charData)
  }
  return characters
}

function loadFloorTiles() {
  const fp = join(ASSETS_ROOT, 'assets', 'floors.png')
  if (!existsSync(fp)) return null
  const png = PNG.sync.read(readFileSync(fp))
  const sprites = []
  for (let t = 0; t < 7; t++) {
    const sprite = []
    for (let y = 0; y < 16; y++) {
      const row = []
      for (let x = 0; x < 16; x++) {
        const idx = (y * png.width + (t * 16 + x)) * 4
        const r = png.data[idx], g = png.data[idx + 1], b = png.data[idx + 2], a = png.data[idx + 3]
        if (a < PNG_ALPHA_THRESHOLD) row.push('')
        else row.push(`#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase())
      }
      sprite.push(row)
    }
    sprites.push(sprite)
  }
  return sprites
}

function loadWallTiles() {
  const fp = join(ASSETS_ROOT, 'assets', 'walls.png')
  if (!existsSync(fp)) return null
  const png = PNG.sync.read(readFileSync(fp))
  const sprites = []
  for (let mask = 0; mask < 16; mask++) {
    const ox = (mask % 4) * 16, oy = Math.floor(mask / 4) * 32
    const sprite = []
    for (let r = 0; r < 32; r++) {
      const row = []
      for (let c = 0; c < 16; c++) {
        const idx = ((oy + r) * png.width + (ox + c)) * 4
        const rv = png.data[idx], gv = png.data[idx + 1], bv = png.data[idx + 2], av = png.data[idx + 3]
        if (av < PNG_ALPHA_THRESHOLD) row.push('')
        else row.push(`#${rv.toString(16).padStart(2, '0')}${gv.toString(16).padStart(2, '0')}${bv.toString(16).padStart(2, '0')}`.toUpperCase())
      }
      sprite.push(row)
    }
    sprites.push(sprite)
  }
  return sprites
}

function loadCycleFrames(framePaths, width, height, sprites) {
  const resolvedIds = []
  for (const framePath of framePaths) {
    const spriteId = framePath.split('/').pop().replace(/\.[^.]+$/, '')
    let fp = framePath.startsWith('assets/') ? framePath : `assets/${framePath}`
    const fullPath = join(ASSETS_ROOT, fp)
    if (!existsSync(fullPath)) continue
    try {
      sprites[spriteId] = pngToSpriteData(readFileSync(fullPath), width, height)
      resolvedIds.push(spriteId)
    } catch { /* skip bad frames */ }
  }
  return resolvedIds
}

function loadFurnitureAssets() {
  const catalogPath = join(ASSETS_ROOT, 'assets', 'furniture', 'furniture-catalog.json')
  if (!existsSync(catalogPath)) return null
  const catalogData = JSON.parse(readFileSync(catalogPath, 'utf-8'))
  const catalog = catalogData.assets || []
  const sprites = {}
  for (const asset of catalog) {
    let filePath = asset.file
    if (!filePath.startsWith('assets/')) filePath = `assets/${filePath}`
    const assetPath = join(ASSETS_ROOT, filePath)
    if (!existsSync(assetPath)) continue
    sprites[asset.id] = pngToSpriteData(readFileSync(assetPath), asset.width, asset.height)
    if (Array.isArray(asset.meetingCycle) && asset.meetingCycle.length > 0)
      asset.meetingCycle = loadCycleFrames(asset.meetingCycle, asset.width, asset.height, sprites)
    if (Array.isArray(asset.workCycle) && asset.workCycle.length > 0)
      asset.workCycle = loadCycleFrames(asset.workCycle, asset.width, asset.height, sprites)
    if (Array.isArray(asset.interactionCycle) && asset.interactionCycle.length > 0)
      asset.interactionCycle = loadCycleFrames(asset.interactionCycle, asset.width, asset.height, sprites)
  }
  return { catalog, sprites }
}

function loadDefaultLayout() {
  if (existsSync(DEFAULT_LAYOUT)) {
    try { return JSON.parse(readFileSync(DEFAULT_LAYOUT, 'utf-8')) } catch { /* fall through */ }
  }
  return null
}

// ── Pre-load assets at startup ──────────────────────────────
console.log('Loading assets...')
const cachedCharacters = loadCharacterSprites()
const cachedFloors = loadFloorTiles()
const cachedWalls = loadWallTiles()
const cachedFurniture = loadFurnitureAssets()
console.log(`  Characters: ${cachedCharacters ? '6 palettes' : 'not found'}`)
console.log(`  Floors: ${cachedFloors ? cachedFloors.length + ' patterns' : 'not found'}`)
console.log(`  Walls: ${cachedWalls ? cachedWalls.length + ' pieces' : 'not found'}`)
console.log(`  Furniture: ${cachedFurniture ? cachedFurniture.catalog.length + ' items' : 'not found'}`)

// ── Relay state ─────────────────────────────────────────────
/** @type {Map<string, object>} windowId → SyncWindowState */
const publisherStates = new Map()
/** @type {object|null} */
let lastLayout = loadDefaultLayout()
/** @type {Set<import('ws').WebSocket>} */
const publishers = new Set()
/** @type {Set<import('ws').WebSocket>} */
const viewers = new Set()

function broadcastToViewers(msg) {
  const data = JSON.stringify(msg)
  for (const ws of viewers) {
    if (ws.readyState === 1) ws.send(data)
  }
}

function broadcastToPublishers(msg) {
  const data = JSON.stringify(msg)
  for (const ws of publishers) {
    if (ws.readyState === 1) ws.send(data)
  }
}

function getAllWindowStates() {
  return Array.from(publisherStates.values())
}

// ── Bridge script (injected into index.html) ────────────────
function getBridgeScript() {
  return `
<style>
  :root {
    --vscode-foreground: #cccccc;
    --vscode-editor-background: #1e1e2e;
    --vscode-charts-yellow: #cca700;
    --vscode-charts-blue: #3794ff;
    --vscode-charts-green: #89d185;
    --vscode-list-activeSelectionBackground: rgba(255,255,255,0.04);
    --vscode-widget-border: rgba(255,255,255,0.12);
  }
  #pa-token-prompt {
    position: fixed; inset: 0; z-index: 99999;
    display: flex; align-items: center; justify-content: center;
    background: #1e1e2e; font-family: monospace;
  }
  #pa-token-prompt .pa-box {
    background: #2a2a3e; border: 2px solid #444466;
    padding: 32px; max-width: 360px; width: 90%;
    box-shadow: 4px 4px 0 #0a0a14;
  }
  #pa-token-prompt h2 { color: #cccccc; margin: 0 0 8px; font-size: 16px; }
  #pa-token-prompt p { color: #888; margin: 0 0 16px; font-size: 12px; }
  #pa-token-prompt input {
    width: 100%; box-sizing: border-box; padding: 8px;
    background: #1e1e2e; border: 2px solid #444466; color: #cccccc;
    font-family: monospace; font-size: 14px; outline: none;
  }
  #pa-token-prompt input:focus { border-color: #6666aa; }
  #pa-token-prompt button {
    margin-top: 12px; padding: 8px 24px; width: 100%;
    background: #444466; border: 2px solid #555577; color: #cccccc;
    font-family: monospace; font-size: 14px; cursor: pointer;
  }
  #pa-token-prompt button:hover { background: #555577; }
  #pa-token-prompt .pa-error { color: #ff6666; font-size: 12px; margin-top: 8px; display: none; }
</style>
<div id="pa-token-prompt">
  <div class="pa-box">
    <h2>Pixel Agents</h2>
    <p>Enter the instance key to connect:</p>
    <input type="password" id="pa-token-input" placeholder="Instance key" autocomplete="off" />
    <button id="pa-token-submit">Connect</button>
    <div class="pa-error" id="pa-token-error">Invalid key. Try again.</div>
  </div>
</div>
<script>
window.__PIXEL_AGENTS_STANDALONE__ = true;
window.__PIXEL_AGENTS_RELAY__ = true;

// Token management — check localStorage first
let VIEWER_TOKEN = localStorage.getItem('pa-relay-token') || '';

function showTokenPrompt() {
  const overlay = document.getElementById('pa-token-prompt');
  if (overlay) overlay.style.display = 'flex';
}
function hideTokenPrompt() {
  const overlay = document.getElementById('pa-token-prompt');
  if (overlay) overlay.style.display = 'none';
}

// If we already have a stored token, hide the prompt immediately
if (VIEWER_TOKEN) {
  // Hide prompt as soon as DOM is ready (the div is already in the HTML above)
  document.addEventListener('DOMContentLoaded', hideTokenPrompt);
  // Also try immediately in case DOM is already ready
  hideTokenPrompt();
}

// Handle token form submission
document.addEventListener('DOMContentLoaded', function() {
  const input = document.getElementById('pa-token-input');
  const btn = document.getElementById('pa-token-submit');
  const err = document.getElementById('pa-token-error');

  function submitToken() {
    const val = (input.value || '').trim();
    if (!val) return;
    VIEWER_TOKEN = val;
    localStorage.setItem('pa-relay-token', val);
    err.style.display = 'none';
    hideTokenPrompt();
    connectRelay();
  }

  btn.addEventListener('click', submitToken);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') submitToken();
  });
});

window.acquireVsCodeApi = function() {
  return {
    postMessage: function(msg) {
      if (msg.type === 'webviewReady') {
        if (VIEWER_TOKEN) {
          hideTokenPrompt();
          connectRelay();
        } else {
          showTokenPrompt();
        }
      }
      if (msg.type === 'saveLayout' && msg.layout) {
        sendToRelay({ type: 'saveLayout', layout: msg.layout });
      }
    },
    getState: function() { return null; },
    setState: function() {},
  };
};

let relayWs = null;
let reconnectDelay = 1000;
const RECONNECT_MAX = 30000;

function dispatch(data) {
  window.postMessage(data, '*');
}

function devLog(entry) {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  dispatch({ type: 'devConsoleLog', entry: '[' + hh + ':' + mm + ':' + ss + '] ' + entry });
}

function sendToRelay(msg) {
  if (relayWs && relayWs.readyState === 1) {
    relayWs.send(JSON.stringify(msg));
  }
}

const knownAgents = new Map();

function reconcileAgents(windows) {
  const currentAgents = new Map();
  for (const win of windows) {
    if (!win.agents) continue;
    for (const agent of win.agents) {
      const id = agent.localId + (win.windowId ? hashCode(win.windowId) * 1000 : 0);
      currentAgents.set(id, {
        id,
        name: agent.name || 'Agent',
        palette: agent.palette || 0,
        hueShift: agent.hueShift || 0,
        seatId: agent.seatId,
        isActive: agent.isActive || false,
        currentTool: agent.currentTool,
        toolStatus: agent.currentToolStatus,
        isWaiting: agent.isWaiting || false,
        bubbleType: agent.bubbleType,
        idleHint: agent.idleHint || null,
        workspaceName: win.workspaceName || '',
        workspaceFolder: win.workspaceFolder || '',
      });
    }
  }

  // Detect new agents
  const newAgentIds = [];
  const newAgentMeta = {};
  const newFolderNames = {};
  const newWorkspaceFolders = {};
  let projectName = '';
  for (const [id, agent] of currentAgents) {
    if (!knownAgents.has(id)) {
      newAgentIds.push(id);
      const hasExplicitPalette = agent.palette > 0 || agent.hueShift > 0;
      newAgentMeta[id] = {
        palette: hasExplicitPalette ? agent.palette : undefined,
        hueShift: hasExplicitPalette ? agent.hueShift : undefined,
        seatId: agent.seatId,
      };
      newFolderNames[id] = agent.name;
      newWorkspaceFolders[id] = agent.workspaceFolder;
      if (agent.workspaceName) projectName = agent.workspaceName;
      devLog('CREATE #' + id + ' "' + agent.name + '"');
    }
  }
  if (newAgentIds.length > 0) {
    dispatch({
      type: 'existingAgents',
      agents: newAgentIds,
      agentMeta: newAgentMeta,
      workspaceFolders: newWorkspaceFolders,
      folderNames: newFolderNames,
      projectName: projectName,
    });
  }

  // Detect removed agents
  for (const id of knownAgents.keys()) {
    if (!currentAgents.has(id)) {
      dispatch({ type: 'agentClosed', id });
      devLog('CLOSE  #' + id);
    }
  }

  // Send state updates for all current agents
  for (const [id, agent] of currentAgents) {
    const snap = JSON.stringify(agent);
    if (knownAgents.get(id) !== snap) {
      const prev = knownAgents.get(id) ? JSON.parse(knownAgents.get(id)) : null;
      const toolChange = prev && prev.currentTool !== agent.currentTool;
      const activeChange = prev && prev.isActive !== agent.isActive;
      const waitChange = prev && prev.isWaiting !== agent.isWaiting;
      if (activeChange || toolChange || waitChange) {
        const parts = [];
        if (activeChange) parts.push(agent.isActive ? 'active' : 'idle');
        if (toolChange && agent.currentTool) parts.push('tool=' + agent.currentTool);
        if (waitChange && agent.isWaiting) parts.push('waiting');
        devLog('STATUS #' + id + ' "' + agent.name + '" ' + parts.join(' '));
      }
      dispatch({
        type: 'agentStateUpdate',
        id: agent.id,
        isActive: agent.isActive,
        currentTool: agent.currentTool,
        toolStatus: agent.toolStatus,
        bubbleType: agent.bubbleType,
        idleHint: agent.idleHint,
      });
    }
    knownAgents.set(id, snap);
  }

  // Clean up removed
  for (const id of knownAgents.keys()) {
    if (!currentAgents.has(id)) {
      knownAgents.delete(id);
    }
  }
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 100;
}

function connectRelay() {
  if (!VIEWER_TOKEN) { showTokenPrompt(); return; }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = protocol + '//' + location.host + '/ws?role=viewer&token=' + encodeURIComponent(VIEWER_TOKEN);
  devLog('CONN   Connecting to relay...');

  try {
    relayWs = new WebSocket(wsUrl);
  } catch (e) {
    devLog('ERROR  WebSocket creation failed: ' + e.message);
    scheduleReconnect();
    return;
  }

  relayWs.onopen = function() {
    reconnectDelay = 1000;
    devLog('CONN   v${VERSION} — relay connected');
  };

  relayWs.onmessage = function(e) {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'init') {
        if (msg.characters) dispatch({ type: 'characterSpritesLoaded', characters: msg.characters });
        if (msg.floors) dispatch({ type: 'floorTilesLoaded', sprites: msg.floors });
        if (msg.walls) dispatch({ type: 'wallTilesLoaded', sprites: msg.walls });
        if (msg.furniture) dispatch({ type: 'furnitureAssetsLoaded', catalog: msg.furniture.catalog, sprites: msg.furniture.sprites });
        dispatch({ type: 'settingsLoaded', soundEnabled: false, showNametags: true, claudeExtAvailable: false });
        if (msg.layout) dispatch({ type: 'layoutLoaded', layout: msg.layout });
        if (msg.windows && msg.windows.length > 0) {
          reconcileAgents(msg.windows);
        }
      } else if (msg.type === 'sync') {
        reconcileAgents(msg.windows || []);
      } else if (msg.type === 'layoutUpdate') {
        dispatch({ type: 'layoutLoaded', layout: msg.layout });
      } else if (msg.type === 'authError') {
        // Bad token — clear stored token and show prompt again
        localStorage.removeItem('pa-relay-token');
        VIEWER_TOKEN = '';
        relayWs.close();
        relayWs = null;
        showTokenPrompt();
        var err = document.getElementById('pa-token-error');
        if (err) err.style.display = 'block';
      }
    } catch (err) {
      devLog('ERROR  ' + err.message);
    }
  };

  relayWs.onclose = function(e) {
    relayWs = null;
    // 4001 = invalid token — show prompt instead of reconnecting
    if (e.code === 4001) {
      localStorage.removeItem('pa-relay-token');
      VIEWER_TOKEN = '';
      showTokenPrompt();
      var errEl = document.getElementById('pa-token-error');
      if (errEl) errEl.style.display = 'block';
      return;
    }
    if (VIEWER_TOKEN) {
      devLog('CONN   Relay disconnected, reconnecting in ' + (reconnectDelay / 1000) + 's...');
      scheduleReconnect();
    }
  };

  relayWs.onerror = function() {
    // onclose will fire after this
  };
}

function scheduleReconnect() {
  setTimeout(connectRelay, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
}
</script>
`
}

// ── MIME types ───────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

// ── HTTP Server ─────────────────────────────────────────────
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const pathname = url.pathname

  // Health check
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      publishers: publishers.size,
      viewers: viewers.size,
      agents: Array.from(publisherStates.values()).reduce((n, w) => n + (w.agents?.length || 0), 0),
    }))
    return
  }

  // Serve modified index.html with bridge script
  if (pathname === '/' || pathname === '/index.html') {
    const indexPath = join(WEBVIEW_DIST, 'index.html')
    if (!existsSync(indexPath)) {
      res.writeHead(404)
      res.end('Webview not built. Run: npm run build')
      return
    }
    let html = readFileSync(indexPath, 'utf-8')
    html = html.replace('<script type="module"', getBridgeScript() + '\n    <script type="module"')
    html = html.replace(/\s+crossorigin/g, '')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
    return
  }

  // Static files from webview dist
  const filePath = join(WEBVIEW_DIST, pathname)
  if (!existsSync(filePath)) {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  const ext = extname(filePath)
  const mime = MIME[ext] || 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': mime })
  res.end(readFileSync(filePath))
})

// ── WebSocket Server ────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const role = url.searchParams.get('role')
  const token = url.searchParams.get('token')

  // Token auth
  if (RELAY_TOKEN && token !== RELAY_TOKEN) {
    console.log(`[Relay] Rejected ${role} connection: bad token`)
    ws.close(4001, 'Invalid token')
    return
  }

  if (role === 'publisher') {
    let publisherWindowId = null
    publishers.add(ws)
    console.log(`[Relay] Publisher connected (total: ${publishers.size})`)

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())

        if (msg.type === 'sync' && msg.state) {
          const windowId = msg.state.windowId || 'unknown'
          publisherWindowId = windowId
          publisherStates.set(windowId, msg.state)
          // Broadcast updated state to all viewers
          broadcastToViewers({ type: 'sync', windows: getAllWindowStates() })
        }

        if (msg.type === 'layout' && msg.layout) {
          lastLayout = msg.layout
          // Broadcast to all viewers
          broadcastToViewers({ type: 'layoutUpdate', layout: msg.layout })
          // Also broadcast to other publishers so they can sync
          const data = JSON.stringify({ type: 'layoutUpdate', layout: msg.layout })
          for (const other of publishers) {
            if (other !== ws && other.readyState === 1) other.send(data)
          }
        }
      } catch (err) {
        console.log(`[Relay] Bad publisher message: ${err.message}`)
      }
    })

    ws.on('close', () => {
      publishers.delete(ws)
      if (publisherWindowId) {
        publisherStates.delete(publisherWindowId)
        // Notify viewers that agents from this window are gone
        broadcastToViewers({ type: 'sync', windows: getAllWindowStates() })
      }
      console.log(`[Relay] Publisher disconnected (total: ${publishers.size})`)
    })

  } else if (role === 'viewer') {
    viewers.add(ws)
    console.log(`[Relay] Viewer connected (total: ${viewers.size})`)

    // Send init payload with all assets + current state
    const initPayload = {
      type: 'init',
      characters: cachedCharacters,
      floors: cachedFloors,
      walls: cachedWalls,
      furniture: cachedFurniture,
      layout: lastLayout,
      windows: getAllWindowStates(),
    }

    // Split init into chunks if needed (assets can be large)
    try {
      ws.send(JSON.stringify(initPayload))
    } catch (err) {
      console.log(`[Relay] Failed to send init: ${err.message}`)
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())

        // Viewer can save layout (bidirectional)
        if (msg.type === 'saveLayout' && msg.layout) {
          lastLayout = msg.layout
          // Broadcast to all publishers so VS Code picks it up
          broadcastToPublishers({ type: 'layoutUpdate', layout: msg.layout })
          // Broadcast to other viewers
          const data = JSON.stringify({ type: 'layoutUpdate', layout: msg.layout })
          for (const other of viewers) {
            if (other !== ws && other.readyState === 1) other.send(data)
          }
          console.log(`[Relay] Layout saved by viewer`)
        }
      } catch (err) {
        console.log(`[Relay] Bad viewer message: ${err.message}`)
      }
    })

    ws.on('close', () => {
      viewers.delete(ws)
      console.log(`[Relay] Viewer disconnected (total: ${viewers.size})`)
    })

  } else {
    console.log(`[Relay] Rejected connection: unknown role "${role}"`)
    ws.close(4002, 'Invalid role. Use ?role=publisher or ?role=viewer')
  }
})

// ── Start ───────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n  Pixel Agents Relay Server v${VERSION}`)
  console.log(`  ─────────────────────────────────`)
  console.log(`  HTTP:      http://localhost:${PORT}`)
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`)
  console.log(`  Token:     ${RELAY_TOKEN ? '***' + RELAY_TOKEN.slice(-4) : '(none)'}`)
  console.log(`\n  Waiting for publishers (VS Code) and viewers (browsers)...\n`)
})
