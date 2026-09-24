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

/** The build this renderer is drawing, shown on the tablet so it is clear what is live */
const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version }
  catch { return '?' }
})()
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
  maxFps: Math.min(30, Number(env.PIXEL_AGENTS_RENDERER_FPS || file.maxFps || 10)),
  /** zlib level for the deflate encoding (3 = fast, 6 = small); runs on the thread pool */
  deflateLevel: Number(env.PIXEL_AGENTS_RENDERER_DEFLATE_LEVEL || file.deflateLevel || 3),
  /** Resend an unchanged frame at least this often so a relay restart never leaves tablets blank */
  keyframeSec: Number(env.PIXEL_AGENTS_RENDERER_KEYFRAME_SEC || file.keyframeSec || 15),
  /** Poll the relay for connected tablets this often; with none, frames are drawn at idleFps */
  clientPollSec: Number(env.PIXEL_AGENTS_RENDERER_CLIENT_POLL_SEC || file.clientPollSec || 5),
  idleFps: Number(env.PIXEL_AGENTS_RENDERER_IDLE_FPS || file.idleFps || 0.5),
  /** Simulation rate while idle: the engine caps dt at 0.1 s, so 10 Hz keeps the office in real time (cheap, no drawing) */
  idleSimHz: Number(env.PIXEL_AGENTS_RENDERER_IDLE_SIM_HZ || file.idleSimHz || 10),
  /** Redraw the whole frame this often even when nothing is known to have changed (seconds) */
  fullRedrawSec: Number(env.PIXEL_AGENTS_RENDERER_FULL_REDRAW_SEC || file.fullRedrawSec || 2),
  /**
   * Restart when a frame costs this many times its healthy CPU cost (0 disables). Skia's text
   * rendering was measured degrading ~67x over a 19 hour run - the same fourteen nametags going
   * from 1.4 ms to 96 ms a frame - which starved the stream down to 2 fps. Nametag text is now
   * cached as images, which takes that path out of the loop, but the underlying cause is in the
   * native canvas and this is the insurance: systemd restarts the service in a few seconds.
   */
  watchdogFactor: Number(env.PIXEL_AGENTS_RENDERER_WATCHDOG_FACTOR || file.watchdogFactor || 4),
  /** Never restart for a frame cheaper than this, however fast the baseline was (ms of CPU) */
  watchdogFloorMs: Number(env.PIXEL_AGENTS_RENDERER_WATCHDOG_FLOOR_MS || file.watchdogFloorMs || 25),
  /** Damage tracking: draw, read back and convert only what changed. false = every pixel, every frame */
  dirtyRects: (env.PIXEL_AGENTS_RENDERER_DIRTY_RECTS || String(file.dirtyRects ?? 'true')) === 'true',
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
  background: cfg.background,
  fullRedrawSec: cfg.fullRedrawSec,
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
// The frame the tablet is looking at, kept between frames: a damaged frame rewrites only the
// regions that changed, so this is the only complete copy of the picture. `encodeBuffer` is
// handed to zlib on the thread pool, so it gets its own copy and this one can keep being updated.
const rgb565 = Buffer.allocUnsafe(rawSize)
const encodeBuffer = Buffer.allocUnsafe(rawSize)
const frame16 = new Uint16Array(rgb565.buffer, rgb565.byteOffset, pixelCount)
let encoding = false
let prevOverlayRects = []

const timing = { render: 0, readback: 0, rgb565: 0, area: 0 }

/**
 * Convert one region of the scene canvas into the RGB565 frame, upscaled.
 *
 * `src` is the whole canvas read back once: reading each region separately was measured slower
 * than one full read plus this, because every getImageData call allocates and flushes Skia.
 */
