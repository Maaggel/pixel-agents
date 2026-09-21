# Handoff: a legacy Pixel Agents viewer for old Android

**From:** Oriel (TabScreen)
**To:** Panto (Pixel Agents)
**Date:** 2026-09-21

Panto - this is for you. Mix wants the "show Pixel Agents on the ancient Galaxy Tab 2" idea to
live in your project, not mine, because it is really a *viewer for your page on hardware too old to
render it in a browser* - and modern devices already have the fullscreen browser view. TabScreen is
going back to being a wired extended monitor for Mix's personal PC. So I am handing you everything I
built and learned getting a real-time frame renderer working on Android 4.1.2, which is the hard,
uncertain part, and it is already **proven on the actual tablet**.

Take the code, take the scars, ignore the parts that do not fit. Mix and I will owe you a good
review when you ship it.

---

## TL;DR

- The Tab 2 (Android 4.1.2, API 16, 1024x600, 2012) **cannot render your page**: both the Samsung
  browser and Chrome for 4.1 load `https://apps.blommemix.dk/pixelagents/` to a blank white page.
  The HTML arrives; the modern JavaScript never runs. A WebView kiosk will not work.
- The fix that *does* work: **render the page on the Pi, stream it to the tablet as compressed
  pixels, and let a tiny native app decode and blit them.** I proved the tablet half end to end -
  see the photo Mix has: colour bars and four corner markers landed correct, in landscape, at full
  1024x600, decoding a real compressed frame in a couple of milliseconds.
- The wire format is **RGB565 + LZ4 block**, not H.264. Pixel art is flat colour with small
  changes, which is the ideal case, and MediaCodec on API 16 is a documented trap. Decode measured
  at ~1.6-3 ms per full 1024x600 frame on the Tab 2's 2012 CPU.
- Reuse my client code (below). The only genuinely new piece is the transport: an **authenticated
  HTTPS stream on `apps.blommemix.dk`**, because Mix wants the tablet to work while roaming, not
  just on the home LAN. The trick that makes HTTPS work on a 2012 device is in the TLS section.

---

## The decision, in one paragraph

TabScreen started as a USB extended monitor for a Windows PC: capture a virtual display, stream it
over adb to the tablet. That needs a host PC, and Mix's work laptop is IT-managed and blocks
unsigned executables - so on that machine it is a non-starter, and it was never really a monitor we
needed anyway. The goal was only ever "show the Pixel Agents page on that tablet." Your Pi already
renders the page and is reachable at `apps.blommemix.dk`, so it is the natural sender. TabScreen
keeps the extended-monitor identity for Mix's *personal* PC at home (no restrictions there); the
old-tablet-as-Pixel-Agents-screen becomes your legacy viewer.

---

## Architecture for your legacy viewer

```
blommemix Raspberry Pi (your Pixel Agents project)          Galaxy Tab 2 (the legacy app)
  render the page headless at 1024x600
  -> RGB565 (little-endian) -> LZ4 block
  -> serve on an authenticated HTTPS stream
        |                                                          ^
        +--- HTTPS over the internet (roaming) or LAN -------------+
             token auth; app forces TLS 1.2 and pins your cert
                                                                    |
                                            LZ4 decode -> RGB_565 Bitmap -> SurfaceView (landscape)
```

Roaming is a requirement (Mix confirmed), so the endpoint must be internet-reachable and
authenticated. Auth mechanism is your call (Mix left it to you) - I only specify that it exists and
that the stream is encrypted.

---

## The wire protocol (self-contained)

Binary, little-endian, length-prefixed. My original design doc with the full rationale is in the
TabScreen repo at `docs/SPEC.md`, but here is everything the viewer actually uses.

**Framing** - every message:

```
offset size field
0      1    type        (uint8)
1      4    payloadLen  (uint32 LE)   bytes following this header
5      N    payload
```

Read exactly 5 bytes, then exactly `payloadLen` bytes. Never assume one read returns a whole
message.

**Messages you need (three of them):**

`0x01 HELLO` (viewer -> server), 8-byte payload:
```
0 2 protocolVersion (uint16) = 1
2 2 screenWidth     (uint16)   the surface size the app will draw into
4 2 screenHeight    (uint16)
6 1 pixelFormats    (uint8 bitmask: 0x01 = RGB565)
7 1 flags           (uint8, 0 for the viewer)
```

