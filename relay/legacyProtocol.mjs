// Wire protocol for the legacy tablet viewer (TabScreen handoff, docs/HANDOFF-from-TabScreen.md).
// Binary, little-endian, length-prefixed: [type u8][payloadLen u32][payload].

export const PROTOCOL_VERSION = 1
export const MSG_HELLO = 0x01
export const MSG_CONFIG = 0x02
export const MSG_FRAME_FULL = 0x10
export const PIXEL_RGB565 = 0x01
export const COMPRESSION_LZ4_BLOCK = 0x01
export const FRAME_FULL_HEADER_SIZE = 12

function framed(type, payload) {
  const out = Buffer.allocUnsafe(5 + payload.length)
  out[0] = type
  out.writeUInt32LE(payload.length, 1)
  payload.copy(out, 5)
  return out
}

/** CONFIG message: what the stream will carry. */
export function encodeConfig({ width, height, maxFps }) {
  const p = Buffer.allocUnsafe(7)
  p.writeUInt16LE(width, 0)
  p.writeUInt16LE(height, 2)
  p[4] = PIXEL_RGB565
  p[5] = maxFps
  p[6] = COMPRESSION_LZ4_BLOCK
  return framed(MSG_CONFIG, p)
}

/** FRAME_FULL payload (unframed): timestamp, raw size, LZ4 block. This is what the renderer sends the relay. */
export function encodeFramePayload(lz4Block, rawSize, timestampUs) {
  const p = Buffer.allocUnsafe(FRAME_FULL_HEADER_SIZE + lz4Block.length)
  p.writeBigUInt64LE(typeof timestampUs === 'bigint' ? timestampUs : BigInt(Math.floor(timestampUs)), 0)
  p.writeUInt32LE(rawSize, 8)
  lz4Block.copy(p, FRAME_FULL_HEADER_SIZE)
  return p
}

/** Frame a FRAME_FULL payload for the wire. */
export function frameFull(payload) {
  return framed(MSG_FRAME_FULL, payload)
}

/** Parse a HELLO payload (8 bytes). */
export function decodeHello(payload) {
  if (payload.length < 8) throw new Error('HELLO too short')
  return {
    protocolVersion: payload.readUInt16LE(0),
    screenWidth: payload.readUInt16LE(2),
    screenHeight: payload.readUInt16LE(4),
    pixelFormats: payload[6],
    flags: payload[7],
  }
}

/** Convert RGBA8 (row-major, no padding) to tightly packed RGB565 little-endian. */
export function rgbaToRgb565(rgba, width, height) {
  const out = Buffer.allocUnsafe(width * height * 2)
  for (let i = 0, o = 0; o < out.length; i += 4, o += 2) {
    const v = ((rgba[i] >> 3) << 11) | ((rgba[i + 1] >> 2) << 5) | (rgba[i + 2] >> 3)
    out[o] = v & 0xFF
    out[o + 1] = v >> 8
  }
  return out
}
