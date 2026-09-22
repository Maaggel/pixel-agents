#!/usr/bin/env node
// Native frame publisher for the legacy tablet viewer: no browser.
//
// Runs the office engine (renderer/native/engine.mjs, the same TypeScript the web viewer
// runs, bundled for Node) and draws it with Skia (@napi-rs/canvas) into a WIDTHxHEIGHT
// canvas at a fixed frame rate, then ships changed frames to the relay as RGB565 +
// deflate/LZ4 exactly like frame-publisher.mjs did from headless Chrome. State comes
// straight from the relay's viewer WebSocket (the same messages the browser gets).
//
// Config (first match wins): env PIXEL_AGENTS_RENDERER_* > ~/.pixel-agents/renderer.json >
// defaults. Token falls back to ~/.pixel-agents/daemon.json's relayToken.
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { deflateRaw, crc32 } from 'zlib'
import { promisify } from 'util'
import { createCanvas } from '@napi-rs/canvas'
import { installShims, useSnapshots, snapshotsMade } from './native/shims.mjs'
import { compressBlock } from '../relay/lz4.mjs'
import { encodeFramePayload, COMPRESSION_LZ4_BLOCK, COMPRESSION_DEFLATE_RAW } from '../relay/legacyProtocol.mjs'

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
  /** Device pixels per sprite pixel on the tablet; the kiosk web page used 2 (DPR 1) */
  zoom: Number(env.PIXEL_AGENTS_RENDERER_ZOOM || file.zoom || 2),
  /**
   * Integer upscale applied after drawing: the office is drawn at zoom/upscale into a
   * (width/upscale)x(height/upscale) canvas and each pixel is repeated upscale x upscale on the
   * way to RGB565. Pixel art is identical either way (sprites are exact multiples); text and
   * light gradients get chunkier. 2 makes drawing, readback and GC ~4x cheaper.
   */
  upscale: Number(env.PIXEL_AGENTS_RENDERER_UPSCALE || file.upscale || 2),
  /** Nametag font size in tablet pixels; the pixel font is crisp at 16 */
  nametagPx: Number(env.PIXEL_AGENTS_RENDERER_NAMETAG_PX || file.nametagPx || 16),
  /** Show emoji in nametags (the owner prefixes names with icons); off strips them */
  nametagEmoji: (env.PIXEL_AGENTS_RENDERER_NAMETAG_EMOJI || String(file.nametagEmoji ?? 'false')) === 'true',
  /** Nametag font stack; the emoji fallback needs fonts-noto-color-emoji (or another emoji font) installed */
  nametagFont: env.PIXEL_AGENTS_RENDERER_NAMETAG_FONT || file.nametagFont || '"FS Pixel Sans Unicode", "Noto Color Emoji"',
  /** Behind the office where there are no tiles (the browser capture gave black there too) */
  background: env.PIXEL_AGENTS_RENDERER_BACKGROUND || file.background || '#000000',
  maxFps: Math.min(30, Number(env.PIXEL_AGENTS_RENDERER_FPS || file.maxFps || 20)),
  /** zlib level for the deflate encoding (3 = fast, 6 = small); runs on the thread pool */
  deflateLevel: Number(env.PIXEL_AGENTS_RENDERER_DEFLATE_LEVEL || file.deflateLevel || 3),
  /** Resend an unchanged frame at least this often so a relay restart never leaves tablets blank */
  keyframeSec: Number(env.PIXEL_AGENTS_RENDERER_KEYFRAME_SEC || file.keyframeSec || 15),
  /** Poll the relay for connected tablets this often; with none, frames are drawn at idleFps */
  clientPollSec: Number(env.PIXEL_AGENTS_RENDERER_CLIENT_POLL_SEC || file.clientPollSec || 5),
  idleFps: Number(env.PIXEL_AGENTS_RENDERER_IDLE_FPS || file.idleFps || 0.5),
  /** Simulation rate while idle: the engine caps dt at 0.1 s, so 10 Hz keeps the office in real time (cheap, no drawing) */
  idleSimHz: Number(env.PIXEL_AGENTS_RENDERER_IDLE_SIM_HZ || file.idleSimHz || 10),
  /** Debug: draw one frame (after the relay's init arrived) as .png/.rgb565/.lz4/.deflate and exit */
  once: env.PIXEL_AGENTS_RENDERER_ONCE || null,
  /** Debug: seconds of simulation before the once-frame is taken (spawn effects take a moment) */
  onceAfterSec: Number(env.PIXEL_AGENTS_RENDERER_ONCE_AFTER_SEC || file.onceAfterSec || 4),
}
if (!cfg.token) { console.error('[Renderer] No relay token (renderer.json token / daemon.json relayToken / PIXEL_AGENTS_RENDERER_TOKEN)'); process.exit(1) }
if (!Number.isInteger(cfg.upscale) || cfg.upscale < 1 || cfg.zoom % cfg.upscale !== 0 || cfg.width % cfg.upscale !== 0 || cfg.height % cfg.upscale !== 0) {
  console.error(`[Renderer] upscale must be a divisor of zoom (${cfg.zoom}), width (${cfg.width}) and height (${cfg.height}); got ${cfg.upscale}`); process.exit(1)
}

