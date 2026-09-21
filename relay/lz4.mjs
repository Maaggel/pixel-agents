// LZ4 *block* codec (no frame header, no size prefix) - the format the legacy tablet viewer
// decodes (TabScreen's Lz4Decoder.java). Dependency-free so the relay and the renderer can share
// it, and small enough to read. Compression is greedy hash-table matching, close to LZ4 "fast".
//
// Block format: sequences of [token][literal-length ext][literals][offset LE16][match-length ext];
// the final sequence is literals only. Matches are >= 4 bytes; the last 5 bytes are always
// literals and no match may start within the last 12 bytes (LZ4's MFLIMIT).

const MINMATCH = 4
const MFLIMIT = 12
const LASTLITERALS = 5
const MAX_DISTANCE = 0xFFFF
const HASH_BITS = 16

function hash32(v) {
  return Math.imul(v, 2654435761) >>> (32 - HASH_BITS)
}

/** Compress `src` (Uint8Array/Buffer) into a Uint8Array holding one LZ4 block (a Buffer when Buffer exists). */
export function compressBlock(src) {
  const n = src.length
  const out = typeof Buffer !== 'undefined' ? Buffer.allocUnsafe(n + Math.ceil(n / 255) + 16) : new Uint8Array(n + Math.ceil(n / 255) + 16) // worst case: incompressible
  let op = 0
  let anchor = 0
  const emit = (litEnd, matchLen, offset) => {
    const litLen = litEnd - anchor
    const tokenPos = op++
    let token = (litLen >= 15 ? 15 : litLen) << 4
    if (litLen >= 15) { let r = litLen - 15; while (r >= 255) { out[op++] = 255; r -= 255 } out[op++] = r }
    out.set(src.subarray(anchor, litEnd), op)
    op += litLen
    if (matchLen > 0) {
      out[op++] = offset & 0xFF; out[op++] = offset >>> 8
      const ml = matchLen - MINMATCH
      token |= ml >= 15 ? 15 : ml
      if (ml >= 15) { let r = ml - 15; while (r >= 255) { out[op++] = 255; r -= 255 } out[op++] = r }
    }
    out[tokenPos] = token
  }

  if (n >= MFLIMIT + 1) {
    const table = new Int32Array(1 << HASH_BITS).fill(-1)
    const mfLimit = n - MFLIMIT
    const matchLimit = n - LASTLITERALS
    let ip = 0
    while (ip < mfLimit) {
      const seq = src[ip] | (src[ip + 1] << 8) | (src[ip + 2] << 16) | (src[ip + 3] << 24)
      const h = hash32(seq)
      const ref = table[h]
      table[h] = ip
      if (ref >= 0 && ip - ref <= MAX_DISTANCE
          && src[ref] === src[ip] && src[ref + 1] === src[ip + 1] && src[ref + 2] === src[ip + 2] && src[ref + 3] === src[ip + 3]) {
        let ml = MINMATCH
        while (ip + ml < matchLimit && src[ref + ml] === src[ip + ml]) ml++
        emit(ip, ml, ip - ref)
        ip += ml
        anchor = ip
        // Prime the table with the position just before the next candidate (cheap ratio win)
        if (ip < mfLimit) {
          const p = ip - 2
          table[hash32(src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24))] = p
        }
      } else {
        ip++
      }
    }
  }
  emit(n, 0, 0) // trailing literals
  return out.subarray(0, op)
}

/** Decompress one LZ4 block into exactly `rawSize` bytes. Throws on a malformed block. */
export function decompressBlock(src, rawSize) {
  const dst = typeof Buffer !== 'undefined' ? Buffer.allocUnsafe(rawSize) : new Uint8Array(rawSize)
  let s = 0, d = 0
  const sEnd = src.length
  for (;;) {
    if (s >= sEnd) throw new Error('lz4: truncated before token')
    const token = src[s++]
    let lit = token >>> 4
    if (lit === 15) { let b; do { if (s >= sEnd) throw new Error('lz4: truncated in literal length'); b = src[s++]; lit += b } while (b === 255) }
    if (s + lit > sEnd) throw new Error('lz4: literals run past input')
    if (d + lit > rawSize) throw new Error('lz4: output too small for literals')
    for (let i = 0; i < lit; i++) dst[d++] = src[s++]
    if (s >= sEnd) break
    if (s + 2 > sEnd) throw new Error('lz4: truncated in offset')
    const offset = src[s] | (src[s + 1] << 8); s += 2
    if (offset === 0 || offset > d) throw new Error('lz4: bad match offset ' + offset)
    let ml = token & 0x0F
    if (ml === 15) { let b; do { if (s >= sEnd) throw new Error('lz4: truncated in match length'); b = src[s++]; ml += b } while (b === 255) }
    ml += MINMATCH
    if (d + ml > rawSize) throw new Error('lz4: output too small for match')
    let m = d - offset
    for (let i = 0; i < ml; i++) dst[d++] = dst[m++] // byte-wise: overlapping matches are legal
  }
  if (d !== rawSize) throw new Error(`lz4: decoded ${d} bytes, expected ${rawSize}`)
  return dst
}
