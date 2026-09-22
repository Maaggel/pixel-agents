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
import { deflateRaw, crc32 } from 'zlib'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import puppeteer from 'puppeteer'
import { WebSocketServer } from 'ws'
import { compressBlock } from '../relay/lz4.mjs'
import { encodeFramePayload, rgbaToRgb565, COMPRESSION_LZ4_BLOCK, COMPRESSION_DEFLATE_RAW } from '../relay/legacyProtocol.mjs'

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
  maxFps: Math.min(30, Number(env.PIXEL_AGENTS_RENDERER_FPS || file.maxFps || 20)),
  /** zlib level for the deflate encoding (3 = fast, 6 = small); runs on the thread pool */
  deflateLevel: Number(env.PIXEL_AGENTS_RENDERER_DEFLATE_LEVEL || file.deflateLevel || 3),
  /** Resend an unchanged frame at least this often so a relay restart never leaves tablets blank */
  keyframeSec: Number(env.PIXEL_AGENTS_RENDERER_KEYFRAME_SEC || file.keyframeSec || 15),
  /** Poll the relay for connected tablets this often; with none, the page is CPU-throttled and captured at idleFps */
  clientPollSec: Number(env.PIXEL_AGENTS_RENDERER_CLIENT_POLL_SEC || file.clientPollSec || 5),
  idleFps: Number(env.PIXEL_AGENTS_RENDERER_IDLE_FPS || file.idleFps || 0.5),
  /** CPU throttling factor for the page while idle (Chrome DevTools emulation) */
  idleThrottle: Number(env.PIXEL_AGENTS_RENDERER_IDLE_THROTTLE || file.idleThrottle || 8),
  /** Reload the viewer if the picture has not changed for this long (the office is never still this long) */
  stallSec: Number(env.PIXEL_AGENTS_RENDERER_STALL_SEC || file.stallSec || 180),
  /** Debug: write one frame as .rgb565 + .lz4 to this path prefix and exit */
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

// ── In-page capture ──────────────────────────────────────────
// Screenshots cost ~180 ms (PNG encode + decode). The office is one <canvas>, so the page reads
// its own pixels (~4 ms), converts to RGB565 (~8 ms) and ships the raw 1.2 MB to this process
// over a local binary WebSocket (~1 ms). All compression happens here, off the page, on zlib's
// thread pool - the page's cost stays minimal because it shares this box with the owner's sessions.
const here = dirname(fileURLToPath(import.meta.url))
const pixelServer = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await new Promise((r) => pixelServer.once('listening', r))
const pixelPort = pixelServer.address().port
let pageSocket = null
pixelServer.on('connection', (sock) => {
  pageSocket = sock
  sock.on('message', (data, isBinary) => { if (isBinary) void onRawFrame(Buffer.from(data)) })
  sock.on('close', () => { if (pageSocket === sock) pageSocket = null })
})
const captureScript = `
(function () {
  var PORT = ${pixelPort}, ws = null
  function socket() {
    if (ws && ws.readyState === 1) return ws
    if (ws && ws.readyState === 0) return null
    ws = new WebSocket('ws://127.0.0.1:' + PORT); ws.binaryType = 'arraybuffer'
    return null
  }
  socket()
  window.__paCapture = function () {
    var s = socket(); if (!s) return 'nosocket'
    var best = null
    document.querySelectorAll('canvas').forEach(function (c) { if (!best || c.width * c.height > best.width * best.height) best = c })
    if (!best) return 'nocanvas'
    var ctx = best.getContext('2d'); if (!ctx) return 'noctx'
    var img = ctx.getImageData(0, 0, best.width, best.height)
    var d = img.data, n = best.width * best.height, raw = new Uint8Array(4 + n * 2)
    raw[0] = best.width & 255; raw[1] = best.width >> 8; raw[2] = best.height & 255; raw[3] = best.height >> 8
    for (var i = 0, o = 4; o < raw.length; i += 4, o += 2) { var v = ((d[i] >> 3) << 11) | ((d[i + 1] >> 2) << 5) | (d[i + 2] >> 3); raw[o] = v & 255; raw[o + 1] = v >> 8 }
    s.send(raw.buffer)
    return 'sent'
  }
})()`
const deflateRawAsync = promisify(deflateRaw)

