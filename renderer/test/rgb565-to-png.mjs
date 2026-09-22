// Debug helper: turn a .rgb565 frame dump (from PIXEL_AGENTS_RENDERER_ONCE) into a PNG.
//   node test/rgb565-to-png.mjs frame.rgb565 out.png [width height]
import { readFileSync, writeFileSync } from 'fs'
import { PNG } from 'pngjs'
const [src, out, w = '1024', h = '600'] = process.argv.slice(2)
const raw = readFileSync(src)
const png = new PNG({ width: Number(w), height: Number(h) })
for (let i = 0, o = 0; i < raw.length; i += 2, o += 4) {
  const v = raw[i] | (raw[i + 1] << 8)
  png.data[o] = ((v >> 11) & 0x1F) << 3
  png.data[o + 1] = ((v >> 5) & 0x3F) << 2
  png.data[o + 2] = (v & 0x1F) << 3
  png.data[o + 3] = 255
}
writeFileSync(out, PNG.sync.write(png))
