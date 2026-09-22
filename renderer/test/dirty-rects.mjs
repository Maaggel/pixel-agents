// Proves the renderer's damage tracking never misses a pixel.
//
// native-publisher.mjs converts and sends only the rectangles entry.ts reports as damaged, so a
// change nobody tracks becomes a stale patch on the tablet until the next full redraw. This runs
// the real office against live relay state and checks the invariant directly: every pixel that
// differs from the previous frame must lie inside a reported rectangle.
//   node test/dirty-rects.mjs [frames]
import { createCanvas } from '@napi-rs/canvas'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { installShims, useSnapshots } from '../native/shims.mjs'

const frames = Number(process.argv[2] || 300)
// Compared in RGB565, which is what the tablet is sent: 5 bits of red and blue, 6 of green.
// Blends that read a clock (skill auras, the glass tint) drift below that, invisibly.
const TOLERANCE = Number(process.env.TOLERANCE || 2)
const relayWs = process.env.PIXEL_AGENTS_RENDERER_RELAY_WS || 'wss://apps.blommemix.dk/pixelagents/ws'
const token = process.env.PIXEL_AGENTS_RENDERER_TOKEN || JSON.parse(readFileSync(homedir() + '/.pixel-agents/daemon.json', 'utf8')).relayToken
const W = 512, H = 300
installShims()
const print = console.log
console.log = () => {}
const { createHeadlessOffice } = await import('../native/engine.mjs')
const office = createHeadlessOffice({ width: W, height: H, zoom: 1, background: '#000000', nametagOverlay: true, nametagStripEmoji: true, nametagFont: { px: 8, family: 'monospace' } })
const canvas = createCanvas(W, H)
const ctx = useSnapshots(canvas.getContext('2d'))
ctx.imageSmoothingEnabled = false
const to565 = (d, i) => ((d[i] & 0xF8) << 8) | ((d[i + 1] & 0xFC) << 3) | (d[i + 2] >> 3)

const ws = new WebSocket(`${relayWs}?role=viewer&token=${encodeURIComponent(token)}`)
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  office.handleRelayMessage(msg)
  if (msg.type !== 'init') return
  ws.close()
  for (let i = 0; i < 60; i++) office.tick(0.05) // let spawn effects finish

  let prev = null
  let bad = 0, fullRedraws = 0, idle = 0, area = 0, partial = 0
  for (let f = 0; f < frames; f++) {
    office.tick(1 / 10)
    const rects = office.renderDamaged(ctx)
    const cur = Buffer.from(canvas.data())
    if (rects === null) fullRedraws++
    else if (rects.length === 0) idle++
    else { partial++; for (const r of rects) area += r.w * r.h }

    if (prev && rects !== null) {
      let missed = 0, worst = 0, firstX = -1, firstY = -1
      for (let i = 0; i < cur.length; i += 4) {
        if (to565(cur, i) === to565(prev, i)) continue
        const d = Math.max(Math.abs(cur[i] - prev[i]), Math.abs(cur[i + 1] - prev[i + 1]), Math.abs(cur[i + 2] - prev[i + 2]))
        if (d <= TOLERANCE) continue
        const p = i / 4, x = p % W, y = (p / W) | 0
        if (rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) continue
        if (missed === 0) { firstX = x; firstY = y }
        missed++
        if (d > worst) worst = d
      }
      if (missed > 0) {
        bad++
        if (bad <= 5) print(`frame ${f}: ${missed} changed pixels outside the reported rects (by up to ${worst}), first at ${firstX},${firstY}, ${rects.length} rects`)
      }
    }
    prev = cur
  }
  const pct = partial ? (area / partial / (W * H) * 100).toFixed(1) : '0'
  print(`${frames} frames: ${bad} with missed pixels, ${fullRedraws} full redraws, ${idle} unchanged frames, ${pct}% of the canvas reported damaged on the other ${partial}`)
  process.exit(bad > 0 ? 1 : 0)
}
