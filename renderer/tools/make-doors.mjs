// Office doors: a leaf that can be open or closed, for a doorway in a horizontal wall run and for
// one in a vertical run.
//
//   DOOR_FRONT_CLOSED / DOOR_FRONT_OPEN   gap in an east-west wall, walked through north-south
//   DOOR_SIDE_CLOSED  / DOOR_SIDE_OPEN    gap in a north-south wall, walked through east-west
//
// Each is 16x32, placed on a 1x2 footprint whose top row is a background row lying in the wall.
// Only the top 24 rows are drawn, because that is exactly the wall's lit face: measured off a
// rendered wall, a wall block is 1 px of outline, 7 px of dark top, 23 px of lit face and 1 px of
// outline again, and that last outline falls 8 px into the tile row rather than at its bottom.
// So sprite row 0 lands at the top of the lit face and row 23 on the wall's bottom edge.
// Drawn in wood rather than the wall's own colour so a door reads as a door whatever the walls
// are tinted, and so the editor's colour sliders can restain it.
//
// The sprites and the catalog live only on the relay Pi, so this is run by hand and the output
// uploaded over FTP:
//   cd renderer && OUT=<dir> node tools/make-doors.mjs
import { createCanvas } from '@napi-rs/canvas'
import { writeFileSync, mkdirSync } from 'fs'

const OUT = process.env.OUT || '.'
mkdirSync(OUT, { recursive: true })

const P = {
  '.': null,              // transparent
  'K': '#120b08',         // outline, near black
  'F': '#4a2f1d',         // frame, dark wood
  'f': '#63412a',         // frame highlight
  'W': '#8a5a2f',         // leaf, mid wood
  'w': '#a3703d',         // leaf, lit edge
  'd': '#6b4423',         // leaf, shaded panel
  'D': '#33220f',         // panel groove
  'B': '#d9b04a',         // brass handle
  'b': '#8c6c22',         // brass shade
  'O': '#0d0a14',         // the dark of the room beyond
  'o': '#191428',         // that dark, one step lighter
  'S': '#2a1c12',         // threshold sill
  's': '#3d2a1a',         // sill highlight
  'N': '#18202e',         // the wall's depth, behind the frame
  'h': '#00000055',       // soft shadow on the floor
}

function png(rows, name) {
  const w = rows[0].length, h = rows.length
  const c = createCanvas(w, h)
  const x = c.getContext('2d')
  x.imageSmoothingEnabled = false
  rows.forEach((row, y) => [...row].forEach((ch, X) => {
    const col = P[ch]
    if (!col) return
    x.fillStyle = col
    x.fillRect(X, y, 1, 1)
  }))
  writeFileSync(`${OUT}/${name}.png`, c.toBuffer('image/png'))
  console.log(`  ${name}.png  ${w}x${h}`)
}

// ── Door in an east-west wall, seen face on ──────────────────────
// Top 16 rows: the wall plane, with the frame and the leaf. Bottom 16: the floor of the doorway.
const FRONT_CLOSED = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  'KKKKKKKKKKKKKKKK',
  'KFffffffffffffFK',
  'KFFFFFFFFFFFFFFK',
  'KFFFFFFFFFFFFFFK',
  'KKKKKKKKKKKKKKKK',
  'KFNNNNNNNNNNNNfK',
  'KFKwwwwwwwwwwKfK',
  'KFKWDDDDDDDDWKfK',
  'KFKWDddddddDWKfK',
  'KFKWDddddddDWKfK',
  'KFKbDddddddDWKfK',
  'KFKWDddddddDWKfK',
  'KFKWDddddddDWKfK',
  'KFKWDddddddDWKfK',
  'KFKWDDDDDDDDWKfK',
  'KFKWWWWWWWWWWKfK',
  'KFKWWWWWWWWBWKfK',
  'KFKWWWWWWWWbWKfK',
  'KFKWWWWWWWWWWKfK',
  'KFKWDDDDDDDDWKfK',
  'KFKWDddddddDWKfK',
  'KFKWDddddddDWKfK',
  'KFKbDddddddDWKfK',
  'KFKWDddddddDWKfK',
  'KFKWDDDDDDDDWKfK',
  'KFKWWWWWWWWWWKfK',
  'KFKKKKKKKKKKKKfK',
  'KSssssssssssssSK',
  'KKKKKKKKKKKKKKKK',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
]

