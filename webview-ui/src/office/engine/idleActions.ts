import { CharacterState, Direction, IdleActionType } from '../types.js'
import type { Character, PlacedFurniture, Seat, TileType as TileTypeVal } from '../types.js'
import { directionBetween, isSittingState } from './characters.js'
import { addBehaviourEntry } from '../../behaviourLog.js'
import {
  CONVERSATION_MIN_DURATION_SEC,
  CONVERSATION_MAX_DURATION_SEC,
  CONVERSATION_BUBBLE_SHOW_MIN_SEC,
  CONVERSATION_BUBBLE_SHOW_MAX_SEC,
  CONVERSATION_BUBBLE_GAP_MIN_SEC,
  CONVERSATION_BUBBLE_GAP_MAX_SEC,
  CONVERSATION_BUBBLE_INITIAL_MAX_DELAY_SEC,
  THINK_MIN_DURATION_SEC,
  THINK_MAX_DURATION_SEC,
  VISIT_MIN_DURATION_SEC,
  VISIT_MAX_DURATION_SEC,
  SEATED_CONVERSATION_MAX_DISTANCE,
  IDLE_CHAT_BUBBLE_VARIANT_COUNT,
  MEETING_BUBBLE_SHOW_MIN_SEC,
  MEETING_BUBBLE_SHOW_MAX_SEC,
  MEETING_BUBBLE_GAP_MIN_SEC,
  MEETING_BUBBLE_GAP_MAX_SEC,
  MEETING_BUBBLE_INITIAL_MAX_DELAY_SEC,
  MEETING_MIN_PARTICIPANTS,
} from '../../constants.js'
import { getCatalogEntry } from '../layout/furnitureCatalog.js'

// ── Idle Action Registry ───────────────────────────────────────
// Adding a new action: 1) add to IdleActionType in types.ts
// 2) add an entry here  3) add a case in initIdleAction + updateIdleAction

interface IdleActionEntry {
  type: IdleActionType
  weight: number
  /** Action requires another idle non-subagent character */
  needsPartner?: boolean
  /** Action requires "interesting" furniture in the layout */
  needsFurniture?: boolean
}

const IDLE_ACTION_REGISTRY: IdleActionEntry[] = [
  { type: IdleActionType.WANDER, weight: 40 },
  { type: IdleActionType.CONVERSATION, weight: 25, needsPartner: true },
  { type: IdleActionType.VISIT_FURNITURE, weight: 20, needsFurniture: true },
  { type: IdleActionType.STAND_AND_THINK, weight: 15 },
]

function logIdle(ch: Character, message: string): void {
  addBehaviourEntry({ agentId: ch.id, agentName: ch.nametag || `Agent ${ch.id}`, message, type: 'idle' })
}

// ── Helpers ────────────────────────────────────────────────────

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function isInterestingFurniture(type: string): boolean {
  const entry = getCatalogEntry(type)
  return entry?.interactable === true
}

