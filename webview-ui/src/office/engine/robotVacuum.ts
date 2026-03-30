import type { TileType as TileTypeVal, SpriteData, Direction as DirectionType, FloorColor } from '../types.js'
import { TileType, TILE_SIZE, Direction } from '../types.js'
import { findPath } from '../layout/tileMap.js'
import { directionBetween } from './characters.js'
import { getCatalogEntry } from '../layout/furnitureCatalog.js'
import {
  VACUUM_SPEED_PX_PER_SEC,
  VACUUM_WAIT_DURATION_MIN_SEC,
  VACUUM_WAIT_DURATION_MAX_SEC,
  VACUUM_MAX_TILES_PER_CHARGE,
  ROBOT_VACUUM_TYPE_PREFIX,
  VACUUM_TRAIL_FADE_SEC,
  VACUUM_TRAIL_SPAWN_INTERVAL_PX,
  VACUUM_DOCK_CYCLE_INTERVAL_SEC,
  VACUUM_AUTO_CYCLE_MIN_SEC,
  VACUUM_AUTO_CYCLE_MAX_SEC,
  VACUUM_SPEECH_DURATION_SEC,
} from '../../constants.js'

// ── Types ────────────────────────────────────────────────────

export const VacuumState = {
  DOCKED: 'docked',
  CLEANING: 'cleaning',
  TRAVELING: 'traveling',
  WAITING: 'waiting',
  RETURNING: 'returning',
} as const
export type VacuumState = (typeof VacuumState)[keyof typeof VacuumState]

export interface RobotVacuumInstance {
  furnitureUid: string
  customName: string
  baseCol: number
  baseRow: number
  baseDir: DirectionType
  state: VacuumState
  paused: boolean
  x: number
  y: number
  tileCol: number
  tileRow: number
  dir: DirectionType
  path: Array<{ col: number; row: number }>
  moveProgress: number
  rooms: Array<Set<string>>
  cleanedRoomIndices: Set<number>
  currentRoomIndex: number
  coveragePlan: Array<{ col: number; row: number }>
  coveragePlanIndex: number
  waitTimer: number
  cycleActive: boolean
  sprites: Record<string, SpriteData>
  /** Dock sprites keyed by Direction (same mapping as vacuum sprites) */
  dockSprites: Record<string, SpriteData>
  /** Dock charging animation frames per direction: direction → SpriteData[] */
  dockChargingSprites: Record<string, SpriteData[]>
  /** Current charging animation frame index */
  dockCycleFrame: number
  /** Timer for dock charging animation cycling */
  dockCycleTimer: number
  /** Trail patches at pixel positions (centerX, centerY) */
  trail: Array<{ px: number; py: number; age: number }>
  /** Distance traveled since last trail patch (in sprite pixels) */
  trailDistAccum: number
  tilesCleaned: number
  /** Countdown timer for automatic cleaning cycle trigger */
  autoCycleTimer: number
  /** Room indices currently being cleaned by OTHER vacuums (set externally each tick) */
  reservedRoomIndices: Set<number>
  /** Speech bubble text (null = no bubble) */
  speechText: string | null
  /** Speech bubble remaining display time in seconds */
  speechTimer: number
}

// ── Direction ↔ orientation mapping ──────────────────────────

const DIR_TO_ORIENTATION: Record<number, string> = {
  [Direction.DOWN]: 'front',
  [Direction.UP]: 'back',
  [Direction.LEFT]: 'left',
  [Direction.RIGHT]: 'right',
}

export function orientationToDir(orientation: string): DirectionType {
  switch (orientation) {
    case 'front': return Direction.DOWN
    case 'back': return Direction.UP
    case 'left': return Direction.LEFT
    case 'right': return Direction.RIGHT
    default: return Direction.DOWN
  }
}

// ── Helpers ──────────────────────────────────────────────────

export function isRobotVacuumType(type: string): boolean {
  return type.startsWith(ROBOT_VACUUM_TYPE_PREFIX)
}

