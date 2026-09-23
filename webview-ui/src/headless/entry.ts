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
import { updateSunCycle, getSunState, computeSunBeams, getOfficeHour } from '../office/engine/sunlight.js'
import { updateWeather, getWeatherSeverity, setWeather } from '../office/engine/windowEffects.js'
import { migrateLayoutColors } from '../office/layout/layoutSerializer.js'
import { buildDynamicCatalog } from '../office/layout/furnitureCatalog.js'
import { setFloorSprites } from '../office/floorTiles.js'
import { setWallSprites } from '../office/wallTiles.js'
import { setCharacterTemplates } from '../office/sprites/spriteData.js'
import { TileType, TILE_SIZE } from '../office/types.js'
import type { OfficeLayout, Character, SpriteData, FurnitureInstance } from '../office/types.js'
import { NAMETAG_PROJECT_COLORS, TOOL_BUBBLE_MIN_DISPLAY_MS, AGENT_CLOSE_GRACE_MS, BUBBLE_FADE_DURATION_SEC } from '../constants.js'

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
  /** Redraw the whole frame at least this often even when nothing is known to have changed (seconds) */
  fullRedrawSec?: number
  /**
   * Painted behind the office where no tile is drawn. Applied inside render(), so a damaged
   * redraw fills only its own rectangles rather than the whole canvas.
   */
  background?: string
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

// ── Damage tracking ───────────────────────────────────────────
// How far around a character's anchor point anything belonging to it can be drawn, in sprite
// pixels: the sprite is 16x32 drawn bottom-anchored, plus held items, selection outline, the
// speech bubble above the head and the skill aura. Deliberately generous - test/dirty-rects.mjs
// compares damaged rendering against full rendering frame by frame and a box that is too small
// shows up there immediately.
const CHAR_DAMAGE_LEFT = 24
const CHAR_DAMAGE_RIGHT = 24
const CHAR_DAMAGE_UP = 68
const CHAR_DAMAGE_DOWN = 12
/** Extra margin when a skill aura is drawn around the character */
const CHAR_DAMAGE_AURA = 40
/** Furniture and props: the sprite's own box plus a little, since sprites are drawn on integers */
const FURNITURE_DAMAGE_MARGIN = 2
/** Lamps also paint a light pool well beyond their sprite */
const LAMP_DAMAGE_MARGIN = 40
/** Vacuums draw a sprite, a trail and an overlay label */
const VACUUM_DAMAGE_MARGIN = 32
const DEFAULT_FULL_REDRAW_SEC = 2
/** Merging two damage rects may not inflate the drawn area by more than this factor */
const MERGE_MAX_WASTE = 1.25
/** Above this many rects, merge more eagerly: each rect costs a clip edge and a readback */
const MERGE_MAX_RECTS = 12
const MERGE_GIVE_UP_WASTE = 8
// The sun sweeps a full cycle in SUN_CYCLE_DURATION_SEC (300 s), so its angle, intensity and
// colour change every single frame - and beams cover half the office, so any change means a full
// redraw. Quantising the values the renderer uses makes the picture change in steps that are
// invisible at this scale (0.01 rad is ~0.6 degrees) but let whole seconds of frames be identical.
const SUN_ANGLE_STEP = 0.01
const SUN_INTENSITY_STEP = 0.02
const SUN_REACH_STEP = 0.05
const WEATHER_SEVERITY_STEP = 0.05
const quantise = (v: number, step: number) => Math.round(v / step) * step

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
export type DamageRect = OverlayRect

export interface HeadlessOffice {
  handleRelayMessage(msg: Record<string, unknown>): void
  tick(dt: number): void
  render(ctx: CanvasRenderingContext2D): void
   /**
   * Render a frame and report which rectangles of it can differ from the previous one, in canvas
   * pixels. Returns null when that cannot be narrowed down (first frame, layout or agent change,
   * the sun stepping, the periodic full redraw) and an empty array when nothing changed at all.
   *
   * The scene itself is still drawn in full: clipping the draw to the damaged rectangles was
   * tried and made it five times slower, because every draw call then tests against a multi-rect
   * clip. The value is downstream - the caller converts and sends only these rectangles, which is
   * where the per-frame megabyte of writes was.
   *
   * `extra` rectangles are reported as damaged too; the native renderer passes the areas its
   * full-resolution nametag overlay painted last frame and this frame, so the scene underneath a
   * tag that moved is converted again.
   */
  renderDamaged(ctx: CanvasRenderingContext2D, extra?: DamageRect[]): DamageRect[] | null
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
  /** Engine internals, for the tests that watch behaviour emerge over simulated office days */
  debug(): { officeHour: () => number; workload: () => number; characters: () => Character[] }
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
    // The office's day runs whether or not its light is drawn: the wall clocks read it
    updateSunCycle(dt)
    updateWeather(dt)
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

