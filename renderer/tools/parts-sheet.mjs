// Looks at the character parts through the code that actually ships.
//
// The cut into hair / skin / top / legs lives in webview-ui/src/office/sprites/characterParts.ts,
// and a second copy of that logic here would drift the first time either was touched. So this
// bundles the real module and calls it, then draws what it gets back:
//
//   node tools/parts-sheet.mjs              # contact sheet -> parts-sheet.png
//   node tools/parts-sheet.mjs --anim       # every frame and direction -> parts-anim.png
//   node tools/parts-sheet.mjs --write DIR  # cut the six characters into part files, to draw over
//
// The sheet shows every hairstyle on every body, then hair, clothes and skin varied one at a time.
// The anim sheet is the one that catches a bad cut: a seam only the walk or the side view shows.
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = new URL('../../', import.meta.url).pathname
const SRC = `${ROOT}webview-ui/public/assets/characters`
const OUT = 'parts-sheet.png'
const writeIndex = process.argv.indexOf('--write')
const WRITE_DIR = writeIndex >= 0 ? process.argv[writeIndex + 1] : null
const FW = 16, FH = 32, S = 5, STANDING = 1
const CELL_W = FW * S + 4, CELL_H = FH * S + 4
// Skin is always cut from the characters at load, because a skin tone comes with a face
const POOL_LAYERS = ['hair', 'top', 'legs']

// ── the real modules, bundled ────────────────────────────────────────────────
const stage = join(tmpdir(), `parts-sheet-${process.pid}`)
mkdirSync(stage, { recursive: true })
const entry = join(stage, 'entry.ts')
writeFileSync(entry, `
export { splitCharacters } from '${ROOT}webview-ui/src/office/sprites/characterParts.js'
export { setCharacterTemplates, getCharacterSprites } from '${ROOT}webview-ui/src/office/sprites/spriteData.js'
export { lookFromName } from '${ROOT}webview-ui/src/office/lookFromName.js'
export { Direction } from '${ROOT}webview-ui/src/office/types.js'
`)
const bundle = join(stage, 'engine.mjs')
execFileSync('npx', ['esbuild', entry, '--bundle', '--format=esm', `--outfile=${bundle}`],
  { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] })
const engine = await import(bundle)
rmSync(stage, { recursive: true, force: true })

// ── the sheets, read the way the extension reads them ────────────────────────
function toFrames(data, width) {
  const out = { down: [], up: [], right: [] }
  const dirs = ['down', 'up', 'right']
  for (let d = 0; d < dirs.length; d++) {
    for (let f = 0; f < 7; f++) {
      const sprite = []
      for (let y = 0; y < FH; y++) {
        const row = []
        for (let x = 0; x < FW; x++) {
          const i = (((d * FH + y) * width) + (f * FW + x)) * 4
          row.push(data[i + 3] < 128 ? '' :
            `#${data[i].toString(16).padStart(2, '0')}${data[i + 1].toString(16).padStart(2, '0')}${data[i + 2].toString(16).padStart(2, '0')}`.toUpperCase())
        }
        sprite.push(row)
      }
      out[dirs[d]].push(sprite)
    }
  }
  return out
}

const characters = []
for (let i = 0; i < 6; i++) {
  const img = await loadImage(`${SRC}/char_${i}.png`)
  const c = createCanvas(img.width, img.height)
  const g = c.getContext('2d')
  g.imageSmoothingEnabled = false
  g.drawImage(img, 0, 0)
  characters.push(toFrames(g.getImageData(0, 0, img.width, img.height).data, img.width))
}
engine.setCharacterTemplates(characters)

if (WRITE_DIR) {
  mkdirSync(WRITE_DIR, { recursive: true })
  const parts = engine.splitCharacters(characters)
  let written = 0
  for (const layer of POOL_LAYERS) {
    for (let i = 0; i < parts.length; i++) {
      const c = createCanvas(FW * 7, FH * 3)
      const g = c.getContext('2d')
      g.imageSmoothingEnabled = false
      const dirs = ['down', 'up', 'right']
      for (let d = 0; d < dirs.length; d++) {
        parts[i][layer][dirs[d]].forEach((sprite, f) => {
          sprite.forEach((row, y) => row.forEach((px, x) => {
            if (!px) return
            g.fillStyle = px
            g.fillRect(f * FW + x, d * FH + y, 1, 1)
          }))
        })
      }
      writeFileSync(`${WRITE_DIR}/${layer}_${i}.png`, c.toBuffer('image/png'))
      written++
    }
  }
  console.log(`wrote ${written} part sheets to ${WRITE_DIR}`)
  console.log('these files are now the parts - the characters are only cut up when a layer has none')
}

// ── the sheets ───────────────────────────────────────────────────────────────
function paint(ctx, px, py, sprite, scale = S) {
  sprite.forEach((row, y) => row.forEach((hex, x) => {
    if (!hex) return
    ctx.fillStyle = hex
    ctx.fillRect(px + x * scale, py + y * scale, scale, scale)
  }))
}