/** Resolve the 4 directional sprites for the vacuum from the catalog. */
function resolveVacuumSprites(): Record<string, SpriteData> {
  const sprites: Record<string, SpriteData> = {}
  for (const [dir, orientation] of Object.entries(DIR_TO_ORIENTATION)) {
    const id = orientation === 'front' ? 'ROBOT_VACUUM_FRONT'
      : orientation === 'back' ? 'ROBOT_VACUUM_BACK'
      : orientation === 'left' ? 'ROBOT_VACUUM_LEFT'
      : 'ROBOT_VACUUM_RIGHT'
    const entry = getCatalogEntry(id)
    if (entry) sprites[dir] = entry.sprite
  }
  return sprites
}

/** Resolve the 4 directional dock sprites from the catalog. */
function resolveVacuumDockSprites(): Record<string, SpriteData> {
  const sprites: Record<string, SpriteData> = {}
  for (const [dir, orientation] of Object.entries(DIR_TO_ORIENTATION)) {
    const id = orientation === 'front' ? 'ROBOT_VACUUM_DOCK_FRONT'
      : orientation === 'back' ? 'ROBOT_VACUUM_DOCK_BACK'
      : orientation === 'left' ? 'ROBOT_VACUUM_DOCK_LEFT'
      : 'ROBOT_VACUUM_DOCK_RIGHT'
    const entry = getCatalogEntry(id)
    if (entry) sprites[dir] = entry.sprite
  }
  return sprites
}

/** Resolve dock charging animation frames per direction from catalog dockedCycleSprites. */
function resolveVacuumDockChargingSprites(): Record<string, SpriteData[]> {
  const result: Record<string, SpriteData[]> = {}
  for (const [dir, orientation] of Object.entries(DIR_TO_ORIENTATION)) {
    const id = orientation === 'front' ? 'ROBOT_VACUUM_DOCK_FRONT'
      : orientation === 'back' ? 'ROBOT_VACUUM_DOCK_BACK'
      : orientation === 'left' ? 'ROBOT_VACUUM_DOCK_LEFT'
      : 'ROBOT_VACUUM_DOCK_RIGHT'
    const entry = getCatalogEntry(id)
    console.log(`[Vacuum] Dock charging sprites for ${id}: entry=${!!entry}, dockedCycleSprites=${entry?.dockedCycleSprites?.length ?? 0}`)
    if (entry?.dockedCycleSprites && entry.dockedCycleSprites.length > 0) {
      result[dir] = entry.dockedCycleSprites
    }
  }
  return result
}

// ── Factory ──────────────────────────────────────────────────

export function createVacuumInstance(
  uid: string,
  col: number,
  row: number,
  type: string,
): RobotVacuumInstance {
  // Determine base direction from the furniture type's orientation
  const entry = getCatalogEntry(type)
  const baseDir = entry?.orientation ? orientationToDir(entry.orientation) : Direction.DOWN

  return {
    furnitureUid: uid,
    customName: '',
    baseCol: col,
    baseRow: row,
    baseDir,
    state: VacuumState.DOCKED,
    paused: false,
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
    tileCol: col,
    tileRow: row,
    dir: baseDir,
    path: [],
    moveProgress: 0,
    rooms: [],
    cleanedRoomIndices: new Set(),
    currentRoomIndex: -1,
    coveragePlan: [],
    coveragePlanIndex: 0,
    waitTimer: 0,
    cycleActive: false,
    sprites: resolveVacuumSprites(),
    dockSprites: resolveVacuumDockSprites(),
    dockChargingSprites: resolveVacuumDockChargingSprites(),
    dockCycleFrame: 0,
    dockCycleTimer: 0,
    trail: [],
    trailDistAccum: 0,
    tilesCleaned: 0,
    autoCycleTimer: randomAutoCycleDelay(),
    speechText: null,
    speechTimer: 0,
    reservedRoomIndices: new Set(),
  }
}

function randomAutoCycleDelay(): number {
  return VACUUM_AUTO_CYCLE_MIN_SEC + Math.random() * (VACUUM_AUTO_CYCLE_MAX_SEC - VACUUM_AUTO_CYCLE_MIN_SEC)
}

// ── Room detection ───────────────────────────────────────────

/**
 * Detect rooms by flood-filling connected floor tiles.
 * Walls and void separate rooms; different floor patterns within the
 * same connected area are treated as ONE room.
 * Returns only walkable, non-chair tiles per room.
 */
