# Changelog

## v1.10.2

- **The renderer no longer paints a full-resolution overlay when nameplates are off.** It was clearing a 1024x600 canvas and redrawing every speech bubble on it each frame - bubbles the scene had already drawn - which a profile put at 47% of the renderer's entire CPU. With nameplates off (the kiosk default now), a frame costs 2.6 ms of rendering instead of 5.6, and 13.9 ms of CPU instead of 22.
- Fix: with nameplates off the overlay pass still drew them, so the kiosk setting had no effect on the tablet.

## v1.10.1

- **Fix: the tablet dribbled at 2 fps after the renderer had been up overnight.** Skia's text rendering degrades over a long run: a 19 hour old process spent 96 ms a frame drawing the same fourteen nametags that cost 1.4 ms when it started, which starved the frame loop and dropped 400 frames a minute. Nametag text is now rendered once per label into a small canvas and blitted from then on (`renderNametags`), which takes that path out of the loop entirely and also makes a healthy frame ~28% cheaper (render 5.0 ms -> 3.6 ms). The browser viewer gets the same caching.
- A watchdog restarts the renderer if a frame ever costs more than four times its healthy CPU (floor 25 ms), since the root cause is inside the native canvas and this is not the only path through it. It measures CPU per frame, not wall time, so a busy box under SCHED_IDLE never trips it, and it ignores idle minutes, where the office is still simulated at full rate while only a keyframe or two is drawn.

## v1.10.0

- **Damage tracking in the native renderer**: each frame reports which rectangles can differ from the last one, and only those are converted to RGB565 and upscaled. That stage was writing a megabyte per frame and cost 6.5 ms on an idle box but 14.8 ms under load, because it thrashed the cache exactly when the owner's sessions needed it; it is now 0.5 ms. A frame costs 8.2 ms instead of 12.8, and the service uses 19% of one thread instead of 29% at 10 fps. Default frame rate is now 10 (was 20).
- Clipping the *drawing* to the damaged rectangles was tried and reverted: it made rendering five times slower (3.7 ms -> 18.4 ms), because every draw call then tests against a multi-rect clip. The scene is still drawn in full; the win is downstream.
- The headless renderer quantises the sun's angle, intensity and colour into small steps. It sweeps a full cycle in 300 s, so every frame differed slightly and nothing could ever be reused; the steps are invisible at this scale.
- `renderer/test/dirty-rects.mjs` (`npm run test:dirty`) checks the invariant against live relay state: every pixel that changes between frames must lie inside a reported rectangle, compared in RGB565 because that is what the tablet is sent.

## v1.9.2

- The renderer no longer competes with the owner's Claude sessions: the unit runs at `CPUSchedulingPolicy=idle` and is no longer pinned to CPUs 1,3. The pinning was a Chrome-era setting that forced the renderer onto one physical core *and its hyperthread*, so any session work landing there ran at ~60% speed; SCHED_IDLE makes anything else preempt it outright. Short-burst latency with the renderer running went from 2-3x the idle-box baseline to indistinguishable from it. The daemon unit is unpinned for the same reason (it keeps `Nice=5`).
- `renderer/test/latency-bench.mjs` (`npm run bench:latency`): measures what a background service costs interactive work, which the old throughput benchmark could not see (it reported 4% where bursts were 2-3x slower).

## v1.9.1

- Fix: every relay restart (each deploy) made all viewers despawn and respawn every agent, because the relay broadcast each partial state while the daemon's publishers reconnected one by one. The relay now holds agent state for 20 s after starting (viewers keep what they have) and then sends one full sync.
- Interference re-measured with the native renderer: a normal-priority CPU job runs 0-9% slower (mean ~4%, inside the noise of the other sessions) while the tablet watches; was 2x with Chrome.

## v1.9.0

- **Native renderer for the tablet stream** - the office is now rendered in Node with Skia (`@napi-rs/canvas`), no browser. The same engine TypeScript the web viewer runs is bundled for Node (`webview-ui/src/headless/entry.ts` -> `renderer/native/engine.mjs`) and fed straight from the relay's viewer WebSocket. Sprites are blitted as immutable images (6x cheaper than Skia's picture replay of a canvas source), the floor is a cached layer, the scene is drawn at half resolution and doubled (identical pixel art), nameplates and bubbles are drawn on a full-resolution overlay with the pixel font at its native 16 px (crisp; emoji prefixes stripped, `nametagEmoji: true` keeps them). ~8 ms CPU per frame at 15 fps against ~1 core and 1.5 GB for headless Chrome. `renderer/install.sh` installs it by default; `--chrome` is the fallback.
- `renderFrame` gains an opt-in `TileLayerCache` and `setNametagFont`; the browser's rendering is unchanged.

