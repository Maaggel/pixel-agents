// Plants are one tile, not two.
//
// The plant sprites are 16x32 with every pixel in the lower half, so the declared 1x2 footprint
// covered a tile of empty air above the pot. That showed up as a two tile footprint in the editor
// and, worse, as an agent standing two tiles away when watering one from above. This crops each
// to the bottom tile and bottom-aligns its art, which also fixes the one plant that sat a few
// pixels high. Placed plants must move down one row to stay where they were.
//   cd renderer && SRC=<dir> OUT=<dir> node tools/crop-plants.mjs
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { writeFileSync } from 'fs'

const SRC = process.env.SRC
const OUT = process.env.OUT
const PLANTS = ['PLANT_1', 'PLANT_2', 'PLANT_3', 'WHITE_PLANT_1', 'WHITE_PLANT_2', 'WHITE_PLANT_3']

for (const name of PLANTS) {
  const src = await loadImage(`${SRC}/${name}.png`)
  const probe = createCanvas(src.width, src.height)
  const pctx = probe.getContext('2d')
  pctx.drawImage(src, 0, 0)
  const d = pctx.getImageData(0, 0, src.width, src.height).data
  let top = src.height, bottom = -1
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (d[(y * src.width + x) * 4 + 3] > 128) { if (y < top) top = y; if (y > bottom) bottom = y; break }
    }
  }
  const out = createCanvas(16, 16)
  const ctx = out.getContext('2d')
  ctx.imageSmoothingEnabled = false
  // sit the art on the floor of its tile; anything taller than a tile loses its topmost row
  const shift = 15 - bottom
  ctx.drawImage(src, 0, shift)
  const height = bottom - top + 1
  writeFileSync(`${OUT}/${name}.png`, out.toBuffer('image/png'))
  console.log(`${name.padEnd(14)} art was rows ${top}-${bottom} (${height}px)${height > 16 ? `, ${height - 16} row(s) clipped` : ''}`)
}
