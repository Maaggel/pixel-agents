# Pixel Agents — Planned Features

This document captures future feature ideas, organized by priority and complexity.

---

## FUTURE: Standalone-only architecture

**Current situation**: The extension ships both a VS Code webview panel *and* a `standalone/server.mjs` that serves the same React UI in a browser. This creates duplication:
- Asset loading / sprite resolution is implemented independently in `assetLoader.ts` (extension) and `loadFurnitureAssets()` (standalone server), and must be kept in sync manually.
- Dev Console logging, cycle sprite resolution, and any new message types must be wired twice.
- The VS Code webview panel is essentially a browser view inside a frame.

**Proposed direction**: Replace the VS Code webview panel with an embedded browser that points at the standalone server running locally. The extension would:
1. Start `server.mjs` as a child process on activation (or reuse an already-running instance).
2. Open a `WebviewPanel` whose HTML is just an `<iframe src="http://localhost:<port>">` (or use `SimpleBrowser`/`vscode.env.openExternal` to open the browser tab directly).
3. All game logic, asset loading, and UI live only in the standalone server — no duplicate paths.

**Benefits**: Single source of truth for rendering; browser DevTools work naturally; easier to test outside VS Code.

**Blockers**: VS Code webview security model (CSP) restricts iframes to `vscode-resource:` URIs by default — needs `localhost` exception. The `postMessage` bridge between extension and webview also needs to become HTTP polling or WebSocket (which `server.mjs` already supports for sync). Layout save/load would go entirely through the HTTP API.

---

## KNOWN ISSUE: Standalone browser requires webview panel open

**Status**: Partially fixed — `initHeadless()` now runs in `activate()` to restore agents, detect agent definitions, adopt active conversations, and start the sync manager without the webview. However, the **character visual positions** (`characterVisualStates`) are only reported by the webview's game loop, so the sync file won't have `visual` data until the panel is opened at least once. This means agents show in the browser but may lack position/animation data.

**Root cause**: The extension architecture ties agent visual state to the webview's canvas rendering. Without the webview running, there's no game loop computing character positions.

**Possible solutions**:
1. **Accept "panel must be opened once"** — Document that opening the panel once per VS Code window bootstraps the visual state, after which it can be closed. The sync file retains the last-known positions.
2. **Run a headless game loop** — Compute character positions server-side without rendering. This would require extracting the FSM + pathfinding from the webview into a shared module that can run in the extension host. Significant refactor.
3. **Default positions from seat assignments** — When no visual data exists, the standalone browser could place agents at their assigned seat positions (derived from the layout + seatId in sync data). This would give correct resting positions without needing the game loop.

---

## ~~1. Thinking Grace Period (Status Delay)~~ — DONE

Added grace period on extension side. On `turn_duration`, starts `THINKING_GRACE_MS` (6s) timer instead of immediately sending idle status. New activity cancels the timer.

---

## 2. Item / Asset Editor Improvements

**Problem**: The existing `scripts/asset-manager.html` handles sprite metadata (position, bounds, category, footprint) but lacks an intuitive way to configure placement rules.

**Solution**: Enhance the asset editor (or the in-extension editor toolbar) with:
- **Tile selection**: Click a tile type in the palette to see which items can be placed on it
- **Placement rule toggles** per item:
  - `canPlaceOnSurfaces` — can sit on desks/tables
  - `canPlaceOnWalls` — wall-mounted items
  - `backgroundTiles` — how many top rows are "behind" the item
- **Live preview**: Show a ghost of the item on a sample grid with valid/invalid placement feedback
- **Collision visualization**: Highlight blocked tiles vs background tiles vs surface tiles

**Implementation notes**:
- The `asset-manager.html` already has fields for these — this is about making them more discoverable and visual
- Consider adding a "Placement Rules" section with a mini grid preview
- Could also add this as a panel in the in-game editor toolbar (right-click item → "Edit placement rules")

---

## 3. Sub-Agent Persistence Setting