/** Find a walkable tile adjacent to the given furniture piece */
function findAdjacentWalkableTile(
  furniture: PlacedFurniture,
  footprintW: number,
  footprintH: number,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): { col: number; row: number; facingDir: Direction } | null {
  const candidates: Array<{ col: number; row: number; facingDir: Direction }> = []
  const rows = tileMap.length
  const cols = rows > 0 ? tileMap[0].length : 0

  // Check tiles around the furniture footprint
  for (let dc = 0; dc < footprintW; dc++) {
    // Below furniture
    const belowRow = furniture.row + footprintH
    const belowCol = furniture.col + dc
    if (belowRow >= 0 && belowRow < rows && belowCol >= 0 && belowCol < cols) {
      if (!blockedTiles.has(`${belowCol},${belowRow}`) && tileMap[belowRow][belowCol] > 0 && tileMap[belowRow][belowCol] !== 8) {
        candidates.push({ col: belowCol, row: belowRow, facingDir: Direction.UP })
      }
    }
    // Above furniture
    const aboveRow = furniture.row - 1
    const aboveCol = furniture.col + dc
    if (aboveRow >= 0 && aboveRow < rows && aboveCol >= 0 && aboveCol < cols) {
      if (!blockedTiles.has(`${aboveCol},${aboveRow}`) && tileMap[aboveRow][aboveCol] > 0 && tileMap[aboveRow][aboveCol] !== 8) {
        candidates.push({ col: aboveCol, row: aboveRow, facingDir: Direction.DOWN })
      }
    }
  }
  for (let dr = 0; dr < footprintH; dr++) {
    // Left of furniture
    const leftCol = furniture.col - 1
    const leftRow = furniture.row + dr
    if (leftRow >= 0 && leftRow < rows && leftCol >= 0 && leftCol < cols) {
      if (!blockedTiles.has(`${leftCol},${leftRow}`) && tileMap[leftRow][leftCol] > 0 && tileMap[leftRow][leftCol] !== 8) {
        candidates.push({ col: leftCol, row: leftRow, facingDir: Direction.RIGHT })
      }
    }
    // Right of furniture
    const rightCol = furniture.col + footprintW
    const rightRow = furniture.row + dr
    if (rightRow >= 0 && rightRow < rows && rightCol >= 0 && rightCol < cols) {
      if (!blockedTiles.has(`${rightCol},${rightRow}`) && tileMap[rightRow][rightCol] > 0 && tileMap[rightRow][rightCol] !== 8) {
        candidates.push({ col: rightCol, row: rightRow, facingDir: Direction.LEFT })
      }
    }
  }

  if (candidates.length === 0) return null
  return candidates[Math.floor(Math.random() * candidates.length)]
}

/** Find two adjacent walkable tiles for a conversation meeting point */
function findMeetingPoint(
  walkableTiles: Array<{ col: number; row: number }>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): { tileA: { col: number; row: number }; tileB: { col: number; row: number } } | null {
  // Try up to 20 random tiles to find a pair
  const maxAttempts = 20
  const rows = tileMap.length
  const cols = rows > 0 ? tileMap[0].length : 0
  const neighbors = [
    { dc: 0, dr: -1 }, { dc: 0, dr: 1 },
    { dc: -1, dr: 0 }, { dc: 1, dr: 0 },
  ]

  for (let i = 0; i < maxAttempts; i++) {
    const tileA = walkableTiles[Math.floor(Math.random() * walkableTiles.length)]
    if (blockedTiles.has(`${tileA.col},${tileA.row}`)) continue

    for (const n of neighbors) {
      const bCol = tileA.col + n.dc
      const bRow = tileA.row + n.dr
      if (bRow >= 0 && bRow < rows && bCol >= 0 && bCol < cols) {
        if (!blockedTiles.has(`${bCol},${bRow}`) && tileMap[bRow][bCol] > 0 && tileMap[bRow][bCol] !== 8) {
          return { tileA, tileB: { col: bCol, row: bRow } }
        }
      }
    }
  }
  return null
}

/** Check if two characters are sitting near each other (within Manhattan distance) */
function areSeatedNearby(
  a: Character,
  b: Character,
  seats: Map<string, Seat>,
): boolean {
  if (!a.seatId || !b.seatId) return false
  if (!isSittingState(a.state) && a.state !== CharacterState.IDLE) return false
  if (!isSittingState(b.state) && b.state !== CharacterState.IDLE) return false

  const seatA = seats.get(a.seatId)
  const seatB = seats.get(b.seatId)
  if (!seatA || !seatB) return false

  const dist = Math.abs(seatA.seatCol - seatB.seatCol) + Math.abs(seatA.seatRow - seatB.seatRow)
  return dist <= SEATED_CONVERSATION_MAX_DISTANCE
}

/** Try to start a seated conversation for a SIT_IDLE character.
 *  Returns true if a conversation was initiated. */
