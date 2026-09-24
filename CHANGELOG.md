# Changelog

## v1.19.2

- A door in a north-south wall is seen edge on, so there is no door face to show from that direction. Closed, it is now simply a wooden beam filling the gap rather than a panelled door drawn as if we were looking at it square on. Swinging it open turns it toward the camera, and that is when its panels and handle appear.

## v1.19.1

- The north-south door, standing open, was a thin bar across the top of an empty frame and read as a hole rather than a doorway. Its leaf now lies back against the top jamb as a proper panelled door, handle and all, with the way through left clear below it so whoever is walking through is not hidden behind it.

## v1.19.0

- **Doors.** A new Doors category in the editor, with a door for a gap in an east-west wall and one for a gap in a north-south wall, each drawn open and closed (`renderer/tools/make-doors.mjs`). A door is a 16x48 sprite on a 1x3 footprint whose top two rows lie in the wall, so it can reach above the tile people walk through: its head sits up in the wall's dark top band and its body fills the lit face down to the wall's bottom edge. That geometry was measured off a rendered wall rather than guessed - a wall block is 1 px of outline, 7 px of dark top, 23 px of lit face and 1 px of outline, and that last outline falls 8 px into the tile row, not at its bottom. `renderer/test/doors.mjs` covers the behaviour.
- Doors are never walked around. They are left out of the blocked set entirely, so pathfinding treats a doorway as the open floor it is; what a door does is **open when somebody reaches it** (a tile ahead, so it is open by the time they step through) and close again behind them - usually. `DOOR_CLOSE_BEHIND_CHANCE` is 0.65, because people mostly close doors and sometimes do not. One left open is not shut by an invisible timer: the next person to walk past it closes it, the same noticing that gets a stray mug cleared away or a dry plant watered.
- **A toilet is a seat you want the room to yourself for.** While one is sat on, the doors of the room it stands in shut and lock, and because a locked door is in the blocked set, everyone else quietly paths around it - they reroute at the next tile, so nobody is left walking into a shut door. The lock waits for anyone else still inside to leave rather than shutting them in, and lifts the moment the occupant stands up. Which seats are private is catalog data (`privacySeat`, set on the toilet), and the room is found by flooding out from the seat to the doors around it, giving up on anything bigger than `PRIVACY_ROOM_MAX_TILES` so a toilet standing in the open plan cannot lock the whole building.
- **Steam you can actually see.** Each wisp was a single pixel at 45% alpha, which at sixteen pixels to a tile meant nobody ever saw a drink steam. Wisps now leave the cup as one pixel and curl out into a puff as they climb, four of them, rising further and at 80%.
- `renderer/tools/shot.mjs` renders a patch of the live office scaled up, with a colour readout, so a new sprite can be matched to the wall or floor it will actually touch.

## v1.18.0

- **Meetings are an occasional event again, not the office's main activity.** The roll to start one was written to happen once per tick but had no guard, so it ran for every idle agent: a room with twelve people free multiplied the chance by twelve, and a meeting started roughly every ten seconds. Most of the office spent most of its idle time sitting in the meeting room, which is why a glass of water or a steaming cup was so rarely seen. The roll now really does happen once per tick, and `MEETING_CHANCE_PER_SEC` is 0.003 - about one meeting per five and a half idle minutes. Over 30 office days: 36 meetings instead of 77-106, with conversations, meals, drinks, tidying and plant care taking back the time.

## v1.17.1

- Breaks and plant care rebalanced. Making watering prompt-on-sight had turned it into most of what the office did: over 30 office days there were 48 trips with the watering can and only 5 drinks fetched, so a glass of water was a sight nobody ever saw. Watering weights are roughly halved, a break is more likely to be taken, drinks are picked three times as often as something to read, and plants last 16 minutes rather than 10 - sixteen plants on a ten minute cycle is a treadmill. Now around 30 drinks to 35 waterings, with the plants still averaging about half freshly watered.
- `renderer/test/office-audit.mjs` reports the whole mix - actions chosen, items fetched and tidied, plant health, steam - so balance can be measured rather than guessed at.

## v1.17.0

