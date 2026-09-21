package dk.mix.pixelagents.viewer;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.util.Log;
import android.view.SurfaceHolder;
import android.view.SurfaceView;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

import dk.mix.pixelagents.viewer.net.FrameSink;

/**
 * The screen. Holds one RGB_565 backbuffer the size of the virtual display and blits it onto the
 * surface with a "fit" transform: aspect preserved, black bars where the nav bar took the room
 * (on API 16 it cannot be hidden - docs/SPEC.md). The transform lives in exactly one place
 * (dstRect) so Phase 3's touch mapping can invert the same numbers.
 *
 * presentFull() runs on the network thread, by design. Nothing here touches the UI thread.
 */
public final class DisplaySurfaceView extends SurfaceView implements SurfaceHolder.Callback, FrameSink {
    private static final String TAG = "TabScreen";

    private final Object lock = new Object();
    private final Paint paint = new Paint();   // filterBitmap off: nearest neighbour, cheap and crisp
    private Bitmap backBuffer;
    private ByteBuffer pixels;
    private int frameWidth, frameHeight;
    private int surfaceWidth, surfaceHeight;
    private boolean surfaceReady;
    private final Rect src = new Rect();
    private final Rect dst = new Rect();
    private StatusListener statusListener;

    public interface StatusListener {
        void onStatus(String line);
    }

    public DisplaySurfaceView(Context context) {
        super(context);
        getHolder().addCallback(this);
        getHolder().setFormat(android.graphics.PixelFormat.RGB_565);
    }

    public void setStatusListener(StatusListener l) {
        statusListener = l;
    }

    // --- SurfaceHolder.Callback -------------------------------------------------------------

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        Log.i(TAG, "surface created");
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        synchronized (lock) {
            surfaceWidth = width;
            surfaceHeight = height;
            surfaceReady = true;
            recomputeDst();
        }
        Log.i(TAG, "surface " + width + "x" + height + " format " + format);
        redraw();
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        synchronized (lock) {
            surfaceReady = false;
        }
        Log.i(TAG, "surface destroyed");
    }

    // --- FrameSink ------------------------------------------------------------------------

    @Override
    public int screenWidth() {
        synchronized (lock) {
            return surfaceWidth > 0 ? surfaceWidth : 1024;
        }
    }

    @Override
    public int screenHeight() {
        synchronized (lock) {
            return surfaceHeight > 0 ? surfaceHeight : 600;
        }
    }

    @Override
    public void configure(int width, int height) {
        synchronized (lock) {
            if (backBuffer != null && frameWidth == width && frameHeight == height) return;
            if (backBuffer != null) backBuffer.recycle();
            frameWidth = width;
            frameHeight = height;
            // One backbuffer, allocated once. Per-frame Bitmaps would exhaust the native heap
            // on this generation of device within minutes.
            backBuffer = Bitmap.createBitmap(width, height, Bitmap.Config.RGB_565);
            pixels = ByteBuffer.allocateDirect(width * height * 2).order(ByteOrder.LITTLE_ENDIAN);
            src.set(0, 0, width, height);
            recomputeDst();
        }
        // copyPixelsFromBuffer assumes the bitmap's rows are exactly width * 2 bytes apart.
        int rowBytes = backBuffer.getRowBytes();
        Log.i(TAG, "backbuffer " + width + "x" + height + " RGB_565, rowBytes " + rowBytes
                + (rowBytes != width * 2 ? " (UNEXPECTED - frames will shear)" : "") + ", blit rect " + dst.toShortString());
    }

    @Override
    public void presentFull(byte[] rgb565, int length) {
        synchronized (lock) {
            if (backBuffer == null) return;
            pixels.clear();
            pixels.put(rgb565, 0, length);
            pixels.rewind();
            backBuffer.copyPixelsFromBuffer(pixels);
        }
        redraw();
    }

    @Override
    public void status(String line) {
        StatusListener l = statusListener;
        if (l != null) l.onStatus(line);
    }

    // --- drawing ----------------------------------------------------------------------------

    /** Draws the whole surface: bars and frame. lockCanvas() leaves the old contents undefined. */
    private void redraw() {
        Canvas c;
        synchronized (lock) {
            if (!surfaceReady || backBuffer == null) return;
            c = getHolder().lockCanvas();
            if (c == null) return;
            try {
                c.drawColor(Color.BLACK);
                c.drawBitmap(backBuffer, src, dst, paint);
            } finally {
                getHolder().unlockCanvasAndPost(c);
            }
        }
    }

    /** Fit: uniform scale so the frame fits inside the surface, centred. */
    private void recomputeDst() {
        if (frameWidth == 0 || surfaceWidth == 0) return;
        float scale = Math.min((float) surfaceWidth / frameWidth, (float) surfaceHeight / frameHeight);
        int w = Math.round(frameWidth * scale);
        int h = Math.round(frameHeight * scale);
        int x = (surfaceWidth - w) / 2;
        int y = (surfaceHeight - h) / 2;
        dst.set(x, y, x + w, y + h);
    }
}
