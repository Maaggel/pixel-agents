#!/usr/bin/env node
/**
 * Standalone browser server for Pixel Agents.
 *
 * Serves the webview-ui build with a bridge that mocks the VS Code API,
 * reads layout/sync/assets from disk, and polls for live updates.
 *
 * Usage:  node standalone/server.js [--port 3000]
 */

import { createServer } from 'http'
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, extname, resolve } from 'path'
import { homedir } from 'os'
import { PNG } from 'pngjs'

// ── Config ──────────────────────────────────────────────────
const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '3000', 10)
const PROJECT_ROOT = resolve(import.meta.dirname, '..')
const WEBVIEW_DIST = join(PROJECT_ROOT, 'dist', 'webview')
const ASSETS_DIR = join(PROJECT_ROOT, 'dist', 'assets')
// Fallback to webview-ui/public/assets if dist/assets doesn't exist (dev mode)
const ASSETS_ROOT = existsSync(ASSETS_DIR) ? join(PROJECT_ROOT, 'dist') : join(PROJECT_ROOT, 'webview-ui', 'public')
const LAYOUT_FILE = join(homedir(), '.pixel-agents', 'layout.json')
const SYNC_DIR = join(homedir(), '.pixel-agents', 'sync')
const DEFAULT_LAYOUT = join(ASSETS_ROOT, 'assets', 'default-layout.json')

const PNG_ALPHA_THRESHOLD = 128

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
  }
  return { catalog, sprites }
}

function loadLayout() {
  if (existsSync(LAYOUT_FILE)) {
    try { return JSON.parse(readFileSync(LAYOUT_FILE, 'utf-8')) } catch { /* fall through */ }
  }
  if (existsSync(DEFAULT_LAYOUT)) {
    try { return JSON.parse(readFileSync(DEFAULT_LAYOUT, 'utf-8')) } catch { /* fall through */ }
  }
  return null
}

