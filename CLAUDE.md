# Pixel Agents - Compressed Reference

**Read and follow `PLAYBOOK.md` at the start of every conversation and after every compaction** (all of section 0, and the 0.6 voice); product decisions defer to `VALUES.md` (not written yet - see the adoption note). If this session resumed from a compacted or summarized context, the first line of your first reply MUST be, verbatim:

> ⚠️ COMPACTION NOTICE - THIS SESSION RESUMED FROM A COMPACTED / SUMMARIZED CONTEXT ⚠️

then one plain line: detail from before may be lost, you trust this file and memory over recall, and Mikkel should correct anything that looks off.

**This project's agent is named Pantograph** (short form Panto; chosen 2026-09-18, reasoning in `docs/NAME.md`, roster line in the Playbook's Appendix E). Use it when writing to a sibling or signing a handover - you are Pantograph, not "the Pixel Agents agent".

## House rules (mirrored from the playbook; the playbook wins where they differ)

- **Typography.** Never an em dash, en dash or ellipsis character in anything you produce - code, comments, UI strings, docs, commit messages, replies. Plain `-` and `...`. Sweep before shipping: `grep -rnP '\x{2014}|\x{2013}|\x{2026}' --exclude=PLAYBOOK.md --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build .` The upstream fork's older files still carry them; clean a file when you touch it.
- **Branches.** `main` is the release branch: it is what the Pi relay and the daemon on this box run. Do work on a branch cut FROM `main`, deploy and verify FROM that branch, then fast-forward `main`. Never commit to `main` directly - not a feature, not a one-line fix, not a version bump. Before starting: `git log --oneline main..<branch>` (only your commits) and `git diff --name-only main...<branch>` (three dots; only your files). Before every commit: `git branch --show-current` must not print `main`. Adopted 2026-09-21; everything before that was committed straight to `main` and stays as it is.
- **Versioning.** Single source of truth: `version` in `package.json` (the relay reads it, shows it in the DEV console and at `/api/build`; `BUILD_NUMBER` in `src/constants.ts` is only for VSIX packaging). Bump on the branch with a `CHANGELOG.md` entry, before merging:

  | Bump | Here that means |
  |---|---|
  | MAJOR | every viewer and daemon must update together: relay WebSocket protocol, sync-file shape, a catalog schema break |
  | MINOR | anything Mikkel can see or set: a new idle behaviour, View option, catalog field, deploy capability |
  | PATCH | fixes, constant tuning, placeholder sprites, installer/deploy fixes |
  | none | docs, comments, README, playbook sync, refactors with no observable change - say so in the commit message |

  Enforced by `relay/deploy.sh`: it refuses when the live `/api/build` version equals `package.json` but the build differs (`--allow-same-version` is the deliberate docs-only exception).
- **Changing the playbook.** Canonical: `github.com/Maaggel/Playbook`, clone at `~/projects/Playbook`; never edit the vendored copy. Five steps, all of them: 1) edit and re-read the changed lines so you know the edit landed; 2) bump `VERSION` and the version in the file's own header; 3) `CHANGELOG.md` entry with the why; 4) push, then `npm run sync-playbook` here (it shows the diff; commit the sync on its own); 5) read what changed and reconcile this file against it, in that same commit. Check for updates at the start of substantial work and before a release: `gh api repos/Maaggel/Playbook/contents/VERSION -H "Accept: application/vnd.github.raw"` against the `PLAYBOOK.md` header; offer the sync, never mid-release.
- **Siblings and the mailbox.** The other Claude agents on Mikkel's projects are siblings with self-chosen names (Playbook Appendix E). Address them by name, warmly, teammate to teammate. The mailbox is `~/projects/Playbook/mailbox/`, **one folder per conversation between two siblings**, named by both repos, lowercased, sorted, joined with `+` (`blommemix+pixel-agents`, `pixel-agents+tabscreen`). Mikkel is not a participant and never names a folder; he may drop a `from: Mix` message into a pair's folder, and talks to me directly in this session otherwise. Find ours with `ls -d ~/projects/Playbook/mailbox/{pixel-agents+*,*+pixel-agents}/ 2>/dev/null`. **Mail waiting on me is only a file whose `to:` is me and whose `status:` is `unread`** - the folder holds my own sent files too (the first mistake available is answering yourself), and a file without frontmatter is not a message. Files are `<date>-<HHMM>-<sender-repo>-<slug>.md` with `time:` in the frontmatter. Check when Mikkel says something is waiting. Mark read in place (`status: read`, `read: <date>`); reply by writing the next file **into the same folder**; never delete a message that is unread or under 7 days old; leave empty folders alone. The per-recipient inboxes (`mailbox/pixel-agents/`) are gone - never list one as an inbox; if such a folder exists, a sibling wrote on the old scheme: relocate its messages into the conversation folder, tell Mikkel who, remove the folder. **Show Mikkel everything:** when a check finds messages, open your reply with the banner `📬 MAILBOX - N message(s) for Panto (pixel-agents)` and print each message in full in a fenced block; every reply you write gets `📤 MAILBOX REPLY - to <Name> (<repo>): <filename>` followed by its full text. Never just summarise.

**Adoption status (2026-09-21):** playbook vendored (v1.25.0) and this file reconciled; `VALUES.md` and the kickoff-as-archaeology interview (section 0.5) are still to do - ask Mikkel for a quiet moment. Recorded deviation: a single-developer project where `main` is both integration and release branch, handled by the branch rule above.

## Server map (compaction-critical)

- **Claude Code + daemon:** this box (thinkstation, 192.168.0.212). `pixel-agents-daemon` runs as a user systemd unit (`systemctl --user`, needs `XDG_RUNTIME_DIR=/run/user/1000` in non-login shells); bundle in `~/.local/share/pixel-agents-daemon/`, config `~/.pixel-agents/daemon.json`.
- **Legacy viewer app:** `android/` (Gradle, minSdk 16; `android/README.md`). Build with the SDK at `~/Android/sdk` and `JAVA_HOME=~/.local/jdk`; APK lands in `build/`. Sideloaded over adb.
- **Frame renderer (legacy tablet):** also this box, user unit `pixel-agents-renderer` (`renderer/install.sh`; `renderer/README.md`). Native since v1.9.0: `renderer/native-publisher.mjs` runs the office engine in Node with Skia, no browser (`--chrome` installs the old puppeteer renderer as a fallback). Feeds the relay's `GET /stream`. This box is a 2-core/4-thread i3 shared with Mikkel's Claude sessions, which always win: the renderer runs `CPUSchedulingPolicy=idle` and neither unit is pinned (pinning to CPUs 1,3 forced a shared physical core and cost the sessions 2-3x on short bursts), and the renderer idles unless `/api/stream` shows a client. **Judge any change with `npm run bench:latency` in `renderer/`, never a throughput benchmark** - a long CPU-bound job showed 4% where real burst latency was 2-3x. Compare by freezing the service (`kill -STOP`/`-CONT`) with interleaved runs; Mikkel's own load drifts more than the effect. `npm run bench` gives the per-frame cost (~8 ms at 1024x600). **Text drawing in the headless Skia canvas degrades over a long run** (nametags went 1.4 ms -> 96 ms a frame over 19 hours and starved the tablet to 2 fps), so nametag text is cached as images and a watchdog restarts the service when a frame exceeds 4x its healthy CPU cost; to diagnose the live process, `kill -USR1` its MainPID and attach to the inspector on 127.0.0.1:9229. The CPU governor is `performance` via the `cpu-performance.service` unit Mikkel installed 2026-09-22 (root); under the old `schedutil` every frame paid a wake-up penalty that inflated `top` ~3x.
- **Relay + web UI:** the Blommemix Pi, 192.168.0.51 (`apps.blommemix.dk` / `admin.blommemix.dk`), `https://apps.blommemix.dk/pixelagents`, root `/var/www/blommemix.dk/subdomains/apps/public_html/pixelagents`, system unit `pixel-agents-relay`. `data/` there (layout + backups) is live state, root-owned, never written by us. Furniture sprites and the catalog live only there (gitignored here); patch the catalog over FTP, never delete under `dist/assets`.
- **Deploy:** `source ~/.pixel-agents/deploy.env && npm run deploy` (everything: webview, relay, daemon, and `renderer/refresh.sh` which rebuilds the headless engine and restarts the tablet renderer - nothing else restarts it) or `npm run deploy:ui` (webview only). The renderer stamps the version it is running into the bottom left of the tablet's picture, so what is live is visible on the wall. FTP via `~/.pixel-agents/relay-ftp.netrc`; relay restart through the SSH gate `pixelagents-deploy` (`ssh pixelagents-deploy commands` lists what it allows; one command per connection). Viewers reload themselves via the build id.
- **Secrets (names only, never commit):** `~/.pixel-agents/daemon.json` (relay token), `~/.pixel-agents/relay-ftp.netrc`, `~/.pixel-agents/deploy.env`, `~/.ssh/pixelagents_deploy`. Nothing secret belongs in this repo.