/** Build a color key for a tile — tiles with different colors are different rooms. */
function floorColorKey(tileColors: Array<FloorColor | null> | undefined, col: number, row: number, cols: number): string {
  if (!tileColors) return ''
  const fc = tileColors[row * cols + col]
  if (!fc) return ''
  return `${fc.h}:${fc.s}:${fc.b}:${fc.c}:${fc.colorize ? 1 : 0}`
}

export function detectRooms(
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
  chairTiles: Set<string>,
  tileColors?: Array<FloorColor | null>,
): Array<Set<string>> {
  const rows = tileMap.length
  const cols = rows > 0 ? tileMap[0].length : 0
  const visited = new Set<string>()
  const rooms: Array<Set<string>> = []

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const key = `${c},${r}`
      if (visited.has(key)) continue
      const tile = tileMap[r][c]
      if (tile === TileType.WALL || tile === TileType.VOID) continue

      // Flood-fill from this tile — only connect tiles with the same type AND color
      const seedColorKey = floorColorKey(tileColors, c, r, cols)
      const roomAllTiles = new Set<string>()
      const queue = [{ col: c, row: r }]
      visited.add(key)
      while (queue.length > 0) {
        const { col: qc, row: qr } = queue.shift()!
        roomAllTiles.add(`${qc},${qr}`)
        for (const [dc, dr] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
          const nc = qc + dc
          const nr = qr + dr
          if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue
          const nk = `${nc},${nr}`
          if (visited.has(nk)) continue
          const nt = tileMap[nr][nc]
          if (nt === TileType.WALL || nt === TileType.VOID) continue
          // Different floor color = different room
          if (floorColorKey(tileColors, nc, nr, cols) !== seedColorKey) continue
          visited.add(nk)
          queue.push({ col: nc, row: nr })
        }
      }

      // Filter to only walkable, non-chair tiles
      const walkableRoom = new Set<string>()
      for (const tk of roomAllTiles) {
        if (blockedTiles.has(tk) || chairTiles.has(tk)) continue
        walkableRoom.add(tk)
      }
      if (walkableRoom.size > 0) {
        rooms.push(walkableRoom)
      }
    }
  }

  return rooms
}

// ── Coverage pattern ─────────────────────────────────────────

/**
 * Generate a boustrophedon (back-and-forth mowing) coverage plan.
 * Sweeps rows top-to-bottom, alternating left-right and right-left.
 */
function generateCoveragePlan(
  roomTiles: Set<string>,
  entryCol: number,
): Array<{ col: number; row: number }> {
  // Parse tile coords
  const tiles: Array<{ col: number; row: number }> = []
  for (const key of roomTiles) {
    const [c, r] = key.split(',').map(Number)
    tiles.push({ col: c, row: r })
  }
  if (tiles.length === 0) return []

  // Find bounding box
  let minRow = Infinity, maxRow = -Infinity
  for (const t of tiles) {
    if (t.row < minRow) minRow = t.row
    if (t.row > maxRow) maxRow = t.row
  }

  // Group tiles by row
  const byRow = new Map<number, Array<{ col: number; row: number }>>()
  for (const t of tiles) {
    let arr = byRow.get(t.row)
    if (!arr) { arr = []; byRow.set(t.row, arr) }
    arr.push(t)
  }

  // Determine sweep direction: if entry is on right side, start right-to-left
  const entrySide = entryCol > (tiles.reduce((s, t) => s + t.col, 0) / tiles.length) ? 'right' : 'left'
  let leftToRight = entrySide === 'left'

  const plan: Array<{ col: number; row: number }> = []
  for (let r = minRow; r <= maxRow; r++) {
    const row = byRow.get(r)
    if (!row) continue
    row.sort((a, b) => leftToRight ? a.col - b.col : b.col - a.col)
    plan.push(...row)
    leftToRight = !leftToRight
  }

  return plan
}

// ── Cycle start ──────────────────────────────────────────────

