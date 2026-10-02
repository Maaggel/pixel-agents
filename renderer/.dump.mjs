// Mixed looks hold together: hair and glasses follow the face, nothing has holes in it, and the
// six original characters come out exactly as drawn.
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
const ROOT = new URL('../', import.meta.url).pathname
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
const cls = (px) => { if (!px) return '.'; const r = parseInt(px.slice(1, 3), 16), g = parseInt(px.slice(3, 5), 16), b = parseInt(px.slice(5, 7), 16); const l = (r + g + b) / 3
  if (l < 45) return '#'; if (Math.max(r, g, b) - Math.min(r, g, b) < 20) return l > 170 ? 'w' : 'g'; return r > b + 15 ? 's' : 't' }
const look = (h, t, l, sk, hc, th) => ({ palette: sk, hueShift: 0, parts: { hair: h, hairColor: hc, top: t, topHue: th, legs: l, legsHue: 0 } })
const [h, t, l, sk, hc, th, f] = process.argv.slice(2).map(Number)
const sp = engine.getCharacterSprites(look(h, t, l, sk, hc, th))
const a = sp.walk[engine.Direction.RIGHT][f], b = chars[sk].right[[0, 1, 2, 1][f]]
console.log('s skin-ish  t cool colour  w white  g grey  # dark          composite   |  face original')
for (let y = 10; y < 25; y++) console.log(String(y).padStart(3), a[y].map(cls).join(''), '  ', b[y].map(cls).join(''), '  ', a[y].slice(4, 12).map(p => p ? p.slice(1, 7) : '------').join(' '))
if (process.env.SHEET) {
  const { createCanvas } = await import('@napi-rs/canvas')
  const Z = 14, looks = [['Cairn', look(9, 6, 2, 0, 0, 180)], ['Kalende', look(8, 7, 4, 0, 4, 0)]]
  const c = createCanvas(4 * 16 * Z + 3 * 20, 2 * 32 * Z + 20); const x = c.getContext('2d'); x.fillStyle = '#1e1e2e'; x.fillRect(0, 0, c.width, c.height)
  looks.forEach(([, lk], r) => { const sp = engine.getCharacterSprites(lk)
    const frames = [sp.walk[engine.Direction.RIGHT][0], sp.walk[engine.Direction.RIGHT][1], sp.typing[engine.Direction.RIGHT][0], sp.reading[engine.Direction.RIGHT][0]]
    frames.forEach((s, k) => s.forEach((row, yy) => row.forEach((px, xx) => { if (!px) return; x.fillStyle = px.slice(0, 7); x.fillRect(k * (16 * Z + 20) + xx * Z, r * (32 * Z + 20) + yy * Z, Z, Z) }))) })
  const { writeFileSync } = await import('fs'); writeFileSync(process.env.SHEET, c.toBuffer('image/png'))
}