VS Code extension with embedded React webview: pixel art office where AI agents (Claude Code terminals) are animated characters.

**Testing**: The developer ALWAYS uses the standalone viewer (`standalone.sh` / `standalone.bat`) for testing, not the Extension Dev Host. When debugging webview issues, check the standalone browser's DevTools console (F12), not VS Code's.

## Architecture

```
src/ - Backend (Node.js). Only extension.ts + vscodeHost.ts may import 'vscode'
  constants.ts - All backend magic numbers/strings (timing, truncation, asset parsing, VS Code IDs, daemon)
  extension.ts - VS Code entry: activate(), deactivate() - builds a Host, starts PixelAgentsBackend
  daemon.ts - Headless entry (Linux service): ProjectManager polls the session registry, one backend per live project cwd → relay
  claudeSessions.ts - Live `claude` process discovery: ~/.claude/sessions/<pid>.json (+procStart pid-reuse guard), /proc fallback
  host.ts - Host interface: discovery mode, workspace folders, settings, terminals, KeyValueStore, log. MessageSink/TerminalHandle types
  vscodeHost.ts - Host implementation over the VS Code API + terminal event wiring
  PixelAgentsViewProvider.ts - PixelAgentsBackend: agent tracking, sync writes, relay push (takes a Host; no vscode)
  assetLoader.ts - PNG parsing, sprite conversion, catalog building, default layout loading
  agentManager.ts - Agent lifecycle: unbind, remove, restore, persist; getProjectDirPath (cwd → ~/.claude/projects hash)
  layoutPersistence.ts - User-level layout file I/O (~/.pixel-agents/layout.json), migration, cross-window watching
  fileWatcher.ts - fs.watch + polling, readNewLines, /clear detection, terminal adoption
  transcriptParser.ts - JSONL parsing: tool_use/tool_result → webview messages
  timerManager.ts - Waiting/permission timer logic
  types.ts - Shared interfaces (AgentState, PersistedAgent)
  relayClient.ts - WebSocket publisher → relay (global WebSocket, falls back to `ws` package)

webview-ui/src/ - React + TypeScript (Vite)
  constants.ts - All webview magic numbers/strings (grid, animation, rendering, camera, zoom, editor, game logic, notification sound)
  notificationSound.ts - Web Audio API chime on agent turn completion, with enable/disable
  App.tsx - Composition root, hooks + components + EditActionBar
  hooks/
    useExtensionMessages.ts - Message handler + agent/tool state
    useEditorActions.ts - Editor state + callbacks
    useEditorKeyboard.ts - Keyboard shortcut effect
  components/
    BottomToolbar.tsx - + Agent, Layout toggle, Settings button
    ZoomControls.tsx - +/- zoom (top-right)
    SettingsModal.tsx - Centered modal: settings, export/import layout, sound toggle, debug toggle
    useWakeLock.ts - Screen Wake Lock (keep display on while visible; re-requests on visibilitychange and first gesture), driven by ViewOptions.keepAwake (default on)
    ViewOptionsPanel.tsx - "View" dropdown (top-right): per-overlay toggles persisted in localStorage `pixel-agents-view-options`; `hideUi` = display mode - App.tsx gates every overlay on `!hideUi` except OfficeCanvas, ToolOverlay (in-world labels) and the panel's own faint "Show UI" button. Enabling it exits edit mode.
    DebugView.tsx - Debug overlay
  office/
    types.ts - Interfaces (OfficeLayout, FloorColor, Character, etc.) + re-exports constants from constants.ts
    toolUtils.ts - STATUS_TO_TOOL mapping, extractToolName(), defaultZoom()
    colorize.ts - Dual-mode color module: Colorize (grayscale→HSL) + Adjust (HSL shift)
    floorTiles.ts - Floor sprite storage + colorized cache
    wallTiles.ts - Wall auto-tile: 16 bitmask sprites from walls.png
    sprites/
      spriteData.ts - Pixel data: characters (6 pre-colored from PNGs, fallback templates), furniture, tiles, bubbles
      spriteCache.ts - SpriteData → offscreen canvas, per-zoom WeakMap cache, outline sprites
    editor/
      editorActions.ts - Pure layout ops: paint, place, remove, move, rotate, toggleState, canPlace, expandLayout
      editorState.ts - Imperative state: tools, ghost, selection, undo/redo, dirty, drag
      EditorToolbar.tsx - React toolbar/palette for edit mode
    layout/
      furnitureCatalog.ts - Dynamic catalog from loaded assets + getCatalogEntry()
      layoutSerializer.ts - OfficeLayout ↔ runtime (tileMap, furniture, seats, blocked)
      tileMap.ts - Walkability, BFS pathfinding
    engine/
      characters.ts - Character FSM: idle/walk/type + wander AI
      officeState.ts - Game world: layout, characters, seats, selection, subagents
      gameLoop.ts - rAF loop with delta time (capped 0.1s)
      renderer.ts - Canvas: tiles, z-sorted entities, overlays, edit UI
      matrixEffect.ts - Matrix-style spawn/despawn digital rain effect
    components/
      OfficeCanvas.tsx - Canvas, resize, DPR, mouse hit-testing, edit interactions, drag-to-move
      ToolOverlay.tsx - Activity status label above hovered/selected character + close button

scripts/ - 7-stage asset extraction pipeline
  0-import-tileset.ts - Interactive CLI wrapper
  1-detect-assets.ts - Flood-fill asset detection
  2-asset-editor.html - Browser UI for position/bounds editing
  3-vision-inspect.ts - Claude vision auto-metadata
  4-review-metadata.html - Browser UI for metadata review
  5-export-assets.ts - Export PNGs + furniture-catalog.json
  asset-manager.html - Unified editor (Stage 2+4 combined), Save/Save As via File System Access API
  generate-walls.js - Generate walls.png (4×4 grid of 16×32 auto-tile pieces)
  wall-tile-editor.html - Browser UI for editing wall tile appearance
```

