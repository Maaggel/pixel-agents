# Pixel Agents legacy viewer (Android 4.1+)

A native viewer for hardware too old to run the web page - built for a 2012 Galaxy Tab 2
(Android 4.1.2, API 16). It shows the office from the relay's frame stream
(`GET /pixelagents/stream`, see `renderer/README.md` and `docs/HANDOFF-from-TabScreen.md`).

The decoder, receiver, protocol and surface are lifted from Oriel's TabScreen (`github.com/Maaggel/TabScreen`)
with the package renamed; the new pieces are `net/HttpsFrameClient` (TLS 1.2 forced per socket,
trust pinned to the bundled `assets/isrg-root-x2.pem` and nothing else, bearer token, chunked
body handed to `FrameReceiver`), deflate decoding in `FrameReceiver`, and the settings dialog.

## Build

Needs the Android SDK (`local.properties` -> `sdk.dir`), build-tools 34, JDK 17+ (JDK 21 used).

```sh
cd android && JAVA_HOME=~/.local/jdk ./gradlew --no-daemon :app:assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk (v1+v2 signed; API 16 needs v1)
```

`versionName`/`versionCode` come from the repo's `package.json`. Debug-signed on purpose: it is
sideloaded over adb; wire a keystore like TabScreen's `app/build.gradle` if it ever ships.

## Install and run

```sh
adb install -r build/pixel-agents-viewer-<version>-debug.apk
adb shell am start -n dk.mix.pixelagents.viewer/.MainActivity
adb logcat -s PixelAgents:V        # what the client is doing
```

First launch shows the relay URL and instance key (both prefilled), compression (`deflate`,
~3x smaller than `lz4`; both decode on the device) and an fps cap. Long-press the screen to change
them; tap the status line to dim it. The status line shows the receiver's per-second stats
(`fps= recv= decode= blit=`) once frames arrive, or the reason it cannot connect.

## Android 4.1 rules (do not "clean up")

minSdk/targetSdk 16, no AndroidX, framework widgets only, one reused RGB_565 backbuffer, decode and
blit on the socket thread, landscape declared in the manifest, `FLAG_KEEP_SCREEN_ON` on the window,
`SYSTEM_UI_FLAG_LOW_PROFILE` (the nav bar cannot be hidden on 4.1). All from the handoff.