## Unreleased

- Playbook adopted (vendored v1.20.1, `npm run sync-playbook`); `CLAUDE.md` now carries the bootstrap pointer, house rules, versioning table and server map. Versioning and the branch rule apply from here forward; earlier history is not renumbered. `relay/deploy.sh` refuses a code deploy without a version bump.

## v1.8.1

- Fix: the headless daemon burned ~50% of a core re-reading every sync file on every write (11 backends watching each other for a VS Code multi-window feature nothing headless uses). Headless backends now write sync files but never read them back (~4%).
- Renderer cost brought under control on the 2-core thinkstation it shares with the owner's sessions: idles when no tablet is connected (page CPU-throttled 8x, 0.5 fps keyframes, wakes within 5 s); raw pixels leave the page over a local binary WebSocket and all compression happens in Node (thread pool), LZ4 only when an LZ4 client exists; `#fps=N` caps the office's animation loop; both services run at `Nice=` and are pinned to one physical core's hyperthreads (`CPUAffinity=1 3`). Measured: a normal-priority job is slowed 5-15% while the tablet watches, down from 2x.

## v1.8.0

- **Kiosk display settings** - View dropdown gains "Apply to kiosk displays": nameplates, sunlight, dynamic items, lamp lights and weather from this browser are stored on the relay and pushed live to every `#kiosk` viewer (the tablet renderer, wall screens). Also `GET/POST /api/kiosk`.
- Stream no longer "catches up": the relay drops a frame for a client whose previous frame is still queued, and the app skips decoding frames it is behind on (`skip=` in the status line).
- Viewer app hardening from Oriel's review: backoff resets after a healthy session, `Inflater` released per session, a rejected key stops retrying and says so, non-200 responses are disconnected, TLS factory built once.

## v1.7.2

- Stream up to 30 fps: the renderer reads the office canvas inside the page instead of screenshotting (5x cheaper), encodes off the main thread; ~20 fps delivered from the thinkstation. Relay default cap 15, per-client `fps=` up to the renderer's cap.
- Viewer app: instance key shown in clear text and preset; fps 1-30 (default 15).

## v1.7.1

- Fix: an idle agent visiting furniture placed on a half tile crashed the game loop (`tileMap[4.5]`), freezing the office until reload. Found by the headless renderer running the office nonstop.
- **Legacy viewer app** (`android/`): the Android 4.1 client for the frame stream - Oriel's proven decoder/receiver/surface, plus a pinned-root TLS 1.2 HTTPS client, deflate support and a settings dialog. `build/pixel-agents-viewer-<version>-debug.apk`.
- Renderer reloads the page properly after an error (`page.reload`, not a same-URL `goto`).

## v1.7.0

- **Legacy tablet stream** - the relay serves `GET /stream` (chunked; `CONFIG` then `FRAME_FULL`, RGB565 + LZ4 block, protocol v1 from `docs/HANDOFF-from-TabScreen.md`) fed by a new `renderer/` process that renders the viewer headlessly and publishes frames over the publisher WebSocket. `GET /api/stream` reports its state. LZ4 codec and framing verified against TabScreen's fixtures and its Java client stack (`renderer/test`).
- **`#kiosk` URL flag** - display mode with no UI at all and the camera kept centred on the office; for the renderer and wall-mounted tablets.
- Login link (`#token=...`) now keeps other hash flags.

## v1.6.15

