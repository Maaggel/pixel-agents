// The character cut has to be lossless.
//
// Splitting a character into hair / skin / top / legs and stacking its own four parts back up must
// give back exactly the sprite that went in - every frame, every direction, not just the standing
// front view. If it does, then a mixed character is only ever made of pixels that were drawn by
// hand, and the walk and the side profiles cannot have picked up a seam of our making.
//
// The check also reports what mixing actually changes, so a real gap in the art (a dress whose
// skirt belongs to the legs, say) is told apart from a bug in the cut.
//
//   cd renderer && node test/character-parts.mjs
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = new URL('../../', import.meta.url).pathname
const SRC = `${ROOT}webview-ui/public/assets/characters`
const FW = 16, FH = 32, FRAMES = 7
const DIRS = ['down', 'up', 'right']

const stage = join(tmpdir(), `character-parts-${process.pid}`)
mkdirSync(stage, { recursive: true })
const entry = join(stage, 'entry.ts')
writeFileSync(entry, `
export { splitCharacters, composeParts } from '${ROOT}webview-ui/src/office/sprites/characterParts.js'
`)
const bundle = join(stage, 'engine.mjs')
execFileSync('npx', ['esbuild', entry, '--bundle', '--format=esm', `--outfile=${bundle}`],
  { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] })
const { splitCharacters, composeParts } = await import(bundle)
rmSync(stage, { recursive: true, force: true })

function toFrames(data, width) {
  const out = { down: [], up: [], right: [] }
  for (let d = 0; d < DIRS.length; d++) {
    for (let f = 0; f < FRAMES; f++) {
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
      out[DIRS[d]].push(sprite)
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

const parts = splitCharacters(characters)
let mismatches = 0
let hidden = 0

for (let i = 0; i < characters.length; i++) {
  for (const dir of DIRS) {
    for (let f = 0; f < FRAMES; f++) {
      const original = characters[i][dir][f]
      const rebuilt = composeParts([
        parts[i].skin[dir][f],
        parts[i].legs[dir][f],
        parts[i].top[dir][f],
        parts[i].hair[dir][f],
      ])
      const skin = parts[i].skin[dir][f]
      for (let y = 0; y < FH; y++) {
        for (let x = 0; x < FW; x++) {
          // The invented head sits in the skin layer where the art had hair: under it, out of sight
          if (skin[y][x] && original[y][x] && skin[y][x] !== original[y][x]) hidden++
          const was = original[y][x]
          const now = rebuilt[y][x]
          if (was === now) continue
          mismatches++
          if (mismatches <= 10) {
            console.log(`  char ${i} ${dir} frame ${f} at ${x},${y}: was ${was || 'empty'}, rebuilt ${now || 'empty'}`)
          }
        }
      }
    }
  }
}

// ── the exported part files must match the cut ───────────────────────────────
// assets/characters/parts/<layer>_<n>.png was cut out of the characters once and is what the
// viewer loads now. If a file drifts from the cut, every agent quietly changes clothes.
let fileChecked = 0
let fileMismatches = 0
for (const layer of ['hair', 'top', 'legs']) {
  for (let i = 0; i < characters.length; i++) {
    const fp = `${SRC}/parts/${layer}_${i}.png`
    if (!existsSync(fp)) continue
    const img = await loadImage(fp)
    const c = createCanvas(img.width, img.height)
    const g = c.getContext('2d')
    g.imageSmoothingEnabled = false
    g.drawImage(img, 0, 0)
    const fromFile = toFrames(g.getImageData(0, 0, img.width, img.height).data, img.width)
    for (const dir of DIRS) {
      for (let f = 0; f < FRAMES; f++) {
        for (let y = 0; y < FH; y++) {
          for (let x = 0; x < FW; x++) {
            fileChecked++
            if (fromFile[dir][f][y][x] === parts[i][layer][dir][f][y][x]) continue
            fileMismatches++
            if (fileMismatches <= 5) {
              console.log(`  ${layer}_${i}.png ${dir} frame ${f} at ${x},${y}: file ${fromFile[dir][f][y][x] || 'empty'}, cut ${parts[i][layer][dir][f][y][x] || 'empty'}`)
            }
          }
        }
      }
    }
  }
}

const frames = characters.length * DIRS.length * FRAMES
console.log(`${frames} frames rebuilt from their own parts`)
console.log(`  ${fileChecked} px compared against the exported part files`)
console.log(`  ${hidden} px of head filled in under the hair (never visible on the original look)`)
if (mismatches > 0) {
  console.error(`FAIL: ${mismatches} px differ from the art`)
  process.exit(1)
}
if (fileMismatches > 0) {
  console.error(`FAIL: ${fileMismatches} px differ between the part files and the cut`)
  console.error('  re-export with: node tools/parts-sheet.mjs --write ../webview-ui/public/assets/characters/parts')
  process.exit(1)
}
console.log('OK: every frame and direction round-trips exactly, and the part files match the cut')
