package dk.mix.pixelagents.viewer.codec;

/**
 * LZ4 block decompressor, pure Java, decompression only - which is all the client ever needs.
 * Vendored rather than depending on lz4-java so there is nothing to worry about on API 16
 * (docs/SPEC.md, Android stack). Bounds-checked: a corrupt block throws instead of scribbling.
 *
 * Block format: a sequence of [token][literal length*][literals][offset LE16][match length*],
 * where the high nibble of the token is the literal length and the low nibble the match length
 * minus 4, each extended by 255-bytes while the previous byte was 255. The last sequence has
 * literals only.
 */
public final class Lz4Decoder {
    private Lz4Decoder() {}

    /**
     * @return the number of bytes written to dst
     * @throws IllegalArgumentException if the block is malformed or does not fit
     */
    public static int decompress(byte[] src, int srcOff, int srcLen, byte[] dst, int dstOff, int dstCap) {
        final int sEnd = srcOff + srcLen;
        final int dEnd = dstOff + dstCap;
        int s = srcOff;
        int d = dstOff;

        while (true) {
            if (s >= sEnd) throw new IllegalArgumentException("lz4: truncated before token");
            int token = src[s++] & 0xFF;

            int literals = token >>> 4;
            if (literals == 15) {
                int b;
                do {
                    if (s >= sEnd) throw new IllegalArgumentException("lz4: truncated in literal length");
                    b = src[s++] & 0xFF;
                    literals += b;
                } while (b == 255);
            }
            if (s + literals > sEnd) throw new IllegalArgumentException("lz4: literals run past input");
            if (d + literals > dEnd) throw new IllegalArgumentException("lz4: output too small for literals");
            System.arraycopy(src, s, dst, d, literals);
            s += literals;
            d += literals;

            if (s >= sEnd) break;   // last sequence: literals only

            if (s + 2 > sEnd) throw new IllegalArgumentException("lz4: truncated in offset");
            int offset = (src[s] & 0xFF) | ((src[s + 1] & 0xFF) << 8);
            s += 2;
            if (offset == 0 || offset > d - dstOff) throw new IllegalArgumentException("lz4: bad match offset " + offset);

            int matchLen = token & 0x0F;
            if (matchLen == 15) {
                int b;
                do {
                    if (s >= sEnd) throw new IllegalArgumentException("lz4: truncated in match length");
                    b = src[s++] & 0xFF;
                    matchLen += b;
                } while (b == 255);
            }
            matchLen += 4;
            if (d + matchLen > dEnd) throw new IllegalArgumentException("lz4: output too small for match");

            int ref = d - offset;
            if (offset >= matchLen) {
                System.arraycopy(dst, ref, dst, d, matchLen);
            } else {
                // Overlapping match (a repeating pattern): must copy forward byte by byte.
                for (int i = 0; i < matchLen; i++) dst[d + i] = dst[ref + i];
            }
            d += matchLen;
        }
        return d - dstOff;
    }
}
