/**
 * Headless office: the same engine the browser runs, driven from Node.
 *
 * This is the entry point of the bundle `renderer/native/engine.mjs` (built by
 * `node esbuild.js --headless-only`). It contains no React and no DOM code of
 * its own; the Node host installs a few browser shims (document.createElement
 * ('canvas'), localStorage, window) before importing it, then:
 *
 *   const office = createHeadlessOffice({ width, height, zoom })
 *   office.handleRelayMessage(msg)   // every JSON message from the relay's viewer socket
 *   office.tick(dt)                  // advance the simulation
 *   office.render(ctx)               // draw one frame into a 2D context
 *
 * Message handling replicates what the relay's injected bridge (reconcileAgents)
 * and useExtensionMessages do for the canvas. Anything that only drives React UI
 * (behaviour log, personalities panel, dev console) is deliberately absent: the
 * tablet stream only ever showed the canvas.
 */
import { OfficeState } from '../office/engine/officeState.js'
import { renderFrame, renderNametags, renderBubbles, createTileLayerCache, setNametagFont } from '../office/engine/renderer.js'
import type { SelectionRenderState } from '../office/engine/renderer.js'
import { updateSunCycle, getSunState, computeSunBeams } from '../office/engine/sunlight.js'
import { updateWeather, getWeatherSeverity, setWeather } from '../office/engine/windowEffects.js'
import { migrateLayoutColors } from '../office/layout/layoutSerializer.js'
import { buildDynamicCatalog } from '../office/layout/furnitureCatalog.js'
import { setFloorSprites } from '../office/floorTiles.js'
import { setWallSprites } from '../office/wallTiles.js'
import { setCharacterTemplates } from '../office/sprites/spriteData.js'
import { TileType, TILE_SIZE } from '../office/types.js'
import type { OfficeLayout } from '../office/types.js'
import { NAMETAG_PROJECT_COLORS, TOOL_BUBBLE_MIN_DISPLAY_MS, AGENT_CLOSE_GRACE_MS } from '../constants.js'

export interface HeadlessOptions {
  width: number
  height: number
  /** Device pixels per sprite pixel (the kiosk page uses 2 at DPR 1) */
  zoom: number
  /**
   * Draw nametags on a separate overlay (renderNametagOverlay) instead of in the frame. The
   * native renderer draws the scene at half resolution and the tags at full resolution.
   */
  nametagOverlay?: boolean
  /** Font for nametags, e.g. { px: 16, family: '"FS Pixel Sans Unicode"' }; default is the browser's */
  nametagFont?: { px: number; family: string }
  /** Drop emoji and other pictographs from nametags (the icons the owner prefixes names with) */
  nametagStripEmoji?: boolean
  /** Optional sink for the same one-line events the browser's dev console shows */
  log?: (line: string) => void
}

/** Display flags a kiosk display accepts from "Apply to kiosk displays" */
export interface KioskFlags {
  showNametags: boolean
  showSunlight: boolean
  dynamicItems: boolean
  debugLampLights: boolean
}

const DEFAULT_FLAGS: KioskFlags = { showNametags: true, showSunlight: true, dynamicItems: true, debugLampLights: false }
const DEFAULT_EXTERIOR_WALL = { style: 'brick_small' as const, color: { h: 10, s: 50, b: -15, c: 10 }, height: 0 }

// Same as useExtensionMessages.projectColorFromFolder
function projectColorFromFolder(folder: string): string {
  let hash = 0
  for (let i = 0; i < folder.length; i++) hash = ((hash << 5) - hash + folder.charCodeAt(i)) | 0
  return NAMETAG_PROJECT_COLORS[Math.abs(hash) % NAMETAG_PROJECT_COLORS.length]
}

// Emoji, pictographs, their variation selectors / joiners / skin tones, and the whitespace left behind
const EMOJI_RE = /(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D|\u20E3)+\s*/gu
function stripEmoji(label: string): string {
  return label.replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim() || label
}

// Same as the relay bridge's hashCode (window id → agent id offset)
function hashCode(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  return Math.abs(hash) % 100
}

