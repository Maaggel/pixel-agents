package dk.mix.pixelagents.viewer.net;

import android.content.Context;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

/**
 * The one new class the handoff asked for: dial the relay's authenticated HTTPS stream and hand
 * its body to FrameReceiver. Reconnects forever with backoff until shutdown().
 *
 * TLS on a 2012 device (docs/HANDOFF-from-TabScreen.md): TLS 1.2 must be enabled per socket
 * (Tls12SocketFactory), and the system trust store is too old for today's roots, so we trust
 * exactly one certificate - the pinned ISRG Root X2 bundled in assets - and nothing else.
 */
public final class HttpsFrameClient extends Thread {
    private static final String TAG = "PixelAgents";

    public interface Listener {
        void onStatus(String line);
    }

    private final Context context;
    private final String streamUrl;
    private final String token;
    private final FrameSink sink;
    private final Listener listener;
    private volatile boolean running = true;
    private volatile HttpURLConnection current;
    private Tls12SocketFactory factory; // built once; the pinned root does not change between reconnects
    /** A session that streamed at least this long counts as healthy: the next drop retries at once. */
    private static final long HEALTHY_SESSION_MS = 5000;

    public HttpsFrameClient(Context context, String streamUrl, String token, FrameSink sink, Listener listener) {
        super("pixelagents-stream");
        this.context = context;
        this.streamUrl = streamUrl;
        this.token = token;
        this.sink = sink;
        this.listener = listener;
        setDaemon(true);
    }

    public void shutdown() {
        running = false;
        HttpURLConnection c = current;
        if (c != null) c.disconnect();
        interrupt();
    }

    /** Thrown when the relay rejects the key: retrying cannot fix it, so the loop stops and says so. */
    private static final class KeyRejected extends IOException {
        KeyRejected() { super("401 - the instance key was rejected"); }
    }

    @Override
    public void run() {
        long backoffMs = 1000;
        while (running) {
            long started = System.currentTimeMillis();
            try {
                status("connecting...");
                session(); // only returns by exception: EOF, a dropped socket, or a refusal
            } catch (KeyRejected e) {
                status("key rejected by the relay - long-press to check the instance key");
                Log.w(TAG, "stopping: " + e.getMessage());
                return;
            } catch (Exception e) {
                if (!running) break;
                // A session that streamed for a while was healthy; a blip after an hour should not
                // inherit the backoff of an outage (Oriel's review note #1).
                if (System.currentTimeMillis() - started > HEALTHY_SESSION_MS) backoffMs = 1000;
                String msg = e.getClass().getSimpleName() + ": " + e.getMessage();
                Log.w(TAG, "stream ended: " + msg);
                status("disconnected (" + msg + ") - retry in " + (backoffMs / 1000) + "s");
            }
            if (!running) break;
            try { Thread.sleep(backoffMs); } catch (InterruptedException ignored) { }
            backoffMs = Math.min(backoffMs * 2, 30000);
        }
    }

    private void session() throws Exception {
        URL url = new URL(streamUrl);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        if (conn instanceof HttpsURLConnection) {
            ((HttpsURLConnection) conn).setSSLSocketFactory(pinnedFactory());
        }
        conn.setRequestProperty("Authorization", "Bearer " + token);
        conn.setRequestProperty("Accept", "application/octet-stream");
        conn.setUseCaches(false);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(45000); // the relay resends a keyframe every 15 s, so silence this long means dead
        current = conn;
        FrameReceiver receiver = null;
        InputStream in = null;
        try {
            int code = conn.getResponseCode();
            if (code == 401) { drain(conn.getErrorStream()); throw new KeyRejected(); }
            if (code != 200) { drain(conn.getErrorStream()); throw new IOException("HTTP " + code); }
            String serving = conn.getHeaderField("X-Pixel-Agents-Version");
            in = conn.getInputStream();
            receiver = new FrameReceiver(sink, new FrameReceiver.Logger() {
                @Override public void log(String line) { Log.i(TAG, line); }
            });
            // The relay tells us which build it is serving; show that rather than our own version,
            // which is only what this apk was built from and says nothing about what is live.
            if (serving != null && serving.length() > 0) receiver.setPrefix("v" + serving + "  ");
            // HELLO is folded into the request URL; the receiver's HELLO goes to a sink that drops it.
            receiver.run(in, new ByteArrayOutputStream());
        } finally {
            if (receiver != null) receiver.close();
            if (in != null) try { in.close(); } catch (IOException ignored) { }
            conn.disconnect();
            current = null;
        }
    }

    private static void drain(InputStream err) {
        if (err == null) return;
        try { byte[] b = new byte[1024]; while (err.read(b) > 0) { } err.close(); } catch (IOException ignored) { }
    }

    /** SSL socket factory that forces TLS 1.2 and trusts only the bundled root. Built once. */
    private Tls12SocketFactory pinnedFactory() throws Exception {
        if (factory != null) return factory;
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        InputStream pem = context.getAssets().open("isrg-root-x2.pem");
        Certificate root;
        try { root = cf.generateCertificate(pem); } finally { pem.close(); }
        KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
        ks.load(null, null);
        ks.setCertificateEntry("pinned-root", root);
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(ks);
        SSLContext ctx = SSLContext.getInstance("TLSv1.2");
        ctx.init(null, tmf.getTrustManagers(), null);
        factory = new Tls12SocketFactory(ctx.getSocketFactory());
        return factory;
    }

    private void status(String line) {
        if (listener != null) listener.onStatus(line);
    }
}