// Open: the leaf folded back against the left jamb, the room beyond showing through.
const FRONT_OPEN = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  'KKKKKKKKKKKKKKKK',
  'KFffffffffffffFK',
  'KFFFFFFFFFFFFFFK',
  'KFFFFFFFFFFFFFFK',
  'KKKKKKKKKKKKKKKK',
  'KFNNNNNNNNNNNNfK',
  'KFKwWwK.......fK',
  'KFKWdWK.......fK',
  'KFKWdWK.......fK',
  'KFKWdWK.......fK',
  'KFKbdWK.......fK',
  'KFKWdWK.......fK',
  'KFKWdWK.......fK',
  'KFKWdWK.......fK',
  'KFKWdWK.......fK',
  'KFKWdWK.......fK',
  'KFKWdBK.......fK',
  'KFKWdbK.......fK',
  'KFKWdWK.......fK',
  'KFKWdWK.......fK',
  'KFKWdWK.......fK',
  'KFKbdWK.......fK',
  'KFKWdWK.......fK',
  'KFKWdWK.......fK',
  'KFKWdWK.......fK',
  'KFKWdWK.......fK',
  'KFKKKKKK......fK',
  'KSsssK........fK',
  'KKKKKK........KK',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
]

// ── Door in a north-south wall, seen from the side ───────────────
// The frame runs along the top and bottom of the gap; the leaf fills the middle.
const SIDE_CLOSED = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  'KKKKKKKKKKKKKKKK',
  'KFffffffffffffFK',
  'KFFFFFFFFFFFFFFK',
  'KFFFFFFFFFFFFFFK',
  'KKKKKKKKKKKKKKKK',
  'KNNNNNNNNNNNNNNK',
  'KwwwwwwwwwwwwwwK',
  'KWDddddddddddDWK',
  'KWDddddddddddDWK',
  'KWDDDDDDDDDDDDWK',
  'KWDddddddddddDWK',
  'KWDddddddddddDWK',
  'KWDddddddddddDWK',
  'KWDddddddddddDWK',
  'KWDDDDDDDDDDDDWK',
  'KWWWWWWWWWWWWWWK',
  'KBWWWWWWWWWWWWWK',
  'KbWWWWWWWWWWWWWK',
  'KWWWWWWWWWWWWWWK',
  'KWDDDDDDDDDDDDWK',
  'KWDddddddddddDWK',
  'KWDddddddddddDWK',
  'KWDddddddddddDWK',
  'KWDddddddddddDWK',
  'KWDDDDDDDDDDDDWK',
  'KWWWWWWWWWWWWWWK',
  'KwwwwwwwwwwwwwwK',
  'KSssssssssssssSK',
  'KKKKKKKKKKKKKKKK',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
]

// Open: the leaf swung back against the top jamb, the room beyond showing through.
const SIDE_OPEN = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  'KKKKKKKKKKKKKKKK',
  'KFffffffffffffFK',
  'KFFFFFFFFFFFFFFK',
  'KFFFFFFFFFFFFFFK',
  'KKKKKKKKKKKKKKKK',
  'KNNNNNNNNNNNNNNK',
  'KwwwwwwwwwwwwwwK',
  'KWDDDDDDDDDDDDWK',
  'KWDddddddddddDWK',
  'KWDdWWWWWWWdBdWK',
  'KWDdWWWWWWWdbdWK',
  'KWDddddddddddDWK',
  'KWDDDDDDDDDDDDWK',
  'KWWWWWWWWWWWWWWK',
  'KKKKKKKKKKKKKKKK',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
]

console.log('doors ->')
png(FRONT_CLOSED, 'DOOR_FRONT_CLOSED')
png(FRONT_OPEN, 'DOOR_FRONT_OPEN')
png(SIDE_CLOSED, 'DOOR_SIDE_CLOSED')
png(SIDE_OPEN, 'DOOR_SIDE_OPEN')
