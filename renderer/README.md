# Frame renderer (legacy tablet stream)

Renders the Pixel Agents viewer headlessly and publishes frames to the relay, which serves them
to the 2012 Galaxy Tab 2 app on `GET /pixelagents/stream`. Background and wire protocol:
`docs/HANDOFF-from-TabScreen.md` (Oriel, TabScreen).

- **Where it runs:** the box that runs the daemon (thinkstation), as the user unit
  `pixel-agents-renderer` (`renderer/install.sh`). Not the Pi - the office's game loop only exists
  in a browser, and headless Chrome is heavy.
- **What it does:** puppeteer opens `https://apps.blommemix.dk/pixelagents/#kiosk` at exactly
  1024x600 (UI hidden, camera fitted to the office), screenshots up to 5 times a second, and when
  the picture changed converts to RGB565 little-endian and sends the relay two binary WebSocket
  messages per frame: `[0x01][FRAME_FULL payload, LZ4 block]` and `[0x02][FRAME_FULL payload, raw
  deflate]`. An unchanged picture is resent every 15 s so a restarted relay is never empty.
- **What the tablet gets:** `GET /stream` (Bearer token or `?token=`), chunked body = `CONFIG`
  then `FRAME_FULL` forever, protocol v1. Options: `comp=deflate` (needs `java.util.zip.Inflater`
  on the client; ~3x smaller), `fps=N` (per-client cap). `GET /api/stream` shows state.
- **Config:** `~/.pixel-agents/renderer.json` `{ viewerUrl, relayWs, token, width, height, maxFps,
  keyframeSec }`; token falls back to `daemon.json`'s `relayToken`. Env `PIXEL_AGENTS_RENDERER_*`
  overrides. `PIXEL_AGENTS_RENDERER_ONCE=/path/prefix` writes one frame as `.png/.rgb565/.lz4` and exits.
- **Tests:** `npm test` in `renderer/` - LZ4 + framing against the TabScreen fixtures (including
  Oriel's Java `Lz4Decoder`) and a full HELLO/CONFIG/FRAME_FULL session against `FakeTablet`.
  Needs `~/projects/TabScreen` (or `TABSCREEN_DIR`) and a JDK.
- **Measured (2026-09-21):** real frames ~140-175 KB LZ4 / ~40-60 KB deflate; 4 fps LZ4 = ~540 KB/s,
  deflate = ~155 KB/s, `comp=deflate&fps=2` = ~63 KB/s.