export function trySeatedConversation(ch: Character, ctx: IdleActionContext): boolean {
  // Only SIT_IDLE characters with no active idle action
  if (ch.state !== CharacterState.SIT_IDLE || ch.idleAction !== null) return false
  if (ch.isActive || ch.isSubagent || ch.isRemote) return false

  // Find a nearby seated idle partner
  const candidates: Character[] = []
  for (const [, other] of ctx.characters) {
    if (other.id === ch.id) continue
    if (other.isSubagent || other.isRemote || other.isActive || other.isWaiting) continue
    if (other.conversationPartnerId !== null || other.matrixEffect !== null) continue
    if (other.idleAction !== null) continue
    if (!isSittingState(other.state)) continue
    if (areSeatedNearby(ch, other, ctx.seats)) {
      candidates.push(other)
    }
  }
  if (candidates.length === 0) return false

  const partner = candidates[Math.floor(Math.random() * candidates.length)]
  const duration = randomRange(CONVERSATION_MIN_DURATION_SEC, CONVERSATION_MAX_DURATION_SEC)

  // Both stay seated, face each other and talk
  ch.idleAction = IdleActionType.CONVERSATION
  ch.conversationPartnerId = partner.id
  ch.conversationPhase = 'talking'
  ch.idleActionTimer = duration
  ch.preConversationDir = ch.dir
  ch.chatBubbleVariant = Math.floor(Math.random() * IDLE_CHAT_BUBBLE_VARIANT_COUNT)
  ch.wanderTimer = randomRange(0, CONVERSATION_BUBBLE_INITIAL_MAX_DELAY_SEC * 0.5)
  ch.dir = directionBetween(ch.tileCol, ch.tileRow, partner.tileCol, partner.tileRow)

  partner.idleAction = IdleActionType.CONVERSATION
  partner.conversationPartnerId = ch.id
  partner.conversationPhase = 'talking'
  partner.idleActionTimer = duration
  partner.preConversationDir = partner.dir
  partner.chatBubbleVariant = Math.floor(Math.random() * IDLE_CHAT_BUBBLE_VARIANT_COUNT)
  partner.wanderTimer = randomRange(CONVERSATION_BUBBLE_INITIAL_MAX_DELAY_SEC * 0.3, CONVERSATION_BUBBLE_INITIAL_MAX_DELAY_SEC)
  partner.dir = directionBetween(partner.tileCol, partner.tileRow, ch.tileCol, ch.tileRow)

  logIdle(ch, `chatting with ${partner.nametag || `Agent ${partner.id}`}`)
  return true
}

// ── Public API ─────────────────────────────────────────────────

export interface IdleActionContext {
  characters: Map<number, Character>
  walkableTiles: Array<{ col: number; row: number }>
  tileMap: TileTypeVal[][]
  blockedTiles: Set<string>
  furniture: PlacedFurniture[]
  seats: Map<string, Seat>
  /** Callback to get catalog footprint for a furniture type */
  getFurnitureFootprint: (type: string) => { w: number; h: number } | null
  /** Find path with own seat unblocked */
  findPathUnblocked: (ch: Character, toCol: number, toRow: number) => Array<{ col: number; row: number }>
}

/** Pick an idle action for a character based on weighted registry + prerequisites */
export function pickIdleAction(ch: Character, ctx: IdleActionContext): IdleActionType {
  // Count available idle partners (non-subagent, non-remote, idle, not in conversation)
  let idlePartnerCount = 0
  for (const [, other] of ctx.characters) {
    if (other.id !== ch.id && !other.isSubagent && !other.isRemote && !other.isActive && !other.isWaiting
      && other.conversationPartnerId === null && other.matrixEffect === null) {
      idlePartnerCount++
    }
  }

  // Check if interesting furniture exists
  const hasInterestingFurniture = ctx.furniture.some(f => isInterestingFurniture(f.type))

  // Filter eligible actions
  const eligible: IdleActionEntry[] = []
  for (const entry of IDLE_ACTION_REGISTRY) {
    if (entry.needsPartner && idlePartnerCount === 0) continue
    if (entry.needsFurniture && !hasInterestingFurniture) continue
    eligible.push(entry)
  }

  if (eligible.length === 0) return IdleActionType.WANDER

  // Weighted random selection
  const totalWeight = eligible.reduce((sum, e) => sum + e.weight, 0)
  let roll = Math.random() * totalWeight
  for (const entry of eligible) {
    roll -= entry.weight
    if (roll <= 0) return entry.type
  }
  return eligible[eligible.length - 1].type
}

