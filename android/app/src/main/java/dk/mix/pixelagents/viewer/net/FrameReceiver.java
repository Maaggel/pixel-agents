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
    /** If at least this many bytes are already waiting behind a frame, that frame is stale: skip its decode. */
    private static final int BEHIND_THRESHOLD_BYTES = 32 * 1024;
    private int skipped;

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
        if (in.available() >= BEHIND_THRESHOLD_BYTES) { skipped++; return; }

        long t0 = System.nanoTime();
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
                    if (got == 0 && (inflater.needsInput() || inflater.needsDictionary())) break;
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

        frames++;
        decodeNs += t1 - t0;
        blitNs += t2 - t1;
    }

    private void tickStats() {
        long now = System.nanoTime();
        long elapsed = now - windowStart;
        if (elapsed < 1_000_000_000L) return;
        double secs = elapsed / 1e9;
        String line;
        if (frames == 0) {
            line = "fps=0  recv=" + (long) (bytes / secs / 1024) + "KB/s";
        } else {
            line = "fps=" + Math.round(frames / secs)
                    + "  recv=" + (long) (bytes / secs / 1024) + "KB/s"
                    + "  decode=" + String.format("%.1f", decodeNs / 1e6 / frames) + "ms"
                    + "  blit=" + String.format("%.1f", blitNs / 1e6 / frames) + "ms"
                    + (skipped > 0 ? "  skip=" + skipped : "");
        }
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
