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
const CHARS = process.argv[3] || '../webview-ui/public/assets/characters'
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
    facing,
    get: (x, y) => (x < 0 || x >= FW || y < 0 || y >= FH ? '' : rows[y0 + y][x0 + x]),
    set: (x, y, px) => { if (x >= 0 && x < FW && y >= 0 && y < FH) rows[y0 + y][x0 + x] = px },
  }
}

/**
 * The box the hair fills in this frame. Everything hung off the head is placed against this rather
 * than against fixed pixels, so it follows the head as it bobs and leans.
 */
function headBox(view) {
  let top = FH, bottom = -1, left = FW, right = -1
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      if (!view.get(x, y)) continue
      if (y < top) top = y
      if (y > bottom) bottom = y
      if (x < left) left = x
      if (x > right) right = x
    }
  }
  return { top, bottom, left, right, height: bottom - top + 1 }
}

/** The widest row of the head, which is where an ear would be and where a tail is gathered. */
function widestRow(view, box) {
  let best = box.top, most = -1
  for (let y = box.top; y <= box.bottom; y++) {
    let n = 0
    for (let x = 0; x < FW; x++) if (view.get(x, y)) n++
    if (n > most) { most = n; best = y }
  }
  return best
}

/**
 * The head under the hair: where all six characters agree there is something. Each was drawn with
 * its own hair on, so the shape they share is the skull itself - and it is the shape to draw a
 * hairstyle onto when the hairstyle is not a variation of one that exists.
 */
async function skullMasks() {
  const sheets = []
  for (let i = 0; i < 6; i++) sheets.push(await readSheet(`${CHARS}/char_${i}.png`))
  const masks = []
  for (let facing = 0; facing < 3; facing++) {
    masks[facing] = []
    for (let frame = 0; frame < FRAMES; frame++) {
      const mask = []
      for (let y = 0; y < FH; y++) {
        const row = []
        for (let x = 0; x < FW; x++) {
          row.push(sheets.every((sheet) => !!sheet[facing * FH + y][frame * FW + x]))
        }
        mask.push(row)
      }
      masks[facing][frame] = mask
    }
  }
  return masks
}

/** An empty sheet the shape of a character sheet, for a style drawn from nothing. */
function blankSheet() {
  return Array.from({ length: FH * 3 }, () => Array.from({ length: FW * FRAMES }, () => ''))
}

/**
 * A tail: a band where it is gathered, then a fall that narrows to a point. The widths are the
 * shape of it, row by row; `lean` swings it sideways as it falls.
 */
function drawTail(view, x0, y0, widths, tone, lean = 0) {
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i]
    const x = x0 + Math.round(i * lean)
    for (let k = 0; k < w; k++) {
      const edge = w > 1 && (k === 0 || k === w - 1)
      const last = i >= widths.length - 2
      view.set(x + k, y0 + i, i === 0 || last ? tone.dark : edge ? tone.shade : tone.mid)
    }
  }
}

/** Where a tail is gathered and how far the head reaches, measured from the hair in this frame. */
function gatherPoint(view, high) {
  const box = headBox(view)
  if (box.bottom < 0) return null
  let widest = box.top, most = -1
  for (let y = box.top; y <= box.bottom; y++) {
    let n = 0
    for (let x = 0; x < FW; x++) if (view.get(x, y)) n++
    if (n > most) { most = n; widest = y }
  }
  // Worn high, it is gathered at the ear, where the head is widest. Worn low, where the head has
  // started to narrow again - which on a head fifteen pixels across is also where a tail first has
  // room to show against something other than more hair.
  return { box, gather: high ? widest : Math.round((widest + box.bottom) / 2) }
}

/** Hang a ponytail off whatever hair is already in the frame. */
function addPonytail(view, tone, high = false) {
  const at = gatherPoint(view, high)
  if (!at) return
  const { box, gather } = at
  // Worn high it has further to fall, and from the front it clears the ear before the cheek
  const fall = high ? 3 : 0
  if (view.facing === FACING_UP) {
    const widths = [5, 5, 5, 4, 4, 4, 4, 3, 3, 2, 2, 1]
    drawTail(view, Math.round(FW / 2) - 2, gather, high ? [5, 5, 5, ...widths] : widths, tone)
  } else if (view.facing === FACING_RIGHT) {
    const widths = [4, 4, 4, 4, 4, 3, 3, 2, 2, 1]
    drawTail(view, box.left - 2, gather, high ? [4, 4, 4, ...widths] : widths, tone, -0.2)
  } else {
    // Face-on the tail is behind the head: a sliver past the ear, not a slab beside the face
    const widths = [2, 2, 2, 2, 1]
    drawTail(view, box.right - 1, gather + 2, high ? [2, 2, ...widths] : widths, tone)
  }
  void fall
}