/** Initialize a character for a chosen idle action. Returns false if init failed (fall back to wander). */
export function initIdleAction(
  ch: Character,
  action: IdleActionType,
  ctx: IdleActionContext,
): boolean {
  ch.idleAction = action

  switch (action) {
    case IdleActionType.WANDER:
      // Wander uses existing updateCharacter logic — no extra init needed
      logIdle(ch, 'wandering around the office')
      return true

    case IdleActionType.CONVERSATION: {
      // Find idle partners
      const candidates: Character[] = []
      for (const [, other] of ctx.characters) {
        if (other.id !== ch.id && !other.isSubagent && !other.isRemote && !other.isActive && !other.isWaiting
          && other.conversationPartnerId === null && other.matrixEffect === null) {
          candidates.push(other)
        }
      }
      if (candidates.length === 0) return false

      // Try seated conversation first: pick a nearby seated partner
      const seatedPartners = candidates.filter(c => areSeatedNearby(ch, c, ctx.seats))
      if (seatedPartners.length > 0) {
        const partner = seatedPartners[Math.floor(Math.random() * seatedPartners.length)]
        const duration = randomRange(CONVERSATION_MIN_DURATION_SEC, CONVERSATION_MAX_DURATION_SEC)

        // Both stay where they are, just face each other and start talking
        ch.idleAction = IdleActionType.CONVERSATION
        ch.conversationPartnerId = partner.id
        ch.conversationPhase = 'talking'
        ch.idleActionTimer = duration
        ch.preConversationDir = ch.dir
        ch.chatBubbleVariant = Math.floor(Math.random() * IDLE_CHAT_BUBBLE_VARIANT_COUNT)
        ch.wanderTimer = randomRange(0, CONVERSATION_BUBBLE_INITIAL_MAX_DELAY_SEC * 0.5)
        ch.dir = directionBetween(ch.tileCol, ch.tileRow, partner.tileCol, partner.tileRow)

        partner.idleAction = IdleActionType.CONVERSATION
        partner.conversationPartnerId = ch.id
        partner.conversationPhase = 'talking'
        partner.idleActionTimer = duration
        partner.preConversationDir = partner.dir
        partner.chatBubbleVariant = Math.floor(Math.random() * IDLE_CHAT_BUBBLE_VARIANT_COUNT)
        partner.wanderTimer = randomRange(CONVERSATION_BUBBLE_INITIAL_MAX_DELAY_SEC * 0.3, CONVERSATION_BUBBLE_INITIAL_MAX_DELAY_SEC)
        partner.dir = directionBetween(partner.tileCol, partner.tileRow, ch.tileCol, ch.tileRow)

        logIdle(ch, `chatting with ${partner.nametag || `Agent ${partner.id}`}`)
        return true
      }

      // Fall back to walk-to-meeting-point conversation
      const partner = candidates[Math.floor(Math.random() * candidates.length)]

      // Find meeting point
      const meeting = findMeetingPoint(ctx.walkableTiles, ctx.tileMap, ctx.blockedTiles)
      if (!meeting) return false

      // Check both can reach their tiles
      const pathA = ctx.findPathUnblocked(ch, meeting.tileA.col, meeting.tileA.row)
      const pathB = ctx.findPathUnblocked(partner, meeting.tileB.col, meeting.tileB.row)
      if (pathA.length === 0 && (ch.tileCol !== meeting.tileA.col || ch.tileRow !== meeting.tileA.row)) return false
      if (pathB.length === 0 && (partner.tileCol !== meeting.tileB.col || partner.tileRow !== meeting.tileB.row)) return false

      // Set up both characters
      ch.idleAction = IdleActionType.CONVERSATION
      ch.conversationPartnerId = partner.id
      ch.conversationPhase = 'approaching'
      ch.idleActionTimer = randomRange(CONVERSATION_MIN_DURATION_SEC, CONVERSATION_MAX_DURATION_SEC)
      ch.preConversationDir = ch.dir
      ch.chatBubbleVariant = Math.floor(Math.random() * IDLE_CHAT_BUBBLE_VARIANT_COUNT)
      ch.wanderTimer = randomRange(0, CONVERSATION_BUBBLE_INITIAL_MAX_DELAY_SEC * 0.5)
      ch.path = pathA
      ch.moveProgress = 0
      if (pathA.length > 0) {
        ch.state = CharacterState.WALK
        ch.frame = 0
        ch.frameTimer = 0
      }

      partner.idleAction = IdleActionType.CONVERSATION
      partner.conversationPartnerId = ch.id
      partner.conversationPhase = 'approaching'
      partner.idleActionTimer = ch.idleActionTimer // same duration
      partner.preConversationDir = partner.dir
      partner.chatBubbleVariant = Math.floor(Math.random() * IDLE_CHAT_BUBBLE_VARIANT_COUNT)
      partner.wanderTimer = randomRange(CONVERSATION_BUBBLE_INITIAL_MAX_DELAY_SEC * 0.3, CONVERSATION_BUBBLE_INITIAL_MAX_DELAY_SEC)
      partner.path = pathB
      partner.moveProgress = 0
      if (pathB.length > 0) {
        partner.state = CharacterState.WALK
        partner.frame = 0
        partner.frameTimer = 0
      }
      logIdle(ch, `starting a conversation with ${partner.nametag || `Agent ${partner.id}`}`)
      return true
    }

    case IdleActionType.VISIT_FURNITURE: {
      // Pick a random interesting furniture piece — try several until one works
      const interesting = ctx.furniture.filter(f => isInterestingFurniture(f.type))
      if (interesting.length === 0) return false

      // Shuffle to try in random order
      for (let i = interesting.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [interesting[i], interesting[j]] = [interesting[j], interesting[i]]
      }

      for (const target of interesting) {
        const footprint = ctx.getFurnitureFootprint(target.type)
        const fw = footprint ? footprint.w : 1
        const fh = footprint ? footprint.h : 1

        const adj = findAdjacentWalkableTile(target, fw, fh, ctx.tileMap, ctx.blockedTiles)
        if (!adj) continue

        const path = ctx.findPathUnblocked(ch, adj.col, adj.row)
        if (path.length === 0 && (ch.tileCol !== adj.col || ch.tileRow !== adj.row)) continue

        ch.idleActionTimer = randomRange(VISIT_MIN_DURATION_SEC, VISIT_MAX_DURATION_SEC)
        ch.conversationPhase = 'approaching' // reuse phase for state tracking
        if (path.length > 0) {
          ch.path = path
          ch.moveProgress = 0
          ch.state = CharacterState.WALK
          ch.frame = 0
          ch.frameTimer = 0
        } else {
          // Already at the tile — start visiting immediately
          ch.dir = adj.facingDir
          ch.conversationPhase = 'talking' // "talking" phase = standing at furniture
        }
        // Store facing direction for when we arrive (use preConversationDir to avoid
        // corrupting wanderTimer which is a float timer, not a Direction)
        ch.preConversationDir = adj.facingDir
        const entry = getCatalogEntry(target.type)
        const label = entry?.label ?? target.type.replace(/_/g, ' ').toLowerCase()
        logIdle(ch, `going to look at the ${label}`)
        return true
      }
      return false
    }

    case IdleActionType.STAND_AND_THINK: {
      // Pick a random walkable tile
      if (ctx.walkableTiles.length === 0) return false
      const target = ctx.walkableTiles[Math.floor(Math.random() * ctx.walkableTiles.length)]
      const path = ctx.findPathUnblocked(ch, target.col, target.row)
      if (path.length === 0 && (ch.tileCol !== target.col || ch.tileRow !== target.row)) return false

      ch.idleActionTimer = randomRange(THINK_MIN_DURATION_SEC, THINK_MAX_DURATION_SEC)
      ch.conversationPhase = 'approaching'
      if (path.length > 0) {
        ch.path = path
        ch.moveProgress = 0
        ch.state = CharacterState.WALK
        ch.frame = 0
        ch.frameTimer = 0
      } else {
        ch.conversationPhase = 'talking' // at destination, start thinking
      }
      logIdle(ch, 'wandered off to think')
      return true
    }

    default:
      return false
  }
}