`0x02 CONFIG` (server -> viewer), 7-byte payload:
```
0 2 width       (uint16)   frame width you will send (use 1024)
2 2 height      (uint16)   frame height (use 600)
4 1 pixelFormat (uint8) = 0x01 RGB565
5 1 maxFps      (uint8)   informational cap
6 1 compression (uint8) = 0x01 LZ4 block  (0x00 = none, also supported)
```

`0x10 FRAME_FULL` (server -> viewer):
```
0  8 timestampUs (uint64)  your monotonic clock, for latency stats; not required to be correct
8  4 rawSize     (uint32)  decompressed byte count = width * height * 2
12 N lz4Block               the LZ4 *block* of the RGB565 frame
```

Handshake: viewer connects and sends HELLO; server replies CONFIG; then a continuous run of
FRAME_FULL. (`0x11 FRAME_DIRTY`, `0x30/0x31 PING/PONG` exist in `docs/SPEC.md` but are **not**
implemented in the client yet - do not send them for v1. Full frames only.)

**RGB565 pixel packing**, tightly packed, no row padding, `width * 2` bytes per row:
```
value = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)     // per pixel, 0..65535
bytes = value & 0xFF, then value >> 8                     // little-endian
```

**LZ4 must be raw *block* format, NOT frame format**, and with **no size prefix** (we carry
`rawSize` in the header instead). This is the single most common way to get it wrong:
- Python: `lz4.block.compress(raw, mode="fast", store_size=False)`. `store_size=False` is required;
  the default prepends a 4-byte length my decoder does not expect.
- Node: use a block-mode LZ4 (e.g. the `lz4` package's block functions or `lz4js`), not the frame
  API. No magic number `0x184D2204`, no frame descriptor, no block checksums.
- Compression level "fast" is what I used and is plenty; the ratio on real content dominates.

**Validate your encoder with no tablet in the loop** (see the Validation section) - this is the
part I would get wrong first, so I made it checkable offline.

---

## Reusable code - lift these from the TabScreen repo

Repo: `github.com/Maaggel/TabScreen` (same org, so `gh` or a clone works, same as vendoring the
playbook). Client sources are under `android/app/src/main/java/dk/mix/tabscreen/`. Copy into your
project and change the package. They diverge from mine after this (yours is HTTPS, mine is adb), so
copy, do not try to share a module.

| File | Take it | Why |
| --- | --- | --- |
| `codec/Lz4Decoder.java` | **as-is** | Pure-Java LZ4 *block* decompressor, decode only, ~90 lines, no deps, bounds-checked. The crown jewel. Handles overlapping matches. |
| `net/Protocol.java` | **as-is** (or trim) | Framing, `readFully`, HELLO/CONFIG encode, FRAME_FULL parse. |
| `net/FrameSink.java` | **as-is** | The interface between "bytes decoded" and "pixels on screen". |
| `net/FrameReceiver.java` | **adapt lightly** | Runs HELLO/CONFIG/FRAME_FULL over any `InputStream`/`OutputStream`, decodes into one reused buffer, drives the sink, keeps per-second stats. It already works over any stream, so it works over an HTTPS response body. |
| `DisplaySurfaceView.java` | **adapt package** | SurfaceView + one reused RGB_565 backbuffer + fit/letterbox blit. Every rendering pitfall below is already handled here. |
| `MainActivity.java` | **template** | Fullscreen landscape, keep-screen-on, status line. Replace the adb piece with your HTTPS client. |
| `net/ServerThread.java` | **do NOT copy** | This is the adb `LocalServerSocket` *listener* for the USB case. You want the opposite: a client that dials the Pi over HTTPS. |
| `tools/FakeTablet.java`, `fixtures/` | **for testing** | Validate your encoder and the whole wire path on a JVM before touching the tablet. |

The one new class you write is an `HttpsFrameClient`: open the authenticated TLS stream, then hand
its `InputStream`/`OutputStream` to `FrameReceiver.run(...)`. That is the whole integration.

---

## The internet transport - TLS on a 2012 device (the new, non-obvious part)

Mix wants roaming, so this rides the public HTTPS front door. The good news from the browser test:
the tablet reached `apps.blommemix.dk` and got HTML (blank, but *served*), so the server's cert and
TLS are probably reachable from this device. But do not rely on the system doing the right thing on
API 16 - do it explicitly in the app. A native app can do what the browser cannot:

1. **Force TLS 1.2.** On API 16-19, even an `SSLContext.getInstance("TLSv1.2")` produces sockets
   with 1.2 *disabled* by default. You must enable it on every socket the factory creates:
   ```java
   SSLContext ctx = SSLContext.getInstance("TLSv1.2");
   ctx.init(null, trustManagers, null);
   SSLSocketFactory base = ctx.getSocketFactory();
   // wrap base so each created SSLSocket does:
   //   sock.setEnabledProtocols(new String[] { "TLSv1.2" });
   ```
   This is the classic "Tls12SocketFactory" wrapper; search that name for a canonical copy. Without
   it you silently negotiate TLS 1.0 and modern servers reject you.

2. **Pin the cert, do not trust the system store.** Android 4.1's trusted-CA list predates most of
   today's roots (Let's Encrypt / ISRG Root X1 especially, and DST Root X3 has expired). Bundle
   your server's certificate (leaf or the intermediate) in the APK's `assets/`, build a
   `TrustManager` that trusts only that, and pass it to the `SSLContext` above. This sidesteps the
   old trust store entirely and immunises you against future root-expiry surprises. Recommended
   even though the browser reached the server - it removes a whole class of "it worked until a cert
   rotated" failures. If you would rather not pin, at minimum test a Java `HttpsURLConnection` from
   the device against the real endpoint early, because "the browser loaded it" does not prove the
   platform Java stack will.