  // ── Damage tracking state ─────────────────────────────────────
  // Everything the scene draws is either (a) a character, (b) a furniture instance (props and
  // active-state sprite swaps included - OfficeState replaces the whole array when any of them
  // changes), (c) a vacuum, (d) sunlight beams, (e) weather inside windows, or (f) the static
  // background. Each frame we build the union of the boxes whose inputs changed, plus the boxes
  // they occupied last frame, and clip the redraw to that.
  const charSigs = new Map<number, string>()
  const charBoxes = new Map<number, DamageRect>()
  const vacuumSigs = new Map<string, string>()
  const vacuumBoxes = new Map<string, DamageRect>()
  let prevFurnitureBoxes = new Map<string, DamageRect>()
  const prevSpriteByKey = new Map<string, SpriteData>()
  let prevSunKey = ''
  let lastFullRedrawAt = 0
  let damageValid = false

  const fullRedrawSec = opts.fullRedrawSec ?? DEFAULT_FULL_REDRAW_SEC

  /** Sun and weather as the renderer uses them: stepped, so identical frames stay identical */
  function steppedSun(): { angle: number; intensity: number; reach: number; color: [number, number, number]; weather: number } {
    const { angle, intensity, reach, color } = getSunState()
    return {
      angle: quantise(angle, SUN_ANGLE_STEP),
      intensity: quantise(intensity, SUN_INTENSITY_STEP),
      reach: quantise(reach, SUN_REACH_STEP),
      color: [Math.round(color[0]), Math.round(color[1]), Math.round(color[2])],
      weather: quantise(getWeatherSeverity(), WEATHER_SEVERITY_STEP),
    }
  }

  function charSignature(ch: Character): string {
    // Anything that changes a character's pixels. bubbleTimer is included while a bubble is
    // fading (its alpha changes every frame) but not once it is stable.
    const fading = ch.bubbleType && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC ? ch.bubbleTimer.toFixed(3) : ''
    return `${Math.round(ch.x * zoom)},${Math.round(ch.y * zoom)},${ch.state},${ch.dir},${ch.frame},${ch.bubbleType ?? ''},${ch.bubbleItemType ?? ''},${fading},${ch.heldItem ?? ''},${ch.matrixEffect ?? ''},${ch.matrixEffect ? ch.matrixEffectTimer.toFixed(3) : ''},${ch.activeSkill ? 'skill' : ''},${ch.nametag ?? ''}`
  }

  function charBox(ch: Character): DamageRect {
    const m = ch.activeSkill ? CHAR_DAMAGE_AURA : 0
    const cx = lastOffset.x + ch.x * zoom
    const cy = lastOffset.y + ch.y * zoom
    return {
      x: cx - (CHAR_DAMAGE_LEFT + m) * zoom,
      y: cy - (CHAR_DAMAGE_UP + m) * zoom,
      w: (CHAR_DAMAGE_LEFT + CHAR_DAMAGE_RIGHT + 2 * m) * zoom,
      h: (CHAR_DAMAGE_UP + CHAR_DAMAGE_DOWN + 2 * m) * zoom,
    }
  }

  function furnitureBox(f: FurnitureInstance): DamageRect {
    const w = Math.max(f.sprite[0]?.length ?? 0, f.footprintW * TILE_SIZE)
    const h = f.sprite.length
    const m = f.isLamp ? LAMP_DAMAGE_MARGIN : FURNITURE_DAMAGE_MARGIN
    return {
      x: lastOffset.x + f.x * zoom - m * zoom,
      y: lastOffset.y + f.y * zoom - m * zoom,
      w: (w + 2 * m) * zoom,
      h: (h + 2 * m) * zoom,
    }
  }

