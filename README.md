# Pixel Agents

A VS Code extension that turns your AI coding agents into animated pixel art characters in a virtual office.

Each Claude Code terminal you open spawns a character that walks around, sits at desks, and visually reflects what the agent is doing — typing when writing code, reading when searching files, waiting when it needs your attention.

This is the source code for the free [Pixel Agents extension for VS Code](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents) — you can install it directly from the marketplace with the full furniture catalog included.


![Pixel Agents screenshot](webview-ui/public/Screenshot.jpg)

## Features

- **Auto-detected agents** — agents are detected from your project's `.claude/agents/` folder and `CLAUDE.md`, appearing as idle characters that activate when a terminal starts
- **One agent, one character** — every Claude Code terminal gets its own animated character
- **Live activity tracking** — characters animate based on what the agent is actually doing (writing, reading, running commands)
- **Cross-window sync** — agents from other VS Code windows appear in your office with a colored project indicator dot
- **Open in editor tab** — run `Pixel Agents: Open in Editor Tab` from the command palette for a full-size view
- **Office layout editor** — design your office with floors, walls, and furniture using a built-in editor
- **Speech bubbles with tool icons** — pixel art bubbles show what each agent is doing: a book for reading, a pencil for writing, a terminal prompt for running commands, a magnifying glass for searching, and more
- **Sound notifications** — optional chime when an agent finishes its turn
- **Sub-agent visualization** — Task tool sub-agents spawn as separate characters linked to their parent
- **Persistent layouts** — your office design is saved and shared across VS Code windows
- **Diverse characters** — 6 diverse characters. These are based on the amazing work of [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack).

<p align="center">
  <img src="webview-ui/public/characters.png" alt="Pixel Agents characters" width="320" height="72" style="image-rendering: pixelated;">
</p>

## Requirements

- VS Code 1.109.0 or later
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and configured

## Getting Started

If you just want to use Pixel Agents, the easiest way is to download the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents). If you want to play with the code, develop, or contribute, then:

### Install from source

```bash
git clone https://github.com/pablodelucca/pixel-agents.git
cd pixel-agents
npm install
cd webview-ui && npm install && cd ..
npm run build
```

Then press **F5** in VS Code to launch the Extension Development Host.

### Usage

1. Open the **Pixel Agents** panel (it appears in the bottom panel area alongside your terminal)
2. If your project has a `.claude/agents/` folder or a `CLAUDE.md` file, agents are detected automatically and appear as idle characters
3. Start a Claude Code terminal — the corresponding character activates and tracks what the agent is doing in real time
4. Click a character to select it, then click a seat to reassign it
5. Click **Layout** to open the office editor and customize your space

### Viewing Options

- **Panel view** — the default, shown in the bottom panel alongside your terminal
- **Editor tab** — run **Pixel Agents: Open in Editor Tab** from the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) for a larger, full-size view in an editor tab

### Cross-Window Sync

When you have multiple VS Code windows open, agents from other windows automatically appear in your office. Each project gets a colored dot on the nametag so you can tell which window an agent belongs to. Sync happens via `~/.pixel-agents/sync/` — no server or configuration needed.

## Layout Editor

The built-in editor lets you design your office:

- **Floor** — Full HSB color control
- **Walls** — Auto-tiling walls with color customization
- **Tools** — Select, paint, erase, place, eyedropper, pick
- **Undo/Redo** — 50 levels with Ctrl+Z / Ctrl+Y
- **Export/Import** — Share layouts as JSON files via the Settings modal

The grid is expandable up to 64×64 tiles. Click the ghost border outside the current grid to grow it.

### Office Assets