3. **Transport shape (your call, here is my recommendation).** Simplest for a Pi behind the
   existing reverse proxy: an HTTP `GET` to something like
   `/pixelagents/stream?token=<secret>&w=1024&h=600` that returns a **chunked** response whose body
   is `CONFIG` followed by a continuous run of `FRAME_FULL` messages in the framing above. That
   folds HELLO into the request, reuses your TLS termination and domain, and needs no new open
   port. A WebSocket (`wss://.../pixelagents/stream`) works too and is bidirectional if you later
   want PING/PONG or input - pick what your stack and proxy make easy. Either way the *frame bytes*
   inside are identical.

4. **Auth.** You choose the mechanism (Mix delegated it). My only requirements: it is required, it
   is carried inside the TLS stream, and the app can store the secret in its settings and send it on
   connect. A single long random token is enough for a personal dashboard.

---

## Android 4.1.2 - the hard-won lessons

These cost me time so they do not cost you any. Most are already handled in the files above; this is
so you know *why* they are the way they are and do not "clean them up" into breakage.

**Toolchain that actually builds `minSdk 16` in 2026** (newer AGP drops it; pin, do not raise
minSdk):
- AGP **8.7.2**, Gradle **8.14.3** (wrapper), compileSdk **34**, build-tools **34.0.0**, JDK **21**.
- `targetSdk 16` on purpose - a higher target changes runtime behaviour on the device for nothing
  gained. Disable the lints that complain: `ExpiredTargetSdkVersion`, `OldTargetApi`.
- **No AndroidX, no Material.** Framework classes only (`Activity`, `SurfaceView`, `Service`). Set
  `android.useAndroidX=false`. AndroidX misbehaves on 4.1.
- `versionCode` cannot be 0 - AGP rejects it. I compute it from a VERSION file as
  `MAJOR*10000 + MINOR*100 + PATCH`.

**APK signing:** API 16 needs a **v1 (JAR) signature**. v2/v3 alone will not install. `apksigner`
emits v1+v2 by default; verify v1 is present (`apksigner verify -v` -> "Verified using v1 scheme").

**Rendering:**
- The **navigation bar cannot be hidden** on 4.1 (immersive mode is API 19). Best is
  `SYSTEM_UI_FLAG_LOW_PROFILE`, which only dims it. Budget ~48px of the 600 gone; letterbox around
  it. `DisplaySurfaceView` already does fit-with-black-bars, so a 1024x600 frame shows correctly in
  the ~1024x552 usable area.
- **One reused `Bitmap.Config.RGB_565` backbuffer**, allocated on CONFIG, never per frame. Bitmaps
  live on a small native heap on this generation; per-frame allocation is an `OutOfMemoryError`
  within minutes. RGB_565 is the device's native config, so there is no conversion cost.
- Draw with `SurfaceHolder.lockCanvas()` / `unlockCanvasAndPost()`, and **decode + draw on the
  socket thread** - do not post to the UI thread per frame. `getHolder().setFormat(RGB_565)`.
- `Bitmap.copyPixelsFromBuffer` assumes the bitmap's `getRowBytes()` equals `width * 2`. It does at
  1024, but the code logs it and shouts if not, because a mismatch shears the image silently.
- `android:screenOrientation="landscape"` plus `configChanges="orientation|keyboardHidden|screenSize"`
  in the manifest. This is the fix for the rotation mess third-party clients hit - the app declares
  its orientation so nothing is negotiated at runtime.
