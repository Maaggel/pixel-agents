package dk.mix.pixelagents.viewer;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.wifi.WifiManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.SystemClock;
import android.text.InputType;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import dk.mix.pixelagents.viewer.net.HttpsFrameClient;

/**
 * Pixel Agents legacy viewer: shows the office on hardware too old for the web page (Galaxy Tab 2,
 * Android 4.1). Fullscreen landscape, keep-screen-on, one status line. Frames come from the relay's
 * authenticated HTTPS stream (docs/HANDOFF-from-TabScreen.md); everything below the surface is
 * Oriel's proven client stack.
 *
 * Settings live in SharedPreferences: first launch asks for the instance key. Long-press the screen
 * for a menu: keep Wi-Fi awake, the connection overlay, auto-hiding the info text, connection settings (the key, the relay URL, the compression -
 * deflate is ~3x smaller than lz4 - and the fps cap), reconnect now.
 */
public class MainActivity extends Activity {
    private static final String TAG = "PixelAgents";
    private static final String PREFS = "viewer";
    private static final String DEFAULT_BASE = "https://apps.blommemix.dk/pixelagents";
    /** Preset instance key (Mix's call - this is a sideloaded personal app; rotate it here and in the relay together). */
    private static final String DEFAULT_TOKEN = "Z*4jf79Ue#@Z7*dM&2Yf";
    private static final int DEFAULT_FPS = 15;
    private static final int MAX_FPS = 30;
    /**
     * No frame on screen for this long means the stream is stuck: the relay sends at least one
     * every 15 s. The watchdog then does what closing and reopening the app did by hand.
     */
    private static final long STALL_MS = 30000;
    private static final long WATCHDOG_EVERY_MS = 1000;
    /** No new picture for this long darkens the screen and says so. Frames come every 2 s even when nothing moves. */
    /** With auto-hide on, the info text stays this long after the app opens or the screen is tapped */
    private static final long STATUS_SHOW_MS = 30000;
    private static final long OVERLAY_AFTER_MS = 6000;