export function startCleaningCycle(
  vacuum: RobotVacuumInstance,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
  chairTiles: Set<string>,
  tileColors?: Array<FloorColor | null>,
): void {
  if (vacuum.cycleActive) return

  // Detect rooms if not already known (rooms persist across presses; reset on layout change)
  if (vacuum.rooms.length === 0) {
    vacuum.rooms = detectRooms(tileMap, blockedTiles, chairTiles, tileColors)
  }

  // Reset cleaned list only when all rooms have been cleaned
  const allDone = vacuum.rooms.length > 0 &&
    vacuum.cleanedRoomIndices.size >= vacuum.rooms.length
  if (allDone) {
    console.log(`[Vacuum] All ${vacuum.rooms.length} rooms previously cleaned, resetting list`)
    vacuum.cleanedRoomIndices = new Set()
  }

  vacuum.cycleActive = true
  vacuum.path = []
  vacuum.moveProgress = 0
  // Keep current tilesCleaned (battery) — user may start before fully charged

  const roomSizes = vacuum.rooms.map(r => r.size)
  const totalTiles = roomSizes.reduce((a, b) => a + b, 0)
  const uncleanedCount = vacuum.rooms.length - vacuum.cleanedRoomIndices.size
  console.log(`[Vacuum] Starting cycle: ${vacuum.rooms.length} rooms (sizes: ${roomSizes.join(', ')}, total: ${totalTiles} tiles, ${uncleanedCount} uncleaned)`)

  // Pick the next uncleaned room: nearest to current position
  const nextRoom = pickNextRoom(vacuum, vacuum.reservedRoomIndices)
  if (nextRoom === -1) {
    // No rooms to clean
    vacuum.cycleActive = false
    return
  }

  vacuum.currentRoomIndex = nextRoom
  setVacuumSpeech(vacuum, 'Starting room cleaning...')
  beginCleaningRoom(vacuum, tileMap, blockedTiles)
}