/** Update a non-wander idle action. Called each tick for characters with an active idle action.
 *  Returns true if the action is still running, false if it completed (character should return to seat). */
export function updateIdleAction(
  ch: Character,
  dt: number,
  ctx: IdleActionContext,
): boolean {
  if (!ch.idleAction || ch.idleAction === IdleActionType.WANDER) return false

  switch (ch.idleAction) {
    case IdleActionType.CONVERSATION:
      return updateConversation(ch, dt, ctx)
    case IdleActionType.VISIT_FURNITURE:
      return updateVisitFurniture(ch, dt)
    case IdleActionType.STAND_AND_THINK:
      return updateStandAndThink(ch, dt)
    case IdleActionType.MEETING:
      return updateMeeting(ch, dt, ctx)
    default:
      return false
  }
}

/** Cycle a single character's conversation bubble independently.
 *  Uses wanderTimer as a gap cooldown between bubbles. */
function cycleConversationBubble(ch: Character, dt: number): void {
  if (ch.bubbleType === 'permission') return // don't override permission bubbles

  if (ch.bubbleType === 'idle_chat') {
    // Bubble is currently showing — main loop handles its timer countdown
    return
  }

  // No bubble showing — count down the gap timer (stored in wanderTimer)
  ch.wanderTimer -= dt
  if (ch.wanderTimer <= 0) {
    // Show a new bubble with a random duration
    ch.bubbleType = 'idle_chat'
    ch.bubbleTimer = randomRange(CONVERSATION_BUBBLE_SHOW_MIN_SEC, CONVERSATION_BUBBLE_SHOW_MAX_SEC)
    ch.chatBubbleVariant = Math.floor(Math.random() * IDLE_CHAT_BUBBLE_VARIANT_COUNT)
    // Pre-set the next gap timer for when this bubble fades
    ch.wanderTimer = randomRange(CONVERSATION_BUBBLE_GAP_MIN_SEC, CONVERSATION_BUBBLE_GAP_MAX_SEC)
  }
}

