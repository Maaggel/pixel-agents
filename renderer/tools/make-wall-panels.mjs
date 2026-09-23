// Wall status panels, generated from the desk monitor sprite (MONITOR_FRONT_ON).
//
// Produces three 16x16 wall-mountable screens with the monitor's own bezel and no stand:
//   WALL_MONITOR          - the desk monitor's screen, static
//   WALL_MONITOR_GRAPH    - bar charts and trend lines, 7 frames
//   WALL_MONITOR_CONSOLE  - terminal text scrolling, 6 frames
// The cycling ones are driven by the catalog's `idleCycle` + `randomIdleCycle`, the same
// mechanism the server racks blink with, so they animate on their own with no agent nearby.
//
// The sprites and the catalog live only on the relay Pi (gitignored here), so this is run by
// hand and the output uploaded over FTP. It lives here because it draws with the renderer's
// Skia canvas:
//   cd renderer && MON_ON=<MONITOR_FRONT_ON.png> OUT=<dir> node tools/make-wall-panels.mjs
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { writeFileSync } from 'fs'

const SRC = process.env.MON_ON || process.env.S + '/MON_ON.png'
const OUT = process.env.OUT || process.env.S + '/wall'

// The screen's drawable interior, read off MONITOR_FRONT_ON
const SX = 3, SY = 4, SW = 11, SH = 6
const C = {
  graphBg: '#16203a', grid: '#27345c',
  bar: '#6ee7a8', barHi: '#84e6fd', warn: '#eadd7a',
  line: '#84e6fd', lineDim: '#4a7fa8',
  consoleBg: '#101a14', text: '#6ee7a8', textDim: '#3f8a63', prompt: '#eadd7a', cursor: '#e1e3e9',
}

// deterministic PRNG so the frames are reproducible
let seed = 1337
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const ri = (n) => Math.floor(rnd() * n)

async function body() {
  const src = await loadImage(SRC)
  const c = createCanvas(16, 16)
  const x = c.getContext('2d')
  x.imageSmoothingEnabled = false
  x.drawImage(src, 0, 0)
  x.clearRect(0, 13, 16, 3)            // the stand: a wall panel has none
  x.fillStyle = C.graphBg              // wipe the desk screen's content
  x.fillRect(SX, SY, SW, SH)
  return c
}

const px = (x, col, X, Y) => { x.fillStyle = col; x.fillRect(SX + X, SY + Y, 1, 1) }

function drawBars(x, heights, hi) {
  x.fillStyle = C.graphBg; x.fillRect(SX, SY, SW, SH)
  x.fillStyle = C.grid                                   // baseline + one grid line
  x.fillRect(SX, SY + SH - 1, SW, 1)
  x.fillRect(SX, SY + 2, SW, 1)
  heights.forEach((h, i) => {
    const bx = i * 3
    for (let k = 0; k < 2; k++) for (let y = 0; y < h; y++) px(x, i === hi ? C.barHi : (h >= 5 ? C.warn : C.bar), bx + k, SH - 1 - y)
  })
}

function drawLine(x, pts) {
  x.fillStyle = C.graphBg; x.fillRect(SX, SY, SW, SH)
  x.fillStyle = C.grid; x.fillRect(SX, SY + SH - 1, SW, 1)
  pts.forEach((p, i) => {
    px(x, C.line, i, SH - 1 - p)
    if (i > 0) { // join the steps so the line reads as continuous
      const prev = pts[i - 1]
      const [lo, hi] = prev < p ? [prev, p] : [p, prev]
      for (let y = lo; y <= hi; y++) px(x, y === p ? C.line : C.lineDim, i, SH - 1 - y)
    }
  })
}

/**
 * A line of "code": a prompt pixel, then two or three words with gaps between them, so at six
 * pixels a row it reads as text rather than a filled bar. `words` is a list of word lengths.
 */
function drawConsole(x, lines, cursorOn) {
  x.fillStyle = C.consoleBg; x.fillRect(SX, SY, SW, SH)
  lines.forEach((words, row) => {
    if (!words.length) return                              // blank line, like real output
    const last = row === lines.length - 1
    px(x, last ? C.prompt : C.textDim, 0, row)             // only the newest line prompts in amber
    let col = 2
    for (const w of words) {
      for (let i = 0; i < w && col < SW; i++, col++) px(x, last ? C.text : C.textDim, col, row)
      col++                                                // the space between words
    }
  })
  const lastWords = lines[lines.length - 1]
  const end = 2 + lastWords.reduce((a, w) => a + w + 1, 0)
  if (cursorOn) px(x, C.cursor, Math.min(end, SW - 1), SH - 1)
}

