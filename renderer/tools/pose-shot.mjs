// Catch an agent on the toilet and photograph both of the poses they sit in.
//
// Sends someone off with the USE_TOILET action, waits for them to sit, and crops the loo once for
// each pose. Poses are picked at random on sitting, so it keeps sending people until it has both.
//   cd renderer && node tools/pose-shot.mjs <outdir>
import { createCanvas } from '@napi-rs/canvas'
import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { installShims, useSnapshots } from '/home/mix/projects/pixel-agents/renderer/native/shims.mjs'
const token = JSON.parse(readFileSync(homedir() + '/.pixel-agents/daemon.json', 'utf8')).relayToken
const SP = process.argv[2]
installShims(); const print = console.log; console.log = () => {}
const { createHeadlessOffice } = await import('/home/mix/projects/pixel-agents/renderer/native/engine.mjs')
const W = 1024, H = 600, T = 16, VOID = 8
const office = createHeadlessOffice({ width: W, height: H, zoom: 1, background: '#0a0a14' })
const canvas = createCanvas(W, H); const ctx = useSnapshots(canvas.getContext('2d')); ctx.imageSmoothingEnabled = false
const ws = new WebSocket(`wss://apps.blommemix.dk/pixelagents/ws?role=viewer&token=${encodeURIComponent(token)}`)
ws.onmessage = async (e) => {
  const m = JSON.parse(e.data); if (m.type !== 'init') return
  office.handleRelayMessage(m)
  const dbg = office.debug()
  const t0 = Date.now()
  while (dbg.characters().length === 0 && Date.now() - t0 < 8000) { office.tick(0.05); await new Promise((r) => setTimeout(r, 50)) }
  ws.close()
  const lay = m.layout
  const toiletEntry = m.furniture.catalog.find((c) => c.privacySeat)
  const toilet = lay.furniture.find((f) => f.type === toiletEntry.id)
  let minC = lay.cols, maxC = -1, minR = lay.rows, maxR = -1
  for (let r = 0; r < lay.rows; r++) for (let c = 0; c < lay.cols; c++) {
    const t = lay.tiles[r * lay.cols + c]; if (t === VOID) continue
    if (c < minC) minC = c; if (c > maxC) maxC = c; if (r < minR) minR = r; if (r > maxR) maxR = r
  }
  const mapW = lay.cols * T, mapH = lay.rows * T
  const offX = Math.floor((W - mapW) / 2) + Math.round(mapW / 2 - ((minC + maxC + 1) / 2) * T)
  const offY = Math.floor((H - mapH) / 2) + Math.round(mapH / 2 - (((minR + maxR + 1) / 2) * T - T / 2))
  const want = new Set(['phone', 'still'])
  for (let attempt = 0; attempt < 12 && want.size; attempt++) {
    const who = dbg.characters().find((c) => !c.isRemote && !c.isSubagent)
    if (!dbg.startIdle(who.id, 'use_toilet')) { office.tick(0.5); continue }
    let pose = null
    for (let i = 0; i < 800 && !pose; i++) {
      office.tick(0.1)
      const c = dbg.characters().find((x) => x.id === who.id)
      if (c.tileCol === toilet.col && c.tileRow === toilet.row && c.sitPose) pose = c.sitPose
    }
    if (!pose || !want.has(pose)) continue
    want.delete(pose)
    office.tick(0.1); office.render(ctx)
    const SC = 12, TILES = 4, half = 1
    const crop = createCanvas(TILES * T * SC, TILES * T * SC)
    const g = crop.getContext('2d'); g.imageSmoothingEnabled = false
    g.drawImage(canvas, offX + (toilet.col - half) * T, offY + (toilet.row - half - 1) * T, TILES * T, TILES * T, 0, 0, crop.width, crop.height)
    writeFileSync(`${SP}/loo-${pose}.png`, crop.toBuffer('image/png'))
    print(`captured ${pose}`)
    // let the visit finish before the next one
    for (let i = 0; i < 900; i++) office.tick(0.1)
  }
  print(want.size ? `never saw: ${[...want].join(', ')}` : 'both poses captured')
  process.exit(0)
}
