// The watering can: a 16x16 utensil sprite in the office's palette.
//
// Drawn here rather than cut from the tileset because the tileset has no can. Run by hand and the
// output uploaded to the relay Pi with the rest of the furniture:
//   cd renderer && OUT=<dir> node tools/make-watering-can.mjs
import { createCanvas } from '@napi-rs/canvas'
import { writeFileSync } from 'fs'

const OUT = process.env.OUT || '.'
const C = {
  '.': null,
  B: '#4f8f6a',   // body
  h: '#7fc294',   // lit edge
  d: '#391624',   // the dark outline the other utensils use
  S: '#b5bfc7',   // spout and handle, the same metal as the monitors
  w: '#84e6fd',   // water in the spout
}
// Seen from above and sitting low in the tile, like the coffee mug it stands beside.
const ART = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '.....dddd.......',
  '....dhhhhd......',
  '...dhBBBBhSd....',
  '.dSdhBBBBBhd....',
  '.dwdhBBBBhSd....',
  '...ddBBBBd......',
  '.....dddd.......',
  '................',
]
const canvas = createCanvas(16, 16)
const ctx = canvas.getContext('2d')
ctx.imageSmoothingEnabled = false
ART.forEach((row, y) => [...row].forEach((ch, x) => {
  const col = C[ch]
  if (!col) return
  ctx.fillStyle = col
  ctx.fillRect(x, y, 1, 1)
}))
writeFileSync(`${OUT}/WATERING_CAN.png`, canvas.toBuffer('image/png'))

// a preview at 20x so the shape can be judged
const SC = 20
const big = createCanvas(16 * SC, 16 * SC)
const g = big.getContext('2d')
g.imageSmoothingEnabled = false
g.fillStyle = '#2a2a3e'; g.fillRect(0, 0, big.width, big.height)
g.drawImage(canvas, 0, 0, 16 * SC, 16 * SC)
writeFileSync(`${OUT}/watering-can-preview.png`, big.toBuffer('image/png'))
console.log('WATERING_CAN.png written')