- `FLAG_KEEP_SCREEN_ON` on the *window* (not the view).

**Networking:** `DataInputStream.readFully`, always. A single `read()` will hand you 1400 bytes of
a 40 KB frame and you will spend an afternoon on it.

**Do not reach for MediaCodec / H.264.** Vendor-specific colour formats and broken behaviour on
2012 SoCs. The LZ4 + RGB565 path is proven fast here; keep it.

**adb, if you use it to install/debug:** I hit `offline` and even `(no serial number)` from
`adb devices`, and none of toggling USB debugging, switching MTP/PTP, or trying a different adb
version fixed it. **Rebooting the tablet fixed it** - adbd on the device had wedged. Try that first.

**Measured on the Tab 2 (so you have a baseline):** full-frame 1024x600 RGB565 = 1.23 MB raw,
compressing to roughly 50 KB with LZ4-fast on my test pattern (real pixel art should do as well or
better); tablet-side LZ4 decode ~1.6-3 ms per frame. The bottleneck is the blit, not the decode, so
if the page changes slowly you have enormous headroom.

---

## Rendering the page on the Pi (your domain - options, not instructions)

- **Headless Chromium** (Puppeteer / Playwright) at a 1024x600 viewport, screenshot to raw pixels,
  convert to RGB565, LZ4-compress, frame it. A Pi 4 handles headless Chromium; an older Pi will
  feel it, so cap the rate.
- **Skip the browser** if Pixel Agents can render to an offscreen canvas server-side (e.g.
  `node-canvas`) - then you emit pixels directly, much lighter on a Pi.
- **Rate:** a pixel-art office changes slowly. 1-5 fps, or better, **send a frame only when the
  page actually changed**. Full frames at that rate are trivial bandwidth, so you do not need dirty
  rects for v1. Add them later only if a busy scene proves it.
- **Render at exactly 1024x600** so there is no scaling on either end; the tablet shows it 1:1 and
  letterboxes for the nav bar.

---

## Validate without a tablet

I built the frame format to be checkable offline, because it is the easiest thing to get subtly
wrong.

- `fixtures/lz4/pattern-256x160.rgb565` is a raw RGB565 frame; `fixtures/lz4/pattern-256x160.lz4` is
  that frame in the exact LZ4 block format the viewer decodes. Point your encoder at the raw and
  confirm your output decodes back (via `Lz4Decoder`) to the original; and confirm my `.lz4` decodes
  to the `.rgb565`. If both hold, your LZ4 is wire-compatible.
- `fixtures/protocol/hello.bin`, `config.bin`, `frame-full-256x160.bin`, `frame-full-1024x600.bin`
  are complete framed messages to test your parser/serialiser against byte for byte.
- `android/tools/FakeTablet.java` runs the *real* client stack (`Protocol` + `Lz4Decoder` +
  `FrameReceiver`) on a plain JVM socket and asserts the corner markers. Point your Pi encoder at it
  and you have exercised the entire wire path before flashing an APK. (It uses a raw `ServerSocket`;
  for your HTTPS transport, either test the frame bytes through it first, or stand up a tiny local
  HTTP shim - the frame format is what matters.)

---

## Open questions for you (and maybe Plumbline for the infra)

- The exact stream endpoint on `apps.blommemix.dk`: path, and chunked-HTTP vs WebSocket. Plumbline
  runs the blommemix admin/infra, so the reverse-proxy route may be a conversation with them.
- The auth mechanism (Mix left it to you).
- How the Pi renders (headless browser vs direct canvas) and the frame cadence / change detection.
- Whether to pin the cert (I recommend yes) and getting the cert file into the APK's assets.
- Protocol version coupling: the app and the Pi sender must agree on protocol v1. If either changes
  the wire format, bump both together and treat it as a required update.

## What I need back from you (your return handoff)

So the next TabScreen session can help build or review the app's client side:
- The endpoint URL and how to authenticate (so the settings screen and `HttpsFrameClient` can be
  written).
- The server certificate (or intermediate) to pin, if we pin.
- Confirmation of what you actually implemented: frame size, cadence, whether you send CONFIG then
  FRAME_FULL as specified, and any deviations from this doc.
- Anything the app must send you beyond HELLO (token location, screen size, etc.).

Thanks, Panto. It is a good little machine once it stops fighting you - and your office deserves a
screen of its own. Shout if any of this is unclear; I would rather answer than have you rediscover a
scar I already have.

-- Oriel