/** Cycle meeting bubbles — longer show/gap durations than conversations */
function cycleMeetingBubble(ch: Character, dt: number): void {
  if (ch.bubbleType === 'permission') return
  if (ch.bubbleType === 'idle_chat') return // bubble showing, main loop handles timer

  ch.wanderTimer -= dt
  if (ch.wanderTimer <= 0) {
    ch.bubbleType = 'idle_chat'
    ch.bubbleTimer = randomRange(MEETING_BUBBLE_SHOW_MIN_SEC, MEETING_BUBBLE_SHOW_MAX_SEC)
    ch.chatBubbleVariant = Math.floor(Math.random() * IDLE_CHAT_BUBBLE_VARIANT_COUNT)
    ch.wanderTimer = randomRange(MEETING_BUBBLE_GAP_MIN_SEC, MEETING_BUBBLE_GAP_MAX_SEC)
  }
}

/** Get all characters currently in the same meeting (same idleAction === MEETING).
 *  Meetings are identified by shared conversationPartnerId chains — not needed here
 *  because all meeting participants are tracked externally via meetingOriginalSeats. */
function getMeetingParticipants(ch: Character, ctx: IdleActionContext): Character[] {
  const participants: Character[] = []
  for (const [, other] of ctx.characters) {
    if (other.idleAction === IdleActionType.MEETING && other.id !== ch.id) {
      participants.push(other)
    }
  }
  return participants
}

