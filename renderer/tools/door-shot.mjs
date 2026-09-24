// Put a door into the layout, let the engine draw it, and crop the result with a colour readout
// down its middle.
//
// Use this rather than compositing a sprite onto a rendered frame yourself. A composite is drawn
// with your own camera maths, which sat 8 px below the engine's, and every door sprite tuned
// against one of those previews came out 8 px high in the actual office. It also hides z-order:
// in a north-south wall run the wall below a doorway draws in front of it, which is why the side
// door's band stops where it does.
//
//   node tools/door-shot.mjs <outdir> front|side        closed, as placed
//   DT=0.01 VARIANT=DOOR_SIDE_OPEN node tools/door-shot.mjs <outdir> side
//     (a small DT keeps an open door open: the engine shuts it after DOOR_MIN_OPEN_SEC)
import { createCanvas } from '@napi-rs/canvas'
import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { installShims, useSnapshots } from '../native/shims.mjs'
const token = JSON.parse(readFileSync(homedir() + '/.pixel-agents/daemon.json', 'utf8')).relayToken
const SP = process.argv[2]
const WANT = process.argv[3] || 'side'
installShims(); const print = console.log; console.log = () => {}
const { createHeadlessOffice } = await import('../native/engine.mjs')
const W = 1024, H = 600, T = 16, VOID = 8, WALL = 0
const office = createHeadlessOffice({ width: W, height: H, zoom: 1, background: '#0a0a14' })
const canvas = createCanvas(W, H); const ctx = useSnapshots(canvas.getContext('2d')); ctx.imageSmoothingEnabled = false
const ws = new WebSocket(`wss://apps.blommemix.dk/pixelagents/ws?role=viewer&token=${encodeURIComponent(token)}`)
ws.onmessage = (e) => {
  const m = JSON.parse(e.data); if (m.type !== 'init') return; ws.close()
  const lay = m.layout, cat = m.furniture.catalog
  const tile = (c, r) => (c < 0 || r < 0 || c >= lay.cols || r >= lay.rows) ? VOID : lay.tiles[r * lay.cols + c]
  const gaps = []
  for (let r = 0; r < lay.rows; r++) for (let c = 0; c < lay.cols; c++) {
    const t = tile(c, r); if (t === VOID || t === WALL) continue
    if (WANT === 'side' && tile(c, r - 1) === WALL && tile(c, r + 1) === WALL) gaps.push([c, r])
    if (WANT === 'front' && tile(c - 1, r) === WALL && tile(c + 1, r) === WALL) gaps.push([c, r])
  }
  const [gc, gr] = gaps[0]
  const closed = cat.find((a) => a.name === (process.env.VARIANT || (WANT === 'side' ? 'DOOR_SIDE_CLOSED' : 'DOOR_FRONT_CLOSED')))
  lay.furniture.push({ uid: 'shot-door', type: closed.id, col: gc, row: gr - (closed.footprintH - 1) })
  office.handleRelayMessage(m)
  setTimeout(() => {
    for (let i = 0; i < 40; i++) office.tick(Number(process.env.DT ?? 0.05)) // small DT keeps an open door open past the spawn effect
    office.render(ctx)
    let minC = lay.cols, maxC = -1, minR = lay.rows, maxR = -1
    for (let r = 0; r < lay.rows; r++) for (let c = 0; c < lay.cols; c++) {
      const t = tile(c, r); if (t === VOID) continue
      if (c < minC) minC = c; if (c > maxC) maxC = c; if (r < minR) minR = r; if (r > maxR) maxR = r
    }
    const mapW = lay.cols * T, mapH = lay.rows * T
    const offX = Math.floor((W - mapW) / 2) + Math.round(mapW / 2 - ((minC + maxC + 1) / 2) * T)
    const offY = Math.floor((H - mapH) / 2) + Math.round(mapH / 2 - (((minR + maxR + 1) / 2) * T - T / 2))
    const SC = 10, TILES = 5, half = Math.floor(TILES / 2)
    const crop = createCanvas(TILES * T * SC, TILES * T * SC)
    const g = crop.getContext('2d'); g.imageSmoothingEnabled = false
    g.drawImage(canvas, offX + (gc - half) * T, offY + (gr - half) * T, TILES * T, TILES * T, 0, 0, crop.width, crop.height)
    writeFileSync(`${SP}/real-${process.env.VARIANT ? process.env.VARIANT.toLowerCase() : WANT}.png`, crop.toBuffer('image/png'))
    print(`${WANT} door at ${gc},${gr} -> real-${WANT}.png`)
    // and the colours straight down its middle
    const x = offX + gc * T + 2
    let prev = null, start = 0
    const rows = []
    for (let r = gr - 3; r <= gr + 2; r++) for (let dy = 0; dy < T; dy++) rows.push([r, dy])
    rows.forEach(([r, dy], i) => {
      const d = ctx.getImageData(x, offY + r * T + dy, 1, 1).data
      const hex = `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`
      if (hex !== prev) {
        if (prev !== null) print(`  ${prev}  ${rows[start][0]}+${rows[start][1]} .. ${rows[i - 1][0]}+${rows[i - 1][1]}  (${i - start} px)`)
        prev = hex; start = i
      }
    })
    print(`  ${prev}  ${rows[start][0]}+${rows[start][1]} .. end`)
    process.exit(0)
  }, 400)
}