function pickNextRoom(vacuum: RobotVacuumInstance, reservedRoomIndices?: Set<number>): number {
  let bestIdx = -1
  let bestDist = Infinity
  for (let i = 0; i < vacuum.rooms.length; i++) {
    if (vacuum.cleanedRoomIndices.has(i)) continue
    if (reservedRoomIndices && reservedRoomIndices.has(i)) continue
    // Find nearest tile in this room
    for (const key of vacuum.rooms[i]) {
      const [c, r] = key.split(',').map(Number)
      const d = Math.abs(c - vacuum.tileCol) + Math.abs(r - vacuum.tileRow)
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
  }
  return bestIdx
}

function findNearestTileInRoom(
  vacuum: RobotVacuumInstance,
  roomIdx: number,
): { col: number; row: number } | null {
  const room = vacuum.rooms[roomIdx]
  if (!room || room.size === 0) return null
  let best: { col: number; row: number } | null = null
  let bestDist = Infinity
  for (const key of room) {
    const [c, r] = key.split(',').map(Number)
    const d = Math.abs(c - vacuum.tileCol) + Math.abs(r - vacuum.tileRow)
    if (d < bestDist) {
      bestDist = d
      best = { col: c, row: r }
    }
  }
  return best
}

function beginCleaningRoom(
  vacuum: RobotVacuumInstance,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): void {
  const entry = findNearestTileInRoom(vacuum, vacuum.currentRoomIndex)
  if (!entry) {
    vacuum.state = VacuumState.RETURNING
    return
  }

  // If we're not in the room yet, travel there first
  if (!vacuum.rooms[vacuum.currentRoomIndex].has(`${vacuum.tileCol},${vacuum.tileRow}`)) {
    vacuum.path = findPath(vacuum.tileCol, vacuum.tileRow, entry.col, entry.row, tileMap, blockedTiles)
    if (vacuum.path.length > 0) {
      vacuum.state = VacuumState.TRAVELING
    } else {
      // Can't reach room, skip it
      vacuum.cleanedRoomIndices.add(vacuum.currentRoomIndex)
      advanceToNextRoom(vacuum, tileMap, blockedTiles)
    }
    return
  }

  // Already in the room — generate coverage plan
  vacuum.coveragePlan = generateCoveragePlan(
    vacuum.rooms[vacuum.currentRoomIndex],
    vacuum.tileCol,
  )
  vacuum.coveragePlanIndex = 0
  vacuum.state = VacuumState.CLEANING
  console.log(`[Vacuum] Cleaning room ${vacuum.currentRoomIndex + 1}/${vacuum.rooms.length} (${vacuum.coveragePlan.length} tiles to cover, ${vacuum.tilesCleaned}/${VACUUM_MAX_TILES_PER_CHARGE} battery)`)
}

/** Pathfind to base, temporarily unblocking the vacuum's own furniture tile. */
function pathfindToBase(
  vacuum: RobotVacuumInstance,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): Array<{ col: number; row: number }> {
  const baseKey = `${vacuum.baseCol},${vacuum.baseRow}`
  const wasBlocked = blockedTiles.has(baseKey)
  blockedTiles.delete(baseKey)
  const path = findPath(vacuum.tileCol, vacuum.tileRow, vacuum.baseCol, vacuum.baseRow, tileMap, blockedTiles)
  if (wasBlocked) blockedTiles.add(baseKey)
  return path
}

function advanceToNextRoom(
  vacuum: RobotVacuumInstance,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): void {
  const nextRoom = pickNextRoom(vacuum, vacuum.reservedRoomIndices)
  if (nextRoom === -1) {
    // All rooms cleaned — return to base
    vacuum.state = VacuumState.RETURNING
    vacuum.path = pathfindToBase(vacuum, tileMap, blockedTiles)
    setVacuumSpeech(vacuum, 'Job complete. Returning to dock!')
    return
  }

  // Check battery before starting the next room
  const batteryLeft = VACUUM_MAX_TILES_PER_CHARGE - vacuum.tilesCleaned
  const nextRoomSize = vacuum.rooms[nextRoom]?.size ?? 0
  // Return to recharge if battery can't cover the room — UNLESS the room exceeds max (always attempt it)
  if (batteryLeft < nextRoomSize && nextRoomSize <= VACUUM_MAX_TILES_PER_CHARGE) {
    console.log(`[Vacuum] Battery too low for room ${nextRoom + 1} (${batteryLeft} left, room needs ${nextRoomSize}), returning to base`)
    vacuum.state = VacuumState.RETURNING
    vacuum.path = pathfindToBase(vacuum, tileMap, blockedTiles)
    setVacuumSpeech(vacuum, 'Low battery: Returning to dock!')
    return
  }

  vacuum.currentRoomIndex = nextRoom
  beginCleaningRoom(vacuum, tileMap, blockedTiles)
}

// ── Movement ─────────────────────────────────────────────────

function moveAlongPath(vacuum: RobotVacuumInstance, dt: number): boolean {
  if (vacuum.path.length === 0) return true // arrived

  const next = vacuum.path[0]
  vacuum.dir = directionBetween(vacuum.tileCol, vacuum.tileRow, next.col, next.row)
  vacuum.moveProgress += (VACUUM_SPEED_PX_PER_SEC / TILE_SIZE) * dt

  const fromX = vacuum.tileCol * TILE_SIZE + TILE_SIZE / 2
  const fromY = vacuum.tileRow * TILE_SIZE + TILE_SIZE / 2
  const toX = next.col * TILE_SIZE + TILE_SIZE / 2
  const toY = next.row * TILE_SIZE + TILE_SIZE / 2
  const prevX = vacuum.x
  const prevY = vacuum.y
  const t = Math.min(vacuum.moveProgress, 1)
  vacuum.x = fromX + (toX - fromX) * t
  vacuum.y = fromY + (toY - fromY) * t

  // Track distance for trail spawning (during cleaning)
  if (vacuum.state === VacuumState.CLEANING) {
    const dx = vacuum.x - prevX
    const dy = vacuum.y - prevY
    vacuum.trailDistAccum += Math.sqrt(dx * dx + dy * dy)
    while (vacuum.trailDistAccum >= VACUUM_TRAIL_SPAWN_INTERVAL_PX) {
      vacuum.trailDistAccum -= VACUUM_TRAIL_SPAWN_INTERVAL_PX
      vacuum.trail.push({ px: vacuum.x, py: vacuum.y, age: 0 })
    }
  }

  if (vacuum.moveProgress >= 1) {
    vacuum.tileCol = next.col
    vacuum.tileRow = next.row
    vacuum.x = toX
    vacuum.y = toY
    vacuum.path.shift()
    vacuum.moveProgress = 0
    // Count tiles for battery
    if (vacuum.state === VacuumState.CLEANING) {
      vacuum.tilesCleaned++
      if (vacuum.tilesCleaned % 10 === 0) {
        const tilesLeft = vacuum.coveragePlan.length - vacuum.coveragePlanIndex
        console.log(`[Vacuum] Progress: ${vacuum.tilesCleaned}/${VACUUM_MAX_TILES_PER_CHARGE} battery, room ${vacuum.currentRoomIndex + 1} tiles left: ${tilesLeft}`)
      }
    }
  }

  return vacuum.path.length === 0
}

// ── Character collision check ────────────────────────────────

function isTileOccupiedByCharacter(
  col: number,
  row: number,
  characters: Map<number, { tileCol: number; tileRow: number }>,
): boolean {
  for (const ch of characters.values()) {
    if (ch.tileCol === col && ch.tileRow === row) return true
  }
  return false
}

// ── Per-tick update ──────────────────────────────────────────

export function updateVacuum(
  vacuum: RobotVacuumInstance,
  dt: number,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
  characters: Map<number, { tileCol: number; tileRow: number }>,
): void {
  // Tick speech bubble timer
  if (vacuum.speechTimer > 0) {
    vacuum.speechTimer -= dt
    if (vacuum.speechTimer <= 0) {
      vacuum.speechText = null
      vacuum.speechTimer = 0
    }
  }

  // Age and prune trail entries
  for (let i = vacuum.trail.length - 1; i >= 0; i--) {
    vacuum.trail[i].age += dt
    if (vacuum.trail[i].age >= VACUUM_TRAIL_FADE_SEC) {
      vacuum.trail.splice(i, 1)
    }
  }

  // Dock charging animation cycle (runs while docked and charging)
  if (vacuum.state === VacuumState.DOCKED && vacuum.tilesCleaned > 0) {
    const frames = vacuum.dockChargingSprites[vacuum.baseDir]
    if (frames && frames.length > 0) {
      vacuum.dockCycleTimer += dt
      if (vacuum.dockCycleTimer >= VACUUM_DOCK_CYCLE_INTERVAL_SEC) {
        vacuum.dockCycleTimer -= VACUUM_DOCK_CYCLE_INTERVAL_SEC
        vacuum.dockCycleFrame = (vacuum.dockCycleFrame + 1) % frames.length
      }
    }
  } else {
    vacuum.dockCycleFrame = 0
    vacuum.dockCycleTimer = 0
  }

  // Auto-cycle countdown: only ticks when docked and fully charged
  if (vacuum.state === VacuumState.DOCKED && vacuum.tilesCleaned <= 0 && !vacuum.cycleActive) {
    vacuum.autoCycleTimer -= dt
  }

  if (vacuum.state === VacuumState.DOCKED) return
  if (vacuum.paused) return

  switch (vacuum.state) {
    case VacuumState.CLEANING:
      updateCleaning(vacuum, dt, tileMap, blockedTiles, characters)
      break
    case VacuumState.TRAVELING:
      updateTraveling(vacuum, dt, tileMap, blockedTiles)
      break
    case VacuumState.WAITING:
      updateWaiting(vacuum, dt, tileMap, blockedTiles, characters)
      break
    case VacuumState.RETURNING:
      updateReturning(vacuum, dt, tileMap, blockedTiles)
      break
  }
}

function updateCleaning(
  vacuum: RobotVacuumInstance,
  dt: number,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
  characters: Map<number, { tileCol: number; tileRow: number }>,
): void {
  // If currently moving along a path, continue
  if (vacuum.path.length > 0) {
    const arrived = moveAlongPath(vacuum, dt)
    if (arrived && vacuum.coveragePlanIndex < vacuum.coveragePlan.length) {
      // Check if we've reached the current coverage tile
      const target = vacuum.coveragePlan[vacuum.coveragePlanIndex]
      if (vacuum.tileCol === target.col && vacuum.tileRow === target.row) {
        vacuum.coveragePlanIndex++
      }
    }
    return
  }

  // Need to move to next coverage tile
  if (vacuum.coveragePlanIndex >= vacuum.coveragePlan.length) {
    // Room complete
    console.log(`[Vacuum] Room ${vacuum.currentRoomIndex + 1} complete (${vacuum.cleanedRoomIndices.size + 1}/${vacuum.rooms.length} rooms done, ${vacuum.tilesCleaned} tiles cleaned)`)
    vacuum.cleanedRoomIndices.add(vacuum.currentRoomIndex)
    advanceToNextRoom(vacuum, tileMap, blockedTiles)
    return
  }

  const target = vacuum.coveragePlan[vacuum.coveragePlanIndex]

  // Already at target?
  if (vacuum.tileCol === target.col && vacuum.tileRow === target.row) {
    vacuum.coveragePlanIndex++
    return
  }

  // Check if character is on target tile
  if (isTileOccupiedByCharacter(target.col, target.row, characters)) {
    vacuum.state = VacuumState.WAITING
    vacuum.waitTimer = VACUUM_WAIT_DURATION_MIN_SEC +
      Math.random() * (VACUUM_WAIT_DURATION_MAX_SEC - VACUUM_WAIT_DURATION_MIN_SEC)
    return
  }

  // Pathfind to next coverage tile
  const path = findPath(vacuum.tileCol, vacuum.tileRow, target.col, target.row, tileMap, blockedTiles)
  if (path.length > 0) {
    vacuum.path = path
    vacuum.moveProgress = 0
  } else {
    // Can't reach tile, skip it
    vacuum.coveragePlanIndex++
  }
}

function updateTraveling(
  vacuum: RobotVacuumInstance,
  dt: number,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): void {
  if (vacuum.path.length > 0) {
    moveAlongPath(vacuum, dt)
    return
  }

  // Arrived at room — generate coverage plan and start cleaning
  const room = vacuum.rooms[vacuum.currentRoomIndex]
  if (room) {
    vacuum.coveragePlan = generateCoveragePlan(room, vacuum.tileCol)
    vacuum.coveragePlanIndex = 0
    vacuum.state = VacuumState.CLEANING
  } else {
    vacuum.state = VacuumState.RETURNING
    vacuum.path = findPath(vacuum.tileCol, vacuum.tileRow, vacuum.baseCol, vacuum.baseRow, tileMap, blockedTiles)
  }
}

function updateWaiting(
  vacuum: RobotVacuumInstance,
  dt: number,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
  characters: Map<number, { tileCol: number; tileRow: number }>,
): void {
  vacuum.waitTimer -= dt
  if (vacuum.waitTimer > 0) return

  const target = vacuum.coveragePlan[vacuum.coveragePlanIndex]
  if (!target) {
    vacuum.state = VacuumState.CLEANING
    return
  }

  if (!isTileOccupiedByCharacter(target.col, target.row, characters)) {
    // Tile freed, resume cleaning
    vacuum.state = VacuumState.CLEANING
    return
  }

  // Still blocked — try to path around by temporarily adding the blocked tile
  const tempBlocked = new Set(blockedTiles)
  tempBlocked.add(`${target.col},${target.row}`)

  // Try to reach the NEXT coverage tile instead, skipping this one
  if (vacuum.coveragePlanIndex + 1 < vacuum.coveragePlan.length) {
    const nextTarget = vacuum.coveragePlan[vacuum.coveragePlanIndex + 1]
    const altPath = findPath(vacuum.tileCol, vacuum.tileRow, nextTarget.col, nextTarget.row, tileMap, tempBlocked)
    if (altPath.length > 0) {
      vacuum.coveragePlanIndex++ // skip blocked tile
      vacuum.path = altPath
      vacuum.moveProgress = 0
      vacuum.state = VacuumState.CLEANING
      return
    }
  }

  // Can't path around, skip this tile
  vacuum.coveragePlanIndex++
  vacuum.state = VacuumState.CLEANING
}

function updateReturning(
  vacuum: RobotVacuumInstance,
  dt: number,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): void {
  if (vacuum.path.length === 0 && (vacuum.tileCol !== vacuum.baseCol || vacuum.tileRow !== vacuum.baseRow)) {
    vacuum.path = pathfindToBase(vacuum, tileMap, blockedTiles)
    if (vacuum.path.length === 0) {
      // Can't reach base, just dock in place
      console.log(`[Vacuum] Can't reach base, docking in place at (${vacuum.tileCol},${vacuum.tileRow})`)
      vacuum.state = VacuumState.DOCKED
      vacuum.cycleActive = false
      vacuum.dir = vacuum.baseDir
      return
    }
  }

  if (vacuum.path.length > 0) {
    moveAlongPath(vacuum, dt)
    return
  }

  // Arrived at base
  vacuum.dir = vacuum.baseDir
  vacuum.x = vacuum.baseCol * TILE_SIZE + TILE_SIZE / 2
  vacuum.y = vacuum.baseRow * TILE_SIZE + TILE_SIZE / 2
  vacuum.tileCol = vacuum.baseCol
  vacuum.tileRow = vacuum.baseRow

  // Dock and wait for next manual trigger — battery charges gradually via OfficeState update
  const uncleaned = vacuum.rooms.filter((_, i) => !vacuum.cleanedRoomIndices.has(i)).length
  if (uncleaned > 0) {
    console.log(`[Vacuum] Docked for recharge (${vacuum.cleanedRoomIndices.size}/${vacuum.rooms.length} rooms done, ${uncleaned} remaining)`)
  } else {
    console.log(`[Vacuum] All ${vacuum.rooms.length} rooms cleaned, docking`)
  }
  vacuum.state = VacuumState.DOCKED
  vacuum.cycleActive = false
  if (vacuum.tilesCleaned > 0) {
    setVacuumSpeech(vacuum, 'Charging...')
  }
}

// ── Sprite access ────────────────────────────────────────────

export function getVacuumSprite(vacuum: RobotVacuumInstance): SpriteData | null {
  return vacuum.sprites[vacuum.dir] ?? null
}

export function getVacuumDockSprite(vacuum: RobotVacuumInstance): SpriteData | null {
  // Show charging animation when docked and battery not full
  if (vacuum.state === VacuumState.DOCKED && vacuum.tilesCleaned > 0) {
    const frames = vacuum.dockChargingSprites[vacuum.baseDir]
    if (frames && frames.length > 0) {
      return frames[vacuum.dockCycleFrame % frames.length]
    }
  }
  return vacuum.dockSprites[vacuum.baseDir] ?? null
}

// ── Reset ────────────────────────────────────────────────────

export function resetVacuumCycle(vacuum: RobotVacuumInstance): void {
  vacuum.state = VacuumState.DOCKED
  vacuum.cycleActive = false
  vacuum.path = []
  vacuum.moveProgress = 0
  vacuum.rooms = []
  vacuum.cleanedRoomIndices = new Set()
  vacuum.currentRoomIndex = -1
  vacuum.coveragePlan = []
  vacuum.coveragePlanIndex = 0
  vacuum.waitTimer = 0
  vacuum.tilesCleaned = 0
  vacuum.trailDistAccum = 0
  vacuum.x = vacuum.baseCol * TILE_SIZE + TILE_SIZE / 2
  vacuum.y = vacuum.baseRow * TILE_SIZE + TILE_SIZE / 2
  vacuum.tileCol = vacuum.baseCol
  vacuum.tileRow = vacuum.baseRow
  vacuum.dir = vacuum.baseDir
  vacuum.paused = false
  vacuum.autoCycleTimer = randomAutoCycleDelay()
}

// ── Speech bubbles ──────────────────────────────────────────

export function setVacuumSpeech(vacuum: RobotVacuumInstance, text: string): void {
  vacuum.speechText = text
  vacuum.speechTimer = VACUUM_SPEECH_DURATION_SEC
}

// ── Auto-cycle ──────────────────────────────────────────────

/** Check if the vacuum's auto-cycle timer has expired. If so, reset it and return true. */
export function checkAutoCycleReady(vacuum: RobotVacuumInstance): boolean {
  if (vacuum.autoCycleTimer <= 0 && vacuum.state === VacuumState.DOCKED && vacuum.tilesCleaned <= 0 && !vacuum.cycleActive) {
    vacuum.autoCycleTimer = randomAutoCycleDelay()
    return true
  }
  return false
}

// ── Pause / Home ────────────────────────────────────────────

export function pauseVacuum(vacuum: RobotVacuumInstance): void {
  if (vacuum.state === VacuumState.DOCKED) return
  vacuum.paused = !vacuum.paused
  if (vacuum.paused) {
    setVacuumSpeech(vacuum, 'Pausing...')
  } else {
    setVacuumSpeech(vacuum, 'Resuming room cleaning...')
  }
}

export function sendVacuumHome(
  vacuum: RobotVacuumInstance,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): void {
  if (vacuum.state === VacuumState.DOCKED) return
  vacuum.paused = false
  vacuum.state = VacuumState.RETURNING
  vacuum.coveragePlan = []
  vacuum.coveragePlanIndex = 0
  vacuum.path = pathfindToBase(vacuum, tileMap, blockedTiles)
  setVacuumSpeech(vacuum, 'Returning to dock!')
}