function updateMeeting(ch: Character, dt: number, ctx: IdleActionContext): boolean {
  if (ch.conversationPhase === 'approaching') {
    // Wait for walk to meeting seat
    if (ch.state !== CharacterState.WALK && ch.path.length === 0) {
      // Arrived — sit down facing forward (seat's facing direction)
      ch.conversationPhase = 'talking'
      ch.state = CharacterState.SIT_IDLE
      ch.frame = 0
      ch.frameTimer = 0
      ch.wanderTimer = randomRange(0, MEETING_BUBBLE_INITIAL_MAX_DELAY_SEC)
    }
    return true
  }

  if (ch.conversationPhase === 'talking') {
    ch.idleActionTimer -= dt
    cycleMeetingBubble(ch, dt)

    // Check how many participants are still in the meeting
    const others = getMeetingParticipants(ch, ctx)
    const totalInMeeting = others.length + 1

    if (totalInMeeting < MEETING_MIN_PARTICIPANTS) {
      // Not enough participants — end meeting for this character
      logIdle(ch, 'meeting ended (not enough participants)')
      ch.bubbleType = null
      ch.bubbleTimer = 0
      clearIdleAction(ch)
      return false
    }

    if (ch.idleActionTimer <= 0) {
      // Meeting time's up — end for ALL remaining participants simultaneously
      logIdle(ch, 'meeting concluded')
      ch.bubbleType = null
      ch.bubbleTimer = 0
      clearIdleAction(ch)
      // End for all other participants too
      for (const other of others) {
        other.bubbleType = null
        other.bubbleTimer = 0
        clearIdleAction(other)
      }
      return false
    }
    return true
  }

  return false
}

function updateConversation(ch: Character, dt: number, ctx: IdleActionContext): boolean {
  const partner = ch.conversationPartnerId !== null ? ctx.characters.get(ch.conversationPartnerId) : null

  // Partner gone or became active — disengage
  if (!partner || partner.isActive || partner.conversationPartnerId !== ch.id) {
    logIdle(ch, 'conversation interrupted')
    clearIdleAction(ch)
    return false
  }

  if (ch.conversationPhase === 'approaching') {
    // Wait for walk to complete
    if (ch.state !== CharacterState.WALK && ch.path.length === 0) {
      // Check if partner also arrived
      if (partner.state !== CharacterState.WALK && partner.path.length === 0) {
        // Both arrived — face each other
        ch.dir = directionBetween(ch.tileCol, ch.tileRow, partner.tileCol, partner.tileRow)
        partner.dir = directionBetween(partner.tileCol, partner.tileRow, ch.tileCol, ch.tileRow)
        ch.conversationPhase = 'talking'
        partner.conversationPhase = 'talking'
        ch.state = CharacterState.IDLE
        ch.frame = 0
        partner.state = CharacterState.IDLE
        partner.frame = 0
      }
    }
    return true
  }

  if (ch.conversationPhase === 'talking') {
    // Only the character with the lower ID drives the timer to avoid double-decrement
    if (ch.id < partner.id) {
      ch.idleActionTimer -= dt
      partner.idleActionTimer = ch.idleActionTimer
    }

    // Each character independently cycles their conversation bubble
    // wanderTimer is repurposed as a gap cooldown between bubbles
    if (ch.id < partner.id) {
      cycleConversationBubble(ch, dt)
      cycleConversationBubble(partner, dt)
    }

    if (ch.idleActionTimer <= 0) {
      // Conversation done — disengage both and clear bubbles
      logIdle(ch, `finished chatting with ${partner.nametag || `Agent ${partner.id}`}`)
      ch.conversationPhase = 'leaving'
      partner.conversationPhase = 'leaving'
      ch.bubbleType = null
      ch.bubbleTimer = 0
      partner.bubbleType = null
      partner.bubbleTimer = 0
      clearIdleAction(ch)
      clearIdleAction(partner)
      return false
    }
    return true
  }

  return false
}