**Headless daemon**: `npm run build` also emits `dist/pixel-agents-daemon.cjs` (bundled WITHOUT `vscode` external - a `vscode` import anywhere in the backend fails the build). `npm run package:daemon` builds only the daemon (no webview) and tars it with `daemon/install.sh` into `build/pixel-agents-daemon-<ver>.tar.gz` (~60 KB, `ws` bundled so Node 18+ suffices). On the Claude Code server, as the user running `claude`: `./install.sh --relay-url ... --relay-token ...` → copies to `~/.local/share/pixel-agents-daemon/`, writes `~/.pixel-agents/daemon.json`, installs+starts a user systemd unit, enables linger (may need `sudo loginctl enable-linger`); `--system` for a system unit, `--uninstall` to remove. No folder list needed. Persists to `~/.pixel-agents/daemon-state/`. Full guide: `daemon/README.md`.

**Viewer auto-reload** (`relay/server.mjs`): `currentBuildId()` = sha256(dist/webview/index.html + relay source hash + version), recomputed when index.html's mtime/size changes. Sent in every viewer `init` and in `reload` broadcasts; the bridge script embeds `LOADED_BUILD` at page-serve time and `reloadForBuild()` calls `location.reload()` on mismatch (sessionStorage guard: ≤1 reload / 30 s). `GET /api/build` (public) shows the live id; `POST /api/reload` (token) broadcasts. index.html is `Cache-Control: no-cache`. Deploy flow: upload `dist/` → POST reload (no restart); relay-code changes → restart, viewers reload on reconnect.

**Relay deploy**: restarting the relay drops every tablet's stream and their app takes over a minute to come back, so `deploy.sh` restarts it **only when the relay's own code changed** (hash of `relay/*.mjs` + `relay/package.json` against `relay/.deployed-code` on the host). A version bump alone does not: the relay re-reads `package.json` whenever it recomputes the build id. `relay/deploy.sh` (FTP via `~/.pixel-agents/relay-ftp.netrc`, env `PIXEL_AGENTS_RELAY_HTTP`/`_TOKEN`) uploads `dist/assets` + `dist/webview` (index.html last), prunes stale `index-*.js/css`, stages `relay/server.mjs` + `package.json` (need a service restart), POSTs `/api/reload`. Never touches `data/`. Furniture sprites under `dist/assets/furniture` are gitignored and exist only on the server - never delete under `dist/assets`.

