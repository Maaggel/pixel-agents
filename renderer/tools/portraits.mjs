// The household, as the office currently draws it.
//
// One portrait per sibling, from the looks the relay is actually serving - chosen ones where they
// have been chosen, hashed-from-the-nametag where they have not - so the sheet is a picture of the
// office as it stands rather than of what anyone intended. Goes in the Playbook beside Appendix E,
// where the names are.
//
//   cd renderer && node tools/portraits.mjs [out.png]
//   cd renderer && node tools/portraits.mjs --reasons [out.png]   # with why each one chose it
//
// Regenerate it whenever somebody chooses a look. The relay is asked over HTTP and needs no token.
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { registerSheetFont } from './sheet-font.mjs'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = new URL('../../', import.meta.url).pathname
const FONT = registerSheetFont()
const SRC = `${ROOT}webview-ui/public/assets/characters`
const REASONS = process.argv.includes('--reasons')
const OUT = process.argv.filter((a) => !a.startsWith('--')).slice(2)[0] ||
  (REASONS ? 'portraits-reasons.png' : 'portraits.png')
const RELAY = process.env.PIXEL_AGENTS_RELAY_HTTP || 'https://apps.blommemix.dk/pixelagents'
const FW = 16, FH = 32, STANDING = 1
// Big enough that the names under them are read rather than squinted at - this hangs in the
// Playbook beside Appendix E and is the only picture of the household there is
const S = Number(process.env.PORTRAIT_SCALE || 8)
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

/** Break text into lines that fit, and stop once there are enough of them. */
function wrap(ctx, text, width, maxLines) {
  const words = text.split(/\s+/)
  const lines = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (ctx.measureText(next).width > width && line) {
      lines.push(line)
      line = word
      if (lines.length === maxLines) break
    } else {
      line = next
    }
  }
  if (lines.length < maxLines && line) lines.push(line)
  // An excerpt that stops mid-thought should say so rather than look finished
  const shown = lines.join(' ')
  if (shown.length < text.length - 1) lines[lines.length - 1] += ' ...'
  return lines
}

if (REASONS) {
  const S2 = 4
  const CARD_W = 470, CARD_H = 158, PAD = 18
  const cols = 2
  const rows = Math.ceil(household.length / cols)
  const c = createCanvas(cols * CARD_W + PAD * 2, rows * CARD_H + 80)
  const x = c.getContext('2d')
  x.imageSmoothingEnabled = false
  x.fillStyle = '#20202e'
  x.fillRect(0, 0, c.width, c.height)
  x.fillStyle = '#cfcfe4'
  x.font = `22px "${FONT.bold}"`
  x.fillText('The household', PAD + 4, 38)
  x.fillStyle = '#7f7f99'
  x.font = `13px "${FONT.regular}"`
  x.fillText('twelve agents, and why each one is dressed the way it is', PAD + 4, 58)

  household.forEach((tag, i) => {
    const { project, name } = caption(tag)
    const stored = looks[tag.trim().toLowerCase()]
    const look = stored ? engine.storedToLook(stored) : engine.lookFromName(tag)
    const px = PAD + (i % cols) * CARD_W
    const py = 80 + Math.floor(i / cols) * CARD_H

    const sprite = engine.getCharacterSprites(look).walk[engine.Direction.DOWN][STANDING]
    sprite.forEach((row, sy) => row.forEach((hex, sx) => {
      if (!hex) return
      x.fillStyle = hex
      x.fillRect(px + 10 + sx * S2, py + 8 + sy * S2, S2, S2)
    }))

    const tx = px + 10 + FW * S2 + 16
    const tw = CARD_W - (tx - px) - 20
    x.fillStyle = '#e4e4f2'
    x.font = `16px "${FONT.bold}"`
    x.fillText(name, tx, py + 24)
    // Measure the name in the font it was drawn in, not in the one about to replace it
    const nameWidth = x.measureText(name).width
    x.fillStyle = '#8f8fa8'
    x.font = `11px "${FONT.regular}"`
    x.fillText(project, tx + nameWidth + 10, py + 24)

    x.fillStyle = '#b6b6cc'
    x.font = `11px "${FONT.regular}"`
    const reason = (stored?.reason || 'Dressed by a hash of the nametag - nobody chose this one.').replace(/\s+/g, ' ')
    wrap(x, reason, tw, 7).forEach((line, li) => x.fillText(line, tx, py + 44 + li * 15))
  })

  writeFileSync(OUT, c.toBuffer('image/png'))
  console.log(`wrote ${OUT}: ${household.length} with their reasons`)
  process.exit(0)
}

const COLS = Number(process.env.PORTRAIT_COLS || 6)
const CELL_W = Math.max(FW * S + 30, 150), CELL_H = FH * S + 56
const rows = Math.ceil(household.length / COLS)
const c = createCanvas(COLS * CELL_W + 32, rows * CELL_H + 76)
const x = c.getContext('2d')
x.imageSmoothingEnabled = false
x.fillStyle = '#20202e'
x.fillRect(0, 0, c.width, c.height)

x.fillStyle = '#cfcfe4'
x.font = `22px "${FONT.bold}"`
x.fillText('The household', 20, 36)
x.fillStyle = '#7f7f99'
x.font = `13px "${FONT.regular}"`
x.fillText('as the office draws them, each one chosen', 20, 56)

household.forEach((tag, i) => {
  const { project, name } = caption(tag)
  const stored = looks[tag.trim().toLowerCase()]
  const look = stored ? engine.storedToLook(stored) : engine.lookFromName(tag)
  const px = 16 + (i % COLS) * CELL_W
  const py = 76 + Math.floor(i / COLS) * CELL_H

  const sprite = engine.getCharacterSprites(look).walk[engine.Direction.DOWN][STANDING]
  const inset = Math.round((CELL_W - FW * S) / 2)
  sprite.forEach((row, sy) => row.forEach((hex, sx) => {
    if (!hex) return
    x.fillStyle = hex
    x.fillRect(px + inset + sx * S, py + sy * S, S, S)
  }))

  const mid = px + CELL_W / 2 - 6
  x.textAlign = 'center'
  x.fillStyle = stored ? '#e4e4f2' : '#8f8fa8'
  x.font = `17px "${FONT.bold}"`
  x.fillText(name, mid, py + FH * S + 22)
  x.fillStyle = '#8f8fa8'
  // Shrink a long project name rather than let it run into its neighbour
  let size = 13
  x.font = `${size}px "${FONT.regular}"`
  while (size > 9 && x.measureText(project).width > CELL_W - 12) {
    size -= 1
    x.font = `${size}px "${FONT.regular}"`
  }
  x.fillText(project, mid, py + FH * S + 40)
  x.textAlign = 'left'
})

writeFileSync(OUT, c.toBuffer('image/png'))
const chosen = household.filter((t) => looks[t.trim().toLowerCase()]).length
console.log(`wrote ${OUT}: ${household.length} portraits, ${chosen} chosen, ${household.length - chosen} still hashed from the name`)