interface RelayAgent {
  localId: number
  name?: string
  palette?: number
  hueShift?: number
  seatId?: string
  isActive?: boolean
  currentTool?: string | null
  currentToolStatus?: string | null
  isWaiting?: boolean
  bubbleType?: 'permission' | 'waiting' | null
  idleHint?: 'thinking' | 'between-turns' | null
  personalityKey?: string | null
  lookExplicit?: boolean
}

interface RelayWindow {
  windowId?: string
  workspaceName?: string
  workspaceFolder?: string
  agents?: RelayAgent[]
}

interface FlatAgent {
  id: number
  name: string
  palette: number
  hueShift: number
  seatId?: string
  isActive: boolean
  currentTool: string | null
  toolStatus: string | null
  isWaiting: boolean
  bubbleType: 'permission' | 'waiting' | null
  idleHint: 'thinking' | 'between-turns' | null
  workspaceName: string
  workspaceFolder: string
  personalityKey: string | null
  lookExplicit?: boolean
}

interface PendingAgent {
  id: number
  palette?: number
  hueShift?: number
  seatId?: string
  folderName?: string
  projectName?: string
  workspaceFolder?: string
  personalityKey?: string
}

export interface OverlayRect { x: number; y: number; w: number; h: number }

export interface HeadlessOffice {
  handleRelayMessage(msg: Record<string, unknown>): void
  tick(dt: number): void
  render(ctx: CanvasRenderingContext2D): void
  /**
   * Draw the nametags and speech bubbles of the last rendered frame onto ctx at `scale` times
   * the frame's resolution (nametagOverlay mode only). Bubbles are drawn again here, on top of
   * the tags, so their order matches the browser. Returns the rectangles that were painted, in
   * overlay pixels, so the caller can composite just those.
   */
  renderNametagOverlay(ctx: CanvasRenderingContext2D, scale: number): OverlayRect[]
  setFlags(flags: Partial<KioskFlags>): void
  getFlags(): KioskFlags
  /** True once assets and a layout have arrived (frames before that are blank) */
  isReady(): boolean
  agentCount(): number
}