**Session discovery** (`Host.discovery()`): `'terminals'` (VS Code) keeps the terminal + JSONL-mtime heuristics in `fileWatcher.ts`. `'registry'` (daemon) disables those and instead `claudeSessions.ts` reads `~/.claude/sessions/<pid>.json` (pid, sessionId, cwd, name, procStart) every 2s + on `fs.watch`; an entry counts only if the pid is alive AND `/proc/<pid>/stat` starttime == `procStart` (pid-reuse guard); duplicates collapse on sessionId. Fallback when the registry dir is missing: `/proc` scan for `claude` cmdlines → cwd → newest non-ended JSONL whose tail contains `"cwd":<cwd>`. `PixelAgentsBackend.applyLiveSessions()` reconciles: new session → bind unbound `main` definition, else marker/single unbound definition, else ad-hoc agent (offset = file size, `lastDataAt` = mtime, polls if the JSONL doesn't exist yet); vanished session → definition agents unbind (idle), ad-hoc removed. Registry-bound agents get `pid`, `sessionName` (user-set names win on nametags) and a synthetic `terminalRef` `{name:'claude:<pid>'}` so terminal-aware logic (orchestrator detection, dedup) treats them as live. `ProjectManager` in `daemon.ts` creates a backend per cwd on first sighting and disposes it `DAEMON_PROJECT_LINGER_MS` (5 min) after its last session exits; `--folder` pins, `--include`/`--exclude` filter by cwd prefix; `SIGUSR1` logs a tracking summary.

## Core Concepts

**Vocabulary**: Terminal = VS Code terminal running Claude. Session = JSONL conversation file. Agent = webview character bound 1:1 to a terminal.

**Extension ↔ Webview**: `postMessage` protocol. Key messages: `openClaude`, `agentCreated/Closed`, `focusAgent`, `agentToolStart/Done/Clear`, `agentStatus`, `existingAgents`, `layoutLoaded`, `furnitureAssetsLoaded`, `floorTilesLoaded`, `wallTilesLoaded`, `saveLayout`, `saveAgentSeats`, `exportLayout`, `importLayout`, `settingsLoaded`, `setSoundEnabled`.

**One-agent-per-terminal**: Each "+ Agent" click → new terminal (`claude --session-id <uuid>`) → immediate agent creation → 1s poll for `<uuid>.jsonl` → file watching starts.

**Terminal adoption**: Project-level 1s scan detects unknown JSONL files. If active terminal has no agent → adopt. If focused agent exists → reassign (`/clear` handling).

## Agent Status Tracking

JSONL transcripts at `~/.claude/projects/<project-hash>/<session-id>.jsonl`. Project hash = workspace path with `:`/`\`/`/` → `-`.

**JSONL record types**: `assistant` (tool_use blocks or thinking), `user` (tool_result or text prompt), `system` with `subtype: "turn_duration"` (reliable turn-end signal), `progress` with `data.type`: `agent_progress` (sub-agent tool_use/tool_result forwarded to webview, non-exempt tools trigger permission timers), `bash_progress` (long-running Bash output - restarts permission timer to confirm tool is executing), `mcp_progress` (MCP tool status - same timer restart logic). Also observed but not tracked: `file-history-snapshot`, `queue-operation`.

**File watching**: Hybrid `fs.watch` + 2s polling backup. Partial line buffering for mid-write reads. Tool done messages delayed 300ms to prevent flicker.

**Extension state per agent**: `id, terminalRef, projectDir, jsonlFile, fileOffset, lineBuffer, activeToolIds, activeToolStatuses, activeSubagentToolNames, isWaiting`.

**Persistence**: Agents persisted to `workspaceState` key `'pixel-agents.agents'` (includes palette/hueShift/seatId). **Layout persisted to `~/.pixel-agents/layout.json`** (user-level, shared across all VS Code windows/workspaces). `layoutPersistence.ts` handles all file I/O: `readLayoutFromFile()`, `writeLayoutToFile()` (atomic via `.tmp` + rename), `migrateAndLoadLayout()` (checks file → migrates old workspace state → falls back to bundled default), `watchLayoutFile()` (hybrid `fs.watch` + 2s polling for cross-window sync). On save, `markOwnWrite()` prevents the watcher from re-reading our own write. External changes push `layoutLoaded` to the webview; skipped if the editor has unsaved changes (last-save-wins). On webview ready: `restoreAgents()` matches persisted entries to live terminals. `nextAgentId`/`nextTerminalIndex` advanced past restored values. **Default layout**: When no saved layout file exists and no workspace state to migrate, a bundled `default-layout.json` is loaded from `assets/` and written to the file. If that also doesn't exist, `createDefaultLayout()` generates a basic office. To update the default: run "Pixel Agents: Export Layout as Default" from the command palette (writes current layout to `webview-ui/public/assets/default-layout.json`), then rebuild. **Export/Import**: Settings modal offers Export Layout (save dialog → JSON file) and Import Layout (open dialog → validates `version: 1` + `tiles` array → writes to layout file + pushes `layoutLoaded` to webview).

## Office UI

**Rendering**: Game state in imperative `OfficeState` class (not React state). Pixel-perfect: zoom = integer device-pixels-per-sprite-pixel (1x-10x). No `ctx.scale(dpr)`. Default zoom = `Math.round(2 * devicePixelRatio)`. Z-sort all entities by Y. Pan via middle-mouse drag (`panRef`) or, on touch, double-tap-and-hold then drag (native non-passive touch listeners in `OfficeCanvas`, `TOUCH_DOUBLE_TAP_MS`/`_MAX_DIST_PX`; canvas has `touch-action: none`, so a single tap still yields the synthesized click). **Camera follow**: `cameraFollowId` (separate from `selectedAgentId`) smoothly centers camera on the followed agent; set on agent click, cleared on deselection or manual pan.

**Z-order** (`index.css`): in-world labels `--pixel-overlay-z` 100 / selected 110 < side panels `--pixel-panel-z` 120 < modals `--pixel-modal-z` 300 (backdrop 299). Use the variables, not literals.

**UI styling**: Pixel art aesthetic - all overlays use sharp corners (`borderRadius: 0`), solid backgrounds (`#1e1e2e`), `2px solid` borders, hard offset shadows (`2px 2px 0px #0a0a14`, no blur). CSS variables defined in `index.css` `:root` (`--pixel-bg`, `--pixel-border`, `--pixel-accent`, etc.). Pixel font: FS Pixel Sans (`webview-ui/src/fonts/`), loaded via `@font-face` in `index.css`, applied globally.

**Characters**: FSM states - active (pathfind to seat, typing/reading animation by tool type), idle (wander randomly with BFS, return to seat for rest after `wanderLimit` moves). Idle pacing lives in `constants.ts`: `SEAT_REST_MIN/MAX_SEC` (150-420 s between outings), `INITIAL_IDLE_SEAT_REST_MIN/MAX_SEC` (120-300 s after finishing work), `WANDER_MOVES_BEFORE_REST_MIN/MAX` (1-3), and `IDLE_ACTION_REGISTRY` weights in `engine/idleActions.ts` (wander 10, conversation 35, visit furniture 35, think 10, eating 230 in kitchen). Tune these when agents move too much/little. 4-directional sprites, left = flipped right. Tool animations: typing (Write/Edit/Bash/Task) vs reading (Read/Grep/Glob/WebFetch). Sitting offset: characters shift down 6px when in TYPE state so they visually sit in their chair. Z-sort uses `ch.y + TILE_SIZE/2 + 0.5` so characters render in front of same-row furniture (chairs) but behind furniture at lower rows (desks, bookshelves). Chair z-sorting: non-back chairs use `zY = (row+1)*TILE_SIZE` (capped to first row) so characters at any seat tile render in front; back-facing chairs use `zY = (row+1)*TILE_SIZE + 1` so the chair back renders in front of the character. **An empty chair is walked past**: chairs are left out of `getBlockedTiles` and only the tile someone is actually sitting on is blocked, added and removed each tick in `update()` the way a moving vacuum is. They are kept out of `walkableTiles` so nobody chooses to stand on one. Before this a row of chairs walled a room into cells - a plant behind one could never be watered and whoever sat there could not get out - and the office proper went from 182 to 233 of its 340 floor tiles when it changed. `withOwnSeatUnblocked` remains for the seat a character is heading to. **Look assignment** (`office/lookFromName.ts`): a character's look is derived from its nametag - FNV-1a hash → `palette = h % 6`, `hueShift = ((h>>>8) % 8) * 45°` - so the same name renders identically on every device/spawn with nothing stored. Precedence in `addAgent`: explicit look from the backend (`SyncAgentState.lookExplicit === true`, only when a user chose it) → Shuffle override (`localStorage` `pixel-agents-look-overrides`, keyed by lowercased name, written by `shuffleAgentLook`) → hash. `pickDiversePalette()` remains only for Shuffle and sub-agents. Relay/standalone pass palette/hueShift through only when `lookExplicit` (older publishers: non-zero heuristic). Character stores `palette` (0-5) + `hueShift` (degrees). Sprite cache keyed by `"palette:hueShift"`.

**Spawn/despawn effect**: Matrix-style digital rain animation (0.3s). 16 vertical columns sweep top-to-bottom with staggered timing (per-column random seeds). Spawn: green rain reveals character pixels behind the sweep. Despawn: character pixels consumed by green rain trails. `matrixEffect` field on Character (`'spawn'`/`'despawn'`/`null`). Normal FSM is paused during effect. Despawning characters skip hit-testing. Restored agents (`existingAgents`) use `skipSpawnEffect: true` to appear instantly. `matrixEffect.ts` contains `renderMatrixEffect()` (per-pixel rendering) called from renderer instead of cached sprite draw.

**Dynamic items (utensils)**: data-driven from the catalog - an entry with `utensil: true`, `utensilOrigin` and `utensilDisposal` (asset-name prefixes, e.g. `COFFEE_MUG` ← `COFFEE_MACHINE` → `SINK`) can be fetched, carried, placed and tidied. Set via asset-manager.html "Utensil" section → `5-export-assets.ts` → `furniture-catalog.json`; `useSide` (`front`/`back`/`left`/`right`, asset-manager "Use side"; default front, or the rotation `orientation`) picks which side characters stand on - `findAdjacentWalkableTile(..., preferredSide)` prefers it and falls back to any free side; when a `canPlaceOnSurfaces` item has **no** free tile beside it at all - a mug on the back row of a desk against a wall - it falls back again to standing across the desk, one tile further out with furniture in between, which is what taking it looks like from the outside; used for fetch/dispose/tidy and visit-furniture. `FurnitureCatalogEntry` also keeps the asset `name` (`getCatalogTypesByName(prefix)`, `getUtensilEntries()`). Engine (`idleActions.ts`): `utensilOrigin`/`utensilDisposal`/`utensilEmpty` accept a comma list of asset-name prefixes and `*` globs (`SINK,WATER_COOLER`, `*BOOKSHELF*`) via `getCatalogTypesMatching()`. `utensilUse` is `drink` (default), `item` (same flow as drink: fetched on breaks, placed on the desk - paper, books) or `food`. Live utensils: COFFEE_MUG, GLASS_WATER (sink/cooler→sink), PAPER_SHEET (printer→bin), BOOK (bookshelf→bookshelf), PLATE_FOOD/BOWL_SALAD/SANDWICH (fridge→sink, →empty variants). `FETCH_ITEM` walks to a random origin of a random *drink* utensil, waits `ITEM_FETCH_SEC`, sets `ch.heldItem` (catalog type); `EATING` first fetches a *food* utensil when one is fetchable (`conversationPhase` `'leaving'` = fetch leg, then `'approaching'` back to the kitchen seat, plate placed on the table on sitting); the character walks back and `officeState.placeHeldItem()` drops it as a `PlacedProp` on the *surface* tile in front/beside/behind the seat (`isSurface` = `isDesk` or catalog `surface`, asset-manager "Is Surface"; the same flag gates editor surface placement and surface z-sorting) once seated: the tile in front first, then **along the desk** out to `DESK_SPOT_SEARCH_TILES` either side of it, then the seat's sides and behind, preferring a tile with nothing already standing on it (`hasSurfaceItemAt` - a monitor, a keyboard) and falling back to putting it down on top of something rather than leaving it in their hand for ever (`MAX_PROPS` cap, else "finished"). `TIDY_UP` picks the *nearest* prop that is not targeted by another character and is either **finished with** - an empty, meaning a utensil with a disposal but no origin, which can go at once and from under someone's nose - or older than `PROP_MIN_AGE_SEC` and not in use. **In use means its own owner is sitting beside it and it is younger than `PROP_ABANDONED_SEC`**: anyone else near a mug is simply near a mug, and protecting it from whoever happened to be next to it meant nothing on a desk was ever cleared away, because the person who fetched it sits at that desk. **Props age by `officeState.elapsedSec`, not the wall clock** - they used `performance.now()`, so a fast-forwarded simulation saw mugs eight seconds old after half an office day and the audit reported two things tidied where the office really tidies thirty.; its weight jumps to `TIDY_NEAR_WEIGHT` (70) when such a prop is within `TIDY_NEAR_DISTANCE_TILES` (6) of the agent, walks to it, takes it, walks to the nearest `utensilDisposal` furniture, `ITEM_DISPOSE_SEC`, gone. Props are runtime-only: `officeState.props` rendered as virtual furniture (the utensil's own sprite, surface z-sort) appended in `rebuildFurnitureInstances()`; never saved; editor hit-tests use the layout so they can't be selected. Fetched items get a random `ITEM_COLOR_VARIANTS` entry (adjust-mode hue shift, same as editor furniture color) stored in `ch.itemColor` → bubble, hand (`getItemSprite` in renderer) and `PlacedProp.color`; tidy carries the prop's color. `utensilEmpty` (asset name) = what a food utensil turns into when eating ends: `officeState.finishFoodNear(ch)` (called from `updateEating`) swaps food props within 1 tile to that type and resets their age; the empty variant is itself a utensil with a disposal but no origin (tidied, never fetched). Live: PLATE_FOOD/SANDWICH → PLATE_EMPTY, BOWL_SALAD → BOWL_EMPTY. Multiple food utensils: `FETCH`/`EATING` pick a random fetchable one (live catalog has placeholder `PLATE_FOOD`, `BOWL_SALAD`, `SANDWICH`). Bubbles: `'idle_item'` (frame composed around the utensil's cropped sprite via `getItemBubbleSprite`, `ch.bubbleItemType`) while going to fetch; `'idle_tidy'` (broom) while tidying; both cleared by the action (safety timeout `ITEM_BUBBLE_MAX_SEC`). Held items are drawn by the renderer at `HELD_ITEM_OFFSETS[dir]` (cropped sprite; behind the body when facing up). Debug triggers: Behaviour-log bar buttons Coffee/Food/Tidy → `officeState.triggerDynamicItemAction(kind, selectedAgentId)` (interrupts any solo idle action; 'tidy' ages all props past `PROP_MIN_AGE_SEC`; failures are logged as `System: Items (kind): reason`). `ViewOptions.dynamicItems` (View dropdown, default on) → `officeState.setDynamicItems()`; off clears props and held items and disables both actions. `TileType.FLOOR` doesn't exist - floors are `FLOOR_1..7`.

**Kiosk display options**: relay keeps `data/kiosk-options.json` (`showNametags`, `showSunlight`, `dynamicItems`, `debugLampLights`, `weather`), sends it in viewer `init` and broadcasts `kioskOptions` on change; set from a normal viewer's View dropdown "Apply to kiosk displays" (`vscode.postMessage({type:'kioskOptions'})` -> bridge -> relay) or `POST /api/kiosk` (token). Only `#kiosk` viewers apply them (`App.tsx` message handler). Relay `/stream` drops frames for a client whose socket still holds the previous one (no catch-up); the app skips decoding when `in.available()` is large.

**Steam**: a drink whose catalog entry says `steams: true` records when it was poured (`officeState.pouredAt`, office seconds) and carries `instance.steam` from 1 down to 0 over `STEAM_DURATION_SEC`; `renderSteam()` draws the wisps in the furniture drawable, and `headless/entry.ts` damages a steaming cup every frame since it never looks the same twice.

**Plants**: one tile each (16x16, footprint 1x1) - the originals were 16x32 with an empty top tile, which made agents stand a tile too far away; `renderer/tools/crop-plants.mjs` did the crop and placed plants were moved down a row to match. Each carries a `thirstCycle` of three frames (watered, fading, parched) generated by `make-thirsty-plants.mjs`, chosen from `officeState.plantDryness()` which counts **office time**, not wall-clock time. `renderer/test/plants.mjs` covers it.

**Watering and tidying**: `utensilUse: 'water'` marks a utensil that is *used on* something rather than carried to a desk - the watering can, with `utensilTargets` (asset-name spec of what it waters) and `utensilUses` (targets per fill). `WATER_PLANTS`'s weight comes from `wateringUrge()` - what is dry and whether the agent is walking past it, as `TIDY_UP` does for stray mugs - then it fills at the can's `utensilOrigin`, walks the thirsty plants worst-first (`officeState.isPlantThirsty`, `PLANT_DRY_AFTER_SEC`), refills when dry and puts the can back; every exit path must clear `heldItem` or the agent carries it around forever. `TIDY_UP` also clears away layout-placed cups and plates (`officeState.tidyableFurniture()`, anything utensil-ish that is not `item` or `water`); they are hidden in `clearedLayoutUids`, never removed from the layout, and come back on reload.

**Doors**: catalog data (`isDoor`), in their own `doors` category. A door is a 16x48 sprite on a 1x3 footprint whose top two rows are `backgroundTiles` lying in the wall, so it reaches above the tile people walk through. The east-west door is a state pair (closed/open); the north-south one is a single asset with no open state - edge on it is just the beam of the leaf, and a swung leaf drawn beside it read as a plank however it was angled. `getWallPlacementRow()` drops it so that bottom row lands on the tile you point at, and `layoutToFurnitureInstances` sorts it by `(row + footprintH) * TILE_SIZE`, exactly as the wall pieces beside it. Door tiles are **left out of `getBlockedTiles` entirely**, so pathfinding treats a doorway as open floor - a door is walked through, never around. `officeState.updateDoors()` opens one for anyone standing on it or a step from it (`DOOR_OPEN_AHEAD_TILES`), then rolls once per opening whether they closed it behind them (`DOOR_CLOSE_BEHIND_CHANCE`); one left open is closed by the next person to stand beside it (`DOOR_PASSING_CLOSE_CHANCE_PER_SEC`), never by a timer. Open/closed is an ordinary state pair (`state: on`/`off`, same `groupId`), so the editor's T toggles it - which is why `rebuildFurnitureInstances` has to skip doors in the electronics auto-state branch or an agent working nearby would swing them open. **The toilet is not a desk.** A seat with `privacySeat` is left out of **every** seat picker (`isPrivacySeat`): `findFreeSeat()`, and the two that walk `this.seats` directly to move idle agents toward rest and kitchen seats - miss one and an idle agent gets sent to sit on the loo and reads there all day. A net in `update()` also takes the toilet back off anyone holding it who is not on a visit - before that, an agent could be given the toilet as their seat and sit on it all day. It is visited by the `USE_TOILET` idle action instead: walk over, sit for `TOILET_SIT_MIN/MAX_SEC`, then wash at the nearest `SINK` for `WASH_HANDS_SEC`, then home. The toilet is *borrowed as a seat* for the walk and the sit - that is what unblocks the tile for whoever is heading to it (chairs block everyone but their occupant) and what makes the room lock - and handed back on the way to the sink, via `preToiletSeatId`, so they return to their own desk. On sitting down they take one of two poses at random (`sitPose`, `TOILET_PHONE_CHANCE`): just sitting, or on their phone - the seated idle animation otherwise holds up a sheet of paper, which is not what anyone is doing in there. `PHONE_SPRITE` is drawn at `PHONE_OFFSETS` over the typing frames, whose hands are already up. `renderer/test/toilet.mjs` covers it. `updatePrivacyLocks()` handles the toilet: a seat with `privacySeat` shuts and locks the doors of the room it stands in while it is sat on, found by flooding out from the seat to the doors around it (`roomAround`, capped at `PRIVACY_ROOM_MAX_TILES` so a toilet in the open plan cannot lock the building). A locked door joins `blockedTiles`, and since `characters.ts` rechecks the next tile against that set at every tile boundary, anyone already walking at it reroutes rather than walking into it. The lock waits for anyone else inside to leave, and lifts when the occupant stands. **`yOffset`**: a catalog field that lifts an item's *drawn* sprite by n pixels without moving the tile it belongs to or its depth sorting (`layoutToFurnitureInstances`). Use it to hang something a few pixels higher on a wall: a footprint cannot express three pixels, and growing the footprint to fake it shifts every one of those items already placed in the layout down by a tile.

**Door signs**: a wall-placeable sign (`roomCycle` in the catalog: three frames, free / meeting / in use) that reports on the nearest room worth reporting on. `qualifyingRooms()` treats a room with a `privacySeat` in it as whatever walls and doors enclose that seat, but a **meeting room as its zone**, not its walls - meeting areas are rarely walled off, and flooding out from one swallows the open plan. `rebuildSignRooms()` pairs each sign with the nearest such room once per layout (nothing within `SIGN_ROOM_MAX_DISTANCE_TILES` means the sign stays on its first frame), and `updateDataSprites()` reads that room each tick: someone sitting on a privacy seat in it wins, then anyone mid-meeting in it, else free.

`renderer/test/doors.mjs` checks all of it against the live office - freeze the other characters when testing a door, or passers-by hold it open and the timings become a lottery. **Never judge a door sprite from a preview that composites it onto a rendered frame**: the tool's camera maths sits 8 px below the engine's, and four sprites were drawn 8 px too high before that showed up. `renderer/tools/door-shot.mjs` puts one in the layout and lets the engine draw it, which also shows the z-order - in a north-south wall run the wall below a doorway draws in front of it, so a side door's art stops where that begins.

**The office day**: `getOfficeHour()` in `sunlight.ts` is the office's own clock (its sun cycle read as hours), and behaviour hangs off it: `OFFICE_MEAL_HOURS`/`OFFICE_DRINK_HOURS` multiply those idle weights by hour, and after dark a lamp stays on only while `someoneWorkingNear()` is true. `officeState.getWorkload()` (active agents over `OFFICE_FULL_LOAD_AGENTS`) drives the load gauge's `loadCycle` frames and speeds up `loadReactive` idle cycles. Anything an agent walks to is chosen by `nearestFirst()` in `idleActions.ts`, which measures the real route with `ctx.findPathUnblocked` for the closest few candidates - straight-line distance sends agents through walls. When something in the office is quietly never done - a plant always parched, a mug never cleared - check the layout before the behaviour: `renderer/test/reachability.mjs` reports every plant, utensil and machine nobody can walk to. **A chair tile is blocked for everyone but its own occupant**, so a row of chairs walls a room into cells - the tool reports seats an agent cannot get out of as well. Someone walled in like that can still be seen standing beside the parched plant they cannot water: the can is filled at a sink, and they cannot get out to reach one. `renderer/test/office-day.mjs` simulates office days and prints the rhythm; `office-audit.mjs` reports the whole behaviour mix (actions, items fetched and tidied, plant health, steam) and is the thing to run after touching any idle weight - they compete, and raising one quietly starves the others. The audit closes the relay connection after `init`, so every agent stays frozen busy or idle: for anything that depends on agents really going idle together, use `npm run watch:live` in `renderer/` (`test/watch-live.mjs`, holds the connection open and prints actions and pickups as they happen). A per-second chance rolled inside the character loop is multiplied by however many agents are eligible - roll it once per tick (see `meetingRolled` in `update()`), or a full office fires it constantly.

**Wall clocks**: both clock assets carry a catalog `timeCycle` of 48 dial frames (quarter hours; half hours made the minute hand flip 180 degrees every step). `officeState.updateClockSprites()` picks one from `getOfficeDialFraction()` in `sunlight.ts` - the office's own day, so the dials agree with the daylight - and sets `activeTimeSprite`, which wins over every other cycle sprite in `renderScene`. The sun cycle advances regardless of the sunlight toggle, or the clocks would stop. Frames come from `renderer/tools/make-clock-frames.mjs`. A new cycle type must be added to **three** loaders: `src/assetLoader.ts`, `relay/server.mjs` (the relay loads assets itself) and `furnitureCatalog.ts`. The relay reads the catalog and sprites at startup only, so patching them over FTP needs a relay restart - `relay/deploy.sh` restarts it only when relay code changed.

**Legacy tablet stream**: the relay takes the **first renderer to send a frame as the stream's source** and ignores any other until it disconnects - two publishing at once (a restart overlap, or a `PIXEL_AGENTS_RENDERER_ONCE` screenshot run, which also publishes) interleave frames from two separate simulations and the tablet runs at double rate and jumps.  `relay/lz4.mjs` (LZ4 block codec), `relay/legacyProtocol.mjs` (CONFIG/FRAME_FULL framing, RGB565), relay `GET /stream` + `/api/stream`, `renderer/` (`native-publisher.mjs`: the engine bundled for Node from `webview-ui/src/headless/entry.ts`, drawn with `@napi-rs/canvas` at 512x300 and doubled, nametags/bubbles on a full-res overlay via `renderNametagOverlay`; publishes `[tag][payload]` binary frames over the publisher WebSocket; tag 0x01 LZ4, 0x02 raw deflate; `frame-publisher.mjs` is the old puppeteer path). `headless/entry.ts` replicates the relay bridge's `reconcileAgents` and the canvas-relevant parts of `useExtensionMessages`: when a relay message changes what the browser does, mirror it there. It also does **damage tracking** (`renderDamaged()`): the scene is drawn in full, but only the rectangles it reports are converted and sent. **Anything new that animates must be added there**, or it shows as a stale patch on the tablet until the 2 s full redraw - `npm run test:dirty` in `renderer/` checks that invariant against the live office and is the thing to run after touching the engine's rendering. `renderer.ts` has two headless-only hooks: `TileLayerCache` (floor pass cached per layout/camera) and `setNametagFont`. `#kiosk` in the viewer URL = forced display mode, no restore button, `fitCamera` centres the non-void tiles, vignette off. `relay/deploy.sh` uploads every `relay/*.mjs`. Tests in `renderer/test` need `~/projects/TabScreen` and a JDK.

**Sub-agents**: Negative IDs (from -1 down). Created on `agentToolStart` with "Subtask:" prefix. Same palette + hueShift as parent. Click focuses parent terminal. Not persisted. Spawn at closest free seat to parent (Manhattan distance); fallback: closest walkable tile. **Sub-agent permission detection**: when a sub-agent runs a non-exempt tool, `startPermissionTimer` fires on the parent agent; if 5s elapse with no data, permission bubbles appear on both parent and sub-agent characters. `activeSubagentToolNames` (parentToolId → subToolId → toolName) tracks which sub-tools are active for the exempt check. Cleared when data resumes or Task completes.

**Speech bubbles**: Permission ("..." amber dots) stays until clicked/cleared. Waiting (green checkmark) auto-fades 2s. Sprites in `spriteData.ts`.

**Sound notifications**: Ascending two-note chime (E5 → E6) via Web Audio API plays when waiting bubble appears (`agentStatus: 'waiting'`). `notificationSound.ts` manages AudioContext lifecycle; `unlockAudio()` called on canvas mousedown to ensure context is resumed (webviews start suspended). Toggled via "Sound Notifications" checkbox in Settings modal. Enabled by default; persisted in extension `globalState` key `pixel-agents.soundEnabled`, sent to webview as `settingsLoaded` on init.

**Seats**: Derived from chair furniture. `layoutToSeats()` creates a seat at every footprint tile of every chair. Multi-tile chairs (e.g. 2-tile couches) produce multiple seats keyed `uid` / `uid:1` / `uid:2`. Facing direction priority: 1) chair `orientation` from catalog (front→DOWN, back→UP, left→LEFT, right→RIGHT), 2) adjacent desk direction, 3) forward (DOWN). Click character → select (white outline) → click available seat → reassign.

