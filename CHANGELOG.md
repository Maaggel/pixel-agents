# Changelog

## Unreleased

- Playbook adopted (vendored v1.20.1, `npm run sync-playbook`); `CLAUDE.md` now carries the bootstrap pointer, house rules, versioning table and server map. Versioning and the branch rule apply from here forward; earlier history is not renumbered. `relay/deploy.sh` refuses a code deploy without a version bump.

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
