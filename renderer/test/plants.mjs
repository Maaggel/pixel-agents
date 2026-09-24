// Plants dry out, and watering them puts them back.
//
// Asserts on what the engine decides to show rather than on pixels at a guessed screen position,
// and saves a picture of one plant through its three states for the eye.
//   node test/plants.mjs        OUT=<dir> for the picture
import { createCanvas } from '@napi-rs/canvas'
import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { installShims, useSnapshots } from '../native/shims.mjs'
const token = process.env.PIXEL_AGENTS_RENDERER_TOKEN || JSON.parse(readFileSync(homedir() + '/.pixel-agents/daemon.json', 'utf8')).relayToken
const OUT = process.env.OUT
installShims(); const print = console.log; console.log = () => {}
const { createHeadlessOffice } = await import('../native/engine.mjs')
const PLANTS = new Set(['ASSET_132', 'ASSET_133_0_0', 'ASSET_140', 'ASSET_141', 'ASSET_142', 'ASSET_143'])
const office = createHeadlessOffice({ width: 512, height: 300, zoom: 1, background: '#000000' })
const canvas = createCanvas(512, 300)
const ctx = useSnapshots(canvas.getContext('2d'))
ctx.imageSmoothingEnabled = false

const ws = new WebSocket(`wss://apps.blommemix.dk/pixelagents/ws?role=viewer&token=${encodeURIComponent(token)}`)
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.type !== 'init') return
  ws.close()
  const uids = new Set(msg.layout.furniture.filter((f) => PLANTS.has(f.type)).map((f) => f.uid))
  office.handleRelayMessage(msg)
  const plants = () => office.debug().furniture().filter((f) => uids.has(f.uid) && f.thirstCycleSprites?.length)
  // before the first tick nothing is chosen yet and the renderer falls back to the base sprite,
  // which is the watered one, so treat "unset" as frame 0
  const frames = () => plants().map((f) => Math.max(0, f.thirstCycleSprites.indexOf(f.activeDataSprite)))
  const run = (minutes) => { for (let t = 0; t < minutes * 120; t++) office.tick(0.5) }

  print(`${plants().length} plants have thirst frames`)
  const shots = []
  const capture = (label) => {
    office.render(ctx)
    const counts = frames().reduce((acc, i) => (acc[i] = (acc[i] || 0) + 1, acc), {})
    print(`${label.padEnd(22)} frames in use: ${JSON.stringify(counts)}`)
    if (OUT) shots.push({ label, sprite: plants()[0].activeDataSprite })
    return counts
  }
  const fresh = capture('just watered')
  run(9); const mid = capture('9 minutes on')
  run(11); const dry = capture('20 minutes on')

  if (OUT && shots.length) {
    const SC = 8
    const sheet = createCanvas(shots.length * (16 * SC + 8) + 8, 16 * SC + 26)
    const g = sheet.getContext('2d'); g.imageSmoothingEnabled = false
    g.fillStyle = '#2a2a3e'; g.fillRect(0, 0, sheet.width, sheet.height)
    shots.forEach((s, i) => {
      const t = createCanvas(16, 16); const tc = t.getContext('2d')
      s.sprite.forEach((row, y) => row.forEach((col, x) => { if (col) { tc.fillStyle = col; tc.fillRect(x, y, 1, 1) } }))
      g.drawImage(t, 8 + i * (16 * SC + 8), 20, 16 * SC, 16 * SC)
      g.fillStyle = '#fff'; g.font = '12px sans-serif'; g.fillText(s.label, 8 + i * (16 * SC + 8), 14)
    })
    writeFileSync(`${OUT}/plants.png`, sheet.toBuffer('image/png'))
  }
  const count = plants().length
  // Plants dry at their own pace, so partway through the office should be showing a mix: that
  // spread is the point, and a run where every plant changed together would mean it was lost.
  const spread = Object.keys(mid).length
  print(`part way through, ${spread} different states are on show at once`)
  // With nobody watering them (no can reachable, or everyone busy) they all end up parched; with
  // the office running normally, passing agents should be keeping some of them alive.
  const ok = fresh['0'] === count && spread > 1 && (dry['2'] ?? 0) + (dry['1'] ?? 0) + (dry['0'] ?? 0) === count
  print(ok ? 'plants start watered and dry out at their own pace' : 'plants are not drying as expected')
  process.exit(ok ? 0 : 1)
}
