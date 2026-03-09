# Multi-Window Agent Sync

Share agents across multiple VS Code windows in the same pixel agent environment, with positions, actions, appearance etc. synced in real-time.

## Approach: Shared Agent State File

Extends the existing layout sync pattern (`~/.pixel-agents/layout.json` with file watching) to agent state.

**`~/.pixel-agents/agents-state.json`** — each window writes its agents' state, all windows read it.

```jsonc
{
  "windows": {
    "window-uuid-1": {
      "lastHeartbeat": 1709740800000,
      "workspaceFolder": "/path/to/project-a",
      "agents": [
        {
          "id": 1,
          "palette": 3,
          "hueShift": 0,
          "seatId": "chair_abc",
          "position": { "x": 128, "y": 96 },
          "direction": "DOWN",
          "state": "TYPE",
          "activeTools": ["Edit"],
          "isWaiting": false
        }
      ]
    },
    "window-uuid-2": { "..." : "..." }
  }
}
```

## What's Needed

1. **Window identity** — Each VS Code window gets a UUID on activation (persisted in `workspaceState`). Used as the key in the shared file.

2. **State broadcasting** — `agentManager.ts` periodically writes local agent state (position, animation, tools, palette) to the shared file. Throttled to ~500ms to avoid excessive I/O.

3. **State receiving** — File watcher (same hybrid `fs.watch` + polling pattern) picks up changes from other windows. Remote agents rendered as "ghost" characters — visible but not interactive (no terminal to focus).

4. **Heartbeat / cleanup** — Each window updates `lastHeartbeat` on write. Stale windows (no heartbeat for ~10s) get pruned so closed windows don't leave phantom agents.

5. **Rendering remote agents** — The webview already handles characters generically via `OfficeState`. Remote agents would be a new category alongside sub-agents: same sprite rendering, same animations, but click shows a label like "Agent in Project B".

## Main Challenges

- **Position conflicts** — Two windows might assign agents to the same seat. Solution: seat reservation in the shared file (first-write-wins).
- **Animation smoothness** — 500ms file sync means remote agents move in discrete jumps. Interpolation on the receiving side would smooth this out.
- **File contention** — Multiple windows writing simultaneously. Atomic writes (`.tmp` + rename) already used for layout; same pattern works here. Each window only writes its own key, reads others.
- **Identity across windows** — Remote agents need distinct rendering (maybe a subtle label or workspace icon) so users know which are local vs. remote.

## Existing Foundation

These patterns already work and can be reused:
- Layout file sync with hybrid `fs.watch` + polling
- Atomic file writes (`.tmp` + rename)
- Character rendering pipeline (palette diversity, sprites, animations)
- Sub-agent rendering (non-terminal-bound characters)
- `markOwnWrite()` pattern to avoid re-reading own writes
