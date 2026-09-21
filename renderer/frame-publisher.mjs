#!/usr/bin/env node
// Frame publisher for the legacy tablet viewer (docs/HANDOFF-from-TabScreen.md).
//
// Loads the Pixel Agents viewer in headless Chrome at exactly WIDTHxHEIGHT, in display mode
// (UI hidden), screenshots it up to MAXFPS times a second, and whenever the picture changed
// converts it to RGB565 + LZ4 block and sends it to the relay as a binary publisher message.
// The relay fans frames out to tablets on GET /stream.
//
// Config (first match wins): env PIXEL_AGENTS_RENDERER_* > ~/.pixel-agents/renderer.json >
// defaults. Token falls back to ~/.pixel-agents/daemon.json's relayToken.
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { PNG } from 'pngjs'
import puppeteer from 'puppeteer'
import { compressBlock } from '../relay/lz4.mjs'
import { encodeFramePayload, rgbaToRgb565 } from '../relay/legacyProtocol.mjs'

const CONFIG_FILE = join(homedir(), '.pixel-agents', 'renderer.json')
const DAEMON_FILE = join(homedir(), '.pixel-agents', 'daemon.json')
const readJson = (f) => { try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {} } catch { return {} } }
const file = readJson(CONFIG_FILE)
const env = process.env
const cfg = {
  viewerUrl: env.PIXEL_AGENTS_RENDERER_URL || file.viewerUrl || 'https://apps.blommemix.dk/pixelagents/',
  relayWs: env.PIXEL_AGENTS_RENDERER_RELAY_WS || file.relayWs || 'wss://apps.blommemix.dk/pixelagents/ws',
  token: env.PIXEL_AGENTS_RENDERER_TOKEN || file.token || readJson(DAEMON_FILE).relayToken || '',
  width: Number(env.PIXEL_AGENTS_RENDERER_WIDTH || file.width || 1024),
  height: Number(env.PIXEL_AGENTS_RENDERER_HEIGHT || file.height || 600),
  maxFps: Number(env.PIXEL_AGENTS_RENDERER_FPS || file.maxFps || 5),
  /** Resend an unchanged frame at least this often so a relay restart never leaves tablets blank */
  keyframeSec: Number(env.PIXEL_AGENTS_RENDERER_KEYFRAME_SEC || file.keyframeSec || 15),
  /** Debug: write one frame as PNG + .rgb565 + .lz4 to this path prefix and exit */
  once: env.PIXEL_AGENTS_RENDERER_ONCE || null,
}
if (!cfg.token) { console.error('[Renderer] No relay token (renderer.json token / daemon.json relayToken / PIXEL_AGENTS_RENDERER_TOKEN)'); process.exit(1) }

const ts = () => new Date().toISOString().slice(11, 19)
const log = (m) => console.log(`${ts()} [Renderer] ${m}`)

// ── Relay publisher connection (binary frames) ──────────────
let ws = null
let wsOpen = false
let reconnectDelay = 1000
function connectRelay() {
  const url = `${cfg.relayWs}${cfg.relayWs.includes('?') ? '&' : '?'}role=publisher&token=${encodeURIComponent(cfg.token)}`
  try { ws = new WebSocket(url) } catch (e) { log(`WebSocket error: ${e.message}`); return scheduleReconnect() }
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => {
    wsOpen = true; reconnectDelay = 1000
    ws.send(JSON.stringify({ type: 'frameConfig', width: cfg.width, height: cfg.height, maxFps: cfg.maxFps }))
    log(`relay connected (${cfg.width}x${cfg.height} @${cfg.maxFps}fps)`)
    lastSentHash = null // force a fresh frame for the new connection
  }
  ws.onclose = () => { wsOpen = false; ws = null; log(`relay disconnected, retry in ${reconnectDelay / 1000}s`); scheduleReconnect() }
  ws.onerror = () => {}
  ws.onmessage = () => {} // layout/idle messages are for the daemon, not us
}
function scheduleReconnect() { setTimeout(connectRelay, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 2, 30000) }

// ── Headless browser ────────────────────────────────────────
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required', `--window-size=${cfg.width},${cfg.height}`],
})
const page = await browser.newPage()
await page.setViewport({ width: cfg.width, height: cfg.height, deviceScaleFactor: 1 })
// Pre-seed the viewer: relay key + display mode (no chrome, no wake lock needed)
await page.evaluateOnNewDocument((token) => {
  try {
    localStorage.setItem('pa-relay-token', token)
    const opts = JSON.parse(localStorage.getItem('pixel-agents-view-options') || '{}')
    localStorage.setItem('pixel-agents-view-options', JSON.stringify({ ...opts, hideUi: true, keepAwake: false }))
  } catch {}
}, cfg.token)
page.on('pageerror', (e) => log(`page error: ${e.message}`))
// #kiosk: display mode with no UI and the camera centred on the office
const kioskUrl = /(^|[#&])kiosk(&|$)/.test(new URL(cfg.viewerUrl).hash) ? cfg.viewerUrl : cfg.viewerUrl + (cfg.viewerUrl.includes('#') ? '&kiosk' : '#kiosk')
await page.goto(kioskUrl, { waitUntil: 'networkidle2', timeout: 60000 })
log(`viewer loaded: ${cfg.viewerUrl}`)

// ── Capture loop ────────────────────────────────────────────
let lastSentHash = null
let lastSentAt = 0
let stats = { captured: 0, sent: 0, bytes: 0, since: Date.now() }
const rawSize = cfg.width * cfg.height * 2

async function captureAndSend() {
  const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: cfg.width, height: cfg.height }, captureBeyondViewport: false })
  stats.captured++
  const hash = createHash('sha1').update(png).digest('hex')
  const now = Date.now()
  const unchanged = hash === lastSentHash
  if (unchanged && now - lastSentAt < cfg.keyframeSec * 1000) return
  const img = PNG.sync.read(png)
  if (img.width !== cfg.width || img.height !== cfg.height) { log(`unexpected screenshot size ${img.width}x${img.height}`); return }
  const rgb565 = rgbaToRgb565(img.data, img.width, img.height)
  const block = compressBlock(rgb565)
  const payload = encodeFramePayload(block, rawSize, Math.round(performance.now() * 1000))
  if (cfg.once) {
    writeFileSync(`${cfg.once}.png`, png); writeFileSync(`${cfg.once}.rgb565`, rgb565); writeFileSync(`${cfg.once}.lz4`, block)
    log(`wrote ${cfg.once}.{png,rgb565,lz4} (${rgb565.length} -> ${block.length} bytes)`)
    await browser.close(); process.exit(0)
  }
  if (wsOpen && ws) {
    ws.send(payload)
    stats.sent++; stats.bytes += payload.length
    lastSentHash = hash; lastSentAt = now
  }
}

connectRelay()
const interval = Math.max(50, Math.round(1000 / cfg.maxFps))
let busy = false
setInterval(async () => {
  if (busy) return
  busy = true
  try { await captureAndSend() } catch (e) { log(`capture failed: ${e.message}`) } finally { busy = false }
}, interval)
setInterval(() => {
  const s = (Date.now() - stats.since) / 1000
  log(`${stats.captured} captures, ${stats.sent} frames sent (${(stats.bytes / 1024).toFixed(0)} KB, ${(stats.bytes / s / 1024).toFixed(1)} KB/s) in ${s.toFixed(0)}s`)
  stats = { captured: 0, sent: 0, bytes: 0, since: Date.now() }
}, 60000)

const shutdown = async () => { log('shutting down'); try { ws?.close(); await browser.close() } catch {} process.exit(0) }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