- **Walking past a dry plant is what sets someone off to water it**, the same way walking past a stray mug is what gets it cleared away. A plant that has merely started to fade is now worth watering at all, and one that is parched and close by is acted on far more readily (`PLANT_NOTICE_DISTANCE_TILES` and the `WATER_*_WEIGHT` constants). Someone with a canful waters the worst plants first, nearest within that.
- The office keeps its plants alive as a result: over 30 simulated office days, 56 watering rounds instead of 16, and the plants averaged 65% freshly watered against 18% parched rather than steadily wilting.

## v1.16.1

- Plants dry at their own pace: each draws a fresh figure for how long its watering lasts, within about half again either way, so the office no longer wilts in lockstep - one plant droops while its neighbour is still fine.
- The drying colours go further still: clearly yellow-green partway, golden-olive and darker when parched.

## v1.16.0

- **Fresh coffee steams.** Three wisps climb out of a cup on their own rhythm, wandering sideways and fading as they rise, thinning out over a minute and a half until the drink is cold. Which drinks are served hot is catalog data (`steams: true`, set on the coffee mug), so tea or soup can steam later without touching the engine.
- Thirsty plants read more clearly: the leaves now walk green to yellow-green to dry olive rather than merely losing a little colour. The first attempt was too subtle to see at sixteen pixels.
- `renderer/test/steam.mjs` checks a poured drink steams at once, thins as it cools, and stops.

## v1.15.0

- **Plants are one tile, not two.** Their sprites are 16x32 with every pixel in the lower half, so the declared 1x2 footprint covered a tile of empty air: a two tile footprint in the editor, and an agent standing two tiles away when watering one from above. The sprites are cropped to their bottom tile and bottom-aligned (which also lifts the one plant that sat a few pixels high), and placed plants moved down a row to stay where they were.
- **Plants look thirsty.** Two drier variants of each - faded, then faded further and drooping - shown through a new `thirstCycle` as the time since watering grows, and reset when someone waters them. They start fading at 60% of the way to wanting water, so the office looks thirsty before anyone is sent round with the can.
- Plant dryness is measured in office time rather than wall-clock time, so a tab left in the background does not come back to a room full of dead plants.
- `renderer/tools/crop-plants.mjs` and `make-thirsty-plants.mjs` generate the sprites; `renderer/test/plants.mjs` checks a plant passes through watered, fading and parched.

## v1.14.0

- **Someone waters the plants.** An agent fetches the watering can from a sink or water cooler, does the rounds of the plants that have not had a drink lately, and goes back for more water after a few of them - then puts the can away. Driven by catalog data like the other utensils: a new `utensilUse: "water"` with `utensilTargets` (what it is used on) and `utensilUses` (plants per fill). Plants on shelves or boxed in by desks are not counted, since nobody can stand next to them.
- **Cups and plates you placed yourself get cleared away too.** Anything drinkable or edible from the layout is fair game for tidying; books and paper are left alone as decoration, and so is the watering can. They are only hidden, never removed from your layout, so reloading brings them all back.
- New sprite: `renderer/tools/make-watering-can.mjs` draws the can in the same style as the mug.

## v1.13.0