  /** Only the glass of a window changes every frame, not the whole frame sprite around it */
  function glassBoxes(f: FurnitureInstance, out: DamageRect[]): void {
    for (const sec of f.glassSections ?? []) {
      addRect(out, {
        x: lastOffset.x + (f.x + sec.x) * zoom - zoom,
        y: lastOffset.y + (f.y + sec.y) * zoom - zoom,
        w: (sec.w + 2) * zoom,
        h: (sec.h + 2) * zoom,
      })
    }
  }

  /** Union of two rects (both already in canvas pixels) */
  function addRect(list: DamageRect[], r: DamageRect): void {
    const x = Math.max(0, Math.floor(r.x))
    const y = Math.max(0, Math.floor(r.y))
    const x2 = Math.min(width, Math.ceil(r.x + r.w))
    const y2 = Math.min(height, Math.ceil(r.y + r.h))
    if (x2 <= x || y2 <= y) return
    list.push({ x, y, w: x2 - x, h: y2 - y })
  }

  /**
   * Merge rects that overlap or nearly do. Two distant rects merge into a bounding box far larger
   * than both, so a merge only happens when it costs little area; when there are too many rects
   * for a cheap clip, the threshold is relaxed until the count fits.
   */
  function mergeRects(rects: DamageRect[], waste = MERGE_MAX_WASTE): DamageRect[] {
    const out: DamageRect[] = []
    for (const r of rects) {
      let cur = r
      let merged = true
      while (merged) {
        merged = false
        for (let i = 0; i < out.length; i++) {
          const o = out[i]
          const ox2 = o.x + o.w, oy2 = o.y + o.h
          const cx2 = cur.x + cur.w, cy2 = cur.y + cur.h
          const x = Math.min(o.x, cur.x), y = Math.min(o.y, cur.y)
          const w = Math.max(ox2, cx2) - x, h = Math.max(oy2, cy2) - y
          const overlaps = cur.x <= ox2 && o.x <= cx2 && cur.y <= oy2 && o.y <= cy2
          if (overlaps || w * h <= (o.w * o.h + cur.w * cur.h) * waste) {
            cur = { x, y, w, h }
            out.splice(i, 1)
            merged = true
            break
          }
        }
      }
      out.push(cur)
    }
    return out.length > MERGE_MAX_RECTS && waste < MERGE_GIVE_UP_WASTE ? mergeRects(out, waste * 2) : out
  }

