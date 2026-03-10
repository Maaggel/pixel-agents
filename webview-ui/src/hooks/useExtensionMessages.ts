import { useState, useEffect, useRef } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import type { OfficeLayout, ToolActivity } from '../office/types.js'
import { extractToolName } from '../office/toolUtils.js'
import { migrateLayoutColors } from '../office/layout/layoutSerializer.js'
import { buildDynamicCatalog } from '../office/layout/furnitureCatalog.js'
import { setFloorSprites } from '../office/floorTiles.js'
import { setWallSprites } from '../office/wallTiles.js'
import { setCharacterTemplates } from '../office/sprites/spriteData.js'
import { vscode } from '../vscodeApi.js'
import { setSoundEnabled } from '../notificationSound.js'
import { NAMETAG_PROJECT_COLORS, TOOL_BUBBLE_MIN_DISPLAY_MS } from '../constants.js'

/** Derive a stable color from a workspace folder path. */
function projectColorFromFolder(folder: string): string {
  let hash = 0
  for (let i = 0; i < folder.length; i++) {
    hash = ((hash << 5) - hash + folder.charCodeAt(i)) | 0
  }
  return NAMETAG_PROJECT_COLORS[Math.abs(hash) % NAMETAG_PROJECT_COLORS.length]
}

export interface SubagentCharacter {
  id: number
  parentAgentId: number
  parentToolId: string
  label: string
}

export interface FurnitureAsset {
  id: string
  name: string
  label: string
  category: string
  file: string
  width: number
  height: number
  footprintW: number
  footprintH: number
  isDesk: boolean
  canPlaceOnWalls: boolean
  partOfGroup?: boolean
  groupId?: string
  canPlaceOnSurfaces?: boolean
  backgroundTiles?: number
}

export interface WorkspaceFolder {
  name: string
  path: string
}

export interface DetectedAgentInfo {
  definitionId: string
  name: string
  source: string
  workspaceFolder: string
  id: number
  palette: number
  hueShift: number
  seatId: string | null
}

export interface ExtensionMessageState {
  agents: number[]
  selectedAgent: number | null
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  subagentTools: Record<number, Record<string, ToolActivity[]>>
  subagentCharacters: SubagentCharacter[]
  layoutReady: boolean
  loadedAssets?: { catalog: FurnitureAsset[]; sprites: Record<string, string[][]> }
  workspaceFolders: WorkspaceFolder[]
  claudeExtAvailable: boolean
  showNametags: boolean
  setShowNametags: (enabled: boolean) => void
  detectedAgents: DetectedAgentInfo[]
}

function saveAgentSeats(os: OfficeState): void {
  const seats: Record<number, { palette: number; hueShift: number; seatId: string | null }> = {}
  for (const ch of os.characters.values()) {
    if (ch.isSubagent) continue
    seats[ch.id] = { palette: ch.palette, hueShift: ch.hueShift, seatId: ch.seatId }
  }
  vscode.postMessage({ type: 'saveAgentSeats', seats })
}

/** Tracks when each agent last showed a tool icon bubble (talking).
 *  Used to enforce a minimum display time before downgrading to thinking. */
const toolBubbleTimestamps = new Map<number, number>()