The office tileset used in this project and available via the extension is **[Office Interior Tileset (16x16)](https://donarg.itch.io/officetileset)** by **Donarg**, available on itch.io for **$2 USD**.

This is the only part of the project that is not freely available. The tileset is not included in this repository due to its license. To use Pixel Agents locally with the full set of office furniture and decorations, purchase the tileset and run the asset import pipeline:

```bash
npm run import-tileset
```

Fair warning: the import pipeline is not exactly straightforward — the out-of-the-box tileset assets aren't the easiest to work with, and while I've done my best to make the process as smooth as possible, it may require some manual tweaking. If you have experience creating pixel art office assets and would like to contribute freely usable tilesets for the community, that would be hugely appreciated.

The extension will still work without the tileset — you'll get the default characters and basic layout, but the full furniture catalog requires the imported assets.

### Adding Custom Furniture

You can add your own furniture items without the full tileset pipeline. Each item needs a 16×N pixel PNG sprite and a catalog entry:

1. **Create the sprite** — draw a 16×16 (1×1 tile) or larger PNG at `webview-ui/public/assets/furniture/<category>/YOUR_ITEM.png`. Use transparency for empty pixels. Standard tile size is 16×16 per footprint tile.

2. **Add a catalog entry** — edit `webview-ui/public/assets/furniture/furniture-catalog.json` and add an entry to the `assets` array:
   ```json
   {
     "id": "YOUR_ITEM",
     "name": "YOUR_ITEM",
     "label": "Your Item",
     "category": "misc",
     "file": "furniture/misc/YOUR_ITEM.png",
     "width": 16,
     "height": 16,
     "footprintW": 1,
     "footprintH": 1,
     "isDesk": false
   }
   ```

3. **Rebuild** — run `npm run build` to copy assets to `dist/`, then restart the extension or standalone server.

**Catalog fields:**
| Field | Description |
|-------|-------------|
| `id` | Unique identifier (used as furniture type in layouts) |
| `name` | Internal name (usually matches id) |
| `label` | Display name shown in the editor palette |
| `category` | Editor tab: `desks`, `chairs`, `storage`, `electronics`, `decor`, `wall`, `misc` |
| `file` | Path relative to `assets/` directory |
| `width` / `height` | Sprite dimensions in pixels |
| `footprintW` / `footprintH` | Tile footprint (e.g. 2×2 for a large desk) |
| `isDesk` | `true` if agents can work at this furniture (enables auto-on for electronics) |
| `canPlaceOnSurfaces` | `true` for items that sit on top of desks (monitors, mugs) |
| `canPlaceOnWalls` | `true` for wall-mounted items (paintings, clocks) |
| `backgroundTiles` | Number of top footprint rows that characters can walk through |
| `groupId` | Shared ID for rotation/state groups (items that rotate or toggle on/off) |
| `orientation` | `front`, `back`, `left`, or `right` — for chairs (seat facing) and rotation groups |

## Speech Bubbles & Tool Icons

Characters show different speech bubbles depending on their state:

- **No bubble** — the agent is idle
- **Thought cloud** (grey dots) — the agent is thinking, processing text, or waiting to start
- **Speech bubble with tool icon** — the agent is actively using a specific tool
- **Amber dots** — the agent needs permission to proceed (click to focus)

Each tool gets its own pixel art icon inside the speech bubble:

| Tool | Icon | Color | Description |
|------|------|-------|-------------|
| Read | Book | Blue | Reading files |
| Write | Pencil | Orange | Writing new files |
| Edit | Wrench | Teal | Editing existing files |
| Bash | `> _` | Green | Running terminal commands |
| Bash:build | Hammer | Orange | Building (`npm run build`, `tsc`, `make`, `cargo build`, etc.) |
| Bash:test | Checkmark | Green | Testing (`npm test`, `jest`, `vitest`, `pytest`, etc.) |
| Bash:git | Branch | Red-orange | Git commands (`git commit`, `git push`, etc.) |
| Bash:install | Package | Blue | Installing dependencies (`npm install`, `pip install`, etc.) |
| Grep | Magnifying glass | Purple | Searching file contents |
| Glob | Folder | Yellow | Finding files by pattern |
| Task | Person | Blue | Running sub-agent tasks |
| WebFetch | Download arrow | Cyan | Fetching web content |
| WebSearch | Globe | Teal | Searching the web |

Bash commands are automatically categorized by matching the command against known patterns (see `refineBashToolName()` in `src/transcriptParser.ts`). Unrecognized commands fall back to the generic terminal icon.

When the "Always show activities" view option is enabled, the activity text panel appears below the character. If a bubble would be hidden behind this panel, a compact indicator is shown above the panel instead.

### Customizing tool icons

Tool icons are defined as 7x6 pixel art sprites in `webview-ui/src/office/sprites/spriteData.ts`. Each icon is a simple 2D array of hex color strings (or `''` for transparent), stamped into the standard 11x13 speech bubble frame by `makeBubbleIcon()`.

To add or modify an icon:

1. Find the `BUBBLE_TOOL_*` constants in `spriteData.ts`
2. Edit the 7x6 pixel grid — each row is an array of 7 color values
3. Add new tools to the `TOOL_BUBBLE_SPRITES` map at the bottom
4. Rebuild with `npm run build`

The tool names in `TOOL_BUBBLE_SPRITES` must match the tool names that Claude Code reports in its JSONL transcript (e.g. `Read`, `Write`, `Bash`). Bash subcategories use the `Bash:*` naming convention (e.g. `Bash:build`, `Bash:test`). Unknown tools fall back to the generic talking bubble with text lines.

To add new Bash subcategories, edit `refineBashToolName()` in `src/transcriptParser.ts` and add a matching icon sprite + entry in `TOOL_BUBBLE_SPRITES`.

## Standalone Viewer

You can view the pixel office in a standalone browser window outside of VS Code:

```bash
bash standalone.sh
```

This starts a local server at `http://localhost:7600` that shows your office with all agents synced from VS Code via the `~/.pixel-agents/sync/` directory.

## Remote Viewer (Relay Server)

Want to watch your pixel office from a tablet, phone, or another machine? The relay server bridges VS Code agent state over WebSocket to any browser.

```
VS Code  --(WebSocket)-->  Relay Server  <--(Browser)--  Tablet/Phone
```

### Quick start

```bash
cd relay && npm install && cd ..
RELAY_TOKEN=my-secret-key npm run relay
```

Open `http://localhost:7601` in a browser and enter the token.

### VS Code configuration

```json
{
  "pixel-agents.relayUrl": "wss://yourserver.com/pixelagents/ws",
  "pixel-agents.relayToken": "your-secret-key-here"
}
```

For full deployment instructions (systemd, Apache reverse proxy, authentication), see [relay/README.md](relay/README.md).

## How It Works

Pixel Agents watches Claude Code's JSONL transcript files to track what each agent is doing. When an agent uses a tool (like writing a file or running a command), the extension detects it and updates the character's animation accordingly. No modifications to Claude Code are needed — it's purely observational.

The webview runs a lightweight game loop with canvas rendering, BFS pathfinding, and a character state machine (idle → walk → type/read). Everything is pixel-perfect at integer zoom levels.

## Tech Stack

- **Extension**: TypeScript, VS Code Webview API, esbuild
- **Webview**: React 19, TypeScript, Vite, Canvas 2D

## Known Limitations

- **Agent-terminal sync** — the way agents are connected to Claude Code terminal instances is not super robust and sometimes desyncs, especially when terminals are rapidly opened/closed or restored across sessions.
- **Heuristic-based status detection** — Claude Code's JSONL transcript format does not provide clear signals for when an agent is waiting for user input or when it has finished its turn. The current detection is based on heuristics (idle timers, turn-duration events) and often misfires — agents may briefly show the wrong status or miss transitions.
- **Windows-only testing** — the extension has only been tested on Windows 11. It may work on macOS or Linux, but there could be unexpected issues with file watching, paths, or terminal behavior on those platforms.

## Roadmap

There are several areas where contributions would be very welcome:

- **Improve agent-terminal reliability** — more robust connection and sync between characters and Claude Code instances
- **Better status detection** — find or propose clearer signals for agent state transitions (waiting, done, permission needed)
- **Community assets** — freely usable pixel art tilesets or characters that anyone can use without purchasing third-party assets
- **Agent creation and definition** — define agents with custom skills, system prompts, names, and skins before launching them
- **Desks as directories** — click on a desk to select a working directory, drag and drop agents or click-to-assign to move them to specific desks/projects
- **Claude Code agent teams** — native support for [agent teams](https://code.claude.com/docs/en/agent-teams), visualizing multi-agent coordination and communication
- **Git worktree support** — agents working in different worktrees to avoid conflict from parallel work on the same files
- **Support for other agentic frameworks** — [OpenCode](https://github.com/nichochar/opencode), or really any kind of agentic experiment you'd want to run inside a pixel art interface (see [simile.ai](https://simile.ai/) for inspiration)

If any of these interest you, feel free to open an issue or submit a PR.

## Contributions

See [CONTRIBUTORS.md](CONTRIBUTORS.md) for instructions on how to contribute to this project.

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Supporting the Project

If you find Pixel Agents useful, consider supporting its development:

<a href="https://github.com/sponsors/pablodelucca">
  <img src="https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=github" alt="GitHub Sponsors">
</a>
<a href="https://ko-fi.com/pablodelucca">
  <img src="https://img.shields.io/badge/Support-Ko--fi-ff5e5b?logo=ko-fi" alt="Ko-fi">
</a>

## License

This project is licensed under the [MIT License](LICENSE).
