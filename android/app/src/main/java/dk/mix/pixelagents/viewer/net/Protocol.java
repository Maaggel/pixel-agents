package dk.mix.pixelagents.viewer.net;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;

/**
 * The wire protocol as docs/SPEC.md defines it, mirroring Protocol.cs on the host: little-endian,
 * uint8 type + uint32 payload length, then the payload. Pure Java, no Android imports, so it is
 * tested on the JVM against the same fixture bytes as the host.
 */
public final class Protocol {
    private Protocol() {}

    public static final int VERSION = 1;
    public static final int HEADER_SIZE = 5;

    public static final int HELLO = 0x01;
    public static final int CONFIG = 0x02;
    public static final int FRAME_FULL = 0x10;
    public static final int FRAME_DIRTY = 0x11;
    public static final int TOUCH = 0x20;
    public static final int PING = 0x30;
    public static final int PONG = 0x31;

    public static final int PIXEL_FORMAT_RGB565 = 0x01;
    public static final int COMPRESSION_NONE = 0x00;
    public static final int COMPRESSION_LZ4_BLOCK = 0x01;
    /** Pixel Agents extension: raw deflate (Inflater(true)); opt-in via /stream?comp=deflate */
    public static final int COMPRESSION_DEFLATE_RAW = 0x02;

    public static final int FLAG_CAN_TOUCH = 0x01;

    public static final int HELLO_PAYLOAD_SIZE = 8;
    public static final int CONFIG_PAYLOAD_SIZE = 7;
    public static final int FRAME_FULL_HEADER_SIZE = 12;

    /** Sanity cap on a payload, so a garbage header cannot make us allocate gigabytes. */
    public static final int MAX_PAYLOAD = 16 * 1024 * 1024;

    /** A received message. The payload array is reused between reads; only [0, length) is valid. */
    public static final class Message {
        public int type;
        public int length;
        public byte[] payload = new byte[64 * 1024];
    }

    public static final class Config {
        public int width, height, pixelFormat, maxFps, compression;
    }

    public static byte[] encodeHello(int screenWidth, int screenHeight, int pixelFormats, int flags) {
        byte[] b = new byte[HEADER_SIZE + HELLO_PAYLOAD_SIZE];
        writeHeader(b, HELLO, HELLO_PAYLOAD_SIZE);
        putU16(b, HEADER_SIZE, VERSION);
        putU16(b, HEADER_SIZE + 2, screenWidth);
        putU16(b, HEADER_SIZE + 4, screenHeight);
        b[HEADER_SIZE + 6] = (byte) pixelFormats;
        b[HEADER_SIZE + 7] = (byte) flags;
        return b;
    }

    public static byte[] encodeConfig(int width, int height, int pixelFormat, int maxFps, int compression) {
        byte[] b = new byte[HEADER_SIZE + CONFIG_PAYLOAD_SIZE];
        writeHeader(b, CONFIG, CONFIG_PAYLOAD_SIZE);
        putU16(b, HEADER_SIZE, width);
        putU16(b, HEADER_SIZE + 2, height);
        b[HEADER_SIZE + 4] = (byte) pixelFormat;
        b[HEADER_SIZE + 5] = (byte) maxFps;
        b[HEADER_SIZE + 6] = (byte) compression;
        return b;
    }

    public static void writeHello(OutputStream out, int screenWidth, int screenHeight, int pixelFormats, int flags) throws IOException {
        out.write(encodeHello(screenWidth, screenHeight, pixelFormats, flags));
        out.flush();
    }

    /** Reads exactly one message. Always readFully - a socket read hands you whatever it likes. */
    public static void readMessage(DataInputStream in, Message m) throws IOException {
        byte[] h = new byte[HEADER_SIZE];
        in.readFully(h);
        m.type = h[0] & 0xFF;
        long len = getU32(h, 1);
        if (len > MAX_PAYLOAD) throw new IOException("payload length " + len + " is absurd - out of sync?");
        m.length = (int) len;
        if (m.payload.length < m.length) m.payload = new byte[Math.max(m.length, m.payload.length * 2)];
        in.readFully(m.payload, 0, m.length);
    }

    public static Config parseConfig(byte[] p, int off, int len) throws IOException {
        if (len != CONFIG_PAYLOAD_SIZE) throw new IOException("CONFIG payload is " + len + " bytes, expected " + CONFIG_PAYLOAD_SIZE);
        Config c = new Config();
        c.width = getU16(p, off);
        c.height = getU16(p, off + 2);
        c.pixelFormat = p[off + 4] & 0xFF;
        c.maxFps = p[off + 5] & 0xFF;
        c.compression = p[off + 6] & 0xFF;
        return c;
    }

    public static long frameTimestampUs(byte[] p, int off) {
        return getU64(p, off);
    }

    public static int frameRawSize(byte[] p, int off) {
        long v = getU32(p, off + 8);
        if (v > Integer.MAX_VALUE) throw new IllegalArgumentException("rawSize out of range");
        return (int) v;
    }

    public static void writeHeader(byte[] b, int type, int payloadLength) {
        b[0] = (byte) type;
        putU32(b, 1, payloadLength);
    }

    static void putU16(byte[] b, int off, int v) {
        b[off] = (byte) v;
        b[off + 1] = (byte) (v >>> 8);
    }

    static void putU32(byte[] b, int off, long v) {
        b[off] = (byte) v;
        b[off + 1] = (byte) (v >>> 8);
        b[off + 2] = (byte) (v >>> 16);
        b[off + 3] = (byte) (v >>> 24);
    }

    static int getU16(byte[] b, int off) {
        return (b[off] & 0xFF) | ((b[off + 1] & 0xFF) << 8);
    }

    static long getU32(byte[] b, int off) {
        return (b[off] & 0xFFL) | ((b[off + 1] & 0xFFL) << 8) | ((b[off + 2] & 0xFFL) << 16) | ((b[off + 3] & 0xFFL) << 24);
    }

    static long getU64(byte[] b, int off) {
        return getU32(b, off) | (getU32(b, off + 4) << 32);
    }
}