const HAIRSTYLES = [
  {
    name: 'ponytail',
    base: 'hair_4',
    draw: (rows) => {
      const { mid, dark } = tones(rows)
      const tone = { mid, dark, shade: shadeOf(mid, dark) }
      for (let facing = 0; facing < 3; facing++) {
        for (let frame = 0; frame < FRAMES; frame++) addPonytail(frameView(rows, frame, facing), tone)
      }
      return rows
    },
  },
  {
    // Not a variation of anything: a smooth head of hair drawn straight onto the skull, swept off a
    // parting and held back in a tail. Four tones off the brown mop, so it belongs in the same set.
    name: 'sleek low ponytail',
    skull: true,
    draw: (rows, masks, style) => {
      const tone = { mid: '#57351A', dark: '#2F160F', shade: '#432415', light: '#7A5322' }

      for (let facing = 0; facing < 3; facing++) {
        for (let frame = 0; frame < FRAMES; frame++) {
          const mask = masks[facing][frame]
          const view = frameView(rows, frame, facing)
          const on = (x, y) => x >= 0 && x < FW && y >= 0 && y < FH && mask[y][x]

          let top = FH, left = FW, right = -1
          for (let y = 0; y < FH; y++) {
            for (let x = 0; x < FW; x++) {
              if (!mask[y][x]) continue
              if (y < top) top = y
              if (x < left) left = x
              if (x > right) right = x
            }
          }
          if (right < 0) continue

          // How far down the hair comes, column by column: full to the nape at the back, clear of
          // the eyes at the front, and down past the ear at the sides of a face-on head.
          const width = Math.max(1, right - left)
          // How far down the hair comes, column by column, counted from the top of the head. Traced
          // off a reference rather than computed from a slope: a parting a third of the way across,
          // short above it, sweeping down and over to fall past the far ear, and never across the
          // eyes - which sit two rows below the brow, and read as hair in the face if covered.
          const HAIRLINE = style.hairline ?? {
            // Face-on, the hair falls the same on both sides of the head, and what is swept is the
            // fringe between them. It never steps more than a row at a time: on a head this size a
            // two-row step in the hairline is a notch, not a sweep.
            [FACING_DOWN]: [11, 11, 10, 9, 9, 9, 10, 10, 10, 10, 11, 11, 11, 11],
            [FACING_UP]: [13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13],
            [FACING_RIGHT]: [12, 12, 11, 10, 9, 9, 8, 8, 7, 7, 7, 8, 9],
          }
          const hairline = (x) => {
            const table = HAIRLINE[facing]
            const at = Math.round(((x - left) / width) * (table.length - 1))
            return top + table[Math.max(0, Math.min(table.length - 1, at))]
          }

          // Sitting two rows down the skull rather than right on top of it: the head reads shorter
          // that way, and the bald base underneath stops two rows down to match. Cutting straight
          // across would leave a flat lid, so the two rows at the new crown are pulled in to a
          // curve - measured on each row's own width, since the head narrows as it goes up.
          const CROWN_DROP = 2
          const CROWN_TAPER = [2, 1]
          const rowExtent = (y) => {
            let l = FW, r = -1
            for (let x = 0; x < FW; x++) if (on(x, y)) { if (x < l) l = x; if (x > r) r = x }
            return { l, r }
          }
          const isHair = (x, y) => {
            if (!on(x, y) || y < top + CROWN_DROP || y > hairline(x)) return false
            const taper = CROWN_TAPER[y - (top + CROWN_DROP)]
            if (taper === undefined) return true
            const { l, r } = rowExtent(y)
            return x >= l + taper && x <= r - taper
          }
          for (let y = 0; y < FH; y++) {
            for (let x = 0; x < FW; x++) {
              if (!isHair(x, y)) continue
              const across = (x - left) / width
              const edge = !isHair(x - 1, y) || !isHair(x + 1, y) || !isHair(x, y - 1) || !isHair(x, y + 1)
              // The parting shows as the step in the fringe, not as a drawn line: at this size a
              // dark stripe over the crown reads as a scar
              const parted = false
              // Strands down the length of it, where there is length to read - face-on there is
              // only the crown, and stripes across it look like a barcode
              const strand = !edge && facing !== FACING_DOWN && (x - left) % 3 === 1
              // The light falls from the upper left, as it does on every other sprite here
              const lit = !edge && y - top + (x - left) * 0.7 < width * 0.5
              view.set(x, y,
                edge || parted ? tone.dark
                  : lit ? tone.light
                  : strand || y >= hairline(x) - 1 ? tone.shade
                  : tone.mid)
            }
          }
          if (style.tail !== false) addPonytail(view, tone, !!style.high)
        }
      }
      return rows
    },
  },
]

// Worn high, off the same drawing: the tail is gathered at the ear rather than at the nape
const SLEEK = HAIRSTYLES[HAIRSTYLES.length - 1]
HAIRSTYLES.push({ ...SLEEK, name: 'sleek high ponytail', high: true })

// The office had grown long-haired: of the styles so far, two are long, three end in a tail and two
// are bobs, and a name dealt at random came out looking much the same each time. These two are
// short, and cut close above the ear rather than down past it.
HAIRSTYLES.push({
  ...SLEEK,
  name: 'short crop',
  tail: false,
  hairline: {
    [FACING_DOWN]: [7, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 7],
    [FACING_UP]: [10, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 10],
    [FACING_RIGHT]: [10, 10, 10, 9, 9, 8, 8, 8, 7, 7, 7, 7, 8],
  },
})

HAIRSTYLES.push({
  ...SLEEK,
  name: 'short, side parting',
  tail: false,
  hairline: {
    [FACING_DOWN]: [8, 9, 9, 7, 7, 7, 8, 8, 9, 9, 9, 9, 9, 8],
    [FACING_UP]: [11, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 11],
    [FACING_RIGHT]: [11, 11, 11, 10, 10, 9, 8, 8, 7, 7, 7, 8, 9],
  },
})

// The first six of every layer are the characters cut up; anything drawn here goes after them, at a
// fixed number, so running this again redraws the same files instead of piling up new ones.
let next = FROM_CHARACTERS
const masks = HAIRSTYLES.some((h) => h.skull) ? await skullMasks() : null
for (const style of HAIRSTYLES) {
  const rows = style.skull ? blankSheet() : await readSheet(`${OUT}/${style.base}.png`)
  writeSheet(`${OUT}/hair_${next}.png`, style.draw(rows, masks, style))
  console.log(`  hair_${next}.png  ${style.name} (${style.skull ? 'drawn on the bare skull' : `from ${style.base}`})`)
  next++
}
console.log(`${HAIRSTYLES.length} new hairstyle(s); the pool now runs to hair_${next - 1}`)