## Layout Editor

Toggle via "Layout" button. Tools: SELECT (default), Floor paint, Wall paint, Erase (set tiles to VOID), Furniture place, Furniture pick (eyedropper for furniture type), Eyedropper (floor).

**Floor**: 7 patterns from `floors.png` (grayscale 16×16), colorizable via HSBC sliders (Photoshop Colorize). Color baked per-tile on paint. Eyedropper picks pattern+color.

**Walls**: Separate Wall paint tool. Click/drag to add walls; click/drag existing walls to remove (toggle direction set by first tile of drag, tracked by `wallDragAdding`). HSBC color sliders (Colorize mode) apply to all wall tiles at once. Eyedropper on a wall tile picks its color and switches to Wall tool. Furniture cannot be placed on wall tiles, but background rows (top N `backgroundTiles` rows) may overlap walls.

**Furniture**: Ghost preview (green/red validity). R key rotates, T key toggles on/off state. Drag-to-move in SELECT. Delete button (red X) + rotate button (blue arrow) on selected items. Any selected furniture shows HSBC color sliders (Color toggle + Clear button); color stored per-item in `PlacedFurniture.color?`. Single undo entry per color-editing session (tracked by `colorEditUidRef`). Pick tool copies type+color from placed item. Surface items preferred when clicking stacked furniture.

