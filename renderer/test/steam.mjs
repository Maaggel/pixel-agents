// Steam above a fresh cup of coffee.
//
// Drops a mug on a desk, then renders it as it cools: the steam should be there at once, thinner
// after a minute, and gone once the drink is cold.
//   node test/steam.mjs      OUT=<dir> for a picture
import { createCanvas } from '@napi-rs/canvas'
import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { installShims, useSnapshots } from '../native/shims.mjs'
const token = process.env.PIXEL_AGENTS_RENDERER_TOKEN || JSON.parse(readFileSync(homedir() + '/.pixel-agents/daemon.json', 'utf8')).relayToken
const OUT = process.env.OUT
installShims(); const print = console.log; console.log = () => {}
const { createHeadlessOffice } = await import('../native/engine.mjs')
const office = createHeadlessOffice({ width: 512, height: 300, zoom: 1, background: '#000000' })
const canvas = createCanvas(512, 300)
const ctx = useSnapshots(canvas.getContext('2d'))
ctx.imageSmoothingEnabled = false
const ws = new WebSocket(`wss://apps.blommemix.dk/pixelagents/ws?role=viewer&token=${encodeURIComponent(token)}`)
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.type !== 'init') return
  ws.close()
  const mug = msg.furniture.catalog.find((c) => c.id === 'ASSET_51')
  print(`coffee is served hot: ${mug?.steams === true}`)
  office.handleRelayMessage(msg)
  office.tick(0.1)
  // put a fresh mug on a desk the way an agent would
  const seated = office.debug().characters().find((c) => c.seatId)
  const dbg = office.debug()
  const placed = dbg.dropProp("ASSET_51")
  print(placed ? `mug placed at ${placed.col},${placed.row}` : "no desk to put it on")
  const steaming = () => dbg.furniture().filter((f) => (f.steam ?? 0) > 0)
  const readings = []
  let elapsed = 0
  office.tick(0.5) // the cup only knows it is hot on the tick after it is poured
  for (const seconds of [0, 50, 110]) {
    while (elapsed < seconds) { office.tick(0.5); elapsed += 0.5 }
    const hot = steaming()
    readings.push({ seconds, count: hot.length, heat: hot[0]?.steam ?? 0 })
    print(`${String(seconds).padStart(3)}s after pouring: ${hot.length} cup(s) steaming, heat ${(hot[0]?.steam ?? 0).toFixed(2)}`)
  }
  const ok = readings[0].count > 0 && readings[1].heat > 0 && readings[1].heat < readings[0].heat && readings[2].count === 0
  print(ok ? 'steam starts thick, thins out, and stops once the drink is cold' : 'steam did not behave')
  process.exit(ok ? 0 : 1)
}
