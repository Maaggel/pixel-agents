// What is the office doing right now?
//
// office-audit.mjs closes the relay connection after the first message, which freezes every agent
// as busy or idle forever and simulates from there. That hid a real bug: the meeting roll ran once
// per idle agent, so a dozen agents going idle together made meetings start every few seconds -
// invisible in the audit, obvious here. This watches the live feed instead, connection held open,
// agents going busy and idle as they really do, and prints each idle action and pickup as it
// happens. Use it when the office looks wrong but the audit says it is fine.
//   MINUTES=10 node test/watch-live.mjs
//   S=/some/dir MINUTES=10 node test/watch-live.mjs   # also save pictures of any steaming cup
import { createCanvas } from '@napi-rs/canvas'
import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { installShims, useSnapshots } from '../native/shims.mjs'

const token = JSON.parse(readFileSync(homedir() + '/.pixel-agents/daemon.json', 'utf8')).relayToken
const SHOTS = process.env.S
const MINUTES = Number(process.env.MINUTES || 10)
installShims()
const print = console.log
console.log = () => {}
const { createHeadlessOffice } = await import('../native/engine.mjs')

const W = 512, H = 300, TILE = 16, VOID = 8
const office = createHeadlessOffice({ width: W, height: H, zoom: 1, background: '#000000' })
const canvas = createCanvas(W, H)
const ctx = useSnapshots(canvas.getContext('2d'))
ctx.imageSmoothingEnabled = false

let offX = 0, offY = 0
const byId = new Map()
const ws = new WebSocket(`wss://apps.blommemix.dk/pixelagents/ws?role=viewer&token=${encodeURIComponent(token)}`)
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  office.handleRelayMessage(msg)
  if (msg.type !== 'init') return
  msg.furniture.catalog.forEach((c) => byId.set(c.id, c.name))
  const layout = msg.layout
  // centre the same way the kiosk camera does, so saved crops line up with what the tablet shows
  let minC = layout.cols, maxC = -1, minR = layout.rows, maxR = -1
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      const t = layout.tiles[r * layout.cols + c]
      if (t === VOID || t === undefined) continue
      if (c < minC) minC = c
      if (c > maxC) maxC = c
      if (r < minR) minR = r
      if (r > maxR) maxR = r
    }
  }
  const mapW = layout.cols * TILE, mapH = layout.rows * TILE
  offX = Math.floor((W - mapW) / 2) + Math.round(mapW / 2 - ((minC + maxC + 1) / 2) * TILE)
  offY = Math.floor((H - mapH) / 2) + Math.round(mapH / 2 - (((minR + maxR + 1) / 2) * TILE - TILE / 2))
  print(`watching for ${MINUTES} minutes, ${office.debug().characters().length} agents`)
}

const dbg = office.debug()
const actions = {}, fetched = {}
const lastAction = new Map(), held = new Map()
let busySum = 0, samples = 0, steamShots = 0
let last = Date.now()

const stamp = () => new Date().toTimeString().slice(0, 8)

const timer = setInterval(() => {
  const now = Date.now()
  office.tick(Math.min(0.2, (now - last) / 1000))
  last = now
  const chars = dbg.characters()
  if (!chars.length) return
  samples++
  busySum += chars.filter((c) => c.isActive).length / chars.length

  for (const ch of chars) {
    const who = (ch.nametag || String(ch.id)).slice(0, 22).padEnd(22)
    if (ch.idleAction && ch.idleAction !== lastAction.get(ch.id)) {
      actions[ch.idleAction] = (actions[ch.idleAction] || 0) + 1
      print(`  ${stamp()} ${who} ${ch.idleAction}`)
    }
    lastAction.set(ch.id, ch.idleAction)
    if (ch.heldItem && ch.heldItem !== (held.get(ch.id) ?? null)) {
      const label = byId.get(ch.heldItem) ?? ch.heldItem
      fetched[label] = (fetched[label] || 0) + 1
      print(`  ${stamp()} ${who} picked up ${label}`)
    }
    held.set(ch.id, ch.heldItem ?? null)
  }

  const hot = dbg.furniture().filter((f) => f.steam > 0.05)
  if (hot.length && steamShots < 3 && SHOTS) {
    steamShots++
    office.render(ctx)
    const f = hot[0], SCALE = 10
    const crop = createCanvas(3 * TILE * SCALE, 3 * TILE * SCALE)
    const g = crop.getContext('2d')
    g.imageSmoothingEnabled = false
    g.drawImage(canvas, offX + (Math.floor(f.col) - 1) * TILE, offY + (Math.floor(f.row) - 2) * TILE,
      3 * TILE, 3 * TILE, 0, 0, crop.width, crop.height)
    writeFileSync(`${SHOTS}/live-steam-${steamShots}.png`, crop.toBuffer('image/png'))
    print(`  ${stamp()} >>> ${byId.get(f.type) ?? f.type} steaming at ${f.col},${f.row} (heat ${f.steam.toFixed(2)}) - picture saved`)
  }
}, 100)

setTimeout(() => {
  clearInterval(timer)
  const list = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join(', ')
  print(`\nover ${MINUTES} minutes of the real office:`)
  print(`  agents busy working: ${(busySum / Math.max(1, samples) * 100).toFixed(0)}% of the time`)
  print(`  idle actions: ${list(actions) || 'none at all'}`)
  print(`  picked up: ${list(fetched) || 'nothing'}`)
  process.exit(0)
}, MINUTES * 60000)