// ── Headless browser ────────────────────────────────────────
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required', `--window-size=${cfg.width},${cfg.height}`],
})
const page = await browser.newPage()
// #kiosk: display mode with no UI and the camera centred on the office
// #kiosk: display mode, camera fitted; #fps=N caps the office's own animation loop to what we capture
const kioskUrl = (/(^|[#&])kiosk(&|$)/.test(new URL(cfg.viewerUrl).hash) ? cfg.viewerUrl : cfg.viewerUrl + (cfg.viewerUrl.includes('#') ? '&kiosk' : '#kiosk')) + `&fps=${cfg.maxFps}`
await page.setViewport({ width: cfg.width, height: cfg.height, deviceScaleFactor: 1 })
// Pre-seed the viewer: relay key + display mode (no chrome, no wake lock needed)
await page.evaluateOnNewDocument((token) => {
  try {
    localStorage.setItem('pa-relay-token', token)
    const opts = JSON.parse(localStorage.getItem('pixel-agents-view-options') || '{}')
    localStorage.setItem('pixel-agents-view-options', JSON.stringify({ ...opts, hideUi: true, keepAwake: false, ...(window.__PA_NO_LIGHT__ ? { showSunlight: false } : {}) }))
  } catch {}
}, cfg.token)
// A viewer bug that throws inside the game loop freezes the picture; a reload costs one second.
let reloading = false
async function reloadPage(reason) {
  if (reloading) return
  reloading = true
  log(`reloading viewer: ${reason}`)
  // page.reload(), not goto(): goto to the same URL (only the hash differs) is a same-document navigation and leaves the dead page in place
  try { await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }); lastSentHash = null; lastChangeAt = Date.now(); log('viewer reloaded') }
  catch (e) { log(`reload failed: ${e.message}`) }
  finally { setTimeout(() => { reloading = false }, 5000) }
}
await page.setBypassCSP(true) // the page must be allowed to open ws://127.0.0.1 to this process
await page.evaluateOnNewDocument(captureScript)
page.on('pageerror', (e) => { log(`page error: ${(e.stack || e.message || String(e)).split('\n').slice(0, 6).join(' | ')}`); void reloadPage('page error') })
page.on('console', (m) => { if (m.type() === 'error') log(`console.error: ${m.text().slice(0, 300)}`) })
await page.goto(kioskUrl, { waitUntil: 'networkidle2', timeout: 60000 })
log(`viewer loaded: ${cfg.viewerUrl}`)

// ── Capture loop ────────────────────────────────────────────
let lastSentHash = null
let lastSentAt = 0
let lastChangeAt = Date.now()
let stats = { captured: 0, sent: 0, bytes: 0, since: Date.now() }
const rawSize = cfg.width * cfg.height * 2

async function captureAndSend() {
  const r = await page.evaluate(() => window.__paCapture())
  stats.captured++
  if (r !== 'sent' && stats.captured % 100 === 1) log(`capture: ${r}`)
}

/** A raw frame from the page: [w u16][h u16][RGB565 LE]. Dedupe, then encode off the capture path. */
async function onRawFrame(buf) {
  const w = buf.readUInt16LE(0), h = buf.readUInt16LE(2)
  if (w !== cfg.width || h !== cfg.height) { if (stats.captured % 100 === 1) log(`canvas is ${w}x${h}, expected ${cfg.width}x${cfg.height}`); return }
  const rgb565 = buf.subarray(4)
  const hash = crc32(rgb565) // native, ~1 ms for 1.2 MB; sha1 was ~4 ms
  const now = Date.now()
  const unchanged = hash === lastSentHash
  if (!unchanged) lastChangeAt = now
  if (unchanged && now - lastSentAt < cfg.keyframeSec * 1000) return
  lastSentHash = hash; lastSentAt = now
  sendChain = sendChain.then(() => encodeAndSend(rgb565)) // ws hands us a fresh Buffer per message.catch((e) => log(`encode failed: ${e.message}`))
}

let sendChain = Promise.resolve()
/** Which encodings anyone is actually consuming (from the relay's /api/stream); no client, no work. */
let needLz4 = false
let needDeflate = true
async function encodeAndSend(rgb565) {
  const tsUs = Math.round(performance.now() * 1000)
  const out = []
  if (needDeflate || cfg.once) {
    // Raw deflate, ~3x smaller than LZ4 on real pixel art; the tablet's default. zlib runs on the thread pool.
    out.push([COMPRESSION_DEFLATE_RAW, encodeFramePayload(await deflateRawAsync(rgb565, { level: cfg.deflateLevel }), rawSize, tsUs)])
  }
  if (needLz4 || cfg.once) {
    // Protocol v1 encoding, only when an LZ4 client is connected (18 ms a frame otherwise wasted)
    out.push([COMPRESSION_LZ4_BLOCK, encodeFramePayload(compressBlock(rgb565), rawSize, tsUs)])
  }
  if (cfg.once) {
    writeFileSync(`${cfg.once}.rgb565`, rgb565)
    for (const [tag, p] of out) writeFileSync(`${cfg.once}.${tag === COMPRESSION_LZ4_BLOCK ? 'lz4' : 'deflate'}`, p.subarray(12))
    log(`wrote ${cfg.once}.{rgb565,lz4,deflate} (${rgb565.length} raw; ${out.map(([t, p]) => (t === COMPRESSION_LZ4_BLOCK ? 'lz4 ' : 'deflate ') + (p.length - 12)).join(', ')} bytes)`)
    await browser.close(); process.exit(0)
  }
  if (wsOpen && ws) {
    for (const [tag, p] of out) { ws.send(Buffer.concat([Buffer.from([tag]), p])); stats.bytes += p.length }
    stats.sent++
  }
}

connectRelay()

// ── Idle when nobody is watching ─────────────────────────────
// This box also runs the owner's Claude sessions; rendering an office nobody sees is CPU stolen
// from them. With no stream client on the relay, the page is CPU-throttled and captured rarely
// (the relay still gets a fresh keyframe now and then), and it wakes within clientPollSec.
let watched = true
async function setWatched(next) {
  if (next === watched) return
  watched = next
  try { await page.emulateCPUThrottling(next ? 1 : cfg.idleThrottle) } catch (e) { log(`throttle failed: ${e.message}`) }
  log(next ? `viewer connected - full rate (${cfg.maxFps} fps)` : `no viewers - idle (${cfg.idleFps} fps, page throttled ${cfg.idleThrottle}x)`)
  scheduleCapture()
}
async function pollClients() {
  try {
    const base = cfg.viewerUrl.replace(/#.*$/, '').replace(/\/+$/, '')
    const r = await fetch(`${base}/api/stream`)
    if (r.ok) {
      const j = await r.json()
      needLz4 = (j.clientsLz4 | 0) > 0
      needDeflate = (j.clientsDeflate | 0) > 0 || (j.clients | 0) === 0 // idle keyframes: keep the small one fresh
      await setWatched((j.clients | 0) > 0)
    }
  } catch { /* relay unreachable - keep current mode */ }
}
setInterval(pollClients, cfg.clientPollSec * 1000)
void pollClients()

let busy = false
let captureTimer = null
function scheduleCapture() {
  if (captureTimer) clearInterval(captureTimer)
  const fps = watched ? cfg.maxFps : cfg.idleFps
  captureTimer = setInterval(async () => {
    if (busy) return
    busy = true
    try { await captureAndSend() } catch (e) { log(`capture failed: ${e.message}`) } finally { busy = false }
  }, Math.max(50, Math.round(1000 / fps)))
}
scheduleCapture()
// Stall watchdog: the office animates continuously, so a long run of identical captures means
// the page's loop has died (a thrown error, a lost WebSocket) rather than a quiet office.
setInterval(() => {
  if (watched && lastSentAt && Date.now() - lastChangeAt > cfg.stallSec * 1000) void reloadPage(`no change for ${cfg.stallSec}s`)
}, 30000)
setInterval(() => {
  const s = (Date.now() - stats.since) / 1000
  log(`${stats.captured} captures, ${stats.sent} frames sent (${(stats.bytes / 1024).toFixed(0)} KB, ${(stats.bytes / s / 1024).toFixed(1)} KB/s) in ${s.toFixed(0)}s`)
  stats = { captured: 0, sent: 0, bytes: 0, since: Date.now() }
}, 60000)

const shutdown = async () => { log('shutting down'); try { ws?.close(); await browser.close() } catch {} process.exit(0) }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
