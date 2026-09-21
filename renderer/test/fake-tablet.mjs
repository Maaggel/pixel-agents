// End-to-end wire test with the real client stack: compile Oriel's FakeTablet (Protocol +
// Lz4Decoder + FrameReceiver on a JVM), then act as the host: read its HELLO, send CONFIG and a
// few synthetic 1024x600 frames carrying the corner markers it asserts on.
import { execFileSync, spawn } from 'child_process'
import { mkdirSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { connect } from 'net'
import { compressBlock } from '../../relay/lz4.mjs'
import { encodeConfig, encodeFramePayload, frameFull, decodeHello, rgbaToRgb565 } from '../../relay/legacyProtocol.mjs'

const TABSCREEN = process.env.TABSCREEN_DIR || resolve(process.env.HOME, 'projects/TabScreen')
const scratch = process.env.SCRATCH || join(process.env.TMPDIR || '/tmp', 'pixel-agents-faketablet')
const srcRoot = join(TABSCREEN, 'android/app/src/main/java/dk/mix/tabscreen')
if (!existsSync(join(TABSCREEN, 'android/tools/FakeTablet.java'))) { console.error('TabScreen not found at ' + TABSCREEN); process.exit(2) }
mkdirSync(scratch, { recursive: true })
execFileSync('javac', ['-d', scratch, join(srcRoot, 'codec/Lz4Decoder.java'), join(srcRoot, 'net/Protocol.java'), join(srcRoot, 'net/FrameSink.java'), join(srcRoot, 'net/FrameReceiver.java'), join(TABSCREEN, 'android/tools/FakeTablet.java')], { stdio: 'inherit' })

const PORT = 27184
const W = 1024, H = 600
const tablet = spawn('java', ['-cp', scratch, 'FakeTablet', String(PORT), '8'], { stdio: ['ignore', 'pipe', 'inherit'] })
let tabletOut = ''
tablet.stdout.on('data', (d) => { tabletOut += d; process.stdout.write(d) })
await new Promise(r => setTimeout(r, 1200))

// Synthetic frame: gradient background, corner markers 16px in (red, green, blue, white), a moving bar
function makeFrame(n) {
  const rgba = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    rgba[i] = (x >> 3) & 0xFF; rgba[i + 1] = (y >> 2) & 0xFF; rgba[i + 2] = 64; rgba[i + 3] = 255
  }
  const put = (x, y, r, g, b) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const i = ((y + dy) * W + x + dx) * 4; rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b } }
  put(16, 16, 255, 0, 0); put(W - 16, 16, 0, 255, 0); put(16, H - 16, 0, 0, 255); put(W - 16, H - 16, 255, 255, 255)
  for (let y = 200; y < 300; y++) for (let x = (n * 40) % W; x < Math.min(W, (n * 40) % W + 30); x++) { const i = (y * W + x) * 4; rgba[i] = 255; rgba[i + 1] = 200; rgba[i + 2] = 0 }
  return rgbaToRgb565(rgba, W, H)
}

const sock = connect(PORT, '127.0.0.1')
await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej) })
// One accumulating reader: bytes are buffered as they arrive and handed out exactly as requested
const inbox = { buf: Buffer.alloc(0), waiters: [] }
sock.on('data', (d) => { inbox.buf = Buffer.concat([inbox.buf, d]); pump() })
function pump() {
  while (inbox.waiters.length && inbox.buf.length >= inbox.waiters[0].n) {
    const w = inbox.waiters.shift()
    const out = inbox.buf.subarray(0, w.n); inbox.buf = inbox.buf.subarray(w.n); w.res(out)
  }
}
function readExactly(_s, n) { return new Promise((res) => { inbox.waiters.push({ n, res }); pump() }) }
// HELLO: 5-byte header then 8-byte payload
const hdr = await readExactly(sock, 5)
if (hdr[0] !== 0x01) throw new Error('expected HELLO, got type ' + hdr[0])
const hello = decodeHello(await readExactly(sock, hdr.readUInt32LE(1)))
console.log('[host] HELLO', hello)
sock.write(encodeConfig({ width: W, height: H, maxFps: 5 }))
let sentBytes = 0
for (let n = 0; n < 10; n++) {
  const raw = makeFrame(n)
  const block = compressBlock(raw)
  const msg = frameFull(encodeFramePayload(block, raw.length, Math.round(performance.now() * 1000)))
  sock.write(msg); sentBytes += msg.length
  await new Promise(r => setTimeout(r, 200))
}
console.log(`[host] sent 10 frames, ${(sentBytes / 1024).toFixed(0)} KB total`)
await new Promise(r => setTimeout(r, 500))
sock.end()
await new Promise(r => tablet.on('exit', r))
const m = /result: (\d+) frames, (\d+) bad/.exec(tabletOut)
const ok = !!m && Number(m[1]) === 10 && Number(m[2]) === 0
const bad = !ok
console.log(ok ? 'PASS  FakeTablet decoded all 10 frames with the corner markers intact' : `FAIL  FakeTablet: ${m ? m[0] : 'no result line'}`)
process.exit(bad ? 1 : 0)