function updateVisitFurniture(ch: Character, dt: number): boolean {
  if (ch.conversationPhase === 'approaching') {
    // Wait for walk to complete
    if (ch.state !== CharacterState.WALK && ch.path.length === 0) {
      ch.conversationPhase = 'talking' // arrived, start visiting
      ch.dir = ch.preConversationDir ?? Direction.DOWN // restore target facing dir
      ch.preConversationDir = null
      ch.state = CharacterState.IDLE
      ch.frame = 0
      // Show idle think bubble while visiting furniture
      ch.bubbleType = 'idle_think'
      ch.bubbleTimer = ch.idleActionTimer + 1 // keep showing for duration
    }
    return true
  }

  if (ch.conversationPhase === 'talking') {
    ch.idleActionTimer -= dt
    if (ch.idleActionTimer <= 0) {
      logIdle(ch, 'done looking around')
      ch.bubbleType = null
      ch.bubbleTimer = 0
      ch.currentTool = null
      clearIdleAction(ch)
      return false
    }
    return true
  }

  return false
}

function updateStandAndThink(ch: Character, dt: number): boolean {
  if (ch.conversationPhase === 'approaching') {
    // Wait for walk to complete
    if (ch.state !== CharacterState.WALK && ch.path.length === 0) {
      ch.conversationPhase = 'talking' // arrived, start thinking
      ch.state = CharacterState.IDLE
      ch.frame = 0
      // No bubble — just a brief pause before doing something else
    }
    return true
  }

  if (ch.conversationPhase === 'talking') {
    ch.idleActionTimer -= dt
    if (ch.idleActionTimer <= 0) {
      logIdle(ch, 'done thinking')
      clearIdleAction(ch)
      return false
    }
    return true
  }

  return false
}

/** Clear idle action state and prepare character to return to seat */
function clearIdleAction(ch: Character): void {
  // Restore pre-conversation direction (e.g. facing their desk) if they were seated
  if (ch.preConversationDir !== null) {
    ch.dir = ch.preConversationDir
    ch.preConversationDir = null
  }
  ch.idleAction = null
  ch.conversationPartnerId = null
  ch.conversationPhase = null
  ch.idleActionTimer = 0
  ch.currentTool = null
  // Don't clear bubbleType here — let it fade naturally or get cleared by the caller
}

/** Disengage a character from a conversation (called when partner becomes active or is removed) */
export function disengageConversation(ch: Character, ctx: IdleActionContext): void {
  if (ch.idleAction !== IdleActionType.CONVERSATION) return

  const partnerId = ch.conversationPartnerId
  clearIdleAction(ch) // restores pre-conversation direction
  ch.bubbleType = null
  ch.bubbleTimer = 0
  // Return to idle state
  ch.state = CharacterState.IDLE
  ch.frame = 0

  // Also disengage partner if they still reference us
  if (partnerId !== null) {
    const partner = ctx.characters.get(partnerId)
    if (partner && partner.conversationPartnerId === ch.id) {
      clearIdleAction(partner) // restores pre-conversation direction
      partner.bubbleType = null
      partner.bubbleTimer = 0
      partner.state = CharacterState.IDLE
      partner.frame = 0
    }
  }
}

/** Disengage a single character from a meeting (called when agent becomes active).
 *  Only removes THIS character — others continue if enough remain.
 *  If fewer than MEETING_MIN_PARTICIPANTS remain, ends meeting for all. */
export function disengageMeeting(ch: Character, ctx: IdleActionContext): void {
  if (ch.idleAction !== IdleActionType.MEETING) return

  clearIdleAction(ch)
  ch.bubbleType = null
  ch.bubbleTimer = 0
  ch.state = CharacterState.IDLE
  ch.frame = 0

  // Check remaining participants
  const remaining: Character[] = []
  for (const [, other] of ctx.characters) {
    if (other.id !== ch.id && other.idleAction === IdleActionType.MEETING) {
      remaining.push(other)
    }
  }

  // If not enough remain, end meeting for all
  if (remaining.length < MEETING_MIN_PARTICIPANTS) {
    for (const other of remaining) {
      clearIdleAction(other)
      other.bubbleType = null
      other.bubbleTimer = 0
      other.state = CharacterState.IDLE
      other.frame = 0
    }
  }
}
