# Pixel Agents — Planned Features

This document captures future feature ideas, organized by priority and complexity.

---

## KNOWN ISSUE: Standalone browser requires webview panel open

**Status**: Partially fixed — `initHeadless()` now runs in `activate()` to restore agents, detect agent definitions, adopt active conversations, and start the sync manager without the webview. However, the **character visual positions** (`characterVisualStates`) are only reported by the webview's game loop, so the sync file won't have `visual` data until the panel is opened at least once. This means agents show in the browser but may lack position/animation data.

**Root cause**: The extension architecture ties agent visual state to the webview's canvas rendering. Without the webview running, there's no game loop computing character positions.

**Possible solutions**:
1. **Accept "panel must be opened once"** — Document that opening the panel once per VS Code window bootstraps the visual state, after which it can be closed. The sync file retains the last-known positions.
2. **Run a headless game loop** — Compute character positions server-side without rendering. This would require extracting the FSM + pathfinding from the webview into a shared module that can run in the extension host. Significant refactor.
3. **Default positions from seat assignments** — When no visual data exists, the standalone browser could place agents at their assigned seat positions (derived from the layout + seatId in sync data). This would give correct resting positions without needing the game loop.

---

## 1. Thinking Grace Period (Status Delay) — IMPLEMENTED

**Problem**: Between turns in an agentic loop, `turn_duration` fires and the agent briefly flashes to "Idle" / "Waiting" state — character leaves desk, waiting bubble + done sound play — even though a new turn starts within 1–2 seconds.

**Solution**: Added a **grace period on the extension side**. On `turn_duration`, instead of immediately sending `agentStatus: 'waiting'`, the extension starts a `THINKING_GRACE_MS` (6s) timer using the existing `startWaitingTimer` infrastructure. If a new turn starts (new tool_use or user prompt), `cancelWaitingTimer` fires and the agent stays active without any visible idle flash.

**What changed**:
- `src/constants.ts`: Added `THINKING_GRACE_MS = 6000`
- `src/transcriptParser.ts`: `turn_duration` handler now calls `startWaitingTimer()` instead of immediately sending `agentStatus: 'waiting'`
- `webview-ui/src/hooks/useExtensionMessages.ts`:
  - `agentToolsClear` handler no longer calls `os.setAgentActive(false)` or `os.setAgentTool(null)` — character stays at desk during grace
  - `agentStatus: 'waiting'` handler now also calls `os.setAgentTool(id, null)` to clear the tool when the grace period expires
- During grace period: overlay shows "Thinking...", character keeps typing at desk
- Existing `cancelWaitingTimer` calls throughout the transcript parser automatically cancel the grace timer when new activity arrives

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

## 6. Cross-Window Layout Sync

**Status**: Already implemented! The system has:
- **Layout file**: `~/.pixel-agents/layout.json` — single source of truth, shared across all windows
- **File watcher**: `layoutPersistence.ts` → `watchLayoutFile()` uses hybrid `fs.watch` + 2s polling
- **Cross-window push**: When Window A saves, Window B's watcher detects the change and pushes `layoutLoaded` to the webview
- **Edit conflict protection**: External layout changes are skipped if the local editor has unsaved changes (`isEditDirty` check in `useExtensionMessages.ts`)
- **Own-write filtering**: `markOwnWrite()` prevents the watcher from re-reading our own saves

**Current behavior**: When you edit the layout in Window A and save, all other windows receive the updated layout within ~2 seconds. If Window B is also editing, it won't be overwritten until the editor is closed or saved.

**Potential improvements**:
- Show a notification when an external layout change arrives: "Layout updated from another window"
- Add a "Reload" button if the editor is dirty and an external change was received
- Consider operational transform or CRDT for true concurrent editing (likely overkill)

---

## 7. Standalone Browser View — IMPLEMENTED

A standalone Node.js server (`standalone/server.mjs`) serves the webview in a browser, completely decoupled from VS Code. Reads layout from `~/.pixel-agents/layout.json`, polls sync files from `~/.pixel-agents/sync/` to show agents from all open VS Code windows.

### Quick Start

```bash
# 1. Build the extension (if not already built)
npm run build

# 2. Start the standalone server
npm run standalone

# 3. Open in your browser
#    http://localhost:3000
```

To use a custom port:
```bash
node standalone/server.mjs --port 8080
```

### Prerequisites

- The extension must be built first (`npm run build`) so the webview dist files exist
- At least one VS Code window with the Pixel Agents extension must have the panel opened once, so that agent positions are written to the sync files
- No additional dependencies are needed — the server uses `pngjs` (already a project dependency) and Node.js built-in modules

### How It Works

- Serves the Vite-built webview with an injected bridge script that mocks `acquireVsCodeApi()`
- Parses PNGs server-side (characters, floors, walls, furniture) using pngjs
- API endpoints: `/api/init` (all assets + layout), `/api/sync` (all window states), `/api/layout`
- Polls sync + layout every 500ms, dispatches changes as `remoteAgents` / `layoutLoaded` messages
- All agents appear as remote characters with positions, tool status, and speech bubbles
- Read-only — no editing or agent creation from the browser
- Injects VS Code CSS variable defaults for proper dark theme styling

### Limitations

- Agent visual positions (x/y coordinates, walking animations) are only available after the Pixel Agents panel has been opened at least once in each VS Code window. The panel's game loop computes character positions and writes them to the sync file. Once bootstrapped, the panel can be closed — the sync file retains the last-known positions.
- The browser view is read-only. Layout editing, agent creation, and terminal interaction require VS Code.

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

## Priority Order (Remaining) — easiest first

1. **Standalone Avatars Same Palette (#11)** — Likely just passing palette/hueShift through `addAgent()` correctly; small fix
2. **Project Color Dots (#8)** — Pass `workspaceFolder` through standalone server so `projectColorFromFolder()` works; small fix
3. **Duplicate Agent Root Cause (#12)** — Merge logic in `agentManager.ts`/`fileWatcher.ts`; moderate but high-value
4. **Idle Roaming in Standalone (#13)** — FSM already works in VS Code; likely just missing seatTimer init or zone data; debug + small fix
5. **Thought Bubbles (#4)** — New sprite + render in canvas; self-contained, no architecture changes
6. **Always-Visible Tool Indicators (#9)** — Canvas text above characters + toggle flag; moderate
7. **Toggleable View Options (#10)** — New React component + visibility flags; moderate, mostly UI wiring
8. **Rich Idle Behaviors (#5)** — Interactions, coffee runs, etc.; larger feature, depends on zone system
9. **Sub-Agent Persistence Setting (#3)** — Nice-to-have toggle; simple but low priority
10. **Item Editor Improvements (#2)** — Developer tooling; low user-facing priority