export function createHeadlessOffice(opts: HeadlessOptions): HeadlessOffice {
  const { width, height, zoom } = opts
  const log = opts.log ?? (() => {})
  const os = new OfficeState()
  const flags: KioskFlags = { ...DEFAULT_FLAGS }
  if (opts.nametagFont) { const f = opts.nametagFont; setNametagFont(() => f) }
  let lastOffset = { x: 0, y: 0 }
  os.setDynamicItems(flags.dynamicItems)

  let layoutReady = false
  let pendingAgents: PendingAgent[] = []
  const pendingCloses = new Map<number, ReturnType<typeof setTimeout>>()
  const knownAgents = new Map<number, string>()
  const toolBubbleTimestamps = new Map<number, number>()
  // State updates for agents still buffered behind the first layout
  const pendingState = new Map<number, FlatAgent>()
  let pan = { x: 0, y: 0 }
  // The view never pans or zooms here, so the floor is drawn once per layout
  const tileLayer = createTileLayerCache()

  function cancelPendingClose(id: number): void {
    const t = pendingCloses.get(id)
    if (t) { clearTimeout(t); pendingCloses.delete(id) }
  }

  // ── useExtensionMessages equivalents ──────────────────────────

  function onLayoutLoaded(raw: OfficeLayout | null): void {
    const layout = raw && raw.version === 1 ? migrateLayoutColors(raw) : null
    if (layout) os.rebuildFromLayout(layout)
    for (const p of pendingAgents) {
      os.addAgent(p.id, p.palette, p.hueShift, p.seatId, true, p.folderName, false, p.projectName)
      const ch = os.characters.get(p.id)
      if (ch) {
        if (p.workspaceFolder) ch.projectColor = projectColorFromFolder(p.workspaceFolder)
        if (p.personalityKey) ch.definitionId = p.personalityKey
      }
    }
    pendingAgents = []
    layoutReady = true
  }

  function onExistingAgents(ids: number[], meta: Record<number, PendingAgent>, folderNames: Record<number, string>, wsFolders: Record<number, string>, projectName: string): void {
    for (const id of ids) cancelPendingClose(id)
    if (layoutReady) {
      for (const id of ids) {
        const m = meta[id]
        if (os.characters.has(id)) continue
        os.addAgent(id, m?.palette, m?.hueShift, m?.seatId, false, folderNames[id], false, projectName)
        const ch = os.characters.get(id)
        if (ch) {
          if (wsFolders[id]) ch.projectColor = projectColorFromFolder(wsFolders[id])
          if (m?.personalityKey) ch.definitionId = m.personalityKey
        }
      }
    } else {
      for (const id of ids) {
        const m = meta[id]
        pendingAgents.push({ id, palette: m?.palette, hueShift: m?.hueShift, seatId: m?.seatId, personalityKey: m?.personalityKey, folderName: folderNames[id], projectName, workspaceFolder: wsFolders[id] })
      }
    }
  }

  function onAgentClosed(id: number): void {
    if (pendingCloses.has(id)) return
    const timer = setTimeout(() => {
      pendingCloses.delete(id)
      os.removeAllSubagents(id)
      os.removeAgent(id)
    }, AGENT_CLOSE_GRACE_MS)
    pendingCloses.set(id, timer)
  }

  function onAgentStateUpdate(a: FlatAgent): void {
    cancelPendingClose(a.id)
    os.setAgentActive(a.id, a.isActive)
    os.setAgentTool(a.id, a.currentTool)
    const ch = os.characters.get(a.id)
    if (ch) {
      ch.remoteToolStatus = a.toolStatus
      ch.idleHint = a.idleHint
    }
    if (a.bubbleType === 'permission') {
      os.showPermissionBubble(a.id)
      toolBubbleTimestamps.delete(a.id)
    } else if (a.isActive && a.currentTool) {
      os.showTalkingBubble(a.id)
      toolBubbleTimestamps.set(a.id, Date.now())
    } else if (a.isActive) {
      const lastToolAt = toolBubbleTimestamps.get(a.id)
      if (lastToolAt && Date.now() - lastToolAt < TOOL_BUBBLE_MIN_DISPLAY_MS) {
        // keep the tool icon a bit longer
      } else if (a.idleHint === 'thinking' && !lastToolAt) {
        os.showThinkingBubble(a.id)
      } else {
        os.showTalkingBubble(a.id)
        toolBubbleTimestamps.delete(a.id)
      }
    } else {
      os.clearPermissionBubble(a.id)
      toolBubbleTimestamps.delete(a.id)
    }
  }

  // ── relay bridge equivalent (reconcileAgents) ─────────────────

  function reconcileAgents(windows: RelayWindow[]): void {
    const current = new Map<number, FlatAgent>()
    for (const win of windows) {
      if (!win.agents) continue
      for (const agent of win.agents) {
        const id = agent.localId + (win.windowId ? hashCode(win.windowId) * 1000 : 0)
        current.set(id, {
          id,
          name: agent.name || 'Agent',
          palette: agent.palette || 0,
          hueShift: agent.hueShift || 0,
          seatId: agent.seatId,
          isActive: agent.isActive || false,
          currentTool: agent.currentTool ?? null,
          toolStatus: agent.currentToolStatus ?? null,
          isWaiting: agent.isWaiting || false,
          bubbleType: agent.bubbleType ?? null,
          idleHint: agent.idleHint || null,
          workspaceName: win.workspaceName || '',
          workspaceFolder: win.workspaceFolder || '',
          personalityKey: agent.personalityKey || null,
          lookExplicit: agent.lookExplicit,
        })
      }
    }

    const newIds: number[] = []
    const newMeta: Record<number, PendingAgent> = {}
    const folderNames: Record<number, string> = {}
    const wsFolders: Record<number, string> = {}
    let projectName = ''
    for (const [id, agent] of current) {
      if (knownAgents.has(id)) continue
      newIds.push(id)
      const explicit = agent.lookExplicit !== undefined ? agent.lookExplicit === true : (agent.palette > 0 || agent.hueShift > 0)
      newMeta[id] = {
        id,
        palette: explicit ? agent.palette : undefined,
        hueShift: explicit ? agent.hueShift : undefined,
        seatId: agent.seatId,
        personalityKey: agent.personalityKey || undefined,
      }
      folderNames[id] = agent.name
      wsFolders[id] = agent.workspaceFolder
      if (agent.workspaceName) projectName = agent.workspaceName
      log(`CREATE #${id} "${agent.name}"`)
    }
    if (newIds.length > 0) onExistingAgents(newIds, newMeta, folderNames, wsFolders, projectName)

    for (const id of knownAgents.keys()) {
      if (!current.has(id)) {
        onAgentClosed(id)
        log(`CLOSE  #${id}`)
      }
    }

    for (const [id, agent] of current) {
      const snap = JSON.stringify(agent)
      if (knownAgents.get(id) !== snap) {
        // Buffered agents get their state once the layout has created them
        if (layoutReady || os.characters.has(id)) onAgentStateUpdate(agent)
        else pendingState.set(id, agent)
      }
      knownAgents.set(id, snap)
    }
    for (const id of [...knownAgents.keys()]) if (!current.has(id)) knownAgents.delete(id)
  }

  function applyKioskOptions(options: Record<string, unknown> | undefined): void {
    if (!options) return
    const { weather, ...rest } = options as Partial<KioskFlags> & { weather?: string }
    setFlags(rest)
    if (typeof weather === 'string') setWeather(weather as Parameters<typeof setWeather>[0])
  }

  function setFlags(next: Partial<KioskFlags>): void {
    for (const k of ['showNametags', 'showSunlight', 'dynamicItems', 'debugLampLights'] as const) {
      if (typeof next[k] === 'boolean') flags[k] = next[k]
    }
    os.setDynamicItems(flags.dynamicItems)
  }

  function handleRelayMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string
    if (type === 'init') {
      if (msg.characters) setCharacterTemplates(msg.characters as Parameters<typeof setCharacterTemplates>[0])
      if (msg.floors) setFloorSprites(msg.floors as Parameters<typeof setFloorSprites>[0])
      if (msg.walls) setWallSprites(msg.walls as Parameters<typeof setWallSprites>[0])
      const furniture = msg.furniture as { catalog: Parameters<typeof buildDynamicCatalog>[0]['catalog']; sprites: Parameters<typeof buildDynamicCatalog>[0]['sprites'] } | undefined
      if (furniture) buildDynamicCatalog({ catalog: furniture.catalog, sprites: furniture.sprites })
      if (msg.layout) {
        onLayoutLoaded(msg.layout as OfficeLayout)
        for (const a of pendingState.values()) onAgentStateUpdate(a)
        pendingState.clear()
      }
      const windows = msg.windows as RelayWindow[] | undefined
      if (windows && windows.length > 0) reconcileAgents(windows)
      applyKioskOptions(msg.kioskOptions as Record<string, unknown> | undefined)
    } else if (type === 'kioskOptions') {
      applyKioskOptions(msg.options as Record<string, unknown> | undefined)
    } else if (type === 'sync') {
      reconcileAgents((msg.windows as RelayWindow[]) || [])
    } else if (type === 'layoutUpdate') {
      onLayoutLoaded(msg.layout as OfficeLayout)
      for (const a of pendingState.values()) onAgentStateUpdate(a)
      pendingState.clear()
    }
  }

  // ── OfficeCanvas equivalents ──────────────────────────────────

  function tick(dt: number): void {
    os.update(dt)
    if (flags.showSunlight) {
      updateSunCycle(dt)
      updateWeather(dt)
    }
  }

  function fitCamera(): void {
    const layout = os.getLayout()
    const tm = os.tileMap
    let minC = layout.cols, maxC = -1, minR = layout.rows, maxR = -1
    for (let r = 0; r < tm.length; r++) {
      const row = tm[r]
      for (let c = 0; c < row.length; c++) {
        if (row[c] === TileType.VOID || !row[c]) continue
        if (c < minC) minC = c; if (c > maxC) maxC = c; if (r < minR) minR = r; if (r > maxR) maxR = r
      }
    }
    if (maxC >= 0) {
      const mapW = layout.cols * TILE_SIZE * zoom
      const mapH = layout.rows * TILE_SIZE * zoom
      const cx = ((minC + maxC + 1) / 2) * TILE_SIZE
      const cy = ((minR + maxR + 1) / 2) * TILE_SIZE - TILE_SIZE / 2
      pan = { x: mapW / 2 - cx * zoom, y: mapH / 2 - cy * zoom }
    }
  }

  function render(ctx: CanvasRenderingContext2D): void {
    ctx.imageSmoothingEnabled = false
    fitCamera()
    const selection: SelectionRenderState = {
      selectedAgentId: null,
      hoveredAgentId: null,
      hoveredTile: null,
      seats: os.seats,
      characters: os.characters,
      showNametags: flags.showNametags && !opts.nametagOverlay,
    }
    let sunBeams = undefined
    let sunBeamColor: [number, number, number] | undefined
    let sunIntensity: number | undefined
    if (flags.showSunlight) {
      const { angle, intensity, reach, color } = getSunState()
      sunBeamColor = color
      sunIntensity = intensity
      if (intensity > 0) {
        const beamIntensity = intensity * (1 - getWeatherSeverity() * 0.85)
        sunBeams = computeSunBeams(os.furniture, os.tileMap, angle, beamIntensity, reach)
      }
    }
    const activeVacuumUids = os.getActiveVacuumUids()
    const visibleFurniture = activeVacuumUids.size > 0
      ? os.furniture.filter(f => !f.uid || !activeVacuumUids.has(f.uid))
      : os.furniture
    const vacuumDrawables = os.getVacuumRenderData()
    const vacuumTrails = os.getVacuumTrails()
    const vacuumSpeech = os.getVacuumSpeechBubbles()
    const vacuumOverlays = os.getVacuumOverlayData()
    const layout = os.getLayout()
    const { offsetX, offsetY } = renderFrame(
      ctx, width, height, os.tileMap, visibleFurniture, os.getCharacters(), zoom, pan.x, pan.y,
      selection, undefined, layout.tileColors, layout.cols, layout.rows,
      sunBeams, sunBeamColor, sunIntensity,
      vacuumDrawables.length > 0 ? vacuumDrawables : undefined,
      vacuumTrails.length > 0 ? vacuumTrails : undefined,
      vacuumSpeech.length > 0 ? vacuumSpeech : undefined,
      vacuumOverlays.length > 0 ? vacuumOverlays : undefined,
      layout.exteriorWall ?? DEFAULT_EXTERIOR_WALL,
      flags.debugLampLights,
      tileLayer,
    )
    lastOffset = { x: offsetX, y: offsetY }
  }

  function renderNametagOverlay(ctx: CanvasRenderingContext2D, scale: number): OverlayRect[] {
    const rects: OverlayRect[] = []
    if (!opts.nametagOverlay) return rects
    // Every tag starts with its background fillRect and every bubble is one drawImage; recording
    // those gives the painted areas without duplicating the geometry here. Text can overhang the
    // box by a pixel or two, hence the margin.
    const fillRect = ctx.fillRect.bind(ctx)
    const drawImage = ctx.drawImage.bind(ctx)
    const record = (x: number, y: number, w: number, h: number) => {
      rects.push({ x: Math.floor(x) - 2, y: Math.floor(y) - 2, w: Math.ceil(w) + 4, h: Math.ceil(h) + 4 })
    }
    ctx.fillRect = (x, y, w, h) => { record(x, y, w, h); fillRect(x, y, w, h) }
    ctx.drawImage = ((img: CanvasImageSource, dx: number, dy: number, dw?: number, dh?: number) => {
      const c = img as HTMLCanvasElement
      record(dx, dy, dw ?? c.width, dh ?? c.height)
      if (dw === undefined) drawImage(img, dx, dy); else drawImage(img, dx, dy, dw, dh!)
    }) as typeof ctx.drawImage
    try {
      const chars = os.getCharacters()
      const ox = lastOffset.x * scale, oy = lastOffset.y * scale, z = zoom * scale
      if (flags.showNametags) {
        // renderNametags only reads the characters, so shallow copies with cleaned labels are enough
        const tagged = opts.nametagStripEmoji ? chars.map((ch) => (ch.nametag ? { ...ch, nametag: stripEmoji(ch.nametag) } : ch)) : chars
        renderNametags(ctx, tagged, ox, oy, z)
      }
      renderBubbles(ctx, chars, ox, oy, z)
    } finally {
      ctx.fillRect = fillRect
      ctx.drawImage = drawImage
    }
    return rects
  }

  return {
    handleRelayMessage,
    tick,
    render,
    renderNametagOverlay,
    setFlags,
    getFlags: () => ({ ...flags }),
    isReady: () => layoutReady,
    agentCount: () => os.characters.size,
  }
}