    private DisplaySurfaceView display;
    private TextView statusView;
    private View overlay;
    private TextView overlayDetail;
    /** The client's own latest line (connecting, disconnected - retry in...), not the fps counters */
    private volatile String connLine = "";
    /** When the stream last stopped being live (uptime ms): the overlay shows until a picture newer than this */
    private volatile long notStreamingSince;
    /** When the info text was last asked for (uptime ms): app start or a tap on the screen */
    private long statusShownAt;
    private final Runnable refreshOverlay = new Runnable() {
        @Override public void run() { updateOverlay(); updateStatusVisibility(); }
    };
    private HttpsFrameClient client;
    private SharedPreferences prefs;
    /**
     * Holds the Wi-Fi radio out of power save while the office is on screen. Dozing between packets
     * held the stream's data back at the router for a minute or two at a time, which froze the
     * picture until it caught up. Costs a fraction of what the screen does; released in onStop.
     */
    private WifiManager.WifiLock wifiLock;
    private final Handler handler = new Handler();
    /** When the current client started (uptime ms), so a fresh one gets STALL_MS to show a frame */
    private long clientStartedAt;
    /** Stalls recovered since the app started, and where the stuck thread was: shown on the status line */
    private int stalls;
    private String lastStallAt = "";
    private final Runnable watchdog = new Runnable() {
        @Override public void run() {
            checkStall();
            updateOverlay();
            updateStatusVisibility();
            handler.postDelayed(this, WATCHDOG_EVERY_MS);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LOW_PROFILE);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        display = new DisplaySurfaceView(this);
        root.addView(display, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        // Connection overlay: dims the frozen picture and says what is happening. Added before the
        // status line so that stays readable on top; it takes no touches, so long-press still works
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        box.setBackgroundColor(0xFF1E1E2E);
        box.setPadding(48, 28, 48, 28);
        TextView title = new TextView(this);
        title.setText("Connecting...");
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
        box.addView(title);
        overlayDetail = new TextView(this);
        overlayDetail.setTextColor(0xFFB0B0C8);
        overlayDetail.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        overlayDetail.setGravity(Gravity.CENTER_HORIZONTAL);
        overlayDetail.setPadding(0, 12, 0, 0);
        box.addView(overlayDetail);
        FrameLayout dim = new FrameLayout(this);
        dim.setBackgroundColor(0xB0000000);
        FrameLayout.LayoutParams boxLp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        boxLp.gravity = Gravity.CENTER;
        dim.addView(box, boxLp);
        dim.setVisibility(View.GONE);
        overlay = dim;
        root.addView(overlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        statusView = new TextView(this);
        statusView.setTextColor(Color.WHITE);
        statusView.setBackgroundColor(0x80000000);
        statusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        statusView.setPadding(8, 4, 8, 4);
        statusView.setText("Pixel Agents " + versionName());
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.TOP | Gravity.LEFT;
        root.addView(statusView, lp);
        setContentView(root);

        display.setStatusListener(new DisplaySurfaceView.StatusListener() {
            @Override public void onStatus(final String line) { setStatus(line); }
        });
        // Tap the status line to hide/show it; long-press anywhere for settings.
        statusView.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { statusView.setAlpha(statusView.getAlpha() < 1f ? 1f : 0.15f); }
        });
        // A tap anywhere brings the info text back for STATUS_SHOW_MS when auto-hide is on
        root.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { statusShownAt = SystemClock.uptimeMillis(); updateStatusVisibility(); }
        });
        root.setOnLongClickListener(new View.OnLongClickListener() {
            @Override public boolean onLongClick(View v) { showMenu(); return true; }
        });
        WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        if (wifi != null) {
            wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "pixelagents-stream");
            wifiLock.setReferenceCounted(false);
        }
        Log.i(TAG, "Pixel Agents viewer " + versionName() + " on " + android.os.Build.MODEL
                + " android " + android.os.Build.VERSION.RELEASE + " (api " + android.os.Build.VERSION.SDK_INT + ")");
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (prefs.getString("token", DEFAULT_TOKEN).length() == 0) showSettings();
        else startClient();
        applyWifiLock();
        statusShownAt = SystemClock.uptimeMillis();
        updateStatusVisibility();
        handler.postDelayed(watchdog, WATCHDOG_EVERY_MS);
    }

    @Override
    protected void onStop() {
        handler.removeCallbacks(watchdog);
        stopClient();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onStop();
    }

    private boolean showOverlay() {
        return prefs.getBoolean("connOverlay", true);
    }

    /**
     * Show the overlay from the moment a connection starts or drops until the next picture arrives, and
     * whenever the picture has been still for OVERLAY_AFTER_MS mid-stream. Runs on the UI thread
     * every second, and at once when a connection starts.
     */
    private void updateOverlay() {
        long now = SystemClock.uptimeMillis();
        long lastFrame = display.lastFrameAt();
        long since = Math.max(clientStartedAt, notStreamingSince);
        boolean connecting = lastFrame < since;
        long quiet = now - Math.max(since, lastFrame);
        boolean show = showOverlay() && client != null && (connecting || quiet >= OVERLAY_AFTER_MS);
        if (show) {
            String detail;
            if (connecting && lastFrame > 0) detail = "No new picture for " + ((now - lastFrame) / 1000) + " s";
            else if (connecting) detail = "Waiting for the first picture";
            else detail = "No new picture for " + (quiet / 1000) + " s";
            String c = connLine;
            if (c != null && c.length() > 0 && !c.startsWith("connecting")) detail += "\n" + c;
            if (stalls > 0) detail += "\nRestarted " + stalls + (stalls == 1 ? " time" : " times") + " since the app opened";
            overlayDetail.setText(detail);
        }
        overlay.setVisibility(show ? View.VISIBLE : View.GONE);
    }

    private boolean autoHideStatus() {
        return prefs.getBoolean("statusAutoHide", true);
    }

    /** The info text shows unless auto-hide is on and it has had its STATUS_SHOW_MS - but always while the overlay is up */
    private void updateStatusVisibility() {
        boolean show = !autoHideStatus()
                || overlay.getVisibility() == View.VISIBLE
                || SystemClock.uptimeMillis() - statusShownAt < STATUS_SHOW_MS;
        statusView.setVisibility(show ? View.VISIBLE : View.GONE);
    }

    private boolean keepWifiAwake() {
        return prefs.getBoolean("wifiAwake", true);
    }

    private void applyWifiLock() {
        if (wifiLock == null) return;
        if (keepWifiAwake()) { if (!wifiLock.isHeld()) wifiLock.acquire(); }
        else if (wifiLock.isHeld()) wifiLock.release();
    }

    /** The long-press menu. Connection settings are a level down: they are rarely what you want. */
    private void showMenu() {
        final String[] items = {
                "Keep Wi-Fi awake: " + (keepWifiAwake() ? "ON" : "OFF"),
                "Connection overlay: " + (showOverlay() ? "ON" : "OFF"),
                "Auto-hide info text after 30 s: " + (autoHideStatus() ? "ON" : "OFF"),
                "Connection settings...",
                "Reconnect now",
        };
        new AlertDialog.Builder(this)
                .setTitle("Pixel Agents viewer " + versionName())
                .setItems(items, new DialogInterface.OnClickListener() {
                    @Override public void onClick(DialogInterface d, int which) {
                        if (which == 0) {
                            boolean on = !keepWifiAwake();
                            prefs.edit().putBoolean("wifiAwake", on).apply();
                            applyWifiLock();
                            Toast.makeText(MainActivity.this, on
                                    ? "Wi-Fi kept awake while the office is on screen"
                                    : "Wi-Fi may power save (the stream can pause)", Toast.LENGTH_SHORT).show();
                        } else if (which == 1) {
                            prefs.edit().putBoolean("connOverlay", !showOverlay()).apply();
                            updateOverlay();
                        } else if (which == 2) {
                            prefs.edit().putBoolean("statusAutoHide", !autoHideStatus()).apply();
                            statusShownAt = SystemClock.uptimeMillis();
                            updateStatusVisibility();
                        } else if (which == 3) {
                            showSettings();
                        } else if (which == 4) {
                            startClient();
                        }
                    }
                })
                .setNegativeButton("Close", null)
                .show();
    }

    /**
     * Restart the stream if nothing has reached the screen for STALL_MS. Before it goes, note the
     * innermost frame of our own code the stream thread was in - a stall that heals itself leaves
     * no other trace of why it happened.
     */
    private void checkStall() {
        HttpsFrameClient c = client;
        if (c == null) return;
        long now = SystemClock.uptimeMillis();
        long since = Math.max(clientStartedAt, display.lastFrameAt());
        if (now - since < STALL_MS) return;
        String where = "?";
        for (StackTraceElement e : c.getStackTrace()) {
            if (e.getClassName().startsWith("dk.mix.")) {
                String cls = e.getClassName();
                where = cls.substring(cls.lastIndexOf('.') + 1) + "." + e.getMethodName() + ":" + e.getLineNumber();
                break;
            }
        }
        StringBuilder trace = new StringBuilder();
        for (StackTraceElement e : c.getStackTrace()) trace.append("\n    at ").append(e);
        Log.w(TAG, "stream stalled " + ((now - since) / 1000) + "s (thread " + c.getState() + ") - restarting" + trace);
        stalls++;
        lastStallAt = where;
        startClient();
    }

    private void startClient() {
        stopClient();
        connLine = "";
        String base = prefs.getString("base", DEFAULT_BASE);
        String comp = prefs.getString("comp", "deflate");
        int fps = prefs.getInt("fps", DEFAULT_FPS);
        String url = base + "/stream?w=1024&h=600&comp=" + comp + "&fps=" + fps;
        client = new HttpsFrameClient(this, url, prefs.getString("token", DEFAULT_TOKEN), display, new HttpsFrameClient.Listener() {
            @Override public void onStatus(String line) { connLine = line; setStatus(line); }
            @Override public void onNotStreaming() {
                notStreamingSince = SystemClock.uptimeMillis();
                handler.post(refreshOverlay);
            }
        });
        clientStartedAt = SystemClock.uptimeMillis();
        client.start();
        updateOverlay();
    }

    private void stopClient() {
        if (client != null) { client.shutdown(); client = null; }
    }

    private void setStatus(final String line) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                statusView.setText(stalls == 0 ? line : line + "  stalls=" + stalls + " (" + lastStallAt + ")");
            }
        });
    }

    private void showSettings() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(24, 16, 24, 0);
        final EditText base = field(box, "Relay URL", prefs.getString("base", DEFAULT_BASE), InputType.TYPE_TEXT_VARIATION_URI);
        final EditText token = field(box, "Instance key", prefs.getString("token", DEFAULT_TOKEN), InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD); // cleartext, no autocorrect
        final EditText comp = field(box, "Compression: deflate or lz4", prefs.getString("comp", "deflate"), InputType.TYPE_CLASS_TEXT);
        final EditText fps = field(box, "Max fps (1-" + MAX_FPS + ")", String.valueOf(prefs.getInt("fps", DEFAULT_FPS)), InputType.TYPE_CLASS_NUMBER);
        new AlertDialog.Builder(this)
                .setTitle("Connection settings")
                .setView(box)
                .setPositiveButton("Connect", new DialogInterface.OnClickListener() {
                    @Override public void onClick(DialogInterface d, int w) {
                        int f;
                        try { f = Math.max(1, Math.min(MAX_FPS, Integer.parseInt(fps.getText().toString().trim()))); } catch (NumberFormatException e) { f = DEFAULT_FPS; }
                        String c = comp.getText().toString().trim().toLowerCase();
                        prefs.edit()
                                .putString("base", base.getText().toString().trim().replaceAll("/+$", ""))
                                .putString("token", token.getText().toString().trim())
                                .putString("comp", c.equals("lz4") ? "lz4" : "deflate")
                                .putInt("fps", f)
                                .apply();
                        startClient();
                    }
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    private EditText field(LinearLayout box, String hint, String value, int inputType) {
        TextView label = new TextView(this);
        label.setText(hint);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        box.addView(label);
        EditText e = new EditText(this);
        e.setSingleLine(true);
        e.setInputType(InputType.TYPE_CLASS_TEXT | inputType);
        e.setText(value);
        box.addView(e);
        return e;
    }

    private String versionName() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
        catch (Exception e) { return "?"; }
    }
}
