// Render the live office and crop a patch of it, scaled up, for sprite work: what does the thing
// I am about to draw have to sit next to? Also prints a colour grid down the crop so a new sprite
// can be matched to the wall or floor it will touch.
//   cd renderer && node tools/shot.mjs <outdir> <col> <row> [tiles] [scale]
import { createCanvas } from '@napi-rs/canvas'
import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { installShims, useSnapshots } from '../native/shims.mjs'
const token = JSON.parse(readFileSync(homedir() + '/.pixel-agents/daemon.json', 'utf8')).relayToken
const SP = process.argv[2]
const COL = Number(process.argv[3]), ROW = Number(process.argv[4]), TILES = Number(process.argv[5] || 6), SCALE = Number(process.argv[6] || 12)
installShims(); const print = console.log; console.log = () => {}
const { createHeadlessOffice } = await import('../native/engine.mjs')
const W = 1024, H = 600, T = 16, VOID = 8
const office = createHeadlessOffice({ width: W, height: H, zoom: 1, background: '#0a0a14' })
const canvas = createCanvas(W, H); const ctx = useSnapshots(canvas.getContext('2d')); ctx.imageSmoothingEnabled = false
const ws = new WebSocket(`wss://apps.blommemix.dk/pixelagents/ws?role=viewer&token=${encodeURIComponent(token)}`)
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  office.handleRelayMessage(m)
  if (m.type !== 'init') return
  ws.close()
  const lay = m.layout
  let minC = lay.cols, maxC = -1, minR = lay.rows, maxR = -1
  for (let r = 0; r < lay.rows; r++) for (let c = 0; c < lay.cols; c++) {
    const t = lay.tiles[r * lay.cols + c]; if (t === VOID || t === undefined) continue
    if (c < minC) minC = c; if (c > maxC) maxC = c; if (r < minR) minR = r; if (r > maxR) maxR = r
  }
  const mapW = lay.cols * T, mapH = lay.rows * T
  const offX = Math.floor((W - mapW) / 2) + Math.round(mapW / 2 - ((minC + maxC + 1) / 2) * T)
  const offY = Math.floor((H - mapH) / 2) + Math.round(mapH / 2 - (((minR + maxR + 1) / 2) * T - T / 2))
  setTimeout(() => {
    office.tick(0.05); office.render(ctx)
    const half = Math.floor(TILES / 2)
    const sx = offX + (COL - half) * T, sy = offY + (ROW - half) * T
    const crop = createCanvas(TILES * T * SCALE, TILES * T * SCALE)
    const g = crop.getContext('2d'); g.imageSmoothingEnabled = false
    g.drawImage(canvas, sx, sy, TILES * T, TILES * T, 0, 0, crop.width, crop.height)
    writeFileSync(`${SP}/shot.png`, crop.toBuffer('image/png'))
    // sample the wall face and the wall top for palette matching
    const raw = ctx.getImageData(sx, sy, TILES * T, TILES * T).data
    const at = (x, y) => { const i = (y * TILES * T + x) * 4; return `#${[raw[i], raw[i + 1], raw[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}` }
    print(`crop ${TILES}x${TILES} tiles around ${COL},${ROW} -> shot.png`)
    for (let dy = 0; dy < TILES * T; dy += 8) print(`  y+${dy}: ` + [0, 8, 16, 24, 32, 40].map((dx) => at(dx + half * T, dy)).join(' '))
    process.exit(0)
  }, 400)
}
