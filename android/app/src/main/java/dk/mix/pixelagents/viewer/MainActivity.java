package dk.mix.pixelagents.viewer;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.SharedPreferences;
import android.graphics.Color;
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

import dk.mix.pixelagents.viewer.net.HttpsFrameClient;

/**
 * Pixel Agents legacy viewer: shows the office on hardware too old for the web page (Galaxy Tab 2,
 * Android 4.1). Fullscreen landscape, keep-screen-on, one status line. Frames come from the relay's
 * authenticated HTTPS stream (docs/HANDOFF-from-TabScreen.md); everything below the surface is
 * Oriel's proven client stack.
 *
 * Settings live in SharedPreferences: first launch asks for the instance key; long-press the screen
 * to change the key, the relay URL, the compression (deflate is ~3x smaller than lz4) or the fps cap.
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
    private static final long WATCHDOG_EVERY_MS = 5000;

    private DisplaySurfaceView display;
    private TextView statusView;
    private HttpsFrameClient client;
    private SharedPreferences prefs;
    private final Handler handler = new Handler();
    /** When the current client started (uptime ms), so a fresh one gets STALL_MS to show a frame */
    private long clientStartedAt;
    /** Stalls recovered since the app started, and where the stuck thread was: shown on the status line */
    private int stalls;
    private String lastStallAt = "";
    private final Runnable watchdog = new Runnable() {
        @Override public void run() {
            checkStall();
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
        root.setOnLongClickListener(new View.OnLongClickListener() {
            @Override public boolean onLongClick(View v) { showSettings(); return true; }
        });
        Log.i(TAG, "Pixel Agents viewer " + versionName() + " on " + android.os.Build.MODEL
                + " android " + android.os.Build.VERSION.RELEASE + " (api " + android.os.Build.VERSION.SDK_INT + ")");
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (prefs.getString("token", DEFAULT_TOKEN).length() == 0) showSettings();
        else startClient();
        handler.postDelayed(watchdog, WATCHDOG_EVERY_MS);
    }

    @Override
    protected void onStop() {
        handler.removeCallbacks(watchdog);
        stopClient();
        super.onStop();
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
        String base = prefs.getString("base", DEFAULT_BASE);
        String comp = prefs.getString("comp", "deflate");
        int fps = prefs.getInt("fps", DEFAULT_FPS);
        String url = base + "/stream?w=1024&h=600&comp=" + comp + "&fps=" + fps;
        client = new HttpsFrameClient(this, url, prefs.getString("token", DEFAULT_TOKEN), display, new HttpsFrameClient.Listener() {
            @Override public void onStatus(String line) { setStatus(line); }
        });
        clientStartedAt = SystemClock.uptimeMillis();
        client.start();
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
                .setTitle("Pixel Agents viewer")
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
