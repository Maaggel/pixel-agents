// Thirsty plants: two drier variants of each plant sprite.
//
// The office waters its plants, so they should look like they need it. Level 1 is a little faded,
// level 2 is faded further and droops - the leaves shift down a pixel while the pot stays put.
// The engine swaps between them with the `thirstCycle` catalog cycle.
//   cd renderer && SRC=<dir of 16x16 plants> OUT=<dir> node tools/make-thirsty-plants.mjs
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { writeFileSync } from 'fs'

const SRC = process.env.SRC
const OUT = process.env.OUT
const PLANTS = ['PLANT_1', 'PLANT_2', 'PLANT_3', 'WHITE_PLANT_1', 'WHITE_PLANT_2', 'WHITE_PLANT_3']
/**
 * [hue turn toward yellow, saturation left, lightness left] per dryness level.
 * Green sits near 0.33 on the wheel and yellow near 0.15, so turning the hue down walks the
 * leaves from green through yellow-green to a dry olive. A first pass was too subtle to read at
 * this size: the difference has to survive being sixteen pixels tall.
 */
const LEVELS = [[-0.12, 1.0, 1.0], [-0.225, 0.78, 0.84]]

const rgbToHsl = (r, g, b) => {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6
  return [h, s, l]
}
const hslToRgb = (h, s, l) => {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v] }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q
  const f = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)]
}
/** Leaves are the green pixels; the pot and soil keep their colour and stay where they are */
const isLeaf = (r, g, b) => g > r + 8 && g > b + 8

for (const name of PLANTS) {
  const src = await loadImage(`${SRC}/${name}.png`)
  const base = createCanvas(16, 16)
  base.getContext('2d').drawImage(src, 0, 0)
  const orig = base.getContext('2d').getImageData(0, 0, 16, 16)

  LEVELS.forEach(([hueTurn, satLeft, lightLeft], i) => {
    const out = createCanvas(16, 16)
    const ctx = out.getContext('2d')
    const img = ctx.createImageData(16, 16)
    const droop = i === 1 // the driest one sags
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        // a drooping leaf is read from the row above, so the whole leaf mass slides down one
        const sy = droop && y > 0 && isLeaf(...readAt(orig, x, y - 1)) ? y - 1 : y
        const [r, g, b, a] = readAt(orig, x, sy, true)
        const di = (y * 16 + x) * 4
        if (a < 128) { img.data[di + 3] = 0; continue }
        if (isLeaf(r, g, b)) {
          const [h, s, l] = rgbToHsl(r, g, b)
          const [nr, ng, nb] = hslToRgb((h + hueTurn + 1) % 1, s * satLeft, l * lightLeft)
          img.data[di] = nr; img.data[di + 1] = ng; img.data[di + 2] = nb
        } else {
          img.data[di] = r; img.data[di + 1] = g; img.data[di + 2] = b
        }
        img.data[di + 3] = a
      }
    }
    ctx.putImageData(img, 0, 0)
    writeFileSync(`${OUT}/${name}_DRY_${i + 1}.png`, out.toBuffer('image/png'))
  })
  console.log(`${name}: 2 dry variants`)
}

function readAt(img, x, y, withAlpha) {
  const i = (y * 16 + x) * 4
  return withAlpha ? [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]
    : [img.data[i], img.data[i + 1], img.data[i + 2]]
}
