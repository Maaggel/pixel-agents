import { readFileSync } from 'fs'
import { PNG } from 'pngjs'
const ROOT = new URL('../', import.meta.url).pathname
const { splitCharacters } = await import('/tmp/claude-1000/-home-mix-projects-pixel-agents/cd6f40a2-a92f-4a20-bf00-74069938c28d/scratchpad/cp.mjs')
const hex = (d, i) => d[i + 3] < 128 ? '' : '#' + [0, 1, 2].map(k => d[i + k].toString(16).padStart(2, '0')).join('')
const sheet = (file) => { const p = PNG.sync.read(readFileSync(file)); const frames = { down: [], up: [], right: [] }
  ;['down', 'up', 'right'].forEach((dir, r) => { for (let f = 0; f < 7; f++) { const s = []; for (let y = 0; y < 32; y++) { const row = []; for (let x = 0; x < 16; x++) row.push(hex(p.data, ((r * 32 + y) * p.width + f * 16 + x) * 4)); s.push(row) } frames[dir].push(s) } }); return frames }
const C = ROOT + 'webview-ui/public/assets/characters/'
const chars = [0, 1, 2, 3, 4, 5].map(n => sheet(`${C}char_${n}.png`)); const cut = splitCharacters(chars)
const [hairN, faceN, topN, f] = process.argv.slice(2).map(Number)
const top = sheet(`${C}parts/top_${topN}.png`)
const cls = (px) => { if (!px) return '.'; const r = parseInt(px.slice(1, 3), 16), g = parseInt(px.slice(3, 5), 16), b = parseInt(px.slice(5, 7), 16); const l = (r + g + b) / 3
  if (l < 45) return '#'; if (Math.max(r,g,b)-Math.min(r,g,b) < 20) return l > 170 ? 'w' : 'g'; return r > b + 15 ? (r > 200 && b > 150 ? 'p' : 's') : 'c' }
const d = 'right'
const show = (t, s) => { console.log(t); for (let y = 12; y < 25; y++) console.log(String(y).padStart(3), s[y].map(cls).join('')) }
console.log(`hair ${hairN} face ${faceN} top ${topN} right f${f}:  s skin  p pink  c colour  w white  g grey  # dark`)
const rows = (s) => s.slice(12, 25).map(r => r.map(cls).join(''))
const cols = [['face skin layer', cut[faceN].skin[d][f]], [`top_${topN}`, top[d][f]], [`char_${faceN} top (own)`, cut[faceN].top[d][f]], [`char_${faceN} original`, chars[faceN][d][f]]]
console.log('    ' + cols.map(([n]) => n.padEnd(18)).join(''))
for (let i = 0; i < 13; i++) console.log(String(12 + i).padStart(3), cols.map(([, s]) => rows(s)[i].padEnd(18)).join(''))
