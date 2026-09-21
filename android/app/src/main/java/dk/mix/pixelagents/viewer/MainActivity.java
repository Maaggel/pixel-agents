package dk.mix.pixelagents.viewer;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
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

    private DisplaySurfaceView display;
    private TextView statusView;
    private HttpsFrameClient client;
    private SharedPreferences prefs;

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
        if (prefs.getString("token", "").length() == 0) showSettings();
        else startClient();
    }

    @Override
    protected void onStop() {
        stopClient();
        super.onStop();
    }

    private void startClient() {
        stopClient();
        String base = prefs.getString("base", DEFAULT_BASE);
        String comp = prefs.getString("comp", "deflate");
        int fps = prefs.getInt("fps", 4);
        String url = base + "/stream?w=1024&h=600&comp=" + comp + "&fps=" + fps;
        client = new HttpsFrameClient(this, url, prefs.getString("token", ""), display, new HttpsFrameClient.Listener() {
            @Override public void onStatus(String line) { setStatus(line); }
        });
        client.start();
    }

    private void stopClient() {
        if (client != null) { client.shutdown(); client = null; }
    }

    private void setStatus(final String line) {
        runOnUiThread(new Runnable() {
            @Override public void run() { statusView.setText(line); }
        });
    }

    private void showSettings() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(24, 16, 24, 0);
        final EditText base = field(box, "Relay URL", prefs.getString("base", DEFAULT_BASE), InputType.TYPE_TEXT_VARIATION_URI);
        final EditText token = field(box, "Instance key", prefs.getString("token", ""), InputType.TYPE_TEXT_VARIATION_PASSWORD);
        final EditText comp = field(box, "Compression: deflate or lz4", prefs.getString("comp", "deflate"), InputType.TYPE_CLASS_TEXT);
        final EditText fps = field(box, "Max fps (1-5)", String.valueOf(prefs.getInt("fps", 4)), InputType.TYPE_CLASS_NUMBER);
        new AlertDialog.Builder(this)
                .setTitle("Pixel Agents viewer")
                .setView(box)
                .setPositiveButton("Connect", new DialogInterface.OnClickListener() {
                    @Override public void onClick(DialogInterface d, int w) {
                        int f;
                        try { f = Math.max(1, Math.min(5, Integer.parseInt(fps.getText().toString().trim()))); } catch (NumberFormatException e) { f = 4; }
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