function loadSyncWindows() {
  const windows = []
  if (!existsSync(SYNC_DIR)) return windows
  const now = Date.now()
  for (const f of readdirSync(SYNC_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      const state = JSON.parse(readFileSync(join(SYNC_DIR, f), 'utf-8'))
      if (now - state.updatedAt > 30000) {
        // Check if process alive
        try { process.kill(state.pid, 0) } catch { continue }
      }
      windows.push(state)
    } catch { /* skip */ }
  }
  return windows
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

// ── Bridge script (injected into index.html) ────────────────
const BRIDGE_SCRIPT = `
<style>
  /* VS Code CSS variables that the webview expects — provide dark theme defaults for standalone browser */
  :root {
    --vscode-foreground: #cccccc;
    --vscode-editor-background: #1e1e2e;
    --vscode-charts-yellow: #cca700;
    --vscode-charts-blue: #3794ff;
    --vscode-charts-green: #89d185;
    --vscode-list-activeSelectionBackground: rgba(255,255,255,0.04);
    --vscode-widget-border: rgba(255,255,255,0.12);
  }
</style>
<script>
// Mock VS Code API for standalone browser mode
window.__PIXEL_AGENTS_STANDALONE__ = true;
window.acquireVsCodeApi = function() {
  return {
    postMessage: function(msg) {
      if (msg.type === 'webviewReady') {
        // Fetch init data from server and dispatch as messages
        fetch('/api/init').then(r => r.json()).then(data => {
          if (data.characters) dispatch({ type: 'characterSpritesLoaded', characters: data.characters });
          if (data.floors) dispatch({ type: 'floorTilesLoaded', sprites: data.floors });
          if (data.walls) dispatch({ type: 'wallTilesLoaded', sprites: data.walls });
          if (data.furniture) dispatch({ type: 'furnitureAssetsLoaded', catalog: data.furniture.catalog, sprites: data.furniture.sprites });
          dispatch({ type: 'settingsLoaded', soundEnabled: false, showNametags: true, claudeExtAvailable: false });
          dispatch({ type: 'layoutLoaded', layout: data.layout });
          // Start polling for sync updates
          startSyncPolling();
        });
      }
      // Ignore other messages (saveLayout, saveAgentSeats, etc.) in read-only mode
    },
    getState: function() { return null; },
    setState: function() {},
  };
};

function dispatch(data) {
  window.postMessage(data, '*');
}

let lastLayoutSnapshot = '';
// Track known agents: id → last state JSON (for change detection)
const knownAgents = new Map();

function startSyncPolling() {
  setInterval(() => {
    // Poll sync state — treat agents as LOCAL characters with full FSM
    fetch('/api/sync').then(r => r.json()).then(data => {
      // Build map of all current agents across all windows
      const currentAgents = new Map();
      for (const win of data) {
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
          });
        }
      }

      // Detect new agents — send existingAgents in the format the webview expects
      const newAgentIds = [];
      const newAgentMeta = {};
      const newFolderNames = {};
      let projectName = '';
      for (const [id, agent] of currentAgents) {
        if (!knownAgents.has(id)) {
          newAgentIds.push(id);
          newAgentMeta[id] = { palette: agent.palette, hueShift: agent.hueShift, seatId: agent.seatId };
          newFolderNames[id] = agent.name;
          if (agent.workspaceName) projectName = agent.workspaceName;
        }
      }
      if (newAgentIds.length > 0) {
        dispatch({
          type: 'existingAgents',
          agents: newAgentIds,
          agentMeta: newAgentMeta,
          folderNames: newFolderNames,
          projectName: projectName,
        });
      }

      // Detect removed agents — send agentClosed to despawn them
      for (const id of knownAgents.keys()) {
        if (!currentAgents.has(id)) {
          dispatch({ type: 'agentClosed', id });
        }
      }

      // Send agentStateUpdate for all current agents (drives character FSM)
      for (const [id, agent] of currentAgents) {
        const snap = JSON.stringify(agent);
        if (knownAgents.get(id) !== snap) {
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

      // Clean up removed agents from tracking
      for (const id of knownAgents.keys()) {
        if (!currentAgents.has(id)) {
          knownAgents.delete(id);
        }
      }
    }).catch(() => {});

    // Poll layout changes
    fetch('/api/layout').then(r => r.json()).then(layout => {
      if (!layout) return;
      const snap = JSON.stringify(layout);
      if (snap === lastLayoutSnapshot) return;
      lastLayoutSnapshot = snap;
      dispatch({ type: 'layoutLoaded', layout: layout });
    }).catch(() => {});
  }, 500);
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 100;
}
</script>
`

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

  // API endpoints
  if (pathname === '/api/init') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({
      characters: cachedCharacters,
      floors: cachedFloors,
      walls: cachedWalls,
      furniture: cachedFurniture,
      layout: loadLayout(),
    }))
    return
  }

  if (pathname === '/api/sync') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(loadSyncWindows()))
    return
  }

  if (pathname === '/api/layout') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(loadLayout()))
    return
  }

  // Static file serving
  let filePath
  if (pathname === '/' || pathname === '/index.html') {
    // Serve modified index.html with bridge script injected
    const indexPath = join(WEBVIEW_DIST, 'index.html')
    if (!existsSync(indexPath)) {
      res.writeHead(404)
      res.end('Webview not built. Run: npm run build')
      return
    }
    let html = readFileSync(indexPath, 'utf-8')
    // Inject bridge script before the module script
    html = html.replace('<script type="module"', BRIDGE_SCRIPT + '\n    <script type="module"')
    // Remove crossorigin attributes
    html = html.replace(/\s+crossorigin/g, '')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
    return
  }

  // Serve from webview dist
  filePath = join(WEBVIEW_DIST, pathname)
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

server.listen(PORT, () => {
  console.log(`\n  Pixel Agents standalone viewer running at:\n`)
  console.log(`    http://localhost:${PORT}\n`)
  console.log(`  Open this URL in your browser to see the office.`)
  console.log(`  Agents from all open VS Code windows will appear automatically.\n`)
})
