// Clock faces for every half hour, generated from the two wall clock sprites.
//
// The office runs its own day in SUN_CYCLE_DURATION_SEC, so the clocks are driven by that cycle
// rather than real time and agree with the daylight in the windows. The engine swaps these frames
// the same way it swaps any other furniture cycle (catalog `timeCycle`).
//
// The sprites and the catalog live only on the relay Pi (gitignored here), so this is run by hand
// and the output uploaded over FTP. It draws with the renderer's Skia canvas:
//   cd renderer && SRC=<dir with CLOCK_WALL_*.png> OUT=<dir> node tools/make-clock-frames.mjs
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { writeFileSync } from 'fs'

const SRC = process.env.SRC
const OUT = process.env.OUT
/** Frames per 12 hour dial: quarter hours, so the dial reads "quarter past" and "half past" */
const FRAMES = 48
const HAND = '#391624'          // the same near-black the painted hands use
const FACE = '#ffffff'

/**
 * The dial is found in the art itself, so only the hand reach is stated here.
 *
 * Quarter hours, not half hours: at half hours the minute hand only ever pointed up or down, so
 * every step flipped it 180 degrees and it read as flapping rather than as time passing. At
 * quarters it steps 90 degrees the same way round each time, which reads as a hand sweeping - and
 * the office day being five minutes long, a briskly turning minute hand suits the place.
 */
const CLOCKS = [
  { file: 'CLOCK_WALL_WHITE', minute: 3, hour: 2 },
  { file: 'CLOCK_WALL_COLOR', minute: 3, hour: 2 },
]
/** Colours that make up a dial face: white and its shading ring */
const DIAL = new Set(['ffffff', 'd0d2d4'])
/** The painted-on hands, which are cleared before new ones are drawn */
const OLD_HANDS = new Set(['391624', '617275', '9c2e3f'])

/**
 * Find the dial and blank the hands painted on it.
 *
 * The dial is the run of face pixels; the hands sit inside it and are the only dark pixels there.
 * Flood out from the largest face region so the case's own dark rim is never touched. Returns the
 * dial as a mask plus its centre, because the art's pivot sits a pixel below the middle and a
 * hand drawn from there pokes out of the bottom of the case.
 */
function readDial(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data
  const at = (x, y) => {
    const i = (y * w + x) * 4
    return d[i + 3] < 128 ? null : ((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]).toString(16).padStart(6, '0')
  }
  // seed from any face pixel, then take everything face-or-hand connected to it
  let seed = null
  for (let y = 0; y < h && !seed; y++) for (let x = 0; x < w && !seed; x++) if (DIAL.has(at(x, y))) seed = [x, y]
  const mask = new Set()
  const stack = [seed]
  while (stack.length) {
    const [x, y] = stack.pop()
    const key = `${x},${y}`
    if (x < 0 || y < 0 || x >= w || y >= h || mask.has(key)) continue
    const hex = at(x, y)
    if (!hex || !(DIAL.has(hex) || OLD_HANDS.has(hex))) continue
    mask.add(key)
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])
  }
  let sx = 0, sy = 0
  for (const k of mask) { const [x, y] = k.split(',').map(Number); sx += x; sy += y }
  return { mask, cx: Math.round(sx / mask.size), cy: Math.round(sy / mask.size) }
}

function clearHands(ctx, c) {
  const img = ctx.getImageData(0, 0, c.w, c.h)
  const d = img.data
  for (const key of c.mask) {
    const [x, y] = key.split(',').map(Number)
    const i = (y * c.w + x) * 4
    const hex = ((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]).toString(16).padStart(6, '0')
    if (OLD_HANDS.has(hex)) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255 }
  }
  ctx.putImageData(img, 0, 0)
}

/**
 * A hand of up to `len` pixels from the pivot, at `turns` clockwise from twelve o'clock.
 * Clipped to the dial, so a hand never runs off the face however short the dial is that way.
 */
function hand(ctx, c, turns, len) {
  const a = turns * Math.PI * 2
  ctx.fillStyle = HAND
  for (let k = 1; k <= len; k++) {
    const x = Math.round(c.cx + Math.sin(a) * k)
    const y = Math.round(c.cy - Math.cos(a) * k)
    if (!c.mask.has(`${x},${y}`)) break
    ctx.fillRect(x, y, 1, 1)
  }
}

const sheets = []
for (const clock of CLOCKS) {
  const src = await loadImage(`${SRC}/${clock.file}.png`)
  const probe = createCanvas(src.width, src.height)
  probe.getContext('2d').drawImage(src, 0, 0)
  const dial = readDial(probe.getContext('2d'), src.width, src.height)
  const c = { ...clock, ...dial, w: src.width, h: src.height }
  console.log(`${clock.file}: dial centre ${c.cx},${c.cy} (${dial.mask.size} px)`)
  const frames = []
  for (let f = 0; f < FRAMES; f++) {
    const canvas = createCanvas(c.w, c.h)
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(src, 0, 0)
    clearHands(ctx, c)
    hand(ctx, c, f / FRAMES, c.hour)                      // hour hand: one turn per twelve hours
    hand(ctx, c, (f % 4) / 4, c.minute)                   // minute hand: on the quarter it points at
    ctx.fillStyle = HAND
    ctx.fillRect(c.cx, c.cy, 1, 1)                        // the pivot itself
    writeFileSync(`${OUT}/${clock.file}_TIME_${f}.png`, canvas.toBuffer('image/png'))
    frames.push(canvas)
  }
  sheets.push({ name: clock.file, frames })
  console.log(clock.file, frames.length, 'frames')
}

const SC = 6, cols = FRAMES
const sheet = createCanvas(cols * (16 * SC + 4) + 4, sheets.length * (32 * SC + 20))
const g = sheet.getContext('2d')
g.imageSmoothingEnabled = false
g.fillStyle = '#202030'; g.fillRect(0, 0, sheet.width, sheet.height)
sheets.forEach((s, si) => {
  s.frames.forEach((c, i) => {
    g.drawImage(c, 4 + i * (16 * SC + 4), si * (32 * SC + 20) + 16, c.width * SC, c.height * SC)
    g.fillStyle = '#fff'; g.font = '10px sans-serif'
    const hh = ((Math.floor(i / 4) + 11) % 12) + 1
    g.fillText(`${hh}:${String((i % 4) * 15).padStart(2, '0')}`, 4 + i * (16 * SC + 4), si * (32 * SC + 20) + 11)
  })
})
writeFileSync(`${OUT}/clock-frames.png`, sheet.toBuffer('image/png'))
