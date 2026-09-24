// The sign beside a door, telling you whether the room behind it is free, in a meeting, or in use.
//
//   DOOR_SIGN_VACANT    green, a tick
//   DOOR_SIGN_MEETING   amber, two heads round a table
//   DOOR_SIGN_OCCUPIED  red, a bar
//
// Three 16x16 frames of one plate on a single tile, drawn in the top half of it so the plate sits
// in the wall's lit face rather than hanging past its bottom edge. One tile is deliberate: the
// entry is half-tile placeable, and on a two-tile footprint the only half step that stays on the
// wall is upward, which is the wrong way for a sign that is already too high. The engine picks the frame from the nearest
// room that has something worth reporting - a toilet in it, or a meeting zone - so which frame
// shows is state, not animation. Run by hand, output uploaded over FTP:
//   cd renderer && OUT=<dir> node tools/make-door-signs.mjs
import { createCanvas } from '@napi-rs/canvas'
import { writeFileSync, mkdirSync } from 'fs'

const OUT = process.env.OUT || '.'
mkdirSync(OUT, { recursive: true })

const P = {
  '.': null,
  'K': '#14100e',   // outline
  'M': '#5b4a3a',   // the plate's mount, screwed to the wall
  'm': '#7a6552',
  'G': '#3f9d58',   // green face
  'g': '#59c076',
  'A': '#c9902c',   // amber face
  'a': '#e4b64a',
  'R': '#b03c38',   // red face
  'r': '#d2605a',
  'W': '#f2efe8',   // the mark on the face
  'S': '#00000044', // shadow under the plate
}

// One plate, three faces. F is the face colour, f its highlight, and the marks differ per state.
const plate = (F, f, marks) => {
  const face = (ch) => `...K${ch.repeat(8)}K...`
  const block = [
    '....KKKKKKKK....',
    '....KMmmmmMK....',
    '...KKKKKKKKKK...',
    face(F),
    face(F),
    face(f),
    '...KKKKKKKKKK...',
    '....SSSSSSSS....',
  ]
  const rows = Array.from({ length: 16 }, (_, i) => block[i] ?? '................')
  // stamp the state's marks into the face, which spans columns 4-11 and rows 3-5
  for (const [x, y, ch] of marks) {
    const r = rows[y].split('')
    r[x] = ch
    rows[y] = r.join('')
  }
  return rows
}

const png = (rows, name) => {
  const c = createCanvas(16, 16)
  const x = c.getContext('2d')
  x.imageSmoothingEnabled = false
  rows.forEach((row, y) => [...row].forEach((ch, X) => {
    const col = P[ch]
    if (!col) return
    x.fillStyle = col
    x.fillRect(X, y, 1, 1)
  }))
  writeFileSync(`${OUT}/${name}.png`, c.toBuffer('image/png'))
  console.log(`  ${name}.png`)
}

// a tick: a short stroke down, a long one back up
const VACANT = [[5, 4, 'W'], [6, 5, 'W'], [7, 4, 'W'], [8, 3, 'W']]
// two heads at a table
const MEETING = [[6, 3, 'W'], [9, 3, 'W'], [6, 5, 'W'], [7, 5, 'W'], [8, 5, 'W'], [9, 5, 'W']]
// a bar across: do not come in
const OCCUPIED = [[5, 4, 'W'], [6, 4, 'W'], [7, 4, 'W'], [8, 4, 'W'], [9, 4, 'W'], [10, 4, 'W']]

console.log('door signs ->')
png(plate('G', 'g', VACANT), 'DOOR_SIGN_VACANT')
png(plate('A', 'a', MEETING), 'DOOR_SIGN_MEETING')
png(plate('R', 'r', OCCUPIED), 'DOOR_SIGN_OCCUPIED')
