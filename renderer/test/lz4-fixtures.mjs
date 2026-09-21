// Wire-compatibility check against the TabScreen fixtures (docs/HANDOFF-from-TabScreen.md):
//  1. Oriel's .lz4 must decode to his .rgb565 with our decoder.
//  2. Our compressor's output must decode back to the raw with our decoder AND with his Java decoder.
//  3. Our framed CONFIG must equal fixtures/protocol/config.bin byte for byte.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, resolve } from 'path'
import { compressBlock, decompressBlock } from '../../relay/lz4.mjs'
import { encodeConfig, frameFull, encodeFramePayload } from '../../relay/legacyProtocol.mjs'

const TABSCREEN = process.env.TABSCREEN_DIR || resolve(process.env.HOME, 'projects/TabScreen')
const fx = (p) => join(TABSCREEN, 'fixtures', p)
if (!existsSync(fx('lz4/pattern-256x160.rgb565'))) { console.error('TabScreen fixtures not found at ' + TABSCREEN); process.exit(2) }

const raw = readFileSync(fx('lz4/pattern-256x160.rgb565'))
const theirs = readFileSync(fx('lz4/pattern-256x160.lz4'))
let failures = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); if (!ok) failures++ }

// 1. their block -> our decoder
check('their .lz4 decodes to their .rgb565', decompressBlock(theirs, raw.length).equals(raw), `${theirs.length} -> ${raw.length} bytes`)

// 2. our block -> our decoder, and -> their Java decoder
const ours = compressBlock(raw)
check('our block decodes back (our decoder)', decompressBlock(ours, raw.length).equals(raw), `${raw.length} -> ${ours.length} bytes, theirs ${theirs.length}`)

const big = readFileSync(fx('lz4/pattern-1024x600.lz4'))
const bigRaw = decompressBlock(big, 1024 * 600 * 2)
const bigOurs = compressBlock(bigRaw)
check('1024x600: our block round-trips', decompressBlock(bigOurs, bigRaw.length).equals(bigRaw), `${bigRaw.length} -> ${bigOurs.length} bytes, theirs ${big.length}`)

// Java decoder from the handoff (the crown jewel) - compile once into a scratch dir
const scratch = process.env.SCRATCH || join(process.env.TMPDIR || '/tmp', 'pixel-agents-lz4-check')
mkdirSync(scratch, { recursive: true })
const javaSrc = join(TABSCREEN, 'android/app/src/main/java/dk/mix/tabscreen/codec/Lz4Decoder.java')
const harness = join(scratch, 'Check.java')
writeFileSync(harness, `
import java.nio.file.*;
public class Check { public static void main(String[] a) throws Exception {
  byte[] src = Files.readAllBytes(Paths.get(a[0])); int raw = Integer.parseInt(a[1]);
  byte[] dst = new byte[raw]; int n = dk.mix.tabscreen.codec.Lz4Decoder.decompress(src, 0, src.length, dst, 0, raw);
  Files.write(Paths.get(a[2]), java.util.Arrays.copyOf(dst, n)); System.out.println(n); } }`)
try {
  execFileSync('javac', ['-d', scratch, javaSrc, harness], { stdio: 'pipe' })
  for (const [name, block, expect] of [['256x160', ours, raw], ['1024x600', bigOurs, bigRaw]]) {
    const inF = join(scratch, `${name}.lz4`), outF = join(scratch, `${name}.out`)
    writeFileSync(inF, block)
    execFileSync('java', ['-cp', scratch, 'Check', inF, String(expect.length), outF], { stdio: 'pipe' })
    check(`our block decodes in Oriel's Java Lz4Decoder (${name})`, readFileSync(outF).equals(expect))
  }
} catch (e) {
  check('Java decoder check ran', false, String(e.stderr || e.message).split('\n')[0])
}

// 3. protocol bytes
const cfg = encodeConfig({ width: 1024, height: 600, maxFps: 30 })
check('CONFIG equals fixtures/protocol/config.bin', cfg.equals(readFileSync(fx('protocol/config.bin'))))
const ff = readFileSync(fx('protocol/frame-full-256x160.bin'))
const ourFf = frameFull(encodeFramePayload(theirs, raw.length, ff.readBigUInt64LE(5)))
check('FRAME_FULL framing equals fixtures/protocol/frame-full-256x160.bin', ourFf.equals(ff))

process.exit(failures ? 1 : 0)