function convertRegion(src, x, y, w, h) {
  const up = cfg.upscale
  const W = cfg.width
  for (let sy = 0; sy < h; sy++) {
    const rowStart = (y + sy) * up * W + x * up
    let di = rowStart
    for (let sx = 0, si = (y + sy) * drawW + x; sx < w; sx++, si++) {
      const p = src[si]
      const v = ((p & 0xF8) << 8) | ((p & 0xFC00) >> 5) | ((p & 0xF80000) >> 19)
      for (let k = 0; k < up; k++) frame16[di++] = v
    }
    for (let r = 1; r < up; r++) frame16.copyWithin(rowStart + r * W, rowStart, rowStart + w * up)
  }
  timing.area += w * h
}

/**
 * The build the tablet is looking at, bottom left of the picture.
 *
 * It goes into the scene rather than onto the nametag overlay, because the overlay only exists
 * when the scene is drawn at half size and doubled - and it is not, the tablet does the doubling.
 * Drawn with a 3x5 pixel font rather than a real one: at this size a font is anti-aliased into a
 * smear, and the frame is quantised to RGB565 and doubled by the tablet on top of that. Built once
 * into a small image and blitted each frame - Skia's text drawing also slows down badly over a long
 * run, which is why nametags are cached the same way.
 *
 * Damage needs no special handling. It is drawn after the scene and before the readback, so
 * wherever the office repaints under it the stamp goes back on top and that rectangle is converted
 * anyway; where nothing repaints, the pixels already in the frame are still right.
 */
const STAMP_GLYPHS = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  'v': ['000', '101', '101', '101', '010'],
  '.': ['000', '000', '000', '000', '010'],
}

const stamp = (() => {
  const text = `v${VERSION}`
  const glyphs = [...text].map((ch) => STAMP_GLYPHS[ch]).filter(Boolean)
  const w = glyphs.length * 4 + 1, h = 5 + 4
  const c = createCanvas(w, h)
  const x = c.getContext('2d')
  x.fillStyle = 'rgba(0,0,0,0.6)'
  x.fillRect(0, 0, w, h)
  x.fillStyle = '#e8e8f0'
  glyphs.forEach((g, i) => {
    g.forEach((row, ry) => {
      [...row].forEach((on, rx) => { if (on === '1') x.fillRect(1 + i * 4 + rx, 2 + ry, 1, 1) })
    })
  })
  return { image: c, x: 2, y: drawH - h - 2 }
})()

function drawFrame() {
  const t0 = performance.now()
  // The nametag overlay is drawn first and at full resolution: its rectangles tell the scene pass
  // what to repaint underneath, both where a tag is now and where it was last frame.
  let overlayRects = []
  if (overlayCtx && office.getFlags().showNametags) {
    overlayCtx.clearRect(0, 0, cfg.width, cfg.height)
    overlayRects = office.renderNametagOverlay(overlayCtx, cfg.upscale)
  }
  const up = cfg.upscale
  const extra = []
  for (const list of [prevOverlayRects, overlayRects]) {
    for (const r of list) extra.push({ x: r.x / up, y: r.y / up, w: r.w / up, h: r.h / up })
  }

  const rects = cfg.dirtyRects ? office.renderDamaged(ctx, extra) : (office.render(ctx), null)
  const t1 = performance.now()
  timing.render += t1 - t0

  const unchanged = rects !== null && rects.length === 0 && overlayRects.length === 0 && stats.drawn > 0
  if (!unchanged) {
    ctx.drawImage(stamp.image, stamp.x, stamp.y)
    const rgba = canvas.data() // RGBA8, row-major, no padding (also where Skia rasterises the frame)
    const t2 = performance.now()
    timing.readback += t2 - t1
    const src = new Uint32Array(rgba.buffer, rgba.byteOffset, drawW * drawH) // little-endian: A B G R
    if (rects === null) convertRegion(src, 0, 0, drawW, drawH)
    else for (const r of rects) convertRegion(src, r.x, r.y, r.w, r.h)
    timing.rgb565 += performance.now() - t2
    if (overlayRects.length > 0) compositeNametags(overlayRects)
  }
  prevOverlayRects = overlayRects

  stats.drawn++
  stats.drawMs += performance.now() - t0
  // Nothing moved and no tag was painted: the frame is byte-for-byte the last one
  return unchanged
}

