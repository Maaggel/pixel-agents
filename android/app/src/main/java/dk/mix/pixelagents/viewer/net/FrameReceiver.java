package dk.mix.pixelagents.viewer.net;

import dk.mix.pixelagents.viewer.codec.Lz4Decoder;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;

/**
 * One connection's worth of protocol: send HELLO, take CONFIG, then decode frames into the sink
 * until the stream ends. Pure Java so the JVM fake tablet and the device share it exactly.
 * Decoding and presenting happen on the calling (socket) thread - never post per frame to the
 * UI thread (docs/SPEC.md, threading model).
 */
public final class FrameReceiver {
    public interface Logger {
        void log(String line);
    }

    private final FrameSink sink;
    private final Logger log;
    private final Protocol.Message msg = new Protocol.Message();
    private byte[] raw = new byte[0];
    private int rawSize;
    private int compression = Protocol.COMPRESSION_LZ4_BLOCK;
    private Inflater inflater;
    private DataInputStream in;
    /**
     * A frame is stale when a whole newer one is already waiting behind it. The yardstick is the
     * size of the frame in hand, because that is what a frame currently costs: a fixed 32 KB was
     * set when frames were bigger, and at the ~24 KB they are now one queued frame sat under it
     * and got decoded anyway - which is a fast-forward on screen and an fps count above the cap.
     */
    private static final int MIN_BEHIND_BYTES = 6 * 1024;
    /**
     * Skipping never goes on longer than this. On a link slower than the stream there is always a
     * newer frame waiting, so "skip while behind" skipped every frame for ever: the screen froze
     * on 0 fps with the data still flowing. This way it shows what the link can carry.
     */
    private static final long MAX_SKIP_NS = 250_000_000L;
    private long lastPresentNs;
    private int skipped;
    /**
     * Frames at least this big say something about the link: the time one takes to arrive once it
     * has started is the Wi-Fi's speed, whether the office is busy or still
     */
    private static final int LINK_SAMPLE_MIN_BYTES = 8 * 1024;
    /** Smoothing of the link estimate: each sample moves it this far */
    private static final double LINK_SMOOTHING = 0.2;
    /**
     * A frame that was already waiting in full reads in no time and measures nothing but memory;
     * capped, it counts as "fast" without swamping the average
     */
    private static final double LINK_SAMPLE_MAX_KBPS = 2000;
    private volatile double linkKBps = -1;
    private volatile long linkSampleAt;

    /** The link's speed in KB/s, smoothed; -1 until a frame has been big enough to measure */
    public double linkKBps() { return linkKBps; }
    /** When the link was last measured (System.nanoTime), so a stale estimate can be ignored */
    public long linkSampleAt() { return linkSampleAt; }
    /** Shown before the counters: the build the relay says it is serving. */
    private String prefix = "";

    public void setPrefix(String p) { prefix = p == null ? "" : p; }

    // Per-second counters, mirrored to the status overlay and the log.
    private long windowStart;
    private int frames;
    private long bytes;
    private long decodeNs, blitNs;
    private String lastStatus = "";

    public FrameReceiver(FrameSink sink, Logger log) {
        this.sink = sink;
        this.log = log;
    }

    public String lastStatus() {
        return lastStatus;
    }

    /** Release native zlib state. Call when the session is over; the receiver is not reusable after this. */
    public void close() {
        if (inflater != null) { inflater.end(); inflater = null; }
    }

    /** Runs the session on the current thread; returns when the host goes away. */
    public void run(InputStream rawIn, OutputStream out) throws IOException {
        in = new DataInputStream(rawIn);
        Protocol.writeHello(out, sink.screenWidth(), sink.screenHeight(), Protocol.PIXEL_FORMAT_RGB565, 0);
        log.log("HELLO sent (" + sink.screenWidth() + "x" + sink.screenHeight() + "), waiting for CONFIG");

        Protocol.readMessage(in, msg);
        if (msg.type != Protocol.CONFIG) throw new IOException("expected CONFIG first, got type 0x" + Integer.toHexString(msg.type));
        applyConfig();

        windowStart = System.nanoTime();
        while (true) {
            Protocol.readMessage(in, msg);
            bytes += Protocol.HEADER_SIZE + msg.length;
            if (msg.length >= LINK_SAMPLE_MIN_BYTES && msg.payloadNs > 0) {
                double kbps = Math.min(LINK_SAMPLE_MAX_KBPS, msg.length / 1024.0 / (msg.payloadNs / 1e9));
                linkKBps = linkKBps < 0 ? kbps : linkKBps + LINK_SMOOTHING * (kbps - linkKBps);
                linkSampleAt = System.nanoTime();
            }
            switch (msg.type) {
                case Protocol.FRAME_FULL:
                    handleFrameFull();
                    break;
                case Protocol.CONFIG:
                    applyConfig();
                    break;
                default:
                    log.log("ignoring unknown message type 0x" + Integer.toHexString(msg.type) + " (" + msg.length + " bytes)");
            }
            tickStats();
        }
    }