- **Dynamic items** - agents fetch a coffee mug at the coffee machine, carry it back (drawn in hand), put it on their desk, and now and then pick up stray mugs and take them to the sink. Data-driven: any catalog asset marked `utensil` with `utensilOrigin`/`utensilDisposal` works (fridge → food → sink next, once the sprites exist). Toggle: View → "Dynamic items". Utensils have a `utensilUse`: `drink` (coffee breaks) or `food` - eating in the kitchen now fetches a food item from its origin first, when one exists.
- Settings modal renders above activity labels.
- Catalog `useSide` (asset-manager "Use side"): characters stand in front of the coffee machine/sink instead of a random side.
- Fetched mugs/food come in random colour variants; three placeholder foods (plate, salad bowl, sandwich) picked at random.
- More utensils: a glass of water from the sink or water cooler (back to the sink), a sheet of paper from the printer (to the bin), a book from any bookshelf (back to a bookshelf). Origin/disposal now take comma lists and `*` wildcards; new use type `item`.
- "Keep screen awake" view option (default on): the tablet/phone display stays on while the office is visible (Screen Wake Lock API; PWA on iOS 16.4+).
- Food turns into an empty plate/bowl when the agent finishes eating (catalog `utensilEmpty`), and is then tidied like anything else.
- Catalog `surface` flag (asset-manager "Is Surface"): mugs/plates - placed by agents or by you - can go on non-desk surfaces such as the chess board.
- Tidying is smarter: items someone is sitting next to are left alone; a stray item nearby makes an idle agent far more likely to grab it (nearest first).
- Action bubbles: the item being fetched shows in a bubble on the way to get it; a broom bubble while tidying.
- Placeholder `PLATE_FOOD` sprite on the relay so food fetching is testable (Behaviour bar: Coffee / Food / Tidy).

## v1.6.14

- **Agents keep their look** - appearance is now derived from the nametag (hash → palette + hue), identical on every device and spawn; Shuffle overrides are remembered per name.
- **Touch panning** - double-tap and hold, then drag, moves the view on phones/tablets (same as middle-mouse drag).
- **Calmer idle behaviour** - agents sit 2-3× longer between outings and take shorter walks.

## v1.6.13

### Features

- **Headless daemon - run without VS Code** - `npm run package:daemon` builds a single self-contained `pixel-agents-daemon.cjs` (~60 KB tarball with `daemon/install.sh`). Run it on the Linux box where Claude Code runs; it publishes to the relay so the office is viewable from anywhere. The installer sets up a systemd user service that starts on boot. See [daemon/README.md](daemon/README.md).
- **Exact session discovery** - the daemon finds running `claude` processes through Claude Code's own registry (`~/.claude/sessions/<pid>.json`: pid, sessionId, cwd, name), verified against `/proc/<pid>/stat` start time to rule out pid reuse, with a `/proc` scan fallback for older Claude Code. No folder list or timestamp heuristics. User-named sessions show their name on the nametag.

### Internal

- Backend no longer imports `vscode`: environment access goes through a `Host` interface (`src/host.ts`) with `vscodeHost.ts` (extension) and `daemon.ts` (headless) implementations. The daemon bundle is built without `vscode` as an external so any leak fails the build.
- `relayClient.ts` falls back to the `ws` package when there is no global `WebSocket` (bundled into the daemon → Node 18+).
- Removed dead webview-only helpers (`launchNewTerminal`, `sendExistingAgents`, `sendLayout`).

## v1.0.2

### Bug Fixes

- **macOS path sanitization and file watching reliability** ([#45](https://github.com/pablodelucca/pixel-agents/pull/45)) - Comprehensive path sanitization for workspace paths with underscores, Unicode/CJK chars, dots, spaces, and special characters. Added `fs.watchFile()` as reliable secondary watcher on macOS. Fixes [#32](https://github.com/pablodelucca/pixel-agents/issues/32), [#39](https://github.com/pablodelucca/pixel-agents/issues/39), [#40](https://github.com/pablodelucca/pixel-agents/issues/40).

### Features

- **Workspace folder picker for multi-root workspaces** ([#12](https://github.com/pablodelucca/pixel-agents/pull/12)) - Clicking "+ Agent" in a multi-root workspace now shows a picker to choose which folder to open Claude Code in.

### Maintenance

- **Lower VS Code engine requirement to ^1.107.0** ([#13](https://github.com/pablodelucca/pixel-agents/pull/13)) - Broadens compatibility with older VS Code versions and forks (Cursor, etc.) without code changes.

### Contributors

Thank you to the contributors who made this release possible:

- [@johnnnzhub](https://github.com/johnnnzhub) - macOS path sanitization and file watching fixes
- [@pghoya2956](https://github.com/pghoya2956) - multi-root workspace folder picker, VS Code engine compatibility

## v1.0.1

Initial public release.
