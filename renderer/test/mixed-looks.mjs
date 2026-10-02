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

// No holes: a shirt cut from one character over arms from another left pixels of background
// showing through, and a hairstyle that did not cover the back of the head left a notch there
// holes: transparent pixels the outside cannot reach without crossing something drawn
const enclosed = (s) => { const H = s.length, W = s[0].length, seen = new Set(), q = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((y === 0 || x === 0 || y === H - 1 || x === W - 1) && !s[y][x]) { seen.add(`${x},${y}`); q.push([x, y]) }
  while (q.length) { const [x, y] = q.pop(); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy, k = `${nx},${ny}`
    if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen.has(k) || s[ny][nx]) continue; seen.add(k); q.push([nx, ny]) } }
  const out = new Set(); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!s[y][x] && !seen.has(`${x},${y}`)) out.add(`${x},${y}`); return out }
const DIRS = [['down', engine.Direction.DOWN], ['up', engine.Direction.UP], ['right', engine.Direction.RIGHT]]
let holes = 0
for (let hair = 0; hair < pools.hair.length; hair++) for (let skin = 0; skin < chars.length; skin++) for (let top = 0; top < pools.top.length; top++) {
  const sp = engine.getCharacterSprites({ palette: skin, hueShift: 0, parts: { hair, hairColor: 0, top, topHue: 0, legs: 4, legsHue: 0 } })
  // the same face in its own parts: the gaps its artwork already has (an arm and the page it holds)
  const own = engine.getCharacterSprites({ palette: skin, hueShift: 0, parts: { hair: skin, hairColor: 0, top: skin, topHue: 0, legs: 4, legsHue: 0 } })
  const set = (s, d) => [['walk', s.walk[d]], ['type', s.typing[d]], ['read', s.reading[d]]]
  for (const [dn, d] of DIRS) for (const [[kind, frames], [, ownFrames]] of set(sp, d).map((k, i) => [k, set(own, d)[i]])) frames.forEach((spr, f) => {
    const base = enclosed(ownFrames[f])
    // a hole counts only where the face's own artwork is drawn: a gap between a long strand of hair
    // and the neck is background showing where it would with real hair
    const art = chars[skin][dn][kind === 'walk' ? [0, 1, 2, 1][f] : (kind === 'type' ? 3 : 5) + f]
    const n = [...enclosed(spr)].filter((p) => { const [x, y] = p.split(',').map(Number); return !base.has(p) && art[y][x] }).length
    if (n && ++holes <= 10) console.log(`HOLE hair ${hair} on face ${skin} in top ${top}: ${dn} ${kind}${f + 1}, ${n} px`)
  })
}
if (holes) { console.log(`FAIL: ${holes} frames with holes in them`); process.exit(1) }
console.log(`OK: no holes in any frame of the ${checked} looks beyond the gaps the face's own artwork has`)

// The six characters as drawn: wearing their own parts, every frame is the original pixel for pixel
let changed = 0
for (let i = 0; i < chars.length; i++) {
  const sp = engine.getCharacterSprites({ palette: i, hueShift: 0, parts: { hair: i, hairColor: 0, top: i, topHue: 0, legs: i, legsHue: 0 } })
  const built = { down: [...sp.walk[engine.Direction.DOWN].slice(0, 3), ...sp.typing[engine.Direction.DOWN], ...sp.reading[engine.Direction.DOWN]],
    up: [...sp.walk[engine.Direction.UP].slice(0, 3), ...sp.typing[engine.Direction.UP], ...sp.reading[engine.Direction.UP]],
    right: [...sp.walk[engine.Direction.RIGHT].slice(0, 3), ...sp.typing[engine.Direction.RIGHT], ...sp.reading[engine.Direction.RIGHT]] }
  for (const dir of ['down', 'up', 'right']) built[dir].forEach((spr, f) => spr.forEach((row, y) => row.forEach((px, x) => { if (px !== chars[i][dir][f][y][x] && ++changed <= 30) console.log(`char_${i} ${dir} f${f} (${x},${y}): ${chars[i][dir][f][y][x] || "empty"} -> ${px || "empty"}`) })))
}
if (changed) { console.log(`FAIL: ${changed} pixels of the six original characters changed`); process.exit(1) }
console.log('OK: the six original characters are unchanged, pixel for pixel')
console.log(`OK: ${checked} looks (every hairstyle on every face in every top) keep hair and eyes together at the desk`)