function drawLook(ctx, px, py, look) {
  paint(ctx, px, py, engine.getCharacterSprites(look).walk[engine.Direction.DOWN][STANDING])
}

/**
 * Every frame of every direction for a few mixed looks. A cut that is a pixel out only shows up
 * once an arm swings or the character turns, so this is the sheet worth staring at.
 */
function animSheet() {
  const A = 6
  const CW = FW * A + 6, CH = FH * A + 6
  const looks = [
    ['hair 2 / top 5 / legs 0', { palette: 3, hueShift: 0, parts: { hair: 2, hairHue: 0, top: 5, topHue: 0, legs: 0, legsHue: 0 } }],
    ['hair 5 / top 0 / legs 3', { palette: 1, hueShift: 0, parts: { hair: 5, hairHue: 0, top: 0, topHue: 0, legs: 3, legsHue: 0 } }],
    ['hair 1 / top 2 / legs 4', { palette: 5, hueShift: 30, parts: { hair: 1, hairHue: 330, top: 2, topHue: 180, legs: 4, legsHue: 0 } }],
  ]
  const DIRS = [['down', 'DOWN'], ['up', 'UP'], ['left', 'LEFT'], ['right', 'RIGHT']]
  const COLS = 8 // walk x4, type x2, read x2
  const c = createCanvas(COLS * CW + 120, looks.length * (4 * CH + 34) + 30)
  const x = c.getContext('2d')
  x.imageSmoothingEnabled = false
  x.fillStyle = '#20202e'
  x.fillRect(0, 0, c.width, c.height)
  x.font = 'bold 12px sans-serif'

  x.fillStyle = '#cfcfe4'
  const heads = ['walk 1', 'walk 2', 'walk 3', 'walk 4', 'type 1', 'type 2', 'read 1', 'read 2']
  heads.forEach((h, i) => x.fillText(h, 116 + i * CW, 18))

  let y = 26
  for (const [name, look] of looks) {
    const sprites = engine.getCharacterSprites(look)
    x.fillStyle = '#cfcfe4'
    x.fillText(name, 14, y + 12)
    for (const [label, dir] of DIRS) {
      const d = engine.Direction[dir]
      const frames = [...sprites.walk[d], ...sprites.typing[d], ...sprites.reading[d]]
      x.fillStyle = '#8f8fa8'
      x.fillText(label, 14, y + CH / 2 + 4)
      frames.forEach((sprite, i) => paint(x, 116 + i * CW, y, sprite, A))
      y += CH
    }
    y += 34
  }
  writeFileSync('parts-anim.png', c.toBuffer('image/png'))
  console.log('wrote parts-anim.png')
}

if (process.argv.includes('--anim')) {
  animSheet()
  process.exit(0)
}

// A coloured shirt, so the sweep is visible: rotating the hue of a white one changes nothing
const parts = (over) => ({
  palette: 4, hueShift: 0,
  parts: { hair: 4, hairHue: 0, top: 5, topHue: 0, legs: 0, legsHue: 0, ...over },
})
const HUES = [0, 45, 90, 135, 180, 225]
const c = createCanvas(6 * CELL_W + 100, 10 * CELL_H + 110)
const x = c.getContext('2d')
x.imageSmoothingEnabled = false
x.fillStyle = '#20202e'
x.fillRect(0, 0, c.width, c.height)
x.font = 'bold 12px sans-serif'
const label = (t, px, py) => { x.fillStyle = '#cfcfe4'; x.fillText(t, px, py) }

label('every hairstyle (down) on every body (across)', 14, 18)
for (let hair = 0; hair < 6; hair++) {
  for (let body = 0; body < 6; body++) {
    drawLook(x, 96 + body * CELL_W, 26 + hair * CELL_H,
      { palette: body, hueShift: 0, parts: { hair, hairHue: 0, top: body, topHue: 0, legs: body, legsHue: 0 } })
  }
  label(`hair ${hair}`, 14, 26 + hair * CELL_H + CELL_H / 2)
}

let y = 26 + 6 * CELL_H + 24
for (const [title, key, tag] of [
  ['hair hue swept - clothes and skin untouched', 'hairHue', 'hair'],
  ['top hue swept - hair and skin untouched', 'topHue', 'top'],
]) {
  label(title, 14, y - 6)
  HUES.forEach((h, i) => drawLook(x, 96 + i * CELL_W, y, parts({ [key]: h })))
  label(tag, 14, y + CELL_H / 2)
  y += CELL_H + 24
}

label('names, as the office would hash them', 14, y - 6)
;['Pantograph', 'Blommemix', 'TabScreen', 'Oriel', 'Playbook', 'Iacta'].forEach((name, i) =>
  drawLook(x, 96 + i * CELL_W, y, engine.lookFromName(name)))
label('by name', 14, y + CELL_H / 2)

writeFileSync(OUT, c.toBuffer('image/png'))
console.log(`wrote ${OUT}`)
