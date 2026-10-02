// Hair and glasses follow the face, whichever characters a look's parts were cut from.
//
// The six characters do not bob alike at the desk: reading, one lifts its head a row where another
// drops it. A look takes its hair from one character and its face from another, so the two parted
// company - a strip of bare forehead under the hair - and the glasses, cut with the shirt because
// they sit that low, came from whichever character lent the top. 8 of the 12 looks chosen on
// 2026-10-02 were off by up to four rows. This builds every hairstyle on every face in every top
// and checks that in each typing and reading frame the eyes sit the same distance below the top of
// the head as in the others.
//   node test/mixed-looks.mjs
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const ROOT = new URL('../../', import.meta.url).pathname
const SRC = ROOT + 'webview-ui/public/assets/characters'
const stage = join(tmpdir(), `mixed-looks-${process.pid}`)
mkdirSync(stage, { recursive: true })
writeFileSync(stage + '/entry.ts', `export { setCharacterTemplates, getCharacterSprites } from '${ROOT}webview-ui/src/office/sprites/spriteData.js'
export { Direction } from '${ROOT}webview-ui/src/office/types.js'`)
execFileSync('npx', ['esbuild', stage + '/entry.ts', '--bundle', '--format=esm', `--outfile=${stage}/engine.mjs`], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] })
const engine = await import(stage + '/engine.mjs')
rmSync(stage, { recursive: true, force: true })
async function sheet(path) { const img = await loadImage(path); const c = createCanvas(img.width, img.height); const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, img.width, img.height).data
  const out = { down: [], up: [], right: [] }; ['down', 'up', 'right'].forEach((dir, k) => { for (let f = 0; f < 7; f++) { const s = []; for (let y = 0; y < 32; y++) { const row = []; for (let x = 0; x < 16; x++) { const i = ((k * 32 + y) * img.width + f * 16 + x) * 4; row.push(d[i + 3] < 128 ? '' : '#' + [0, 1, 2].map(j => d[i + j].toString(16).padStart(2, '0')).join('').toUpperCase()) } s.push(row) } out[dir].push(s) } }); return out }
const chars = []; for (let i = 0; i < 6; i++) chars.push(await sheet(`${SRC}/char_${i}.png`))
const pools = {}; for (const L of ['hair', 'top', 'legs']) { const a = []; for (let n = 0; existsSync(`${SRC}/parts/${L}_${n}.png`); n++) a.push(await sheet(`${SRC}/parts/${L}_${n}.png`)); pools[L] = a }
engine.setCharacterTemplates(chars, pools)
const HAIR_GREEN = 14
const white = (px) => {
  if (!px) return false
  const c = [1, 3, 5].map((i) => parseInt(px.slice(i, i + 2), 16))
  return Math.min(...c) > 200 && Math.max(...c) - Math.min(...c) <= 4
}
const topRow = (s) => s.findIndex(r => r.some(Boolean))
const eyeRow = (s) => s.findIndex((r, y) => y > 8 && r.slice(3, 13).some(white))
let bad = 0, checked = 0
for (let hair = 0; hair < pools.hair.length; hair++) for (let skin = 0; skin < chars.length; skin++) for (let top = 0; top < pools.top.length; top++) {
  // Green hair: painted by lightness, even a white-haired style keeps a tint, so its highlights are
  // never mistaken for the whites of the eyes, which have none
  const look = { palette: skin, hueShift: 0, parts: { hair, hairColor: HAIR_GREEN, top, topHue: 0, legs: 0, legsHue: 0 } }
  const sp = engine.getCharacterSprites(look)
  const frames = [['type1', sp.typing[engine.Direction.DOWN][0]], ['type2', sp.typing[engine.Direction.DOWN][1]], ['read1', sp.reading[engine.Direction.DOWN][0]], ['read2', sp.reading[engine.Direction.DOWN][1]]]
  const gap = frames.map(([n, s]) => [n, eyeRow(s) - topRow(s)])
  checked++
  if (gap.every(([, g]) => g === gap[0][1])) continue
  bad++
  if (bad <= 10) console.log(`OFF hair ${hair} on face ${skin} in top ${top}: ` + gap.map(([n, g]) => `${n}=${g}`).join(' '))
}
if (bad) { console.log(`FAIL: ${bad} of ${checked} looks have hair and eyes parting company at the desk`); process.exit(1) }
console.log(`OK: ${checked} looks (every hairstyle on every face in every top) keep hair and eyes together at the desk`)