const ts = () => new Date().toISOString().slice(11, 19)
const log = (m) => process.stdout.write(`${ts()} [Renderer] ${m}\n`)

// ── Engine ───────────────────────────────────────────────────
installShims()
// The engine narrates to console.log (meetings, vacuums, catalog); that is browser dev-console
// material, not journal material. Warnings and errors still come through.
console.log = () => {}
const { createHeadlessOffice } = await import('./native/engine.mjs')
const drawW = cfg.width / cfg.upscale
const drawH = cfg.height / cfg.upscale
// Nametags are text, and text drawn at half resolution and doubled is unreadable, so with an
// upscale the scene is drawn without tags and the tags go on a full-resolution overlay whose
// painted rectangles are composited into the RGB565 frame (a few small readbacks, not a full one).
const useOverlay = cfg.upscale > 1
const office = createHeadlessOffice({
  width: drawW, height: drawH, zoom: cfg.zoom / cfg.upscale, log,
  nametagOverlay: useOverlay,
  nametagFont: { px: useOverlay ? cfg.nametagPx : cfg.nametagPx / cfg.upscale, family: cfg.nametagFont },
  nametagStripEmoji: !cfg.nametagEmoji,
})
const canvas = createCanvas(drawW, drawH)
const ctx = useSnapshots(canvas.getContext('2d'))
ctx.imageSmoothingEnabled = false
const overlay = useOverlay ? createCanvas(cfg.width, cfg.height) : null
const overlayCtx = overlay ? useSnapshots(overlay.getContext('2d')) : null
if (overlayCtx) overlayCtx.imageSmoothingEnabled = false

// ── Relay viewer connection (state in) ───────────────────────
let viewerWs = null
let viewerDelay = 1000
function connectViewer() {
  const url = `${cfg.relayWs}${cfg.relayWs.includes('?') ? '&' : '?'}role=viewer&token=${encodeURIComponent(cfg.token)}`
  try { viewerWs = new WebSocket(url) } catch (e) { log(`viewer socket error: ${e.message}`); return setTimeout(connectViewer, viewerDelay) }
  viewerWs.onopen = () => { viewerDelay = 1000; log('viewer connected (state from relay)') }
  viewerWs.onmessage = (e) => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }
    try { office.handleRelayMessage(msg) } catch (err) { log(`state error on ${msg.type}: ${err.stack || err.message}`) }
    if (msg.type === 'init') log(`init: ${office.agentCount()} agent(s), layout ${office.isReady() ? 'ready' : 'missing'}`)
  }
  viewerWs.onclose = (e) => {
    viewerWs = null
    if (e.code === 4001) { log('viewer rejected: invalid token'); process.exit(1) }
    log(`viewer disconnected, retry in ${viewerDelay / 1000}s`)
    setTimeout(connectViewer, viewerDelay); viewerDelay = Math.min(viewerDelay * 2, 30000)
  }
  viewerWs.onerror = () => {}
}

// ── Relay publisher connection (frames out) ──────────────────
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
    log(`relay connected (${cfg.width}x${cfg.height} @${cfg.maxFps}fps, native, drawn at ${drawW}x${drawH} zoom ${cfg.zoom / cfg.upscale})`)
    lastSentHash = null // force a fresh frame for the new connection
  }
  ws.onclose = () => { wsOpen = false; ws = null; log(`relay disconnected, retry in ${reconnectDelay / 1000}s`); scheduleReconnect() }
  ws.onerror = () => {}
  ws.onmessage = () => {} // layout/idle messages are for the daemon, not us
}
function scheduleReconnect() { setTimeout(connectRelay, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 2, 30000) }

// ── Frame pipeline ───────────────────────────────────────────
const deflateRawAsync = promisify(deflateRaw)
let lastSentHash = null
let lastSentAt = 0
let stats = { ticks: 0, drawn: 0, sent: 0, dropped: 0, bytes: 0, drawMs: 0, snapshots: 0, since: Date.now() }
const rawSize = cfg.width * cfg.height * 2
const pixelCount = cfg.width * cfg.height
// Two RGB565 buffers: one is being encoded on the thread pool while the next frame is drawn
// into the other, with no per-frame allocation. If encoding is still busy when the next frame
// is ready, that frame is dropped rather than queued (the tablet skips frames anyway).
const rgb565Buffers = [Buffer.allocUnsafe(rawSize), Buffer.allocUnsafe(rawSize)]
let drawIndex = 0
let encoding = false