**Undo/Redo**: 50-level, Ctrl+Z/Y. EditActionBar (top-center when dirty): Undo, Redo, Save, Reset.

**Multi-stage Esc**: exit furniture pick → deselect catalog → close tool tab → deselect furniture → close editor.

**Erase tool**: Sets tiles to `TileType.VOID` (transparent, non-walkable, no furniture). Right-click in floor/wall/erase tools also erases to VOID (supports drag-erasing). Context menu suppressed in edit mode.

**Grid expansion**: In floor/wall/erase tools, a ghost border (dashed outline) appears 1 tile outside the grid. Clicking a ghost tile calls `expandLayout()` to grow the grid by 1 tile in that direction (left/right/up/down). New tiles are VOID. Furniture positions and character positions shift when expanding left/up. Max grid size: `MAX_COLS`×`MAX_ROWS` (64×64). Default: `DEFAULT_COLS`×`DEFAULT_ROWS` (20×11). Characters outside bounds after resize are relocated to random walkable tiles.

**Layout model**: `{ version: 1, cols, rows, tiles: TileType[], furniture: PlacedFurniture[], tileColors?: FloorColor[] }`. Grid dimensions are dynamic (not fixed constants). Persisted via debounced saveLayout message → `writeLayoutToFile()` → `~/.pixel-agents/layout.json`.