    private void applyConfig() throws IOException {
        Protocol.Config c = Protocol.parseConfig(msg.payload, 0, msg.length);
        if (c.pixelFormat != Protocol.PIXEL_FORMAT_RGB565) throw new IOException("unsupported pixel format " + c.pixelFormat);
        if (c.compression != Protocol.COMPRESSION_LZ4_BLOCK && c.compression != Protocol.COMPRESSION_NONE && c.compression != Protocol.COMPRESSION_DEFLATE_RAW) throw new IOException("unsupported compression " + c.compression);
        compression = c.compression;
        if (compression == Protocol.COMPRESSION_DEFLATE_RAW && inflater == null) inflater = new Inflater(true);
        rawSize = c.width * c.height * 2;
        if (raw.length < rawSize) raw = new byte[rawSize];
        sink.configure(c.width, c.height);
        log.log("CONFIG: " + c.width + "x" + c.height + " fmt " + c.pixelFormat + " maxFps " + c.maxFps + " compression " + c.compression);
    }

    private void handleFrameFull() throws IOException {
        if (msg.length < Protocol.FRAME_FULL_HEADER_SIZE) throw new IOException("FRAME_FULL too short");
        int declared = Protocol.frameRawSize(msg.payload, 0);
        if (declared != rawSize) throw new IOException("FRAME_FULL rawSize " + declared + " but CONFIG implies " + rawSize);

        // Behind the stream (a link that stalled and recovered): present only the newest frame rather
        // than replaying the backlog in fast-forward. A skipped frame costs nothing - the next one
        // carries the whole picture.
        long t0 = System.nanoTime();
        if (t0 - lastPresentNs < MAX_SKIP_NS && in.available() >= Math.max(MIN_BEHIND_BYTES, msg.length)) { skipped++; return; }

        int blockOff = Protocol.FRAME_FULL_HEADER_SIZE;
        int blockLen = msg.length - blockOff;
        int n;
        try {
            if (compression == Protocol.COMPRESSION_DEFLATE_RAW) {
                inflater.reset();
                inflater.setInput(msg.payload, blockOff, blockLen);
                n = 0;
                while (n < rawSize && !inflater.finished()) {
                    int got = inflater.inflate(raw, n, rawSize - n);
                    // No progress is the end of this frame whatever the reason: waiting on a
                    // flag that never comes spins the stream thread for ever
                    if (got == 0) break;
                    n += got;
                }
            } else if (compression == Protocol.COMPRESSION_NONE) {
                n = Math.min(blockLen, rawSize);
                System.arraycopy(msg.payload, blockOff, raw, 0, n);
            } else {
                n = Lz4Decoder.decompress(msg.payload, blockOff, blockLen, raw, 0, rawSize);
            }
        } catch (IllegalArgumentException e) {
            throw new IOException("corrupt frame: " + e.getMessage());
        } catch (DataFormatException e) {
            throw new IOException("corrupt deflate frame: " + e.getMessage());
        }
        if (n != rawSize) throw new IOException("decoded " + n + " bytes, expected " + rawSize);
        long t1 = System.nanoTime();
        sink.presentFull(raw, rawSize);
        long t2 = System.nanoTime();
        lastPresentNs = t2;

        frames++;
        decodeNs += t1 - t0;
        blitNs += t2 - t1;
    }

    private String linkText() {
        return linkKBps < 0 ? "" : "  link=" + Math.round(linkKBps) + "KB/s";
    }

    private void tickStats() {
        long now = System.nanoTime();
        long elapsed = now - windowStart;
        if (elapsed < 1_000_000_000L) return;
        double secs = elapsed / 1e9;
        String line;
        if (frames == 0) {
            line = "fps=0  recv=" + (long) (bytes / secs / 1024) + "KB/s" + linkText() + (skipped > 0 ? "  skip=" + skipped : "");
        } else {
            line = "fps=" + Math.round(frames / secs)
                    + "  recv=" + (long) (bytes / secs / 1024) + "KB/s" + linkText()
                    + "  decode=" + String.format("%.1f", decodeNs / 1e6 / frames) + "ms"
                    + "  blit=" + String.format("%.1f", blitNs / 1e6 / frames) + "ms"
                    + (skipped > 0 ? "  skip=" + skipped : "");
        }
        line = prefix + line;
        lastStatus = line;
        log.log(line);
        sink.status(line);
        windowStart = now;
        frames = 0;
        bytes = 0;
        decodeNs = 0;
        blitNs = 0;
        skipped = 0;
    }
}
