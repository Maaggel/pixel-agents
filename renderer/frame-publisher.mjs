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
import { deflateRaw } from 'zlib'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import puppeteer from 'puppeteer'
import { decompressBlock } from '../relay/lz4.mjs'
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
  deflateLevel: Number(env.PIXEL_AGENTS_RENDERER_DEFLATE_LEVEL || file.deflateLevel || 5),
  /** Resend an unchanged frame at least this often so a relay restart never leaves tablets blank */
  keyframeSec: Number(env.PIXEL_AGENTS_RENDERER_KEYFRAME_SEC || file.keyframeSec || 15),
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
// Screenshots cost ~180 ms (PNG encode + decode). The office is one <canvas>, so the page reads its
// own pixels (~4 ms), converts to RGB565 and LZ4-compresses them (~25 ms), and hands Node the block
// as base64. Node reuses that block for LZ4 clients and deflates the raw pixels for the others.
const here = dirname(fileURLToPath(import.meta.url))
const lz4Source = readFileSync(join(here, '..', 'relay', 'lz4.mjs'), 'utf8').replace(/^export /gm, '')
const captureScript = lz4Source + `
window.__paCapture = function () {
  var best = null
  document.querySelectorAll('canvas').forEach(function (c) { if (!best || c.width * c.height > best.width * best.height) best = c })
  if (!best) return null
  var ctx = best.getContext('2d'); if (!ctx) return null
  var img = ctx.getImageData(0, 0, best.width, best.height)
  var d = img.data, n = best.width * best.height, raw = new Uint8Array(n * 2)
  for (var i = 0, o = 0; o < raw.length; i += 4, o += 2) { var v = ((d[i] >> 3) << 11) | ((d[i + 1] >> 2) << 5) | (d[i + 2] >> 3); raw[o] = v & 255; raw[o + 1] = v >> 8 }
  var block = compressBlock(raw)
  var s = ''; for (var k = 0; k < block.length; k += 0x8000) s += String.fromCharCode.apply(null, block.subarray(k, k + 0x8000))
  return { w: best.width, h: best.height, lz4: btoa(s) }
}`
const deflateRawAsync = promisify(deflateRaw)

// ── Headless browser ────────────────────────────────────────
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required', `--window-size=${cfg.width},${cfg.height}`],
})
const page = await browser.newPage()
// #kiosk: display mode with no UI and the camera centred on the office
const kioskUrl = /(^|[#&])kiosk(&|$)/.test(new URL(cfg.viewerUrl).hash) ? cfg.viewerUrl : cfg.viewerUrl + (cfg.viewerUrl.includes('#') ? '&kiosk' : '#kiosk')
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
  const cap = await page.evaluate(() => window.__paCapture())
  stats.captured++
  if (!cap) return // no canvas yet (page loading)
  if (cap.w !== cfg.width || cap.h !== cfg.height) { if (stats.captured % 100 === 1) log(`canvas is ${cap.w}x${cap.h}, expected ${cfg.width}x${cfg.height}`); return }
  const hash = createHash('sha1').update(cap.lz4).digest('hex')
  const now = Date.now()
  const unchanged = hash === lastSentHash
  if (!unchanged) lastChangeAt = now
  if (unchanged && now - lastSentAt < cfg.keyframeSec * 1000) return
  lastSentHash = hash; lastSentAt = now
  const block = Buffer.from(cap.lz4, 'base64')
  // Encode + send off the capture path so the next capture overlaps zlib's thread-pool work;
  // the promise chain keeps frames in order.
  sendChain = sendChain.then(() => encodeAndSend(block)).catch((e) => log(`encode failed: ${e.message}`))
}

let sendChain = Promise.resolve()
async function encodeAndSend(block) {
  const rgb565 = decompressBlock(block, rawSize)
  const tsUs = Math.round(performance.now() * 1000)
  const payload = encodeFramePayload(block, rawSize, tsUs)
  // Same frame as raw deflate for clients that opt in (/stream?comp=deflate): ~3x smaller on real art
  const deflated = encodeFramePayload(await deflateRawAsync(rgb565, { level: cfg.deflateLevel }), rawSize, tsUs)
  if (cfg.once) {
    writeFileSync(`${cfg.once}.rgb565`, rgb565); writeFileSync(`${cfg.once}.lz4`, block)
    log(`wrote ${cfg.once}.{rgb565,lz4} (${rgb565.length} -> lz4 ${block.length}, deflate ${deflated.length - 12} bytes)`)
    await browser.close(); process.exit(0)
  }
  if (wsOpen && ws) {
    ws.send(Buffer.concat([Buffer.from([COMPRESSION_LZ4_BLOCK]), payload]))
    ws.send(Buffer.concat([Buffer.from([COMPRESSION_DEFLATE_RAW]), deflated]))
    stats.sent++; stats.bytes += payload.length
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
// Stall watchdog: the office animates continuously, so a long run of identical captures means
// the page's loop has died (a thrown error, a lost WebSocket) rather than a quiet office.
setInterval(() => {
  if (lastSentAt && Date.now() - lastChangeAt > cfg.stallSec * 1000) void reloadPage(`no change for ${cfg.stallSec}s`)
}, 30000)
setInterval(() => {
  const s = (Date.now() - stats.since) / 1000
  log(`${stats.captured} captures, ${stats.sent} frames sent (${(stats.bytes / 1024).toFixed(0)} KB, ${(stats.bytes / s / 1024).toFixed(1)} KB/s) in ${s.toFixed(0)}s`)
  stats = { captured: 0, sent: 0, bytes: 0, since: Date.now() }
}, 60000)

const shutdown = async () => { log('shutting down'); try { ws?.close(); await browser.close() } catch {} process.exit(0) }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
