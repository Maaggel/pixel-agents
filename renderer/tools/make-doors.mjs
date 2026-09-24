// Office doors: a leaf that can be open or closed, for a doorway in a horizontal wall run and for
// one in a vertical run.
//
//   DOOR_FRONT_CLOSED / DOOR_FRONT_OPEN   gap in an east-west wall, walked through north-south
//   DOOR_SIDE_CLOSED  / DOOR_SIDE_OPEN    gap in a north-south wall, walked through east-west
//
// A door in a north-south wall is seen edge on, so closed it is only the narrow beam of the leaf
// itself, a third of the tile wide and standing in the middle of the doorway - there is no door
// face to show from that direction. Open, that beam stays as the frame and the leaf swings out
// beside it, sheared so it reads as a door standing open, which is why that sprite is two tiles
// wide: the leaf reaches past the doorway it belongs to. Their band is shorter than the east-west
// door's, because in a vertical wall run the wall below the gap draws in front of the doorway and
// anything below sprite row 31 is covered anyway.
//
// Each is 16x32, placed on a 1x2 footprint whose top row is a background row lying in the wall.
// Only the top 24 rows are drawn, because that is exactly the wall's lit face: measured off a
// rendered wall, a wall block is 1 px of outline, 7 px of dark top, 23 px of lit face and 1 px of
// outline again, and that last outline falls 8 px into the tile row rather than at its bottom.

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
]

// ── Door in a north-south wall, seen from the side ───────────────
// The frame runs along the top and bottom of the gap; the leaf fills the middle.

// Open: the leaf swung back against the top jamb, the room beyond showing through.

// ── The north-south pair, built rather than typed: the open leaf is a sheared rectangle ──
function grid(w, h) { return Array.from({ length: h }, () => Array(w).fill('.')) }
function rows(g) { return g.map((r) => r.join('')) }

/** The leaf seen edge on: a narrow beam standing in the middle of the doorway. */
function stampBeam(g, x0, top, bottom) {
  for (let y = top; y <= bottom; y++) {
    const cap = y === top || y === top + 1 || y === bottom || y === bottom - 1
    g[y][x0] = 'K'
    g[y][x0 + 1] = cap ? 'F' : 'w'
    g[y][x0 + 2] = cap ? 'F' : 'W'
    g[y][x0 + 3] = cap ? 'F' : 'W'
    g[y][x0 + 4] = cap ? 'F' : 'd'
    g[y][x0 + 5] = 'K'
  }
  for (const y of [top, bottom]) for (let i = 0; i <= 5; i++) g[y][x0 + i] = 'K'
}

/**
 * The leaf swung open beside the frame. It is drawn as a door seen at an angle: it climbs as it
 * travels away from its hinge (SHEAR) and gets shallower with distance (depthNear -> depthFar),
 * which is what stops it reading as a plank nailed to the wall.
 */
function stampSwungLeaf(g, ax, ay, len, depthNear, depthFar, shear) {
  const H = g.length, W = g[0].length
  const put = (x, y, ch) => { if (y >= 0 && y < H && x >= 0 && x < W) g[y][x] = ch }
  for (let i = 0; i < len; i++) {
    const lift = Math.round(i * shear)
    const depth = Math.round(depthNear + (depthFar - depthNear) * (i / (len - 1)))
    const top = ay - lift
    for (let j = 0; j < depth; j++) {
      const x = ax + i, y = top + j
      const first = i === 0, last = i === len - 1
      const edgeTop = j === 0, edgeBottom = j === depth - 1
      if (first || last || edgeTop || edgeBottom) { put(x, y, 'K'); continue }
      if (j === 1) { put(x, y, 'w'); continue }          // the lit top face of the leaf
      if (j === depth - 2) { put(x, y, 'd'); continue }  // and its shaded underside
      // two panels running the length of the leaf
      const inPanel = i > 2 && i < len - 2
      const groove = inPanel && (j === 3 || j === depth - 4 || i === 3 || i === len - 3)
      put(x, y, groove ? 'D' : inPanel ? 'd' : 'W')
    }
  }
  // the handle sits on the swinging edge, furthest from the hinge
  const hi = len - 4, lift = Math.round(hi * shear)
  const depth = Math.round(depthNear + (depthFar - depthNear) * (hi / (len - 1)))
  const hy = ay - lift + Math.floor(depth / 2)
  put(ax + hi, hy, 'B')
  put(ax + hi, hy + 1, 'b')
}

const BEAM_TOP = 8, BEAM_BOTTOM = 31, BEAM_X = 5

const sideClosedGrid = grid(16, 48)
stampBeam(sideClosedGrid, BEAM_X, BEAM_TOP, BEAM_BOTTOM)
const SIDE_CLOSED = rows(sideClosedGrid)

const sideOpenGrid = grid(32, 48)
stampBeam(sideOpenGrid, BEAM_X, BEAM_TOP, BEAM_BOTTOM)
stampSwungLeaf(sideOpenGrid, BEAM_X + 6, BEAM_TOP + 4, 14, 12, 12, -0.3)
const SIDE_OPEN = rows(sideOpenGrid)

console.log('doors ->')
png(FRONT_CLOSED, 'DOOR_FRONT_CLOSED')
png(FRONT_OPEN, 'DOOR_FRONT_OPEN')
png(SIDE_CLOSED, 'DOOR_SIDE_CLOSED')
png(SIDE_OPEN, 'DOOR_SIDE_OPEN')
