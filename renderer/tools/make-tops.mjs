// Draw new shirts on top of the ones the characters came in.
//
// A garment has to work in 21 frames and four directions, and hand-drawing that many times over is
// how sleeves end up a pixel out. So each new top starts from a part that already fits - the right
// silhouette, the right shading, the right arm in every frame - and detail is added by pushing the
// pixels that are already there lighter or darker, or recolouring a few of them. Fabric keeps its
// shading that way, and nothing can fall outside the shape of the garment.
//
//   cd renderer && node tools/make-tops.mjs [outdir]
//
// Writes the next top_<n>.png files after the ones that exist. Preview them with
//   node tools/parts-sheet.mjs && node tools/parts-sheet.mjs --anim
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { writeFileSync } from 'fs'

const OUT = process.argv[2] || '../webview-ui/public/assets/characters/parts'
const FW = 16, FH = 32, FRAMES = 7
/** Sheet rows: frames 0-6 face down, 7-13 face up, 14-20 face right */
const FACING_DOWN = 0, FACING_UP = 1, FACING_RIGHT = 2
/** How many parts per layer come from cutting the six characters up */
const FROM_CHARACTERS = 6

function shade(hex, amount) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
  const f = (v) => Math.max(0, Math.min(255, Math.round(v + amount * 255)))
  return `#${f(r).toString(16).padStart(2, '0')}${f(g).toString(16).padStart(2, '0')}${f(b).toString(16).padStart(2, '0')}`.toUpperCase()
}

/** Recolour to a hue, keeping how light or dark the pixel already was. */
function dye(hex, h, s) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255
  const l = 0.299 * r + 0.587 * g + 0.114 * b
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = h / 60
  const xx = c * (1 - Math.abs(hp % 2 - 1))
  let rr = 0, gg = 0, bb = 0
  if (hp < 1) [rr, gg, bb] = [c, xx, 0]
  else if (hp < 2) [rr, gg, bb] = [xx, c, 0]
  else if (hp < 3) [rr, gg, bb] = [0, c, xx]
  else if (hp < 4) [rr, gg, bb] = [0, xx, c]
  else if (hp < 5) [rr, gg, bb] = [xx, 0, c]
  else [rr, gg, bb] = [c, 0, xx]
  const m = l - c / 2
  const f = (v) => Math.max(0, Math.min(255, Math.round((v + m) * 255)))
  return `#${f(rr).toString(16).padStart(2, '0')}${f(gg).toString(16).padStart(2, '0')}${f(bb).toString(16).padStart(2, '0')}`.toUpperCase()
}

async function readSheet(path) {
  const img = await loadImage(path)
  const c = createCanvas(img.width, img.height)
  const g = c.getContext('2d')
  g.imageSmoothingEnabled = false
  g.drawImage(img, 0, 0)
  const d = g.getImageData(0, 0, img.width, img.height).data
  const rows = []
  for (let y = 0; y < img.height; y++) {
    const row = []
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4
      row.push(d[i + 3] < 128 ? '' :
        `#${d[i].toString(16).padStart(2, '0')}${d[i + 1].toString(16).padStart(2, '0')}${d[i + 2].toString(16).padStart(2, '0')}`.toUpperCase())
    }
    rows.push(row)
  }
  return rows
}

function writeSheet(path, rows) {
  const c = createCanvas(rows[0].length, rows.length)
  const g = c.getContext('2d')
  g.imageSmoothingEnabled = false
  rows.forEach((row, y) => row.forEach((px, x) => {
    if (!px) return
    g.fillStyle = px
    g.fillRect(x, y, 1, 1)
  }))
  writeFileSync(path, c.toBuffer('image/png'))
}

/**
 * Walk every pixel of a sheet with the frame it belongs to. `fn` gets the colour and where it sits
 * inside its own 16x32 frame, and returns a new colour, '' to rub it out, or null to leave it.
 */
function edit(rows, fn) {
  const out = rows.map((row) => [...row])
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const px = rows[y][x]
      if (!px) continue
      const next = fn(px, {
        x: x % FW,
        y: y % FH,
        frame: Math.floor(x / FW),
        facing: Math.floor(y / FH),
      })
      if (next !== null && next !== undefined) out[y][x] = next
    }
  }
  return out
}

/** The middle of the chest, for anything worn down the front. Sleeves are outside it. */
const isChest = (p) => p.x >= 4 && p.x <= 11

const GARMENTS = [
  {
    // Off a mid-toned jumper, not the white tee: stripes need something to be darker than
    name: 'striped jumper',
    base: 'top_5',
    draw: (rows) => edit(rows, (px, p) => (p.y === 19 || p.y === 21 || p.y === 23) ? shade(px, -0.3) : null),
  },
  {
    name: 'shirt and tie',
    base: 'top_4',
    draw: (rows) => edit(rows, (px, p) => {
      if (p.facing === FACING_UP) return p.y === 18 ? shade(px, -0.18) : null // just a collar from behind
      if (p.y === 18 && isChest(p)) return shade(px, -0.18)                   // collar
      if (p.y >= 19 && p.y <= 23 && (p.x === 7 || p.x === 8)) return dye(px, 350, 0.55)
      return null
    }),
  },
  {
    name: 'hoodie',
    base: 'top_3',
    draw: (rows) => edit(rows, (px, p) => {
      if (p.y === 18) return shade(px, 0.16)                                   // the hood, bunched up
      if (p.y === 19) return shade(px, -0.16)                                  // and its shadow
      if (p.facing === FACING_UP) return null
      if (p.y >= 22 && p.y <= 23 && isChest(p)) return shade(px, -0.24)        // the front pocket
      if (p.y === 20 && (p.x === 6 || p.x === 9)) return shade(px, -0.34)      // drawstrings
      return null
    }),
  },
  {
    name: 'waistcoat',
    base: 'top_4',
    draw: (rows) => edit(rows, (px, p) => {
      if (p.y < 19 || p.y > 24) return null
      if (p.facing === FACING_UP) return shade(px, -0.3)                       // all back panel
      if (p.x <= 5 || p.x >= 10) return shade(px, -0.3)                        // panels either side
      if (p.facing === FACING_DOWN && (p.y === 20 || p.y === 22) && p.x === 7) return shade(px, -0.45)
      return null
    }),
  },
]

// The first six of every layer are the characters cut up; anything drawn here goes after them, at a
// fixed number, so running this again redraws the same files instead of piling up new ones.
let next = FROM_CHARACTERS
for (const garment of GARMENTS) {
  const rows = await readSheet(`${OUT}/${garment.base}.png`)
  writeSheet(`${OUT}/top_${next}.png`, garment.draw(rows))
  console.log(`  top_${next}.png  ${garment.name} (from ${garment.base})`)
  next++
}
console.log(`${GARMENTS.length} new tops; the pool now runs to top_${next - 1}`)
void FRAMES