- **The office keeps office hours.** Meals peak around noon and drinks in the first hours of the day, both thin out overnight, and everything still happens at its normal rate in between (`OFFICE_MEAL_HOURS`, `OFFICE_DRINK_HOURS`). Measured over 40 office days: 12 meals in the lunch hours against 1 overnight.
- **Lamps burn where people are.** After dark a desk lamp stays lit only while someone is working within a few tiles of it, so the office ends up lit in pools around whoever is still at it.
- **A wall panel that means something.** "Wall Panel - Office Load" is a gauge whose bars follow how many agents are working, through a new catalog cycle `loadCycle` (ordered quiet to busy, picked by state like the clocks' `timeCycle`). The server racks take a new `loadReactive` flag and blink up to three times faster as the office gets busy.
- **Nearest means nearest to walk to.** Choosing a coffee machine, a bin or a stray mug now measures the real route with the same pathfinding the agents walk with, not straight-line distance - a bin three tiles away through a wall no longer beats one eight tiles down the corridor. Only the closest few candidates are measured, so it stays cheap.
- **One at a time at the coffee machine.** Agents prefer a machine nobody is using, and where there is only one they wait beside it for their turn instead of brewing through each other. The claim is released the moment the drink is handed over, so sitting down to eat no longer keeps the fridge looking busy.
- `renderer/test/office-day.mjs` simulates whole office days against live state and reports the rhythm, plus the engine `debug()` hook it reads.

## v1.12.1

- The wall clocks now read quarter hours, with both hands. The first cut stepped in half hours, which meant the minute hand only ever pointed straight up or straight down and flipped 180 degrees on every step - flapping rather than telling the time. At quarters it steps 90 degrees the same way round each time and sweeps. 48 dial frames per clock.
- Note when changing catalog data on the relay: it reads the catalog and sprites at startup only, so an upload needs `sudo systemctl restart pixel-agents-relay`. `relay/deploy.sh` restarts it only when relay code changed.

## v1.12.0

- **The two wall clocks tell the office's time.** Both dials are driven by the same cycle as the sun, so they agree with the daylight in the windows: the day phase reads as 06:00 to 20:00 and the night phase as the hours back round to dawn. A five minute office day means a hand moves every few seconds.
- Done with a new catalog cycle, `timeCycle`: 24 dial frames per clock (half hours, as fine as a seven pixel face can show), chosen by the time of day rather than by a timer like the other cycles. The renderer needed no idea what a clock is, and the native renderer's damage tracking noticed the swaps by itself. Frames are generated by `renderer/tools/make-clock-frames.mjs`, which finds each dial in the art, clears the hands painted on it and draws new ones clipped to the face.
- The office's day now runs whether or not sunlight is drawn. It used to advance only while the sunlight option was on, which would have quietly stopped the clocks.

## v1.11.3

- Fix: a wall-mounted item was drawn behind the wall when mounted on the upper or lower part of one - on a pillar, on a thick wall, or simply nudged up half a tile. A wall sprite is drawn a tile taller than its tile and sorts by that tile's bottom, so the wall below an item, and its own wall once the item moved up, painted over it. Such items now sort in front of every wall sprite that overlaps them, which is safe because walls are not walkable and nothing can stand between. Items hanging over open floor keep their own sort, so furniture and characters in the room still occlude them.

## v1.11.2

- Three wall-mountable screens added to the live catalog (Wall tab): **Wall Monitor** (the desk monitor's screen, no stand), **Wall Panel - Graphs** (bar charts and trend lines, 7 frames) and **Wall Panel - Console** (terminal text scrolling, 6 frames). The two animated ones use the catalog's `idleCycle`/`randomIdleCycle`, the same mechanism the server racks blink with, so they run on their own with no agent nearby. All are 1x1, wall-only, and half-tile placeable. Generated by `renderer/tools/make-wall-panels.mjs` from `MONITOR_FRONT_ON.png`; the sprites and catalog live on the relay Pi.
- Note for placing them: a wall tile with another wall tile *below* it (a pillar, or the top of a two-tile-thick wall) draws over anything mounted on it, because the lower wall sprite extends a tile upwards. Mount them on a wall with floor below.

## v1.11.1

- Fix: a half-tile item could not be nudged onto a desk standing against a wall - the one spot where a mug looks like it sits *on* the desk rather than on its front edge. Placement checked the tile the item leans into (the wall) instead of the one it rests on, so it was refused. It now checks the resting row; a mug over a plain wall with no desk under it is still refused.

## v1.11.0

- **The tablet stream is sent at the office's own resolution (512x300) instead of being upscaled to 1024x600 first.** The viewer app already scales frames to fit with filtering off, which is the same nearest-neighbour doubling the renderer was doing, so the picture is pixel-identical - but the frame is a quarter of the bytes: less conversion, a quarter of the compression work and of the network (about 600 KB/s -> 150 KB/s), and a quarter of the tablet's decode. Set with `width`/`height`/`zoom`/`upscale` in `~/.pixel-agents/renderer.json`.
- Relay: when the renderer's frame size changes, connected stream clients are ended so they reconnect and read the new CONFIG. A client is told the size once, when its stream opens, and sizes its bitmap from it, so without this it would decode the new frames into the old bitmap.
- Note: half resolution and crisp nameplates are mutually exclusive. Nameplate text cannot survive being doubled, which is what the full-resolution overlay existed for; with the stream at 512x300 there is no overlay, so turning `showNametags` back on for kiosk displays means blocky labels. Raise `width`/`height`/`upscale` back to 1024x600/2 if you want them.

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