## Asset System

**Loading**: `esbuild.js` copies `webview-ui/public/assets/` → `dist/assets/`. Loader checks bundled path first, falls back to workspace root. PNG → pngjs → SpriteData (2D hex array, alpha≥128 = opaque). `loadDefaultLayout()` reads `assets/default-layout.json` (JSON OfficeLayout) as fallback for new workspaces.

**Catalog**: `furniture-catalog.json` with id, name, label, category, footprint, isDesk, canPlaceOnWalls, groupId?, orientation?, state?, canPlaceOnSurfaces?, backgroundTiles?. String-based type system (no enum constraint). Categories: desks, chairs, storage, electronics, decor, wall, misc. Wall-placeable items (`canPlaceOnWalls: true`) use the `wall` category and appear in a dedicated "Wall" tab in the editor. Asset naming convention: `{BASE}[_{ORIENTATION}][_{STATE}]` (e.g., `MONITOR_FRONT_OFF`, `CRT_MONITOR_BACK`). `orientation` is stored on `FurnitureCatalogEntry` and used for chair z-sorting and seat facing direction.

**Rotation groups**: `buildDynamicCatalog()` builds `rotationGroups` Map from assets sharing a `groupId`. Flexible: supports 2+ orientations (e.g., front/back only). Editor palette shows 1 item per group (front orientation preferred). `getRotatedType()` cycles through available orientations.

**State groups**: Items with `state: "on"` / `"off"` sharing the same `groupId` + `orientation` form toggle pairs. `stateGroups` Map enables `getToggledType()` lookup. Editor palette hides on-state variants, showing only the off/default version. State groups are mirrored across orientations (on-state variants get their own rotation groups).

**Auto-state**: `officeState.rebuildFurnitureInstances()` swaps electronics to ON sprites when an active agent faces a desk with that item nearby (3 tiles deep in facing direction, 1 tile to each side). Operates at render time without modifying the saved layout.

**Background tiles**: `backgroundTiles?: number` on `FurnitureCatalogEntry` - top N footprint rows allow other furniture to be placed on them AND characters to walk through them. Items on background rows render behind the host furniture via z-sort (lower zY). Both `getBlockedTiles()` and `getPlacementBlockedTiles()` skip bg rows; `canPlaceFurniture()` also skips the new item's own bg rows (symmetric placement). Set via asset-manager.html "Background Tiles" field.

**Surface placement**: `canPlaceOnSurfaces?: boolean` on `FurnitureCatalogEntry` - items like laptops, monitors, mugs can overlap with all tiles of `isDesk` furniture. `canPlaceFurniture()` builds a desk-tile set and excludes it from collision checks for surface items. Z-sort fix: `layoutToFurnitureInstances()` pre-computes desk zY per tile; surface items get `zY = max(spriteBottom, deskZY + 0.5)` so they render in front of the desk. Set via asset-manager.html "Can Place On Surfaces" checkbox. Exported through `5-export-assets.ts` → `furniture-catalog.json`.

