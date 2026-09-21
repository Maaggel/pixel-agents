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

    @Override
    public void run() {
        long backoffMs = 1000;
        while (running) {
            try {
                status("connecting...");
                session();
                backoffMs = 1000; // a session that ran counts as success
            } catch (Exception e) {
                if (!running) break;
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
        int code = conn.getResponseCode();
        if (code == 401) throw new IOException("401 - the instance key was rejected");
        if (code != 200) throw new IOException("HTTP " + code);
        InputStream in = conn.getInputStream();
        try {
            FrameReceiver receiver = new FrameReceiver(sink, new FrameReceiver.Logger() {
                @Override public void log(String line) { Log.i(TAG, line); }
            });
            // HELLO is folded into the request URL; the receiver's HELLO goes to a sink that drops it.
            receiver.run(in, new ByteArrayOutputStream());
        } finally {
            try { in.close(); } catch (IOException ignored) { }
            conn.disconnect();
            current = null;
        }
    }

    /** SSL socket factory that forces TLS 1.2 and trusts only the bundled root. */
    private Tls12SocketFactory pinnedFactory() throws Exception {
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
        return new Tls12SocketFactory(ctx.getSocketFactory());
    }

    private void status(String line) {
        if (listener != null) listener.onStatus(line);
    }
}