export function useExtensionMessages(
  getOfficeState: () => OfficeState,
  onLayoutLoaded?: (layout: OfficeLayout) => void,
  isEditDirty?: () => boolean,
): ExtensionMessageState {
  const [agents, setAgents] = useState<number[]>([])
  const [selectedAgent, setSelectedAgent] = useState<number | null>(null)
  const [agentTools, setAgentTools] = useState<Record<number, ToolActivity[]>>({})
  const [agentStatuses, setAgentStatuses] = useState<Record<number, string>>({})
  const [subagentTools, setSubagentTools] = useState<Record<number, Record<string, ToolActivity[]>>>({})
  const [subagentCharacters, setSubagentCharacters] = useState<SubagentCharacter[]>([])
  const [layoutReady, setLayoutReady] = useState(false)
  const [loadedAssets, setLoadedAssets] = useState<{ catalog: FurnitureAsset[]; sprites: Record<string, string[][]> } | undefined>()
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([])
  const [claudeExtAvailable, setClaudeExtAvailable] = useState(false)
  const [showNametags, setShowNametags] = useState(false)
  const [detectedAgents, setDetectedAgents] = useState<DetectedAgentInfo[]>([])

  // Ref for accessing agentTools inside message handler without stale closure
  const agentToolsRef = useRef(agentTools)
  agentToolsRef.current = agentTools

  // Track whether initial layout has been loaded (ref to avoid re-render)
  const layoutReadyRef = useRef(false)

  useEffect(() => {
    // Buffer agents from existingAgents until layout is loaded
    let pendingAgents: Array<{ id: number; palette?: number; hueShift?: number; seatId?: string; folderName?: string; projectName?: string; workspaceFolder?: string }> = []

    const handler = (e: MessageEvent) => {
      const msg = e.data
      const os = getOfficeState()

      if (msg.type === 'layoutLoaded') {
        // Skip external layout updates while editor has unsaved changes
        if (layoutReadyRef.current && isEditDirty?.()) {
          console.log('[Webview] Skipping external layout update — editor has unsaved changes')
          return
        }
        const rawLayout = msg.layout as OfficeLayout | null
        const layout = rawLayout && rawLayout.version === 1 ? migrateLayoutColors(rawLayout) : null
        if (layout) {
          os.rebuildFromLayout(layout)
          onLayoutLoaded?.(layout)
        } else {
          // Default layout — snapshot whatever OfficeState built
          onLayoutLoaded?.(os.getLayout())
        }
        // Add buffered agents now that layout (and seats) are correct
        for (const p of pendingAgents) {
          os.addAgent(p.id, p.palette, p.hueShift, p.seatId, true, p.folderName, false, p.projectName)
          if (p.workspaceFolder) {
            const ch = os.characters.get(p.id)
            if (ch) ch.projectColor = projectColorFromFolder(p.workspaceFolder)
          }
        }
        pendingAgents = []
        layoutReadyRef.current = true
        setLayoutReady(true)
        if (os.characters.size > 0) {
          saveAgentSeats(os)
        }
      } else if (msg.type === 'agentCreated') {
        const id = msg.id as number
        const folderName = msg.folderName as string | undefined
        const projectName = msg.projectName as string | undefined
        setAgents((prev) => (prev.includes(id) ? prev : [...prev, id]))
        setSelectedAgent(id)
        os.addAgent(id, undefined, undefined, undefined, undefined, folderName, false, projectName)
        saveAgentSeats(os)
      } else if (msg.type === 'agentClosed') {
        const id = msg.id as number
        setAgents((prev) => prev.filter((a) => a !== id))
        setSelectedAgent((prev) => (prev === id ? null : prev))
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentStatuses((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        os.removeAgent(id)
      } else if (msg.type === 'existingAgents') {
        const incoming = msg.agents as number[]
        const meta = (msg.agentMeta || {}) as Record<number, { palette?: number; hueShift?: number; seatId?: string }>
        const folderNames = (msg.folderNames || {}) as Record<number, string>
        const wsFolders = (msg.workspaceFolders || {}) as Record<number, string>
        const pName = msg.projectName as string | undefined
        if (layoutReadyRef.current) {
          // Layout already loaded — add agents immediately with spawn effect
          for (const id of incoming) {
            const m = meta[id]
            os.addAgent(id, m?.palette, m?.hueShift, m?.seatId, false, folderNames[id], false, pName)
            // Set project color dot from workspace folder path
            const wsFolder = wsFolders[id]
            if (wsFolder) {
              const ch = os.characters.get(id)
              if (ch) ch.projectColor = projectColorFromFolder(wsFolder)
            }
          }
        } else {
          // Buffer agents — they'll be added in layoutLoaded after seats are built
          for (const id of incoming) {
            const m = meta[id]
            pendingAgents.push({ id, palette: m?.palette, hueShift: m?.hueShift, seatId: m?.seatId, folderName: folderNames[id], projectName: pName, workspaceFolder: wsFolders[id] })
          }
        }
        setAgents((prev) => {
          const ids = new Set(prev)
          const merged = [...prev]
          for (const id of incoming) {
            if (!ids.has(id)) {
              merged.push(id)
            }
          }
          return merged.sort((a, b) => a - b)
        })
      } else if (msg.type === 'agentToolStart') {
        const id = msg.id as number
        const toolId = msg.toolId as string
        const status = msg.status as string
        setAgentTools((prev) => {
          const list = prev[id] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: [...list, { toolId, status, done: false }] }
        })
        // Character FSM is now driven by agentStateUpdate — don't call setAgentTool/setAgentActive here
      } else if (msg.type === 'agentToolDone') {
        const id = msg.id as number
        const toolId = msg.toolId as string
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)),
          }
        })
      } else if (msg.type === 'agentToolsClear') {
        const id = msg.id as number
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        // Character FSM is now driven by agentStateUpdate — don't touch active/tool/bubble here
      } else if (msg.type === 'agentSelected') {
        const id = msg.id as number
        setSelectedAgent(id)
      } else if (msg.type === 'agentStateUpdate') {
        // ── Consolidated display state from backend (single source of truth) ──
        const id = msg.id as number
        const isActive = msg.isActive as boolean
        const currentTool = msg.currentTool as string | null
        const toolStatus = msg.toolStatus as string | null
        const bubbleType = msg.bubbleType as 'permission' | 'waiting' | null
        const idleHint = (msg.idleHint as 'thinking' | 'between-turns' | null) ?? null

        os.setAgentActive(id, isActive)
        os.setAgentTool(id, currentTool)
        // Store overlay text and idle hint on character for rendering (ToolOverlay reads these)
        const ch = os.characters.get(id)
        if (ch) {
          ch.remoteToolStatus = toolStatus
          ch.idleHint = idleHint
        }

        if (bubbleType === 'permission') {
          os.showPermissionBubble(id)
          toolBubbleTimestamps.delete(id)
        } else if (isActive && currentTool) {
          // Active with tools → talking bubble (speech box with tool icon)
          os.showTalkingBubble(id)
          toolBubbleTimestamps.set(id, Date.now())
        } else if (isActive) {
          // Active but no tools → thinking bubble, unless a tool icon was shown recently
          const lastToolAt = toolBubbleTimestamps.get(id)
          if (lastToolAt && (Date.now() - lastToolAt) < TOOL_BUBBLE_MIN_DISPLAY_MS) {
            // Keep the tool icon visible a bit longer — don't downgrade to thinking yet
          } else {
            os.showThinkingBubble(id)
            toolBubbleTimestamps.delete(id)
          }
        } else {
          os.clearPermissionBubble(id)
          toolBubbleTimestamps.delete(id)
        }
      } else if (msg.type === 'agentStatus') {
        const id = msg.id as number
        const status = msg.status as string
        setAgentStatuses((prev) => {
          if (status === 'active') {
            if (!(id in prev)) return prev
            const next = { ...prev }
            delete next[id]
            return next
          }
          return { ...prev, [id]: status }
        })
        // Character FSM is now driven by agentStateUpdate — agentStatus only updates React state
      } else if (msg.type === 'agentToolPermission') {
        const id = msg.id as number
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.done ? t : { ...t, permissionWait: true })),
          }
        })
        // Character bubble is now driven by agentStateUpdate
      } else if (msg.type === 'subagentToolPermission') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        // Show permission bubble on the sub-agent character
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          os.showPermissionBubble(subId)
        }
      } else if (msg.type === 'agentToolPermissionClear') {
        const id = msg.id as number
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          const hasPermission = list.some((t) => t.permissionWait)
          if (!hasPermission) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.permissionWait ? { ...t, permissionWait: false } : t)),
          }
        })
        // Character bubble is now driven by agentStateUpdate
        // Also clear permission bubbles on all sub-agent characters of this parent
        for (const [subId, meta] of os.subagentMeta) {
          if (meta.parentAgentId === id) {
            os.clearPermissionBubble(subId)
          }
        }
      } else if (msg.type === 'subagentToolStart') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        const status = msg.status as string
        console.log(`[Webview] subagentToolStart: agent=${id} parent=${parentToolId.slice(-8)} tool=${toolId.slice(-8)} status=${status}`)
        setSubagentTools((prev) => {
          const agentSubs = prev[id] || {}
          const list = agentSubs[parentToolId] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: { ...agentSubs, [parentToolId]: [...list, { toolId, status, done: false }] } }
        })
        // Create sub-agent character on first actual activity (if not already created)
        let subId = os.getSubagentId(id, parentToolId)
        if (subId === null) {
          // Derive label from parent tool's status (contains task description)
          const parentTools = agentToolsRef.current[id] || []
          const parentTool = parentTools.find((t) => t.toolId === parentToolId)
          const label = parentTool?.status?.startsWith('Subtask:')
            ? parentTool.status.slice('Subtask:'.length).trim()
            : parentTool?.status || 'Subtask'
          subId = os.addSubagent(id, parentToolId)
          console.log(`[Webview] Created sub-agent character: subId=${subId} parent=${id} parentToolId=${parentToolId.slice(-8)} label=${label}`)
          // Set nametag from task description
          const subCh = os.characters.get(subId)
          if (subCh) subCh.nametag = label
          setSubagentCharacters((prev) => {
            if (prev.some((s) => s.id === subId)) return prev
            return [...prev, { id: subId!, parentAgentId: id, parentToolId, label }]
          })
        }
        // Update sub-agent character's tool and active state
        const subToolName = extractToolName(status)
        os.setAgentTool(subId, subToolName)
        os.setAgentActive(subId, true)
      } else if (msg.type === 'subagentToolDone') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs) return prev
          const list = agentSubs[parentToolId]
          if (!list) return prev
          return {
            ...prev,
            [id]: { ...agentSubs, [parentToolId]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)) },
          }
        })
      } else if (msg.type === 'subagentClear') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs || !(parentToolId in agentSubs)) return prev
          const next = { ...agentSubs }
          delete next[parentToolId]
          if (Object.keys(next).length === 0) {
            const outer = { ...prev }
            delete outer[id]
            return outer
          }
          return { ...prev, [id]: next }
        })
        // Remove sub-agent character
        os.removeSubagent(id, parentToolId)
        setSubagentCharacters((prev) => prev.filter((s) => !(s.parentAgentId === id && s.parentToolId === parentToolId)))
      } else if (msg.type === 'characterSpritesLoaded') {
        const characters = msg.characters as Array<{ down: string[][][]; up: string[][][]; right: string[][][] }>
        console.log(`[Webview] Received ${characters.length} pre-colored character sprites`)
        setCharacterTemplates(characters)
      } else if (msg.type === 'floorTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        console.log(`[Webview] Received ${sprites.length} floor tile patterns`)
        setFloorSprites(sprites)
      } else if (msg.type === 'wallTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        console.log(`[Webview] Received ${sprites.length} wall tile sprites`)
        setWallSprites(sprites)
      } else if (msg.type === 'workspaceFolders') {
        const folders = msg.folders as WorkspaceFolder[]
        setWorkspaceFolders(folders)
      } else if (msg.type === 'settingsLoaded') {
        const soundOn = msg.soundEnabled as boolean
        setSoundEnabled(soundOn)
        if (msg.showNametags !== undefined) {
          setShowNametags(msg.showNametags as boolean)
        }
        if (msg.claudeExtAvailable) {
          setClaudeExtAvailable(true)
        }
      } else if (msg.type === 'furnitureAssetsLoaded') {
        try {
          const catalog = msg.catalog as FurnitureAsset[]
          const sprites = msg.sprites as Record<string, string[][]>
          console.log(`📦 Webview: Loaded ${catalog.length} furniture assets`)
          // Build dynamic catalog immediately so getCatalogEntry() works when layoutLoaded arrives next
          buildDynamicCatalog({ catalog, sprites })
          setLoadedAssets({ catalog, sprites })
        } catch (err) {
          console.error(`❌ Webview: Error processing furnitureAssetsLoaded:`, err)
        }
      } else if (msg.type === 'detectedAgents') {
        const incoming = msg.agents as DetectedAgentInfo[]
        console.log(`[Webview] Detected ${incoming.length} agent definitions`)
        setDetectedAgents(incoming)

        // Create idle characters for each detected agent
        const incomingIds: number[] = []
        for (const agent of incoming) {
          incomingIds.push(agent.id)
          if (!os.characters.has(agent.id)) {
            os.addAgent(agent.id, agent.palette, agent.hueShift, agent.seatId ?? undefined, true, agent.name)
            // Set the character as inactive and immediately move to a rest zone
            os.setAgentActive(agent.id, false)
            os.sendToRestZone(agent.id)
            const ch = os.characters.get(agent.id)
            if (ch) {
              ch.nametag = agent.name
              ch.definitionId = agent.definitionId
              ch.projectColor = projectColorFromFolder(agent.workspaceFolder)
            }
          }
        }
        setAgents((prev) => {
          const ids = new Set(prev)
          const merged = [...prev]
          for (const id of incomingIds) {
            if (!ids.has(id)) merged.push(id)
          }
          return merged.sort((a, b) => a - b)
        })
        saveAgentSeats(os)
      } else if (msg.type === 'agentBound') {
        const id = msg.id as number
        const definitionId = msg.definitionId as string
        console.log(`[Webview] Agent ${id} bound to definition ${definitionId}`)
        // Character FSM will be updated by agentStateUpdate from the backend
      } else if (msg.type === 'agentUnbound') {
        const id = msg.id as number
        const definitionId = msg.definitionId as string
        console.log(`[Webview] Agent ${id} unbound from definition ${definitionId}`)
        // Clear all tool state
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentStatuses((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        // Agent goes idle — agentStateUpdate will also fire, but set idle immediately
        // so the character doesn't briefly stay at desk
        os.setAgentTool(id, null)
        os.setAgentActive(id, false)
        os.clearPermissionBubble(id)
      } else if (msg.type === 'remoteAgents') {
        const remoteList = msg.agents as Array<{
          id: number
          name: string
          palette: number
          hueShift: number
          seatId: string | null
          isActive: boolean
          currentTool: string | null
          currentToolStatus: string | null
          isWaiting: boolean
          bubbleType: 'permission' | 'waiting' | null
          idleHint?: 'thinking' | 'between-turns' | null
          workspaceName: string
          workspaceFolder: string
          visual?: { x: number; y: number; tileCol: number; tileRow: number; state: string; dir: number; frame: number; moveProgress: number; path?: Array<{ col: number; row: number }> }
        }>
        const remoteIds = new Set(remoteList.map((a) => a.id))

        // Remove remote characters that are no longer present
        for (const [charId, ch] of os.characters) {
          if (ch.isRemote && !remoteIds.has(charId)) {
            os.removeAgent(charId)
          }
        }

        // Add or update remote characters — source window is authority
        for (const ra of remoteList) {
          const existing = os.characters.get(ra.id)
          if (existing) {
            existing.nametag = ra.name
            existing.palette = ra.palette
            existing.hueShift = ra.hueShift
            existing.currentTool = ra.currentTool
            existing.remoteToolStatus = ra.currentToolStatus
            existing.idleHint = ra.idleHint ?? null
            existing.isActive = ra.isActive
            existing.isWaiting = ra.isWaiting
            // Update seat reservation if it changed
            if (existing.seatId !== ra.seatId) {
              // Release old seat
              if (existing.seatId) {
                const oldSeat = os.seats.get(existing.seatId)
                if (oldSeat) oldSeat.assigned = false
              }
              // Claim new seat
              if (ra.seatId) {
                const newSeat = os.seats.get(ra.seatId)
                if (newSeat && !newSeat.assigned) {
                  newSeat.assigned = true
                  existing.seatId = ra.seatId
                }
              } else {
                existing.seatId = null
              }
            }
            // Bubble state from source
            if (ra.bubbleType === 'permission') {
              existing.bubbleType = 'permission'
            } else if (ra.isActive) {
              existing.bubbleType = 'thinking'
            } else if (!ra.bubbleType && (existing.bubbleType === 'permission' || existing.bubbleType === 'thinking')) {
              existing.bubbleType = null
            }
            // Set sync target — game loop animates toward this
            if (ra.visual) {
              existing.syncTarget = ra.visual
              // Evict any local agent sitting at the remote agent's visual tile
              for (const [localId, localCh] of os.characters) {
                if (localCh.isRemote || localCh.isSubagent) continue
                if (localCh.id === ra.id) continue
                if (localCh.tileCol === ra.visual.tileCol && localCh.tileRow === ra.visual.tileRow) {
                  // Local agent is at the same tile — reassign them to a free seat
                  const freeSeat = os.findFreeSeatAwayFrom(ra.visual.tileCol, ra.visual.tileRow)
                  if (freeSeat) {
                    os.reassignSeat(localId, freeSeat)
                  }
                }
              }
            }
            os.rebuildFurnitureInstances()
          } else {
            // Create new remote character — spawn effect + claim seat so locals don't sit there
            os.addAgent(ra.id, ra.palette, ra.hueShift, ra.seatId ?? undefined, false, ra.name, true)
            const ch = os.characters.get(ra.id)
            if (ch) {
              ch.nametag = ra.name
              ch.projectColor = projectColorFromFolder(ra.workspaceFolder)
              ch.currentTool = ra.currentTool
              ch.remoteToolStatus = ra.currentToolStatus
              ch.isActive = ra.isActive
              ch.isWaiting = ra.isWaiting
              // Snap to initial position on first appearance
              if (ra.visual) {
                ch.x = ra.visual.x
                ch.y = ra.visual.y
                ch.tileCol = ra.visual.tileCol
                ch.tileRow = ra.visual.tileRow
                ch.state = ra.visual.state as typeof ch.state
                ch.dir = ra.visual.dir as typeof ch.dir
                ch.frame = ra.visual.frame
                ch.syncTarget = ra.visual
                // Evict any local agent sitting at the remote agent's tile
                for (const [localId, localCh] of os.characters) {
                  if (localCh.isRemote || localCh.isSubagent) continue
                  if (localCh.id === ra.id) continue
                  if (localCh.tileCol === ra.visual.tileCol && localCh.tileRow === ra.visual.tileRow) {
                    const freeSeat = os.findFreeSeatAwayFrom(ra.visual.tileCol, ra.visual.tileRow)
                    if (freeSeat) {
                      os.reassignSeat(localId, freeSeat)
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    window.addEventListener('message', handler)
    vscode.postMessage({ type: 'webviewReady' })
    return () => window.removeEventListener('message', handler)
  }, [getOfficeState])

  return { agents, selectedAgent, agentTools, agentStatuses, subagentTools, subagentCharacters, layoutReady, loadedAssets, workspaceFolders, claudeExtAvailable, showNametags, setShowNametags, detectedAgents }
}