**Wall placement**: `canPlaceOnWalls?: boolean` on `FurnitureCatalogEntry` - items like paintings, windows, clocks can only be placed on wall tiles (and cannot be placed on floor). `canPlaceFurniture()` requires the bottom row of the footprint to be on wall tiles; upper rows may extend above the map (negative row) or into VOID tiles. `getWallPlacementRow()` offsets placement so the bottom row aligns with the hovered tile. Items can have negative `row` values in `PlacedFurniture`. Set via asset-manager.html "Can Place On Walls" checkbox.

**Colorize module**: Shared `colorize.ts` with two modes selected by `FloorColor.colorize?` flag. **Colorize mode** (Photoshop-style): grayscale → luminance → contrast → brightness → fixed HSL; always used for floor tiles. **Adjust mode** (default for furniture and character hue shifts): shifts original pixel HSL - H rotates hue (±180), S shifts saturation (±100), B/C shift lightness/contrast. `adjustSprite()` exported for reuse (character hue shifts). Toolbar shows a "Colorize" checkbox to toggle modes. Generic `Map<string, SpriteData>` cache keyed by arbitrary string (includes colorize flag). `layoutToFurnitureInstances()` colorizes sprites when `PlacedFurniture.color` is set.

**Floor tiles**: `floors.png` (112×16, 7 patterns). Cached by (pattern, h, s, b, c). Migration: old layouts auto-mapped to new patterns.

**Wall tiles**: `walls.png` (64×128, 4×4 grid of 16×32 pieces). 4-bit auto-tile bitmask (N=1, E=2, S=4, W=8). Sprites extend 16px above tile (3D face). Loaded by extension → `wallTilesLoaded` message. `wallTiles.ts` computes bitmask at render time. Colorizable via HSBC sliders (Colorize mode, stored per-tile in `tileColors`). Wall sprites are z-sorted with furniture and characters (`getWallInstances()` builds `FurnitureInstance[]` with `zY = (row+1)*TILE_SIZE`); only the flat base color is rendered in the tile pass. `generate-walls.js` creates the PNG; `wall-tile-editor.html` for visual editing.

**Character sprites**: 6 pre-colored PNGs (`assets/characters/char_0.png`-`char_5.png`), one per palette. Each 112×96: 7 frames × 16px wide, 3 direction rows × 32px tall (24px sprite bottom-aligned with 8px top padding). Row 0 = down, Row 1 = up, Row 2 = right. Frame order: walk1, walk2, walk3, type1, type2, read1, read2. No dedicated idle frames - idle uses walk2 (standing pose). Left = flipped right at runtime. Generated by `scripts/export-characters.ts` which bakes `CHARACTER_PALETTES` colors into templates. Loaded by extension → `characterSpritesLoaded` message (array of 6 character sprite sets). `spriteData.ts` uses pre-colored data directly (no palette swapping); hardcoded template fallback when PNGs not loaded. When `hueShift !== 0`, `hueShiftSprites()` applies `adjustSprite()` (HSL hue rotation) to all frames before caching.

**Load order**: `characterSpritesLoaded` → `floorTilesLoaded` → `wallTilesLoaded` → `furnitureAssetsLoaded` (catalog built synchronously) → `layoutLoaded`.

## Condensed Lessons

- `fs.watch` unreliable on Windows - always pair with polling backup
- Partial line buffering essential for append-only file reads (carry unterminated lines)
- Delay `agentToolDone` 300ms to prevent React batching from hiding brief active states
- **Idle detection** has two signals: (1) `system` + `subtype: "turn_duration"` - reliable for tool-using turns (~98%), emitted once per completed turn, handler clears all tool state as safety measure. (2) Text-idle timer (`TEXT_IDLE_DELAY_MS = 5s`) - for text-only turns where `turn_duration` is never emitted. Only starts when `hadToolsInTurn` is false (no tools used yet in this turn); if any tool_use arrives, `hadToolsInTurn` becomes true and the timer is suppressed for the rest of the turn. Reset on new user prompt or `turn_duration`. Cancelled by ANY new JSONL data arriving in `readNewLines`. Only fires after 5s of complete file silence
- User prompt `content` can be string (text) or array (tool_results) - handle both
- `/clear` creates NEW JSONL file (old file just stops)
- `--output-format stream-json` needs non-TTY stdin - can't use with VS Code terminals
- Hook-based IPC failed (hooks captured at startup, env vars don't propagate). JSONL watching works
- PNG→SpriteData: pngjs for RGBA buffer, alpha threshold 128
- OfficeCanvas selection changes are imperative (`editorState.selectedFurnitureUid`); must call `onEditorSelectionChange()` to trigger React re-render for toolbar

## Build & Dev

```sh
npm install && cd webview-ui && npm install && cd .. && npm run build
```
Build: type-check → lint → esbuild (extension) → vite (webview). F5 for Extension Dev Host.

**Packaging VSIX**: Run `vsce package -o "build/pixel-agents-{version}-build{BUILD_NUMBER}.vsix"` to produce the `.vsix` file. **CRITICAL: Before EVERY `vsce package` run**, you MUST increment `BUILD_NUMBER` in `src/constants.ts` by 1 - no exceptions, even if you just built moments ago. When `version` in `package.json` is bumped to a new value, reset `BUILD_NUMBER` back to 1. The output filename MUST include the build number (e.g., `pixel-agents-1.4.4-build14.vsix`).

## TypeScript Constraints

- No `enum` (`erasableSyntaxOnly`) - use `as const` objects
- `import type` required for type-only imports (`verbatimModuleSyntax`)
- `noUnusedLocals` / `noUnusedParameters`

## Constants

All magic numbers and strings are centralized - never add inline constants to source files:

- **Extension backend**: `src/constants.ts` - timing intervals, display truncation limits, PNG/asset parsing values, VS Code command/key identifiers
- **Webview**: `webview-ui/src/constants.ts` - grid/layout sizes, character animation speeds, matrix effect params, rendering offsets/colors, camera, zoom, editor defaults, game logic thresholds
- **CSS styling**: `webview-ui/src/index.css` `:root` block - `--pixel-*` custom properties for UI colors, backgrounds, borders, z-indices used in React inline styles
- **Canvas overlay colors** (rgba strings for seats, grids, ghosts, buttons) live in the webview constants file since they're used in canvas 2D context, not CSS
- `webview-ui/src/office/types.ts` re-exports grid/layout constants (`TILE_SIZE`, `DEFAULT_COLS`, etc.) from `constants.ts` for backward compatibility - import from either location

## Key Patterns

- `crypto.randomUUID()` works in VS Code extension host
- Terminal `cwd` option sets working directory at creation
- `/add-dir <path>` grants session access to additional directory

## Windows-MCP (Desktop Automation)

- `uvx --python 3.13 windows-mcp` - Tools: Snapshot, Click, Type, Scroll, Move, Shortcut, App, Shell, Wait, Scrape
- Webview buttons show `(0,0)` in a11y tree - must use `Snapshot(use_vision=true)` for coordinates
- Snap both VS Code windows side-by-side on SAME screen before clicking in Extension Dev Host
- Reload extension via button on main VS Code window after building

## Key Decisions

- `WebviewViewProvider` (not `WebviewPanel`) - lives in panel area alongside terminal
- Inline esbuild problem matcher (no extra extension needed)
- Webview is separate Vite project with own `node_modules`/`tsconfig`
