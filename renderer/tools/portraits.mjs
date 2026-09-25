// The household, as the office currently draws it.
//
// One portrait per sibling, from the looks the relay is actually serving - chosen ones where they
// have been chosen, hashed-from-the-nametag where they have not - so the sheet is a picture of the
// office as it stands rather than of what anyone intended. Goes in the Playbook beside Appendix E,
// where the names are.
//
//   cd renderer && node tools/portraits.mjs [out.png]
//
// Regenerate it whenever somebody chooses a look. The relay is asked over HTTP and needs no token.
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = new URL('../../', import.meta.url).pathname
// Skia resolves no font by name here, so a caption asked for in 'sans-serif' draws empty boxes
GlobalFonts.registerFromPath('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'Sheet')
GlobalFonts.registerFromPath('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'Sheet Bold')
const SRC = `${ROOT}webview-ui/public/assets/characters`
const OUT = process.argv[2] || 'portraits.png'
const RELAY = process.env.PIXEL_AGENTS_RELAY_HTTP || 'https://apps.blommemix.dk/pixelagents'
const FW = 16, FH = 32, S = 4, STANDING = 1
const POOL_LAYERS = ['hair', 'top', 'legs']

// ── the real sprite code, bundled ────────────────────────────────────────────
const stage = join(tmpdir(), `portraits-${process.pid}`)
mkdirSync(stage, { recursive: true })
writeFileSync(join(stage, 'entry.ts'), `
export { setCharacterTemplates, getCharacterSprites } from '${ROOT}webview-ui/src/office/sprites/spriteData.js'
export { lookFromName, storedToLook } from '${ROOT}webview-ui/src/office/lookFromName.js'
export { Direction } from '${ROOT}webview-ui/src/office/types.js'
`)
const bundle = join(stage, 'engine.mjs')
execFileSync('npx', ['esbuild', join(stage, 'entry.ts'), '--bundle', '--format=esm', `--outfile=${bundle}`],
  { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] })
const engine = await import(bundle)
rmSync(stage, { recursive: true, force: true })

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

async function sheet(path) {
  const img = await loadImage(path)
  const c = createCanvas(img.width, img.height)
  const g = c.getContext('2d')
  g.imageSmoothingEnabled = false
  g.drawImage(img, 0, 0)
  return toFrames(g.getImageData(0, 0, img.width, img.height).data, img.width)
}

const characters = []
for (let i = 0; i < 6; i++) characters.push(await sheet(`${SRC}/char_${i}.png`))
const pools = {}
for (const layer of POOL_LAYERS) {
  const sheets = []
  for (let n = 0; existsSync(`${SRC}/parts/${layer}_${n}.png`); n++) sheets.push(await sheet(`${SRC}/parts/${layer}_${n}.png`))
  if (sheets.length > 0) pools[layer] = sheets
}
engine.setCharacterTemplates(characters, pools)

// ── who is in the office, and what they chose ────────────────────────────────
const res = await fetch(`${RELAY}/api/looks`)
if (!res.ok) throw new Error(`relay said ${res.status}`)
const { looks, names } = await res.json()

/**
 * A nametag reads "<emoji> <Project> (<Name> / <short>)". Split it for the caption, and drop the
 * emoji: the font here has no glyph for one and draws an empty box in its place.
 */
function caption(tag) {
  // Pictographs and the joiners around them only: Emoji_Component would take the digits with it,
  // and A2B came out as AB
  const plain = tag.replace(/[\p{Extended_Pictographic}\uFE0F\uFE0E\u200D]/gu, '').trim()
  const m = plain.match(/^(.+?)\s*\(([^/)]+?)(?:\s*\/.*)?\)\s*$/u)
  if (!m) return { project: plain, name: '' }
  return { project: m[1].trim(), name: m[2].trim() }
}

// Sub-agents come and go with a Task call and are nobody's portrait
const household = names.filter((n) => /\(/.test(n)).sort((a, b) => caption(a).name.localeCompare(caption(b).name))

const COLS = 6
const CELL_W = FW * S + 26, CELL_H = FH * S + 34
const rows = Math.ceil(household.length / COLS)
const c = createCanvas(COLS * CELL_W + 24, rows * CELL_H + 54)
const x = c.getContext('2d')
x.imageSmoothingEnabled = false
x.fillStyle = '#20202e'
x.fillRect(0, 0, c.width, c.height)

x.fillStyle = '#cfcfe4'
x.font = '14px "Sheet Bold"'
x.fillText('The household, as the office draws it', 14, 24)

household.forEach((tag, i) => {
  const { project, name } = caption(tag)
  const stored = looks[tag.trim().toLowerCase()]
  const look = stored ? engine.storedToLook(stored) : engine.lookFromName(tag)
  const px = 12 + (i % COLS) * CELL_W
  const py = 40 + Math.floor(i / COLS) * CELL_H

  const sprite = engine.getCharacterSprites(look).walk[engine.Direction.DOWN][STANDING]
  sprite.forEach((row, sy) => row.forEach((hex, sx) => {
    if (!hex) return
    x.fillStyle = hex
    x.fillRect(px + 13 + sx * S, py + sy * S, S, S)
  }))

  x.textAlign = 'center'
  x.fillStyle = stored ? '#cfcfe4' : '#8f8fa8'
  x.font = '12px "Sheet Bold"'
  x.fillText(name, px + CELL_W / 2 - 6, py + FH * S + 12)
  x.fillStyle = '#7f7f99'
  // Shrink a long project name rather than let it run into its neighbour
  let size = 10
  x.font = `${size}px Sheet`
  while (size > 7 && x.measureText(project).width > CELL_W - 6) {
    size -= 1
    x.font = `${size}px Sheet`
  }
  x.fillText(project, px + CELL_W / 2 - 6, py + FH * S + 25)
  x.textAlign = 'left'
})

writeFileSync(OUT, c.toBuffer('image/png'))
const chosen = household.filter((t) => looks[t.trim().toLowerCase()]).length
console.log(`wrote ${OUT}: ${household.length} portraits, ${chosen} chosen, ${household.length - chosen} still hashed from the name`)
