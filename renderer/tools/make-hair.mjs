// Draw new hairstyles from the ones the characters came in.
//
// The head is not still: it bobs a row as the character walks and leans when it types, so a tail
// pinned to fixed pixels comes off the head half the time. Each frame is therefore measured first -
// where the hair actually ends, in that frame - and the tail is hung from there. It follows the bob
// for free, in all 21 frames, which is the whole reason for doing it in code rather than by hand.
//
//   cd renderer && node tools/make-hair.mjs [outdir]
//
// Writes the next hair_<n>.png after the ones that exist. Preview with tools/parts-sheet.mjs.
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { writeFileSync } from 'fs'

const OUT = process.argv[2] || '../webview-ui/public/assets/characters/parts'
const FW = 16, FH = 32, FRAMES = 7
const FACING_DOWN = 0, FACING_UP = 1, FACING_RIGHT = 2
/** How many parts per layer come from cutting the six characters up */
const FROM_CHARACTERS = 6

async function readSheet(path) {
  const img = await loadImage(path)
  const c = createCanvas(img.width, img.height)
  const g = c.getContext('2d')
  g.imageSmoothingEnabled = false
  g.drawImage(img, 0, 0)
  const d = g.getImageData(0, 0, img.width, img.height).data
  const rows = []
  for (let y = 0; y < img.height; y++) {
    const row = []
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4
      row.push(d[i + 3] < 128 ? '' :
        `#${d[i].toString(16).padStart(2, '0')}${d[i + 1].toString(16).padStart(2, '0')}${d[i + 2].toString(16).padStart(2, '0')}`.toUpperCase())
    }
    rows.push(row)
  }
  return rows
}

function writeSheet(path, rows) {
  const c = createCanvas(rows[0].length, rows.length)
  const g = c.getContext('2d')
  g.imageSmoothingEnabled = false
  rows.forEach((row, y) => row.forEach((px, x) => {
    if (!px) return
    g.fillStyle = px
    g.fillRect(x, y, 1, 1)
  }))
  writeFileSync(path, c.toBuffer('image/png'))
}

const lum = (hex) =>
  0.299 * parseInt(hex.slice(1, 3), 16) + 0.587 * parseInt(hex.slice(3, 5), 16) + 0.114 * parseInt(hex.slice(5, 7), 16)

/** The tones this hair is drawn in: its commonest colour, and its darkest, for the outline. */
function tones(rows) {
  const counts = new Map()
  for (const row of rows) for (const px of row) if (px) counts.set(px, (counts.get(px) ?? 0) + 1)
  let mid = '', most = 0, dark = ''
  for (const [px, n] of counts) {
    if (n > most) { mid = px; most = n }
    if (!dark || lum(px) < lum(dark)) dark = px
  }
  return { mid, dark }
}

/** Halfway between two tones, for the side of a strand that is turning away from the light. */
function shadeOf(mid, dark) {
  const mix = (i) => Math.round((parseInt(mid.slice(i, i + 2), 16) + parseInt(dark.slice(i, i + 2), 16)) / 2)
  return `#${mix(1).toString(16).padStart(2, '0')}${mix(3).toString(16).padStart(2, '0')}${mix(5).toString(16).padStart(2, '0')}`.toUpperCase()
}

/** One frame as a grid of 16x32, and a way to write back into the sheet. */
function frameView(rows, frame, facing) {
  const x0 = frame * FW, y0 = facing * FH
  return {
    get: (x, y) => (x < 0 || x >= FW || y < 0 || y >= FH ? '' : rows[y0 + y][x0 + x]),
    set: (x, y, px) => { if (x >= 0 && x < FW && y >= 0 && y < FH) rows[y0 + y][x0 + x] = px },
  }
}

/** Where the hair ends in this frame, so something hung off it stays attached. */
function anchor(view, facing) {
  let bottom = -1, back = facing === FACING_RIGHT ? FW : -1, bottomX = 0
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      if (!view.get(x, y)) continue
      if (y > bottom) { bottom = y; bottomX = x }
      if (facing === FACING_RIGHT && x < back) back = x
      if (facing === FACING_DOWN && x > back) back = x
    }
  }
  return { bottom, back, bottomX }
}

const HAIRSTYLES = [
  {
    name: 'ponytail',
    base: 'hair_4',
    draw: (rows) => {
      const { mid, dark } = tones(rows)
      for (let facing = 0; facing < 3; facing++) {
        for (let frame = 0; frame < FRAMES; frame++) {
          const view = frameView(rows, frame, facing)
          const a = anchor(view, facing)
          if (a.bottom < 0) continue

          if (facing === FACING_UP) {
            // From behind, the whole tail: a band at the nape, then three strands falling and
            // narrowing to a point. It hangs over the shirt, which is what hair does.
            const cx = Math.round(FW / 2) - 2
            for (let i = 0; i < 9; i++) {
              const y = a.bottom + i
              const width = i === 0 ? 3 : i < 5 ? 3 : i < 7 ? 2 : 1
              for (let w = 0; w < width; w++) {
                view.set(cx + w, y, i === 0 || i >= 7 ? dark : (w === 1 ? mid : shadeOf(mid, dark)))
              }
            }
          } else if (facing === FACING_RIGHT) {
            // From the side it swings out behind the head, clear of the face
            for (let i = 0; i < 8; i++) {
              const y = a.bottom - 3 + i
              const x = a.back - 1 - Math.floor(i / 3)
              view.set(x, y, i >= 6 ? dark : mid)
              if (i < 6) view.set(x + 1, y, mid)
            }
          } else {
            // From the front, what shows past the head: the tail hanging behind one shoulder
            for (let i = 0; i < 5; i++) {
              const y = a.bottom - 2 + i
              view.set(a.back - 1, y, i === 4 ? dark : mid)
              view.set(a.back, y, i === 4 ? dark : shadeOf(mid, dark))
            }
          }
        }
      }
      return rows
    },
  },
]

// The first six of every layer are the characters cut up; anything drawn here goes after them, at a
// fixed number, so running this again redraws the same files instead of piling up new ones.
let next = FROM_CHARACTERS
for (const style of HAIRSTYLES) {
  const rows = await readSheet(`${OUT}/${style.base}.png`)
  writeSheet(`${OUT}/hair_${next}.png`, style.draw(rows))
  console.log(`  hair_${next}.png  ${style.name} (from ${style.base})`)
  next++
}
console.log(`${HAIRSTYLES.length} new hairstyle(s); the pool now runs to hair_${next - 1}`)