const timing = { render: 0, readback: 0, rgb565: 0 }
function drawFrame() {
  const t0 = performance.now()
  office.render(ctx)
  // The engine clears to transparent where there are no tiles; put the background behind it
  ctx.globalCompositeOperation = 'destination-over'
  ctx.fillStyle = cfg.background
  ctx.fillRect(0, 0, drawW, drawH)
  ctx.globalCompositeOperation = 'source-over'
  const t1 = performance.now()
  const rgba = canvas.data() // RGBA8, row-major, no padding (also where Skia rasterises the frame)
  const t2 = performance.now()
  const src = new Uint32Array(rgba.buffer, rgba.byteOffset, drawW * drawH) // little-endian: A B G R
  const out = rgb565Buffers[drawIndex]
  const dst = new Uint16Array(out.buffer, out.byteOffset, pixelCount)
  const up = cfg.upscale
  if (up === 1) {
    for (let i = 0; i < pixelCount; i++) {
      const p = src[i]
      dst[i] = ((p & 0xF8) << 8) | ((p & 0xFC00) >> 5) | ((p & 0xF80000) >> 19)
    }
  } else {
    // Nearest-neighbour upscale: convert one source row into the first output row, then copy it
    const W = cfg.width
    for (let sy = 0, si = 0; sy < drawH; sy++) {
      const rowStart = sy * up * W
      for (let sx = 0, di = rowStart; sx < drawW; sx++, si++) {
        const p = src[si]
        const v = ((p & 0xF8) << 8) | ((p & 0xFC00) >> 5) | ((p & 0xF80000) >> 19)
        for (let k = 0; k < up; k++) dst[di++] = v
      }
      for (let r = 1; r < up; r++) dst.copyWithin(rowStart + r * W, rowStart, rowStart + W)
    }
  }
  if (overlayCtx) compositeNametags(dst)
  const t3 = performance.now()
  timing.render += t1 - t0; timing.readback += t2 - t1; timing.rgb565 += t3 - t2
  stats.drawn++
  stats.drawMs += t3 - t0
  return out
}

/** Draw the tags at full resolution and blend the painted rectangles over the RGB565 frame. */
function compositeNametags(dst) {
  overlayCtx.clearRect(0, 0, cfg.width, cfg.height)
  const rects = office.renderNametagOverlay(overlayCtx, cfg.upscale)
  const W = cfg.width, H = cfg.height
  for (const r of rects) {
    const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y)
    const x1 = Math.min(W, r.x + r.w), y1 = Math.min(H, r.y + r.h)
    if (x1 <= x0 || y1 <= y0) continue
    const img = overlayCtx.getImageData(x0, y0, x1 - x0, y1 - y0).data // straight (non-premultiplied) RGBA
    for (let y = y0, i = 0; y < y1; y++) {
      for (let x = x0, di = y * W + x0; x < x1; x++, di++, i += 4) {
        const a = img[i + 3]
        if (a === 0) continue
        let r8 = img[i], g8 = img[i + 1], b8 = img[i + 2]
        if (a < 255) {
          const d = dst[di]
          const dr = ((d >> 11) & 0x1F) << 3, dg = ((d >> 5) & 0x3F) << 2, db = (d & 0x1F) << 3
          r8 = (r8 * a + dr * (255 - a)) / 255
          g8 = (g8 * a + dg * (255 - a)) / 255
          b8 = (b8 * a + db * (255 - a)) / 255
        }
        dst[di] = ((r8 & 0xF8) << 8) | ((g8 & 0xFC) << 3) | (b8 >> 3)
      }
    }
  }
}

/** Dedupe, then encode off the draw path. */
function publishFrame(pixels) {
  const hash = crc32(pixels)
  const now = Date.now()
  if (hash === lastSentHash && now - lastSentAt < cfg.keyframeSec * 1000) return
  if (encoding) { stats.dropped++; return }
  lastSentHash = hash; lastSentAt = now
  encoding = true
  drawIndex ^= 1
  encodeAndSend(pixels).catch((e) => log(`encode failed: ${e.message}`)).finally(() => { encoding = false })
}

