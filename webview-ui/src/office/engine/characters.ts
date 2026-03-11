import { CharacterState, Direction, TILE_SIZE } from '../types.js'
import type { Character, Seat, SpriteData, TileType as TileTypeVal } from '../types.js'
import type { CharacterSprites } from '../sprites/spriteData.js'
import { findPath } from '../layout/tileMap.js'
import {
  WALK_SPEED_PX_PER_SEC,
  WALK_FRAME_DURATION_SEC,
  TYPE_FRAME_DURATION_SEC,
  BUILD_FRAME_DURATION_SEC,
  SIT_WAIT_FRAME_DURATION_SEC,
  WANDER_PAUSE_MIN_SEC,
  WANDER_PAUSE_MAX_SEC,
  WANDER_MOVES_BEFORE_REST_MIN,
  WANDER_MOVES_BEFORE_REST_MAX,
  SEAT_REST_MIN_SEC,
  SEAT_REST_MAX_SEC,
  INITIAL_IDLE_SEAT_REST_MIN_SEC,
  INITIAL_IDLE_SEAT_REST_MAX_SEC,
} from '../../constants.js'
import { addBehaviourEntry } from '../../behaviourLog.js'

function logIdle(ch: Character, message: string): void {
  addBehaviourEntry({ agentId: ch.id, agentName: ch.nametag || `Agent ${ch.id}`, message, type: 'idle' })
}

/** Tools that show reading animation instead of typing */
const READING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'])

/** Tools that show build/run animation instead of typing */
const BUILD_TOOLS = new Set(['Bash'])

/** Returns true for any state where the character is seated */
export function isSittingState(state: CharacterState): boolean {
  return state === CharacterState.TYPE
    || state === CharacterState.SIT_IDLE
    || state === CharacterState.SIT_WAIT
    || state === CharacterState.BUILD
}

export function isReadingTool(tool: string | null): boolean {
  if (!tool) return false
  return READING_TOOLS.has(tool)
}

export function isBuildTool(tool: string | null): boolean {
  if (!tool) return false
  return BUILD_TOOLS.has(tool) || tool.startsWith('Bash:')
}

/** Pixel center of a tile */
function tileCenter(col: number, row: number): { x: number; y: number } {
  return {
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
  }
}

/** Direction from one tile to an adjacent tile */
export function directionBetween(fromCol: number, fromRow: number, toCol: number, toRow: number): Direction {
  const dc = toCol - fromCol
  const dr = toRow - fromRow
  if (dc > 0) return Direction.RIGHT
  if (dc < 0) return Direction.LEFT
  if (dr > 0) return Direction.DOWN
  return Direction.UP
}

export function createCharacter(
  id: number,
  palette: number,
  seatId: string | null,
  seat: Seat | null,
  hueShift = 0,
): Character {
  const col = seat ? seat.seatCol : 1
  const row = seat ? seat.seatRow : 1
  const center = tileCenter(col, row)
  return {
    id,
    state: CharacterState.TYPE,
    dir: seat ? seat.facingDir : Direction.DOWN,
    x: center.x,
    y: center.y,
    tileCol: col,
    tileRow: row,
    path: [],
    moveProgress: 0,
    currentTool: null,
    palette,
    hueShift,
    frame: 0,
    frameTimer: 0,
    wanderTimer: 0,
    wanderCount: 0,
    wanderLimit: randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX),
    isActive: false,
    isWaiting: false,
    seatId,
    bubbleType: null,
    bubbleTimer: 0,
    seatTimer: 0,
    idleZoneTimer: 0,
    idleAction: null,
    conversationPartnerId: null,
    idleActionTimer: 0,
    conversationPhase: null,
    chatBubbleVariant: 0,
    preConversationDir: null,
    isSubagent: false,
    parentAgentId: null,
    matrixEffect: null,
    matrixEffectTimer: 0,
    matrixEffectSeeds: [],
  }
}