**Problem**: Currently sub-agents materialize with a matrix effect when spawned and despawn when their task completes. Some users may prefer to see them always present.

**Solution**: Add a setting (in the Settings modal) with options:
- **"Appear on use"** (current default) — sub-agents spawn with matrix effect when the Task tool starts, despawn when it completes
- **"Always present"** — sub-agents are created when first seen and persist as idle characters in the office, walking around until their next task

**Implementation notes**:
- Add `subagentPersistence: 'on-use' | 'always'` to settings (persisted in `globalState`)
- Send to webview via `settingsLoaded` message
- In `always` mode: on `subagentClear`, set character to idle instead of calling `removeSubagent()`
- Track known sub-agent definitions so they can be re-used across turns
- Need to handle seat assignment for persistent idle sub-agents

---

## 4. Thought Bubbles

**Problem**: When Claude is thinking (generating text, no tool active), there's no visual indicator above the character — just the "Thinking..." label on hover.

**Solution**: Add a **thought bubble** sprite (cloud-shaped, with animated "..." dots) that appears above the character while thinking, similar to the existing permission and waiting bubbles.

**Implementation notes**:
- Add a new `bubbleType: 'thinking'` to the Character interface
- Create a thought bubble sprite in `spriteData.ts` — classic cloud shape with cycling dots
- Show when `isActive && currentTool === null` (thinking, not using a tool)
- Hide when a tool starts or agent goes idle
- Animate the dots (3 dots cycling opacity, or bouncing) using `bubbleTimer`
- Pairs naturally with the thinking grace period (feature #1) — bubble shows during grace period too
- Render in the same z-layer as other bubbles, positioned above character head

---

## 5. Rich Idle Behaviors & Agent Interactions

**Problem**: Idle agents only wander randomly and sit. The office feels static when agents aren't working.

**Solution**: Add diverse idle activities and inter-agent interactions:

### 5a. Solo Idle Activities
Each idle action has an animation (or placeholder label until sprites exist):

| Activity | Animation | Placeholder |
|----------|-----------|-------------|
| **Reading** | Sit with book sprite overlay | Label: "Reading" |
| **Coffee break** | Walk to kitchen zone, stand at coffee machine, hold mug | Label: "Getting coffee" |
| **Stretching** | Stand in place, arms up animation | Label: "Stretching" |
| **Looking at phone** | Stand, looking down | Label: "Checking phone" |
| **Whiteboard** | Stand facing whiteboard furniture | Label: "At whiteboard" |

**Implementation notes**:
- Add new `CharacterState` values: `READ`, `COFFEE`, `STRETCH`, `PHONE`, `WHITEBOARD`
- Add `idleActivity` field to Character — tracks which activity was chosen
- When entering idle, randomly pick an activity (weighted — reading and coffee more common)
- Activities have a duration (5–15s), after which the agent returns to normal wander cycle
- Zone-aware: coffee only if kitchen zone exists with coffee machine, whiteboard only near whiteboard furniture
- For activities without dedicated sprites, render the character in `SIT_IDLE` or `IDLE` state with a floating label above showing the activity name

### 5b. Inter-Agent Conversations
When two idle agents are near each other, they may start a conversation:

- **Trigger**: Two idle agents within 3 tiles of each other, random chance per wander cycle (~20%)
- **Behavior**:
  1. Both agents pathfind to face each other (1 tile apart)
  2. Alternating speech bubbles appear (small chat bubble, different from thought/permission bubbles)
  3. Conversation lasts 5–10 seconds with 2–4 bubble exchanges
  4. Both agents are "locked" in the interaction
- **Interruption**: If either agent receives a task (`setAgentActive(id, true)`):
  - The working agent immediately breaks off and goes to their seat
  - The still-idle agent returns to normal idle behavior (short pause, then wander)
- **Sprite**: New `bubbleType: 'chatting'` with a small speech bubble (not thought cloud)

**Implementation notes**:
- Add `interactionPartner: number | null` to Character
- Add `interactionState: 'approaching' | 'chatting' | null` to Character
- In the idle FSM: check for nearby idle agents, initiate approach
- When both agents arrive face-to-face: start chat timer with alternating bubbles
- On `setAgentActive()`: check if agent has `interactionPartner`, if so break both out
- Both agents need to be non-sub-agent and non-remote for interaction to start

---

## ~~6. Cross-Window Layout Sync~~ — DONE

Layout shared via `~/.pixel-agents/layout.json` with hybrid `fs.watch` + 2s polling. Cross-window push, edit conflict protection, own-write filtering all working.

---

## ~~7. Standalone Browser View~~ — DONE

Standalone Node.js server (`standalone/server.mjs`) serves webview in browser. Reads layout + polls sync files. API endpoints: `/api/init`, `/api/sync`, `/api/layout`. Run: `npm run standalone`.

---

## 8. Standalone Browser — Project Color Dots Missing

**Problem**: In the standalone browser, the project color dots (colored circle next to agent name in nameplates) are not showing. These work in the VS Code webview.

**Investigation needed**:
- Check if `projectColor` is set on characters created via `existingAgents` in the standalone browser
- The standalone server may not be passing workspace folder info needed for `projectColorFromFolder()`
- Or the nametag rendering code may skip the dot when `isRemote` or when certain fields are missing

---

## 9. Always-Visible Tool Indicators Above Characters

**Problem**: The current tool activity overlay (ToolOverlay) only shows on hover or when the character is selected. Users want to see at a glance what each agent is doing without hovering.

**Solution**: Render lightweight tool indicators directly on the canvas above character heads (not as HTML overlays):
- **Thinking**: Animated thought bubble sprite (cloud with cycling "..." dots) — currently described in feature #4
- **Tool-specific**: Small icon or short label — "Reading", "Edit", "Grep", "Bash", etc.
- Should be toggleable via view options (see #10)
- Only shown for non-idle agents (active + working)

**Implementation notes**:
- Render in `renderer.ts` after character sprites, using the canvas 2D context
- Use small pixel-font text or mini tool icons above the character's head position
- Different from ToolOverlay (HTML) — this is canvas-native for performance and pixel-art consistency
- The thought bubble (#4) is a subset of this feature

---

## 10. Toggleable View Options Panel

**Problem**: The UI has zoom buttons and bottom toolbar that may clutter the view, especially in the standalone browser used as an ambient display.

**Solution**: Add a toggleable view options panel in the upper-right corner with checkboxes for:
- **Zoom buttons** — show/hide the +/- zoom controls
- **Bottom menu** — show/hide the bottom toolbar (+ Agent, Layout, Settings)
- **Nameplates** — show/hide the name labels below characters
- **Activities** — show/hide tool activity indicators; when enabled, show permanently for non-idle agents (not just on hover)

**Design**:
- Small gear/eye icon in top-right corner
- Panel appears on click, fades/becomes semi-transparent when not focused
- Non-intrusive — pixel art aesthetic, minimal opacity when collapsed
- Settings persisted (globalState for VS Code, localStorage for standalone)

**Implementation notes**:
- New React component `ViewOptionsPanel.tsx` in `webview-ui/src/components/`
- State: `{ showZoom, showBottomBar, showNameplates, showActivities }`
- Pass visibility flags down to `OfficeCanvas`, `ZoomControls`, `BottomToolbar`, `ToolOverlay`
- For "Activities always visible": when enabled, render ToolOverlay for all non-idle characters without requiring hover/selection
- CSS: use `opacity` transition, `pointer-events: none` when faded

---

## 11. Standalone Browser — All Avatars Look the Same

**Problem**: In the standalone browser, all spawned agents appear with the same palette/skin color, even though they have different palette and hueShift values in the sync data.

**Investigation needed**:
- Check if `palette` and `hueShift` from the sync file are correctly passed through `existingAgents` → `addAgent()`
- The standalone server's `existingAgents` message includes `agentMeta` with palette/hueShift — verify the webview reads and applies these
- May be a sprite cache issue: if all characters share the same cache key, they'd render identically
- Could also be that the standalone browser doesn't receive character sprite PNGs, falling back to identical templates

---

## 12. Duplicate Agent Entries in Backend Map (Root Cause)

**Problem**: The `agents` Map in the extension backend can contain multiple entries for the same logical agent — e.g., a definition-based agent (from `.pixel_agents` config) AND a file-adopted agent (from JSONL detection) for the same active session. This causes duplicate characters in the sync file and standalone browser.

**Current workaround**: Name-based dedup in `writeSyncState()` merges display state from duplicates onto the lowest-ID entry. This is stable (no flip-flopping) but is a band-aid.

**Root cause**: Agent creation happens through multiple paths (config restore, terminal creation, JSONL adoption) without checking for existing entries that represent the same logical session. When an agent is restored from config AND its JSONL file is separately detected by the file watcher, two entries are created.

**Proper fix**: When adopting a JSONL file or terminal, check if an existing agent (by definitionId or jsonlFile) already covers this session. If so, merge into the existing entry rather than creating a new one. This should happen in `agentManager.ts` (restore) and `fileWatcher.ts` (adoption).

---

## 13. Idle Characters Stay Static — Should Occasionally Roam

**Problem**: In the standalone browser, idle agents stay in the same location and never move. They should occasionally get up and wander — to the kitchen, rest area, or just around the office.

**Existing infrastructure**: The VS Code webview already has a full idle roaming system:
- `SIT_IDLE` → after `seatTimer` expires → `IDLE` state with `wanderLimit` (3-6) random moves
- `ZONE_WANDER_PREFERENCE` (0.7) — 70% chance idle wander targets come from kitchen/rest zones
- `IDLE_ZONE_DELAY_SEC` (10s) — after 10s idle, reassign to a kitchen/rest zone seat
- `reassignToZoneSeat()` — picks a seat in the target zones
- `getZoneWalkableTiles()` — filters walkable tiles by zone type

**Investigation needed**: This system works in the VS Code webview's game loop (`officeState.update()`). For the standalone browser:
- Check if the zone tiles are being loaded/parsed from the layout (zones are part of the layout data)
- Verify the FSM is running correctly — characters may be stuck in `SIT_IDLE` without `seatTimer` being set
- The wander pause timing (2-20s between moves) may feel too infrequent — consider tuning
- Could add more varied destinations: water cooler, windows, bookshelves (weighted by furniture type proximity)

---

## 14. Instant Avatar Activation on User Prompt

**Problem**: When the user submits a message, the avatar stays "Idle" during the thinking phase until the agent starts using tools or responding. It should react immediately when the user submits.

**Current state**: The backend already detects `user` records in the JSONL and sets `isWaiting = false` + sends `agentStateUpdate` (lines 159-174 in `transcriptParser.ts`). This works for the VS Code webview.

**Why it may not work in standalone**: The chain is: Claude Code writes `user` record → `fs.watch`/2s poll detects change → backend parses + sends `agentStateUpdate` → sync file written (200ms debounce) → standalone polls sync file (500ms interval). Total worst-case delay: ~3s. But the real bottleneck may be Claude Code itself — it might not write the `user` record to the JSONL until the assistant starts streaming, which can be 10-30s for complex prompts.

**Investigation needed**:
- Monitor the JSONL file timestamps to determine when Claude Code writes the `user` record — immediately on submit, or when streaming begins?
- If Claude Code delays the write, there's no way to detect the prompt from the JSONL alone
- Alternative: watch the terminal for input activity (VS Code terminal `onDidWriteData` API) as an earlier signal — but this wouldn't help the standalone browser since it has no terminal access
- Could reduce standalone poll interval from 500ms to 200ms for snappier response

---

## 15. In-Browser Asset Manager (Standalone)

**Problem**: The `scripts/asset-manager.html` is a powerful tool for editing furniture metadata (categories, footprints, flags like `interactable`, `isSeat`, `canPlaceOnWalls`, etc.), but it's a standalone file that must be opened manually and works with the raw `tileset-metadata-final.json`. There's no way to directly edit the live `furniture-catalog.json` from within the standalone browser UI.

**Goal**: Make the asset manager accessible from the standalone server's Settings menu and have it edit `furniture-catalog.json` directly (the file that the game actually loads).

**Approach**:
1. **Serve asset-manager.html** from the standalone server at `/asset-manager`
2. **Add "Asset Manager" button** in the Settings modal (only visible in standalone mode via `window.__STANDALONE__` flag set by the bridge script)
3. **Adapt asset-manager.html** to work in two modes:
   - **Tileset mode** (existing): loads a tileset PNG + `tileset-metadata-final.json` via file picker — for the full extraction pipeline
   - **Catalog mode** (new): loads `furniture-catalog.json` directly from the standalone server's API, shows each asset as individual sprites (loaded from the server), and saves back via HTTP POST
4. **New API endpoints** in `server.mjs`:
   - `GET /api/catalog` — returns the current `furniture-catalog.json`
   - `POST /api/catalog` — writes updated catalog back to disk
   - `GET /api/asset-sprite/:id` — serves individual furniture PNG files
5. **Catalog editor UI**: Either adapt asset-manager.html with a catalog-mode branch, or create a simpler dedicated page (`catalog-editor.html`) that focuses on the fields most commonly edited:
   - `interactable` (checkbox) — idle characters visit this
   - `isSeat` (checkbox) — generates a seat
   - `isDesk` (checkbox) — desk surface
   - `canPlaceOnSurfaces` / `canPlaceOnWalls` (checkboxes)
   - `backgroundTiles` (number)
   - `category` (dropdown)
   - `label` (text)
   - Visual preview of each sprite at the configured footprint size
6. **Live reload**: After saving catalog changes, the standalone server should re-run `buildDynamicCatalog()` and push updated assets to connected browsers

**Implementation notes**:
- The standalone server already loads and caches `furniture-catalog.json` at startup (`cachedFurniture`). The catalog API would read/write the source file and invalidate the cache on write.
- Sprite PNGs are already on disk at paths like `assets/furniture/decor/PLANT_1.png` — the asset sprite endpoint just serves these.
- Consider using the same pixel-art CSS variables for consistent styling.
- The tileset pipeline (`scripts/0-import-tileset.ts` through `5-export-assets.ts`) remains the canonical way to add NEW assets from a sprite sheet. The catalog editor is for tuning metadata of already-exported assets.

---

## Priority Order (Remaining) — easiest first

1. **Standalone Avatars Same Palette (#11)** — Likely just passing palette/hueShift through `addAgent()` correctly; small fix
2. **Project Color Dots (#8)** — Pass `workspaceFolder` through standalone server so `projectColorFromFolder()` works; small fix
3. **Instant Activation on Prompt (#14)** — Investigate JSONL write timing; may already work, just delayed
4. **Duplicate Agent Root Cause (#12)** — Merge logic in `agentManager.ts`/`fileWatcher.ts`; moderate but high-value
5. **Idle Roaming in Standalone (#13)** — FSM already works in VS Code; likely just missing seatTimer init or zone data; debug + small fix
6. **Thought Bubbles (#4)** — New sprite + render in canvas; self-contained, no architecture changes
7. **Always-Visible Tool Indicators (#9)** — Canvas text above characters + toggle flag; moderate
8. **Toggleable View Options (#10)** — New React component + visibility flags; moderate, mostly UI wiring
9. **Rich Idle Behaviors (#5)** — Interactions, coffee runs, etc.; larger feature, depends on zone system
10. **Sub-Agent Persistence Setting (#3)** — Nice-to-have toggle; simple but low priority
11. **In-Browser Asset Manager (#15)** — Serve asset-manager in standalone, edit catalog.json directly; moderate, mostly server + UI wiring
12. **Item Editor Improvements (#2)** — Developer tooling; low user-facing priority
