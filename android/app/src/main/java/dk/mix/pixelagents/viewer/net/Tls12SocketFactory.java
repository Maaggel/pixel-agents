package dk.mix.pixelagents.viewer.net;

import java.io.IOException;
import java.net.InetAddress;
import java.net.Socket;

import javax.net.ssl.HandshakeCompletedEvent;
import javax.net.ssl.HandshakeCompletedListener;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Wraps an SSLSocketFactory so every socket it creates (a) has TLS 1.2 enabled - which on
 * API 16-19 is OFF by default even with a TLSv1.2 SSLContext - and (b) enables every cipher suite
 * the device supports, to give the handshake its best chance against a GCM/ECDSA-only server.
 * It also records the negotiated protocol and cipher of the last handshake, so the probe can
 * report exactly what was agreed.
 *
 * Lifted from Oriel's TabScreen TLS probe, which proved it on the device.
 */
public final class Tls12SocketFactory extends SSLSocketFactory {
    public volatile String lastProtocol = "(no handshake)";
    public volatile String lastCipher = "(no handshake)";

    private final SSLSocketFactory delegate;

    public Tls12SocketFactory(SSLSocketFactory delegate) {
        this.delegate = delegate;
    }

    private Socket patch(Socket socket) {
        if (socket instanceof SSLSocket) {
            final SSLSocket s = (SSLSocket) socket;
            // Enable TLS 1.2 (and 1.1) where the device supports them; keep whatever else it offers.
            java.util.List<String> want = new java.util.ArrayList<String>();
            for (String p : s.getSupportedProtocols()) {
                if (p.equals("TLSv1.2")) want.add(p); // the relay's front door has 1.0/1.1 off; do not offer them
            }
            if (!want.isEmpty()) s.setEnabledProtocols(want.toArray(new String[0]));
            // Enable every cipher suite the device can do - the point is to see if ANY matches.
            s.setEnabledCipherSuites(s.getSupportedCipherSuites());
            s.addHandshakeCompletedListener(new HandshakeCompletedListener() {
                @Override
                public void handshakeCompleted(HandshakeCompletedEvent event) {
                    lastProtocol = event.getSession().getProtocol();
                    lastCipher = event.getSession().getCipherSuite();
                }
            });
        }
        return socket;
    }

    @Override
    public String[] getDefaultCipherSuites() {
        return delegate.getDefaultCipherSuites();
    }

    @Override
    public String[] getSupportedCipherSuites() {
        return delegate.getSupportedCipherSuites();
    }

    @Override
    public Socket createSocket(Socket s, String host, int port, boolean autoClose) throws IOException {
        return patch(delegate.createSocket(s, host, port, autoClose));
    }

    @Override
    public Socket createSocket(String host, int port) throws IOException {
        return patch(delegate.createSocket(host, port));
    }

    @Override
    public Socket createSocket(String host, int port, InetAddress localHost, int localPort) throws IOException {
        return patch(delegate.createSocket(host, port, localHost, localPort));
    }

    @Override
    public Socket createSocket(InetAddress host, int port) throws IOException {
        return patch(delegate.createSocket(host, port));
    }

    @Override
    public Socket createSocket(InetAddress address, int port, InetAddress localAddress, int localPort) throws IOException {
        return patch(delegate.createSocket(address, port, localAddress, localPort));
    }
}
