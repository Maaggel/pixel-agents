# Frame renderer (legacy tablet stream)

Renders the Pixel Agents viewer headlessly and publishes frames to the relay, which serves them
to the 2012 Galaxy Tab 2 app on `GET /pixelagents/stream`. Background and wire protocol:
`docs/HANDOFF-from-TabScreen.md` (Oriel, TabScreen).

- **Where it runs:** the box that runs the daemon (thinkstation), as the user unit
  `pixel-agents-renderer` (`renderer/install.sh`). Not the Pi.
- **What it does (native, since v1.9.0):** `native-publisher.mjs` runs the office engine itself,
  with no browser. `webview-ui/src/headless/entry.ts` is the same TypeScript the web viewer runs
  (OfficeState, renderer, sprites, sunlight, weather, idle actions), bundled by `node esbuild.js
  --headless-only` into `renderer/native/engine.mjs` (built, not committed) and drawn with Skia
  via `@napi-rs/canvas`. State comes from the relay's viewer WebSocket, handled exactly as the
  relay's injected bridge and `useExtensionMessages` handle it for the canvas (agents, layout,
  kiosk options, weather). `native/shims.mjs` provides the three DOM touch points the engine
  has: offscreen canvases (sprite cache), localStorage (in memory), window (DPR 1, `#kiosk`).
  Per frame at `maxFps`: tick, draw, read back RGBA, convert to RGB565 LE, crc32 dedupe, then
  deflate (level 3) on the thread pool and send `[0x02][FRAME_FULL]` to the relay; LZ4
  `[0x01][FRAME_FULL]` only while an LZ4 client is connected. An unchanged picture is resent
  every 15 s so a restarted relay is never empty. `--chrome` installs the old puppeteer
  renderer (`frame-publisher.mjs`) instead; it still works and is the fallback.
- **Why it is cheap:** (1) the engine caches every sprite as a small canvas; in Skia a canvas
  source is a recorded picture replayed on every blit, so the shim snapshots each one into an
  immutable Image the first time it is drawn (6x cheaper blits). (2) The floor + wall base pass
  (~1000 blits) is drawn once per layout into a layer (`TileLayerCache` in `renderer.ts`, opt-in,
  the browser does not use it). (3) `upscale: 2` (default) draws the scene at zoom 1 into
  512x300 and repeats each pixel 2x2 on the way to RGB565: pixel art is identical (sprites are
  exact multiples), and drawing, readback and GC are ~4x cheaper. Nametags and speech bubbles
  are drawn again on a full-resolution overlay (`renderNametagOverlay`) and only their
  rectangles are read back and blended in, so the text is crisp: the pixel font at its native
  16 px with `Noto Color Emoji` as fallback (`nametagFont`), emoji stripped from labels unless
  `nametagEmoji: true`. (4) Two RGB565 buffers alternate between drawing and encoding, no
  per-frame allocation except Skia's readback. (5) With no stream client on the relay
  (`/api/stream` clients = 0) the simulation ticks at 10 Hz and a frame is drawn every 2 s.
- **Cost (2026-09-22, 14 agents, 15 fps):** ~8 ms CPU per frame in a warm loop = ~12% of one
  thread, plus ~3 ms deflate on a worker; ~250 MB RSS. The Chrome renderer was ~1 core and
  ~1.5 GB. Note the box's `schedutil` governor: a frame that costs 4 ms in a tight loop costs
  ~11 ms when the core wakes from idle for it, so `top` shows 40-60% for this process when the
  box is otherwise quiet and much less when the owner's sessions keep the clock up. `npm run
  bench` (`test/bench-native.mjs`) times the stages against live relay state.
- **Debug:** `PIXEL_AGENTS_RENDERER_ONCE=/path/prefix` draws one frame (after
  `onceAfterSec`, default 4) as `.png` (the draw canvas), `.rgb565`, `.lz4`, `.deflate` and
  exits; `node test/rgb565-to-png.mjs frame.rgb565 out.png` shows what the tablet sees.
- **What the tablet gets:** `GET /stream` (Bearer token or `?token=`), chunked body = `CONFIG`
  then `FRAME_FULL` forever, protocol v1. Options: `comp=deflate` (needs `java.util.zip.Inflater`
  on the client; ~3x smaller), `fps=N` (per-client cap). `GET /api/stream` shows state.
- **Config:** `~/.pixel-agents/renderer.json` `{ viewerUrl, relayWs, token, width, height, maxFps,
  zoom, upscale, background, nametagPx, nametagFont, nametagEmoji, deflateLevel, keyframeSec,
  clientPollSec, idleFps, idleSimHz }`; token falls back to `daemon.json`'s `relayToken`. Env
  `PIXEL_AGENTS_RENDERER_*` overrides.
- **Tests:** `npm test` in `renderer/` - LZ4 + framing against the TabScreen fixtures (including
  Oriel's Java `Lz4Decoder`) and a full HELLO/CONFIG/FRAME_FULL session against `FakeTablet`.
  Needs `~/projects/TabScreen` (or `TABSCREEN_DIR`) and a JDK.
- **Sharing the box (2026-09-22):** this box is a 2-core/4-thread i3-4150T that also runs the
  owner's Claude sessions, and they must not wait for frames. The unit runs `CPUSchedulingPolicy=
  idle` (+`CPUWeight=1`) and is deliberately **not** pinned. Both matter, and the second one was a
  mistake worth remembering: the Chrome-era `CPUAffinity=1 3` confined the renderer to one physical
  core *and its hyperthread*, so whenever the owner's work landed on either logical CPU it shared a
  core and ran at ~60% speed. Unpinned, the scheduler separates them; under SCHED_IDLE anything
  else preempts the renderer outright and the frame loop drops frames rather than queueing them,
  so the tablet degrades instead of the sessions (measured: 15 fps on an idle box, ~11 fps at load
  3.4, frames still under 30 ms old).
- **Measure with `npm run bench:latency`, not a throughput benchmark.** A long CPU-bound job
  showed this service costing 4%, while short bursts - the shape of real session work - took 2-3x
  longer (p50 17 ms -> 35-50 ms). `test/latency-bench.mjs` runs fixed bursts on a fixed rhythm and
  reports p50/p95. Compare by freezing the service rather than stopping it (`kill -STOP`/`-CONT`
  on its MainPID) and interleave the runs: the owner's own load drifts by more than the effect
  being measured, so unpaired runs are worthless. After the change, paired runs are
  indistinguishable (the "running" half was faster in 4 of 6 pairs).
- **Measured (2026-09-21):** real frames ~140-180 KB LZ4 / ~40-70 KB deflate. Delivered ~19.5 fps
  at a 30 cap on the thinkstation (the in-page capture is the floor); deflate at 30 = ~980 KB/s,
  at 15 = ~680 KB/s, at 5 = ~235 KB/s, `comp=deflate&fps=2` = ~63 KB/s. HTML overlays are not part
  of a canvas capture (only the activity labels, which are off in kiosk mode).