/** Which encodings anyone is actually consuming (from the relay's /api/stream); no client, no work. */
let needLz4 = false
let needDeflate = true
async function encodeAndSend(pixels) {
  const tsUs = Math.round(performance.now() * 1000)
  const out = []
  if (needDeflate || cfg.once) {
    out.push([COMPRESSION_DEFLATE_RAW, encodeFramePayload(await deflateRawAsync(pixels, { level: cfg.deflateLevel }), rawSize, tsUs)])
  }
  if (needLz4 || cfg.once) {
    out.push([COMPRESSION_LZ4_BLOCK, encodeFramePayload(compressBlock(pixels), rawSize, tsUs)])
  }
  if (cfg.once) {
    writeFileSync(`${cfg.once}.png`, await canvas.encode('png'))
    writeFileSync(`${cfg.once}.rgb565`, pixels)
    for (const [tag, p] of out) writeFileSync(`${cfg.once}.${tag === COMPRESSION_LZ4_BLOCK ? 'lz4' : 'deflate'}`, p.subarray(12))
    log(`wrote ${cfg.once}.{png,rgb565,lz4,deflate} (${pixels.length} raw; ${out.map(([t, p]) => (t === COMPRESSION_LZ4_BLOCK ? 'lz4 ' : 'deflate ') + (p.length - 12)).join(', ')} bytes)`)
    process.exit(0)
  }
  if (wsOpen && ws) {
    for (const [tag, p] of out) { ws.send(Buffer.concat([Buffer.from([tag]), p])); stats.bytes += p.length }
    stats.sent++
  }
}

// ── Loop ─────────────────────────────────────────────────────
// Watched: tick + draw + publish at maxFps. Idle (no stream client on the relay): tick at
// idleSimHz so the office keeps living in real time, draw only every idleFps so the relay
// still has a fresh keyframe, and burn next to nothing. Wakes within clientPollSec.
let watched = true
let loopTimer = null
let lastTick = 0
let drawEvery = 1
let tickCount = 0
let readyAt = 0
const MAX_DT = 0.1 // MAX_DELTA_TIME_SEC in the engine
function scheduleLoop() {
  if (loopTimer) clearInterval(loopTimer)
  const hz = watched ? cfg.maxFps : cfg.idleSimHz
  drawEvery = watched ? 1 : Math.max(1, Math.round(cfg.idleSimHz / cfg.idleFps))
  tickCount = 0
  loopTimer = setInterval(() => {
    const now = performance.now()
    const dt = lastTick === 0 ? 0 : Math.min((now - lastTick) / 1000, MAX_DT)
    lastTick = now
    try {
      office.tick(dt)
      stats.ticks++
      if (++tickCount % drawEvery === 0 && office.isReady()) {
        if (cfg.once) {
          if (!readyAt) readyAt = now
          if (now - readyAt < cfg.onceAfterSec * 1000) return
          void encodeAndSend(Buffer.from(drawFrame())); clearInterval(loopTimer); return
        }
        publishFrame(drawFrame())
      }
    } catch (e) {
      // The loop is the whole service; a broken frame every tick is worth a restart (systemd Restart=always)
      log(`frame error: ${e.stack || e.message}`)
      process.exit(1)
    }
  }, Math.max(20, Math.round(1000 / hz)))
}
function setWatched(next) {
  if (next === watched) return
  watched = next
  log(next ? `viewer connected - full rate (${cfg.maxFps} fps)` : `no viewers - idle (${cfg.idleFps} fps, simulation ${cfg.idleSimHz} Hz)`)
  scheduleLoop()
}
async function pollClients() {
  try {
    const base = cfg.viewerUrl.replace(/#.*$/, '').replace(/\/+$/, '')
    const r = await fetch(`${base}/api/stream`)
    if (r.ok) {
      const j = await r.json()
      needLz4 = (j.clientsLz4 | 0) > 0
      needDeflate = (j.clientsDeflate | 0) > 0 || (j.clients | 0) === 0 // idle keyframes: keep the small one fresh
      setWatched((j.clients | 0) > 0)
    }
  } catch { /* relay unreachable - keep current mode */ }
}

connectViewer()
connectRelay()
scheduleLoop()
setInterval(pollClients, cfg.clientPollSec * 1000)
void pollClients()
setInterval(() => {
  const s = (Date.now() - stats.since) / 1000
  const avg = stats.drawn ? `${(stats.drawMs / stats.drawn).toFixed(1)} ms each: render ${(timing.render / stats.drawn).toFixed(1)}, readback ${(timing.readback / stats.drawn).toFixed(1)}, rgb565 ${(timing.rgb565 / stats.drawn).toFixed(1)}` : '-'
  timing.render = timing.readback = timing.rgb565 = 0
  log(`${stats.ticks} ticks, ${stats.drawn} drawn (${avg}; ${snapshotsMade() - stats.snapshots} new sprite snapshots), ${stats.sent} frames sent, ${stats.dropped} dropped (${(stats.bytes / 1024).toFixed(0)} KB, ${(stats.bytes / s / 1024).toFixed(1)} KB/s) in ${s.toFixed(0)}s`)
  stats = { ticks: 0, drawn: 0, sent: 0, dropped: 0, bytes: 0, drawMs: 0, snapshots: snapshotsMade(), since: Date.now() }
}, 60000)

const shutdown = () => { log('shutting down'); try { ws?.close(); viewerWs?.close() } catch {} process.exit(0) }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