  function collectDamage(extra?: DamageRect[]): DamageRect[] | null {
    const rects: DamageRect[] = []
    if (extra) for (const r of extra) addRect(rects, r)

    // Characters: new box and old box for anything whose pixels can differ
    const seen = new Set<number>()
    for (const ch of os.getCharacters()) {
      seen.add(ch.id)
      const sig = charSignature(ch)
      const box = charBox(ch)
      if (charSigs.get(ch.id) !== sig) {
        addRect(rects, box)
        const old = charBoxes.get(ch.id)
        if (old) addRect(rects, old)
        charSigs.set(ch.id, sig)
      }
      charBoxes.set(ch.id, box)
    }
    for (const id of [...charSigs.keys()]) {
      if (seen.has(id)) continue
      const old = charBoxes.get(id)
      if (old) addRect(rects, old)
      charSigs.delete(id)
      charBoxes.delete(id)
    }

    // Furniture and props. OfficeState replaces the whole array when items appear or change
    // state, but the work/meeting/interaction cycle animations mutate the instance in place, so
    // every instance is checked by the sprite it would draw, not by array identity.
    const fBoxes = new Map<string, DamageRect>()
    for (const f of os.furniture) {
      const key = f.uid ?? `${f.col},${f.row},${f.zY}`
      const box = furnitureBox(f)
      fBoxes.set(key, box)
      const sprite = f.activeDataSprite ?? f.activeWorkSprite ?? f.activeInteractionSprite ?? f.activeMeetingSprite ?? f.activeIdleSprite ?? f.sprite
      const before = prevFurnitureBoxes.get(key)
      if (!before || prevSpriteByKey.get(key) !== sprite) {
        addRect(rects, box)
        if (before) addRect(rects, before)
      }
      prevSpriteByKey.set(key, sprite)
    }
    for (const [key, before] of prevFurnitureBoxes) {
      if (!fBoxes.has(key)) { addRect(rects, before); prevSpriteByKey.delete(key) }
    }
    prevFurnitureBoxes = fBoxes

    // Vacuums: sprite, trail and overlay all move with them
    const vacSeen = new Set<string>()
    for (const v of os.getVacuumRenderData()) {
      const key = `${Math.round(v.zY)}:${v.x.toFixed(0)}:${v.y.toFixed(0)}`
      vacSeen.add(key)
      const box = {
        x: lastOffset.x + v.x * zoom - VACUUM_DAMAGE_MARGIN * zoom,
        y: lastOffset.y + v.y * zoom - VACUUM_DAMAGE_MARGIN * zoom,
        w: (TILE_SIZE + 2 * VACUUM_DAMAGE_MARGIN) * zoom,
        h: (TILE_SIZE + 2 * VACUUM_DAMAGE_MARGIN) * zoom,
      }
      addRect(rects, box)
      vacuumBoxes.set(key, box)
    }
    for (const [key, box] of [...vacuumBoxes]) {
      if (!vacSeen.has(key)) { addRect(rects, box); vacuumBoxes.delete(key); vacuumSigs.delete(key) }
    }
    // Trails and speech fade continuously while a vacuum is out
    if (os.getVacuumTrails().length > 0 || os.getVacuumSpeechBubbles().length > 0) return null

    // Sunlight beams sweep across large areas; when they step, redraw everything
    if (flags.showSunlight) {
      const sun = steppedSun()
      const key = `${sun.angle}:${sun.intensity}:${sun.reach}:${sun.color.join(',')}:${sun.weather}`
      if (key !== prevSunKey) {
        prevSunKey = key
        return null
      }
      // Windows are repainted every frame: the glass tint blends with the weather transition and
      // the sun's colour on a finer scale than the steps above, and rain and snow animate inside
      // the glass. They are a small part of the canvas, so this is cheap insurance.
      for (const f of os.furniture) {
        if (f.glassSections?.length) glassBoxes(f, rects)
      }
    }

    return mergeRects(rects)
  }

  function renderDamaged(ctx: CanvasRenderingContext2D, extra?: DamageRect[]): DamageRect[] | null {
    const now = Date.now()
    const due = now - lastFullRedrawAt >= fullRedrawSec * 1000
    let rects: DamageRect[] | null = null
    if (damageValid && !due) {
      rects = collectDamage(extra)
    } else {
      // Full redraw: refresh every signature so the next frame damages only real changes
      collectDamage(extra)
    }
    render(ctx)
    if (rects === null) {
      lastFullRedrawAt = now
      damageValid = true
      return null
    }
    return rects
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
      const { angle, intensity, reach, color, weather } = steppedSun()
      sunBeamColor = color
      sunIntensity = intensity
      if (intensity > 0) {
        const beamIntensity = intensity * (1 - weather * 0.85)
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
    if (opts.background) {
      // Behind everything drawn above, and clipped with it when this is a damaged redraw
      ctx.globalCompositeOperation = 'destination-over'
      ctx.fillStyle = opts.background
      ctx.fillRect(0, 0, width, height)
      ctx.globalCompositeOperation = 'source-over'
    }
  }

  function renderNametagOverlay(ctx: CanvasRenderingContext2D, scale: number): OverlayRect[] {
    const rects: OverlayRect[] = []
    // With nametags off there is nothing this pass is for: bubbles are already drawn in the
    // scene, and redrawing them here at full resolution (plus clearing a full-size canvas every
    // frame) was measured at 47% of the whole renderer's CPU.
    if (!opts.nametagOverlay || !flags.showNametags) return rects
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
      // renderNametags only reads the characters, so shallow copies with cleaned labels are enough
      const tagged = opts.nametagStripEmoji ? chars.map((ch) => (ch.nametag ? { ...ch, nametag: stripEmoji(ch.nametag) } : ch)) : chars
      renderNametags(ctx, tagged, ox, oy, z)
      // Bubbles again on top of the tags, so they overlap the way the browser draws them
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
    renderDamaged,
    debug: () => ({ officeHour: getOfficeHour, workload: () => os.getWorkload(), characters: () => os.getCharacters() }),
    setFlags,
    getFlags: () => ({ ...flags }),
    isReady: () => layoutReady,
    agentCount: () => os.characters.size,
  }
}