const frames = { graph: [], console: [] }

// Graphs: bars rising and falling, and a trend line, shuffled by randomIdleCycle
const barSets = [[2, 4, 3, 5], [3, 5, 4, 2], [5, 3, 2, 4], [1, 3, 5, 3]]
for (let i = 0; i < barSets.length; i++) {
  const c = await body(); const x = c.getContext('2d')
  drawBars(x, barSets[i], i % 2 === 0 ? 3 : 1)
  frames.graph.push(c)
}
const lineSets = [[1, 2, 4, 3, 5, 4, 3, 2, 3, 4, 5], [3, 2, 1, 2, 3, 4, 4, 5, 4, 3, 2], [2, 3, 3, 4, 2, 1, 2, 3, 5, 4, 4]]
for (const pts of lineSets) {
  const c = await body(); const x = c.getContext('2d')
  drawLine(x, pts)
  frames.graph.push(c)
}

// Console: lines scroll up, a new one is typed at the bottom, cursor blinks
const newLine = () => {
  if (rnd() < 0.15) return []                              // an occasional blank line
  const words = [2 + ri(3), 1 + ri(4)]
  if (rnd() < 0.5) words.push(1 + ri(3))
  return words
}
let lines = [[3, 2], [2, 4, 1], [], [4, 3], [2, 2, 2], [3, 4]]
for (let i = 0; i < 6; i++) {
  const c = await body(); const x = c.getContext('2d')
  drawConsole(x, lines, i % 2 === 0)
  frames.console.push(c)
  lines = [...lines.slice(1), newLine()]                   // scroll up, type a new line
}

// The load gauge: eight frames from a quiet office to a busy one. Unlike the shuffling panels
// these are an ordered ramp, because the engine picks the frame from how many agents are working.
{
  const LEVELS = 8
  for (let l = 0; l < LEVELS; l++) {
    const c = await body(); const x = c.getContext('2d')
    const load = l / (LEVELS - 1)
    // four bars that rise with the load, with a little shape so it does not look like a block
    const shape = [1, 0.75, 0.9, 0.6]
    const heights = shape.map((k, i) => Math.max(1, Math.round((0.15 + load * 0.85) * SH * k) + (i === 1 && load > 0.5 ? 1 : 0)))
    drawBars(x, heights.map((h) => Math.min(h, SH)), load > 0.85 ? 0 : -1)
    writeFileSync(`${OUT}/WALL_MONITOR_LOAD_${l}.png`, c.toBuffer('image/png'))
  }
  console.log('WALL_MONITOR_LOAD', LEVELS, 'levels')
}

// The plain panel: the desk monitor's own screen, just without the stand
{
  const src = await loadImage(SRC)
  const c = createCanvas(16, 16); const x = c.getContext('2d')
  x.imageSmoothingEnabled = false
  x.drawImage(src, 0, 0)
  x.clearRect(0, 13, 16, 3)
  writeFileSync(`${OUT}/WALL_MONITOR.png`, c.toBuffer('image/png'))
  console.log('WALL_MONITOR 1 frame')
}

for (const [kind, list] of Object.entries(frames)) {
  const base = kind === 'graph' ? 'WALL_MONITOR_GRAPH' : 'WALL_MONITOR_CONSOLE'
  for (let i = 0; i < list.length; i++) {
    const name = i === 0 ? `${base}.png` : `${base}_IDLE_${i}.png`
    writeFileSync(`${OUT}/${name}`, list[i].toBuffer('image/png'))
  }
  console.log(base, list.length, 'frames')
}

// contact sheet
const all = [...frames.graph, ...frames.console]
const SC = 10, sheet = createCanvas(all.length * (16 * SC + 6) + 6, 16 * SC + 30)
const g = sheet.getContext('2d'); g.imageSmoothingEnabled = false
g.fillStyle = '#202030'; g.fillRect(0, 0, sheet.width, sheet.height)
all.forEach((c, i) => {
  g.drawImage(c, 6 + i * (16 * SC + 6), 24, 16 * SC, 16 * SC)
  g.fillStyle = '#fff'; g.font = '11px sans-serif'
  g.fillText(i < frames.graph.length ? `graph ${i}` : `console ${i - frames.graph.length}`, 6 + i * (16 * SC + 6), 16)
})
writeFileSync(`${OUT}/panels.png`, sheet.toBuffer('image/png'))
