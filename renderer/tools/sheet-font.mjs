// A font that is there, or a loud failure.
//
// Every label on every sheet was an empty box for hours: Skia resolves no font by name on this box,
// `sans-serif` silently resolved to nothing, and the numbers the catalogue exists to show were
// unreadable in each one. Nobody noticed because the failure looked like small text.
//
// So: register from a path rather than ask for a family by name, prefer the font this repo carries
// over anything the machine happens to have, and check afterwards that glyphs actually measure.
// A sheet with no font on it should stop, not ship.
import { GlobalFonts, createCanvas } from '@napi-rs/canvas'
import { existsSync } from 'fs'

// In order of preference. The first two are crisper at the sizes these labels use; the last is the
// font this repo carries, which is always there - so the list ends in something rather than in a
// machine without fonts. A pixel font scaled off its design size goes soft, which is why it is last
// and not first, but soft and readable beats absent.
const CANDIDATES = [
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  ['/usr/share/fonts/truetype/freefont/FreeSans.ttf', '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf'],
  [new URL('../../webview-ui/src/fonts/FSPixelSansUnicode-Regular.ttf', import.meta.url).pathname, null],
]

/**
 * Register a sheet font and return the family names to draw with. `bold` falls back to the regular
 * face when the family has no separate bold file, which is fine - it is a label, not a headline.
 */
export function registerSheetFont() {
  for (const [regular, bold] of CANDIDATES) {
    if (!existsSync(regular)) continue
    if (!GlobalFonts.registerFromPath(regular, 'Sheet')) continue
    const boldFamily = bold && existsSync(bold) && GlobalFonts.registerFromPath(bold, 'Sheet Bold')
      ? 'Sheet Bold'
      : 'Sheet'
    if (measures('Sheet')) return { regular: 'Sheet', bold: boldFamily }
  }
  throw new Error(
    'no usable font: tried ' + CANDIDATES.map(([r]) => r).join(', ') +
    '\nWithout one every label on the sheet draws as an empty box, which is how this went unnoticed for hours.',
  )
}

/** Does this family actually put glyphs on a canvas, or is it a name Skia accepted and ignored? */
function measures(family) {
  const ctx = createCanvas(32, 32).getContext('2d')
  ctx.font = `12px "${family}"`
  return ctx.measureText('Hg0').width > 1
}