export function updateCharacter(
  ch: Character,
  dt: number,
  walkableTiles: Array<{ col: number; row: number }>,
  seats: Map<string, Seat>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): void {
  ch.frameTimer += dt

  switch (ch.state) {
    case CharacterState.TYPE: {
      if (ch.frameTimer >= TYPE_FRAME_DURATION_SEC) {
        ch.frameTimer -= TYPE_FRAME_DURATION_SEC
        ch.frame = (ch.frame + 1) % 2
      }
      // Switch to BUILD state if current tool is a build tool
      if (ch.isActive && isBuildTool(ch.currentTool)) {
        ch.state = CharacterState.BUILD
        ch.frame = 0
        ch.frameTimer = 0
        break
      }
      // If no longer active, transition to sitting-wait or sitting-idle
      if (!ch.isActive) {
        if (ch.isWaiting) {
          ch.state = CharacterState.SIT_WAIT
          ch.frame = 0
          ch.frameTimer = 0
        } else {
          ch.state = CharacterState.SIT_IDLE
          ch.frame = 0
          ch.frameTimer = 0
          // Set initial rest timer so agents don't immediately wander after finishing work
          if (ch.seatTimer <= 0) ch.seatTimer = randomRange(INITIAL_IDLE_SEAT_REST_MIN_SEC, INITIAL_IDLE_SEAT_REST_MAX_SEC)
        }
      }
      break
    }

    case CharacterState.BUILD: {
      if (ch.frameTimer >= BUILD_FRAME_DURATION_SEC) {
        ch.frameTimer -= BUILD_FRAME_DURATION_SEC
        ch.frame = (ch.frame + 1) % 3
      }
      // Switch back to TYPE if tool changed to non-build
      if (ch.isActive && !isBuildTool(ch.currentTool)) {
        ch.state = CharacterState.TYPE
        ch.frame = 0
        ch.frameTimer = 0
        break
      }
      // If no longer active, transition to sitting-wait or sitting-idle
      if (!ch.isActive) {
        if (ch.isWaiting) {
          ch.state = CharacterState.SIT_WAIT
          ch.frame = 0
          ch.frameTimer = 0
        } else {
          ch.state = CharacterState.SIT_IDLE
          ch.frame = 0
          ch.frameTimer = 0
          // Set initial rest timer so agents don't immediately wander after finishing work
          if (ch.seatTimer <= 0) ch.seatTimer = randomRange(INITIAL_IDLE_SEAT_REST_MIN_SEC, INITIAL_IDLE_SEAT_REST_MAX_SEC)
        }
      }
      break
    }

    case CharacterState.SIT_IDLE: {
      // Sitting at seat, not working — slow idle animation (casually looking around)
      if (ch.frameTimer >= SIT_WAIT_FRAME_DURATION_SEC) {
        ch.frameTimer -= SIT_WAIT_FRAME_DURATION_SEC
        ch.frame = (ch.frame + 1) % 2
      }
      // If became active, start working
      if (ch.isActive) {
        ch.state = isBuildTool(ch.currentTool) ? CharacterState.BUILD : CharacterState.TYPE
        ch.frame = 0
        ch.frameTimer = 0
        break
      }
      // After sitting idle for a while, stand up and wander
      // seatTimer counts down from a pre-set value (set on state entry)
      // Pause countdown if in a seated conversation
      if (ch.seatTimer > 0) {
        if (!ch.idleAction) ch.seatTimer -= dt
        break
      }
      ch.state = CharacterState.IDLE
      ch.frame = 0
      ch.frameTimer = 0
      ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC)
      ch.wanderCount = 0
      ch.wanderLimit = randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX)
      ch.idleAction = null // will be assigned by officeState
      break
    }

    case CharacterState.SIT_WAIT: {
      // Sitting at seat, waiting for user response — slow reading animation
      if (ch.frameTimer >= SIT_WAIT_FRAME_DURATION_SEC) {
        ch.frameTimer -= SIT_WAIT_FRAME_DURATION_SEC
        ch.frame = (ch.frame + 1) % 2
      }
      // If became active again, start working
      if (ch.isActive) {
        ch.state = isBuildTool(ch.currentTool) ? CharacterState.BUILD : CharacterState.TYPE
        ch.frame = 0
        ch.frameTimer = 0
        break
      }
      // If no longer waiting (dismissed), transition to sitting idle
      if (!ch.isWaiting) {
        ch.state = CharacterState.SIT_IDLE
        ch.frame = 0
        ch.frameTimer = 0
        ch.seatTimer = 0
      }
      break
    }

    case CharacterState.IDLE: {
      // No idle animation — static pose
      ch.frame = 0
      // If became active, pathfind to seat
      if (ch.isActive) {
        const activeState = isBuildTool(ch.currentTool) ? CharacterState.BUILD : CharacterState.TYPE
        if (!ch.seatId) {
          // No seat assigned — work in place
          ch.state = activeState
          ch.frame = 0
          ch.frameTimer = 0
          break
        }
        const seat = seats.get(ch.seatId)
        if (seat) {
          const path = findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, tileMap, blockedTiles)
          if (path.length > 0) {
            ch.path = path
            ch.moveProgress = 0
            ch.state = CharacterState.WALK
            ch.frame = 0
            ch.frameTimer = 0
          } else {
            // Already at seat or no path — sit down
            ch.state = activeState
            ch.dir = seat.facingDir
            ch.frame = 0
            ch.frameTimer = 0
          }
        }
        break
      }
      // Countdown wander timer
      ch.wanderTimer -= dt
      if (ch.wanderTimer <= 0) {
        // Check if we've wandered enough — return to seat for a rest
        if (ch.wanderCount >= ch.wanderLimit && ch.seatId) {
          const seat = seats.get(ch.seatId)
          if (seat) {
            const path = findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, tileMap, blockedTiles)
            if (path.length > 0) {
              logIdle(ch, 'heading back to desk')
              ch.path = path
              ch.moveProgress = 0
              ch.state = CharacterState.WALK
              ch.frame = 0
              ch.frameTimer = 0
              break
            }
          }
        }
        if (walkableTiles.length > 0) {
          const target = walkableTiles[Math.floor(Math.random() * walkableTiles.length)]
          const path = findPath(ch.tileCol, ch.tileRow, target.col, target.row, tileMap, blockedTiles)
          if (path.length > 0) {
            ch.path = path
            ch.moveProgress = 0
            ch.state = CharacterState.WALK
            ch.frame = 0
            ch.frameTimer = 0
            ch.wanderCount++
          }
        }
        ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC)
      }
      break
    }

    case CharacterState.WALK: {
      // Walk animation
      if (ch.frameTimer >= WALK_FRAME_DURATION_SEC) {
        ch.frameTimer -= WALK_FRAME_DURATION_SEC
        ch.frame = (ch.frame + 1) % 4
      }

      if (ch.path.length === 0) {
        // Path complete — snap to tile center and transition
        const center = tileCenter(ch.tileCol, ch.tileRow)
        ch.x = center.x
        ch.y = center.y

        if (ch.isActive) {
          const activeState = isBuildTool(ch.currentTool) ? CharacterState.BUILD : CharacterState.TYPE
          if (!ch.seatId) {
            // No seat — work in place
            ch.state = activeState
          } else {
            const seat = seats.get(ch.seatId)
            if (seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
              ch.state = activeState
              ch.dir = seat.facingDir
            } else {
              ch.state = CharacterState.IDLE
            }
          }
        } else {
          // Check if arrived at assigned seat — sit down for a rest
          if (ch.seatId) {
            const seat = seats.get(ch.seatId)
            if (seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
              logIdle(ch, 'sitting down to rest')
              ch.dir = seat.facingDir
              ch.state = ch.isWaiting ? CharacterState.SIT_WAIT : CharacterState.SIT_IDLE
              // Rest at seat before wandering again
              if (!ch.isWaiting && ch.seatTimer <= 0) {
                ch.seatTimer = randomRange(SEAT_REST_MIN_SEC, SEAT_REST_MAX_SEC)
              }
              ch.wanderCount = 0
              ch.wanderLimit = randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX)
              ch.frame = 0
              ch.frameTimer = 0
              break
            }
          }
          ch.state = CharacterState.IDLE
          ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC)
        }
        ch.frame = 0
        ch.frameTimer = 0
        break
      }

      // Move toward next tile in path
      const nextTile = ch.path[0]
      ch.dir = directionBetween(ch.tileCol, ch.tileRow, nextTile.col, nextTile.row)

      ch.moveProgress += (WALK_SPEED_PX_PER_SEC / TILE_SIZE) * dt

      const fromCenter = tileCenter(ch.tileCol, ch.tileRow)
      const toCenter = tileCenter(nextTile.col, nextTile.row)
      const t = Math.min(ch.moveProgress, 1)
      ch.x = fromCenter.x + (toCenter.x - fromCenter.x) * t
      ch.y = fromCenter.y + (toCenter.y - fromCenter.y) * t

      if (ch.moveProgress >= 1) {
        // Arrived at next tile
        ch.tileCol = nextTile.col
        ch.tileRow = nextTile.row
        ch.x = toCenter.x
        ch.y = toCenter.y
        ch.path.shift()
        ch.moveProgress = 0
      }

      // If became active while wandering, repath to seat
      if (ch.isActive && ch.seatId) {
        const seat = seats.get(ch.seatId)
        if (seat) {
          const lastStep = ch.path[ch.path.length - 1]
          if (!lastStep || lastStep.col !== seat.seatCol || lastStep.row !== seat.seatRow) {
            const newPath = findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, tileMap, blockedTiles)
            if (newPath.length > 0) {
              ch.path = newPath
              ch.moveProgress = 0
            }
          }
        }
      }
      break
    }
  }
}

/** Get the correct sprite frame for a character's current state and direction */
export function getCharacterSprite(ch: Character, sprites: CharacterSprites): SpriteData {
  switch (ch.state) {
    case CharacterState.TYPE:
      if (isReadingTool(ch.currentTool)) {
        return sprites.reading[ch.dir][ch.frame % 2]
      }
      return sprites.typing[ch.dir][ch.frame % 2]
    case CharacterState.BUILD:
      // Build: cycle through walk frames 0-2 while seated (looking around animatedly)
      return sprites.walk[ch.dir][ch.frame % 3]
    case CharacterState.SIT_IDLE:
      // Sitting idle: slow reading animation (casually looking around)
      return sprites.reading[ch.dir][ch.frame % 2]
    case CharacterState.SIT_WAIT:
      // Waiting: slow reading animation (casually looking around)
      return sprites.reading[ch.dir][ch.frame % 2]
    case CharacterState.WALK:
      return sprites.walk[ch.dir][ch.frame % 4]
    case CharacterState.IDLE:
      return sprites.walk[ch.dir][1]
    default:
      return sprites.walk[ch.dir][1]
  }
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}