/** Dedupe, then encode off the draw path. */
function publishFrame(unchanged) {
  const now = Date.now()
  const keyframeDue = now - lastSentAt >= cfg.keyframeSec * 1000
  if (unchanged && !keyframeDue) return
  const hash = crc32(rgb565)
  if (hash === lastSentHash && !keyframeDue) return
  if (encoding) { stats.dropped++; return }
  lastSentHash = hash; lastSentAt = now
  encoding = true
  rgb565.copy(encodeBuffer)
  encodeAndSend(encodeBuffer).catch((e) => log(`encode failed: ${e.message}`)).finally(() => { encoding = false })
}

/** Draw the tags at full resolution and blend the painted rectangles over the RGB565 frame. */
function compositeNametags(rects) {
  const dst = frame16
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
          drawFrame(); void encodeAndSend(Buffer.from(rgb565)); clearInterval(loopTimer); return
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
// ── Frame cost watchdog ──────────────────────────────────────
// CPU per frame, not wall time: under SCHED_IDLE a busy box stretches wall time by design, and
// restarting for that would be wrong. Real degradation shows up as more CPU for the same work.
let baselineCpuPerFrame = 0
let cpuAtLastReport = process.cpuUsage()
function checkFrameCost(drawn) {
  const used = process.cpuUsage(cpuAtLastReport)
  cpuAtLastReport = process.cpuUsage()
  if (!drawn) return null
  const perFrame = (used.user + used.system) / 1000 / drawn
  // Idle minutes are not comparable: the office is still simulated at full rate while only a
  // couple of keyframes are drawn, so the cost per frame is mostly simulation and would trip this.
  if (!watched || drawn < cfg.maxFps * 20) return perFrame
  if (baselineCpuPerFrame === 0) { baselineCpuPerFrame = perFrame; return perFrame }
  baselineCpuPerFrame = Math.min(baselineCpuPerFrame, perFrame) // the best minute seen is "healthy"
  const limit = Math.max(cfg.watchdogFloorMs, baselineCpuPerFrame * cfg.watchdogFactor)
  if (cfg.watchdogFactor > 0 && perFrame > limit) {
    log(`frames cost ${perFrame.toFixed(1)} ms of CPU each, over the ${limit.toFixed(1)} ms limit (healthy: ${baselineCpuPerFrame.toFixed(1)}) - restarting`)
    setTimeout(() => process.exit(1), 100) // systemd Restart=always brings it straight back
  }
  return perFrame
}

setInterval(() => {
  const s = (Date.now() - stats.since) / 1000
  const avg = stats.drawn ? `${(stats.drawMs / stats.drawn).toFixed(1)} ms each: render ${(timing.render / stats.drawn).toFixed(1)}, readback ${(timing.readback / stats.drawn).toFixed(1)}, rgb565 ${(timing.rgb565 / stats.drawn).toFixed(1)}, ${(timing.area / stats.drawn / (drawW * drawH) * 100).toFixed(0)}% of the canvas` : '-'
  timing.render = timing.readback = timing.rgb565 = timing.area = 0
  const cpu = checkFrameCost(stats.drawn)
  log(`${stats.ticks} ticks, ${stats.drawn} drawn (${avg}${cpu ? `, ${cpu.toFixed(1)} ms cpu` : ''}; ${snapshotsMade() - stats.snapshots} new sprite snapshots), ${stats.sent} frames sent, ${stats.dropped} dropped (${(stats.bytes / 1024).toFixed(0)} KB, ${(stats.bytes / s / 1024).toFixed(1)} KB/s) in ${s.toFixed(0)}s`)
  stats = { ticks: 0, drawn: 0, sent: 0, dropped: 0, bytes: 0, drawMs: 0, snapshots: snapshotsMade(), since: Date.now() }
}, 60000)

const shutdown = () => { log('shutting down'); try { ws?.close(); viewerWs?.close() } catch {} process.exit(0) }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
