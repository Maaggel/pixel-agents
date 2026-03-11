import { TILE_SIZE, MATRIX_EFFECT_DURATION, CharacterState, Direction, ZoneType as ZoneTypeValues } from '../types.js'
import type { ZoneType } from '../types.js'
import {
  PALETTE_COUNT,
  HUE_SHIFT_MIN_DEG,
  HUE_SHIFT_RANGE_DEG,
  WAITING_BUBBLE_DURATION_SEC,
  TALKING_BUBBLE_DURATION_SEC,
  DISMISS_BUBBLE_FAST_FADE_SEC,
  INACTIVE_SEAT_TIMER_MIN_SEC,
  INACTIVE_SEAT_TIMER_RANGE_SEC,
  AUTO_ON_FACING_DEPTH,
  AUTO_ON_SIDE_DEPTH,
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_HIT_HALF_WIDTH,
  CHARACTER_HIT_HEIGHT,
  ZONE_WANDER_PREFERENCE,
  IDLE_ZONE_DELAY_SEC,
  SEATED_CONVERSATION_CHANCE_PER_SEC,
  WALK_SPEED_PX_PER_SEC,
  WALK_FRAME_DURATION_SEC,
  TYPE_FRAME_DURATION_SEC,
  BUILD_FRAME_DURATION_SEC,
  SIT_WAIT_FRAME_DURATION_SEC,
  MEETING_CHANCE_PER_SEC,
  MEETING_MIN_PARTICIPANTS,
  MEETING_MIN_DURATION_SEC,
  MEETING_MAX_DURATION_SEC,
} from '../../constants.js'
import type { Character, Seat, FurnitureInstance, TileType as TileTypeVal, OfficeLayout, PlacedFurniture } from '../types.js'
import { createCharacter, updateCharacter, isSittingState, directionBetween } from './characters.js'
import { matrixEffectSeeds } from './matrixEffect.js'
import { isWalkable, getWalkableTiles, findPath } from '../layout/tileMap.js'
import {
  createDefaultLayout,
  layoutToTileMap,
  layoutToFurnitureInstances,
  layoutToSeats,
  getBlockedTiles,
} from '../layout/layoutSerializer.js'
import { getCatalogEntry, getOnStateType } from '../layout/furnitureCatalog.js'
import { IdleActionType } from '../types.js'
import { pickIdleAction, initIdleAction, updateIdleAction, disengageConversation, disengageMeeting, trySeatedConversation } from './idleActions.js'
import type { IdleActionContext } from './idleActions.js'
import { addBehaviourEntry } from '../../behaviourLog.js'

export class OfficeState {
  layout: OfficeLayout
  tileMap: TileTypeVal[][]
  seats: Map<string, Seat>
  blockedTiles: Set<string>
  furniture: FurnitureInstance[]
  walkableTiles: Array<{ col: number; row: number }>
  /** Walkable tiles grouped by zone type (only includes tiles with a zone designation) */
  zoneTiles: Map<string, Array<{ col: number; row: number }>> = new Map()
  characters: Map<number, Character> = new Map()
  selectedAgentId: number | null = null
  cameraFollowId: number | null = null
  hoveredAgentId: number | null = null
  hoveredTile: { col: number; row: number } | null = null
  /** Maps agent ID → original seat ID before joining a meeting (to restore after) */
  meetingOriginalSeats: Map<number, string | null> = new Map()
  /** Maps "parentId:toolId" → sub-agent character ID (negative) */
  subagentIdMap: Map<string, number> = new Map()
  /** Reverse lookup: sub-agent character ID → parent info */
  subagentMeta: Map<number, { parentAgentId: number; parentToolId: string }> = new Map()
  private nextSubagentId = -1

  constructor(layout?: OfficeLayout) {
    this.layout = layout || createDefaultLayout()
    this.tileMap = layoutToTileMap(this.layout)
    this.seats = layoutToSeats(this.layout.furniture)
    this.blockedTiles = getBlockedTiles(this.layout.furniture)
    this.furniture = layoutToFurnitureInstances(this.layout.furniture)
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles)
    this.rebuildZoneTiles()
  }

  /** Rebuild all derived state from a new layout. Reassigns existing characters.
   *  @param shift Optional pixel shift to apply when grid expands left/up */
  rebuildFromLayout(layout: OfficeLayout, shift?: { col: number; row: number }): void {
    this.layout = layout
    this.tileMap = layoutToTileMap(layout)
    this.seats = layoutToSeats(layout.furniture)
    this.blockedTiles = getBlockedTiles(layout.furniture)
    this.rebuildFurnitureInstances()
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles)
    this.rebuildZoneTiles()

    // Shift character positions when grid expands left/up
    if (shift && (shift.col !== 0 || shift.row !== 0)) {
      for (const ch of this.characters.values()) {
        ch.tileCol += shift.col
        ch.tileRow += shift.row
        ch.x += shift.col * TILE_SIZE
        ch.y += shift.row * TILE_SIZE
        // Clear path since tile coords changed
        ch.path = []
        ch.moveProgress = 0
      }
    }

    // Reassign characters to new seats, preserving existing assignments when possible
    for (const seat of this.seats.values()) {
      seat.assigned = false
    }

    // First pass: reserve seats for remote characters (source window is authority)
    for (const ch of this.characters.values()) {
      if (!ch.isRemote) continue
      if (ch.seatId && this.seats.has(ch.seatId)) {
        const seat = this.seats.get(ch.seatId)!
        if (!seat.assigned) {
          seat.assigned = true
          // Don't snap position — source window controls remote positions
        }
      }
    }

    // Second pass: try to keep local characters at their existing seats
    for (const ch of this.characters.values()) {
      if (ch.isRemote) continue
      if (ch.seatId && this.seats.has(ch.seatId)) {
        const seat = this.seats.get(ch.seatId)!
        if (!seat.assigned) {
          seat.assigned = true
          // Snap character to seat position
          ch.tileCol = seat.seatCol
          ch.tileRow = seat.seatRow
          const cx = seat.seatCol * TILE_SIZE + TILE_SIZE / 2
          const cy = seat.seatRow * TILE_SIZE + TILE_SIZE / 2
          ch.x = cx
          ch.y = cy
          ch.dir = seat.facingDir
          continue
        }
      }
      ch.seatId = null // will be reassigned below
    }

    // Third pass: assign remaining local characters to free seats
    for (const ch of this.characters.values()) {
      if (ch.isRemote) continue
      if (ch.seatId) continue
      const seatId = this.findFreeSeat()
      if (seatId) {
        this.seats.get(seatId)!.assigned = true
        ch.seatId = seatId
        const seat = this.seats.get(seatId)!
        ch.tileCol = seat.seatCol
        ch.tileRow = seat.seatRow
        ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2
        ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2
        ch.dir = seat.facingDir
      }
    }

    // Relocate any characters that ended up outside bounds or on non-walkable tiles
    for (const ch of this.characters.values()) {
      if (ch.seatId) continue // seated characters are fine
      if (ch.tileCol < 0 || ch.tileCol >= layout.cols || ch.tileRow < 0 || ch.tileRow >= layout.rows) {
        this.relocateCharacterToWalkable(ch)
      }
    }
  }

  /** Move a character to a random walkable tile */
  private relocateCharacterToWalkable(ch: Character): void {
    if (this.walkableTiles.length === 0) return
    const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]
    ch.tileCol = spawn.col
    ch.tileRow = spawn.row
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2
    ch.path = []
    ch.moveProgress = 0
  }

  /** Rebuild zone-to-walkable-tiles mapping from current layout */
  private rebuildZoneTiles(): void {
    this.zoneTiles.clear()
    const zones = this.layout.zones
    if (!zones) return
    for (const tile of this.walkableTiles) {
      const idx = tile.row * this.layout.cols + tile.col
      const zone = zones[idx]
      if (!zone) continue
      let list = this.zoneTiles.get(zone)
      if (!list) {
        list = []
        this.zoneTiles.set(zone, list)
      }
      list.push(tile)
    }
  }

  /** Get walkable tiles for specified zone types, falling back to all walkable tiles */
  getZoneWalkableTiles(zoneTypes: ZoneType[]): Array<{ col: number; row: number }> {
    const tiles: Array<{ col: number; row: number }> = []
    for (const zt of zoneTypes) {
      const list = this.zoneTiles.get(zt)
      if (list) tiles.push(...list)
    }
    return tiles.length > 0 ? tiles : this.walkableTiles
  }

  getLayout(): OfficeLayout {
    return this.layout
  }

  /** Get the blocked-tile key for a character's own seat, or null */
  private ownSeatKey(ch: Character): string | null {
    if (!ch.seatId) return null
    const seat = this.seats.get(ch.seatId)
    if (!seat) return null
    return `${seat.seatCol},${seat.seatRow}`
  }

  /** Temporarily unblock a character's own seat, run fn, then re-block */
  private withOwnSeatUnblocked<T>(ch: Character, fn: () => T): T {
    const key = this.ownSeatKey(ch)
    if (key) this.blockedTiles.delete(key)
    const result = fn()
    if (key) this.blockedTiles.add(key)
    return result
  }

  /** Build context object for idle action functions */
  private buildIdleActionContext(): IdleActionContext {
    return {
      characters: this.characters,
      walkableTiles: this.walkableTiles,
      tileMap: this.tileMap,
      blockedTiles: this.blockedTiles,
      furniture: this.layout.furniture,
      seats: this.seats,
      getFurnitureFootprint: (type: string) => {
        const entry = getCatalogEntry(type)
        return entry ? { w: entry.footprintW, h: entry.footprintH } : null
      },
      findPathUnblocked: (ch: Character, toCol: number, toRow: number) => {
        return this.withOwnSeatUnblocked(ch, () =>
          findPath(ch.tileCol, ch.tileRow, toCol, toRow, this.tileMap, this.blockedTiles)
        )
      },
    }
  }

  /** Send a character back to their assigned seat after an idle action completes */
  private returnToSeat(ch: Character): void {
    addBehaviourEntry({ agentId: ch.id, agentName: ch.nametag || `Agent ${ch.id}`, message: 'heading back to desk', type: 'idle' })
    if (!ch.seatId) {
      ch.state = CharacterState.IDLE
      ch.idleAction = IdleActionType.WANDER
      return
    }
    const seat = this.seats.get(ch.seatId)
    if (!seat) {
      ch.state = CharacterState.IDLE
      ch.idleAction = IdleActionType.WANDER
      return
    }
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles)
    )
    if (path.length > 0) {
      ch.path = path
      ch.moveProgress = 0
      ch.state = CharacterState.WALK
      ch.frame = 0
      ch.frameTimer = 0
      ch.idleAction = IdleActionType.WANDER // treat return-walk as wander so normal WALK handling applies
    } else {
      ch.state = CharacterState.IDLE
      ch.idleAction = IdleActionType.WANDER
    }
  }

  /** Check if a meeting is currently in progress */
  private hasMeetingInProgress(): boolean {
    for (const ch of this.characters.values()) {
      if (ch.idleAction === IdleActionType.MEETING) return true
    }
    return false
  }

  /** Identify separate meeting rooms by flood-filling connected meeting_room tiles.
   *  Returns an array of rooms, each being a Set of "col,row" tile keys. */
  private getMeetingRooms(): Array<Set<string>> {
    const zones = this.layout.zones
    if (!zones) return []
    const cols = this.layout.cols
    const rows = this.layout.rows
    const visited = new Set<string>()
    const rooms: Array<Set<string>> = []

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const key = `${c},${r}`
        if (visited.has(key)) continue
        const idx = r * cols + c
        if (zones[idx] !== ZoneTypeValues.MEETING_ROOM) continue

        // Flood-fill from this tile to find all connected meeting tiles
        const room = new Set<string>()
        const queue = [{ col: c, row: r }]
        visited.add(key)
        while (queue.length > 0) {
          const { col, row } = queue.shift()!
          room.add(`${col},${row}`)
          for (const [dc, dr] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
            const nc = col + dc
            const nr = row + dr
            if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue
            const nk = `${nc},${nr}`
            if (visited.has(nk)) continue
            if (zones[nr * cols + nc] !== ZoneTypeValues.MEETING_ROOM) continue
            visited.add(nk)
            queue.push({ col: nc, row: nr })
          }
        }
        rooms.push(room)
      }
    }
    return rooms
  }

  /** Get free seats grouped by meeting room. Each entry is one room's free seats.
   *  Returns the room with the most free seats (best candidate for a meeting). */
  private getFreeMeetingZoneSeats(): string[] {
    const rooms = this.getMeetingRooms()
    if (rooms.length === 0) {
      console.log(`[Meeting] No meeting rooms found`)
      return []
    }

    // For each room, collect free seats — only rooms with enough seats are eligible
    const eligible: string[][] = []
    for (const room of rooms) {
      const freeInRoom: string[] = []
      for (const [uid, seat] of this.seats) {
        const key = `${seat.seatCol},${seat.seatRow}`
        if (!room.has(key)) continue
        if (seat.assigned) continue
        if (this.isTileOccupiedBySitting(seat.seatCol, seat.seatRow)) continue
        freeInRoom.push(uid)
      }
      console.log(`[Meeting] Room with ${room.size} tiles: ${freeInRoom.length} free seats`)
      if (freeInRoom.length >= MEETING_MIN_PARTICIPANTS) {
        eligible.push(freeInRoom)
      }
    }
    if (eligible.length === 0) return []
    // Randomly pick one eligible room
    return eligible[Math.floor(Math.random() * eligible.length)]
  }

  /** Try to start a meeting. Returns null on success, or a reason string on failure. */
  tryStartMeeting(): string | null {
    // Don't start a new meeting if one is already in progress
    if (this.hasMeetingInProgress()) {
      console.log('[Meeting] Already in progress')
      return 'Meeting already in progress'
    }

    // Find free meeting zone seats
    const freeSeats = this.getFreeMeetingZoneSeats()
    const hasZonesArr = !!this.layout.zones
    const meetingZoneCount = hasZonesArr ? this.layout.zones!.filter(z => z === ZoneTypeValues.MEETING_ROOM).length : 0
    console.log(`[Meeting] Free meeting seats: ${freeSeats.length}, zones array: ${hasZonesArr}, meeting tiles: ${meetingZoneCount}, seats total: ${this.seats.size}`)
    if (freeSeats.length < MEETING_MIN_PARTICIPANTS) {
      // Count meeting-zone seats (assigned + free) for diagnostic
      let meetingSeatsTotal = 0
      let meetingSeatsAssigned = 0
      for (const [, seat] of this.seats) {
        if (this.isMeetingZoneSeat(seat)) {
          meetingSeatsTotal++
          if (seat.assigned) meetingSeatsAssigned++
        }
      }
      return `Not enough free meeting seats (${freeSeats.length}/${MEETING_MIN_PARTICIPANTS}). Total meeting seats: ${meetingSeatsTotal}, assigned: ${meetingSeatsAssigned}, zones: ${meetingZoneCount} tiles, total seats: ${this.seats.size}`
    }

    // Collect eligible idle agents (non-subagent, non-remote, not active, not waiting, no idle action, not in matrix effect)
    const eligible: Character[] = []
    for (const ch of this.characters.values()) {
      if (ch.isSubagent || ch.isRemote || ch.isActive || ch.isWaiting) {
        console.log(`[Meeting] Skipping ${ch.id}: sub=${ch.isSubagent} remote=${ch.isRemote} active=${ch.isActive} waiting=${ch.isWaiting}`)
        continue
      }
      if (ch.matrixEffect !== null) continue
      if (ch.idleAction !== null && ch.idleAction !== IdleActionType.WANDER && ch.idleAction !== IdleActionType.CONVERSATION) {
        console.log(`[Meeting] Skipping ${ch.id}: idleAction=${ch.idleAction}`)
        continue
      }
      eligible.push(ch)
    }
    if (eligible.length < MEETING_MIN_PARTICIPANTS) {
      return `Not enough idle agents (${eligible.length}/${MEETING_MIN_PARTICIPANTS})`
    }

    // Limit participants to available seats
    const participantCount = Math.min(eligible.length, freeSeats.length)
    if (participantCount < MEETING_MIN_PARTICIPANTS) return 'Not enough participants for available seats'

    // Shuffle eligible agents and pick participants
    for (let i = eligible.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = eligible[i]; eligible[i] = eligible[j]; eligible[j] = tmp
    }
    const participants = eligible.slice(0, participantCount)

    // Set a shared meeting duration
    const duration = MEETING_MIN_DURATION_SEC + Math.random() * (MEETING_MAX_DURATION_SEC - MEETING_MIN_DURATION_SEC)

    // Distribute seats across facing directions so participants sit across from each other
    const distributedSeats = this.distributeMeetingSeats(freeSeats, participants.length)

    // Assign each participant to a meeting seat and start walking
    for (let i = 0; i < participants.length; i++) {
      const ch = participants[i]
      const seatId = distributedSeats[i]
      const seat = this.seats.get(seatId)!

      // Save original seat
      this.meetingOriginalSeats.set(ch.id, ch.seatId)

      // Disengage from any current idle action
      if (ch.idleAction === IdleActionType.CONVERSATION) {
        disengageConversation(ch, this.buildIdleActionContext())
      }
      if (ch.idleAction) {
        ch.idleAction = null
        ch.conversationPartnerId = null
        ch.conversationPhase = null
        ch.idleActionTimer = 0
        ch.bubbleType = null
        ch.bubbleTimer = 0
      }

      // Free old seat, assign meeting seat
      if (ch.seatId) {
        const oldSeat = this.seats.get(ch.seatId)
        if (oldSeat) oldSeat.assigned = false
      }
      seat.assigned = true
      ch.seatId = seatId

      // Set up meeting state
      ch.idleAction = IdleActionType.MEETING
      ch.conversationPhase = 'approaching'
      ch.idleActionTimer = duration
      ch.conversationPartnerId = null // meetings don't use partner ID
      ch.preConversationDir = ch.dir

      // Pathfind to meeting seat
      const path = this.withOwnSeatUnblocked(ch, () =>
        findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles)
      )
      if (path.length > 0) {
        ch.path = path
        ch.moveProgress = 0
        ch.state = CharacterState.WALK
        ch.frame = 0
        ch.frameTimer = 0
      } else {
        // Already at meeting seat — sit immediately
        ch.conversationPhase = 'talking'
        ch.state = CharacterState.SIT_IDLE
        ch.dir = seat.facingDir
        ch.frame = 0
        ch.frameTimer = 0
      }

      const name = ch.nametag || `Agent ${ch.id}`
      const mins = Math.floor(duration / 60)
      const secs = Math.round(duration % 60)
      const durationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
      addBehaviourEntry({ agentId: ch.id, agentName: name, message: `heading to meeting (${durationStr})`, type: 'idle' })
    }

    return null
  }

  /** Restore a character's original seat after leaving a meeting */
  restoreMeetingSeat(ch: Character): void {
    const originalSeatId = this.meetingOriginalSeats.get(ch.id)
    this.meetingOriginalSeats.delete(ch.id)

    if (originalSeatId === undefined) return

    // Free current meeting seat
    if (ch.seatId) {
      const currentSeat = this.seats.get(ch.seatId)
      if (currentSeat) currentSeat.assigned = false
    }

    // Try to reclaim original seat
    if (originalSeatId && this.seats.has(originalSeatId)) {
      const origSeat = this.seats.get(originalSeatId)!
      if (!origSeat.assigned) {
        origSeat.assigned = true
        ch.seatId = originalSeatId
        return
      }
    }

    // Original seat taken — find any free seat
    const newSeatId = this.findFreeSeat()
    if (newSeatId) {
      this.seats.get(newSeatId)!.assigned = true
      ch.seatId = newSeatId
    } else {
      ch.seatId = null
    }
  }

  /** Distribute meeting seats across facing directions so participants sit across from each other.
   *  Groups seats by facing direction, then round-robin picks from each group. */
  private distributeMeetingSeats(freeSeats: string[], count: number): string[] {
    // Group seats by facing direction
    const byDir = new Map<number, string[]>()
    for (const uid of freeSeats) {
      const seat = this.seats.get(uid)
      if (!seat) continue
      const dir = seat.facingDir
      let list = byDir.get(dir)
      if (!list) {
        list = []
        byDir.set(dir, list)
      }
      list.push(uid)
    }

    const dirGroups = Array.from(byDir.values())
    if (dirGroups.length <= 1) {
      // Only one facing direction — just return as-is (shuffled)
      const shuffled = [...freeSeats]
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp
      }
      return shuffled.slice(0, count)
    }

    // Shuffle each group internally for variety within a side
    for (const group of dirGroups) {
      for (let i = group.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const tmp = group[i]; group[i] = group[j]; group[j] = tmp
      }
    }

    // Shuffle the direction groups order too
    for (let i = dirGroups.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = dirGroups[i]; dirGroups[i] = dirGroups[j]; dirGroups[j] = tmp
    }

    // Round-robin pick from each direction group
    const result: string[] = []
    const indices = dirGroups.map(() => 0)
    let groupIdx = 0
    while (result.length < count) {
      const group = dirGroups[groupIdx]
      if (indices[groupIdx] < group.length) {
        result.push(group[indices[groupIdx]])
        indices[groupIdx]++
      }
      groupIdx = (groupIdx + 1) % dirGroups.length
      // Safety: if we've exhausted all groups, break
      if (indices.every((idx, gi) => idx >= dirGroups[gi].length)) break
    }

    return result
  }

  /** Check if a seat tile is inside a MEETING_ROOM zone */
  private isMeetingZoneSeat(seat: Seat): boolean {
    const zones = this.layout.zones
    if (!zones) return false
    const idx = seat.seatRow * this.layout.cols + seat.seatCol
    return zones[idx] === ZoneTypeValues.MEETING_ROOM
  }

  private findFreeSeat(): string | null {
    // Prefer non-meeting-zone seats
    for (const [uid, seat] of this.seats) {
      if (!seat.assigned && !this.isTileOccupiedBySitting(seat.seatCol, seat.seatRow) && !this.isMeetingZoneSeat(seat)) return uid
    }
    // Fallback: any seat not flagged as assigned (even if someone is walking through), still skip meeting
    for (const [uid, seat] of this.seats) {
      if (!seat.assigned && !this.isMeetingZoneSeat(seat)) return uid
    }
    // Last resort: meeting zone seats
    for (const [uid, seat] of this.seats) {
      if (!seat.assigned && !this.isTileOccupiedBySitting(seat.seatCol, seat.seatRow)) return uid
    }
    return null
  }

  /** Find a free seat that is NOT at the given tile position */
  findFreeSeatAwayFrom(avoidCol: number, avoidRow: number): string | null {
    for (const [uid, seat] of this.seats) {
      if (seat.assigned) continue
      if (seat.seatCol === avoidCol && seat.seatRow === avoidRow) continue
      if (this.isMeetingZoneSeat(seat)) continue
      if (!this.isTileOccupiedBySitting(seat.seatCol, seat.seatRow)) return uid
    }
    // Fallback: any unassigned seat not at the avoided tile (including meeting)
    for (const [uid, seat] of this.seats) {
      if (!seat.assigned && !(seat.seatCol === avoidCol && seat.seatRow === avoidRow)) return uid
    }
    return null
  }

  /** Find a free seat excluding the given seat ID (for idle agents leaving their desk) */
  private findFreeSeatExcluding(excludeSeatId: string | null): string | null {
    for (const [uid, seat] of this.seats) {
      if (uid === excludeSeatId) continue
      if (seat.assigned) continue
      if (this.isMeetingZoneSeat(seat)) continue
      if (!this.isTileOccupiedBySitting(seat.seatCol, seat.seatRow)) return uid
    }
    // Fallback: any unassigned seat that's different (including meeting)
    for (const [uid, seat] of this.seats) {
      if (uid === excludeSeatId) continue
      if (!seat.assigned) return uid
    }
    return null
  }

  /** Check if any character is sitting at the given tile (physical collision check) */
  private isTileOccupiedBySitting(col: number, row: number): boolean {
    for (const ch of this.characters.values()) {
      if (ch.matrixEffect === 'despawn') continue
      if (ch.tileCol === col && ch.tileRow === row && isSittingState(ch.state)) return true
    }
    return false
  }

  /** Find the closest free seat within given zone types. Falls back to any free seat if none in zones. */
  private findFreeSeatInZones(zoneTypes: ZoneType[], nearCol: number, nearRow: number): string | null {
    const zones = this.layout.zones
    if (!zones || this.zoneTiles.size === 0) return this.findFreeSeat()

    const zoneSet = new Set<string>(zoneTypes)
    let bestId: string | null = null
    let bestDist = Infinity
    for (const [uid, seat] of this.seats) {
      if (seat.assigned) continue
      if (this.isTileOccupiedBySitting(seat.seatCol, seat.seatRow)) continue
      const idx = seat.seatRow * this.layout.cols + seat.seatCol
      const zone = zones[idx]
      if (!zone || !zoneSet.has(zone)) continue
      const d = Math.abs(seat.seatCol - nearCol) + Math.abs(seat.seatRow - nearRow)
      if (d < bestDist) {
        bestDist = d
        bestId = uid
      }
    }
    return bestId ?? this.findFreeSeat()
  }

  /**
   * Pick a diverse palette for a new agent based on currently active agents.
   * First 6 agents each get a unique skin (random order). Beyond 6, skins
   * repeat in balanced rounds with a random hue shift (≥45°).
   */
  private pickDiversePalette(): { palette: number; hueShift: number } {
    // Count how many non-sub-agents use each base palette (0-5)
    const counts = new Array(PALETTE_COUNT).fill(0) as number[]
    for (const ch of this.characters.values()) {
      if (ch.isSubagent) continue
      counts[ch.palette]++
    }
    const minCount = Math.min(...counts)
    // Available = palettes at the minimum count (least used)
    const available: number[] = []
    for (let i = 0; i < PALETTE_COUNT; i++) {
      if (counts[i] === minCount) available.push(i)
    }
    const palette = available[Math.floor(Math.random() * available.length)]
    // First round (minCount === 0): no hue shift. Subsequent rounds: random ≥45°.
    let hueShift = 0
    if (minCount > 0) {
      hueShift = HUE_SHIFT_MIN_DEG + Math.floor(Math.random() * HUE_SHIFT_RANGE_DEG)
    }
    return { palette, hueShift }
  }

  addAgent(id: number, preferredPalette?: number, preferredHueShift?: number, preferredSeatId?: string, skipSpawnEffect?: boolean, folderName?: string, isRemote?: boolean, projectName?: string): void {
    if (this.characters.has(id)) return

    let palette: number
    let hueShift: number
    if (preferredPalette !== undefined) {
      palette = preferredPalette
      hueShift = preferredHueShift ?? 0
    } else {
      const pick = this.pickDiversePalette()
      palette = pick.palette
      hueShift = pick.hueShift
    }

    // Remote agents: position controlled by source window via sync
    if (isRemote) {
      const ch = createCharacter(id, palette, null, null, hueShift)
      ch.isRemote = true
      if (folderName) { ch.nametag = folderName; ch.folderName = folderName }
      // Claim the source window's seat so local agents don't sit there
      let assignedSeatId: string | null = null
      if (preferredSeatId && this.seats.has(preferredSeatId)) {
        const seat = this.seats.get(preferredSeatId)!
        if (!seat.assigned && !this.isTileOccupiedBySitting(seat.seatCol, seat.seatRow)) {
          seat.assigned = true
          assignedSeatId = preferredSeatId
        }
      }
      // Fallback: find any free seat if preferred was taken
      if (!assignedSeatId) {
        assignedSeatId = this.findFreeSeat()
        if (assignedSeatId) {
          this.seats.get(assignedSeatId)!.assigned = true
        }
      }
      ch.seatId = assignedSeatId
      // Start at seat position (or off-screen if no seat)
      if (assignedSeatId) {
        const seat = this.seats.get(assignedSeatId)!
        ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2
        ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2
        ch.tileCol = seat.seatCol
        ch.tileRow = seat.seatRow
        ch.dir = seat.facingDir
      } else {
        ch.x = -100
        ch.y = -100
        ch.tileCol = -1
        ch.tileRow = -1
      }
      this.characters.set(id, ch)
      return
    }

    // Try preferred seat first, then any free seat
    let seatId: string | null = null
    if (preferredSeatId && this.seats.has(preferredSeatId)) {
      const seat = this.seats.get(preferredSeatId)!
      if (!seat.assigned) {
        seatId = preferredSeatId
      }
    }
    if (!seatId) {
      seatId = this.findFreeSeat()
    }
    // Double-check: don't assign a seat that's physically occupied by another character
    if (seatId) {
      const seat = this.seats.get(seatId)!
      if (this.isTileOccupiedBySitting(seat.seatCol, seat.seatRow)) {
        seatId = this.findFreeSeat()
      }
    }

    let ch: Character
    if (seatId) {
      const seat = this.seats.get(seatId)!
      seat.assigned = true
      ch = createCharacter(id, palette, seatId, seat, hueShift)
    } else {
      // No seats — spawn at random walkable tile
      const spawn = this.walkableTiles.length > 0
        ? this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]
        : { col: 1, row: 1 }
      ch = createCharacter(id, palette, null, null, hueShift)
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2
      ch.tileCol = spawn.col
      ch.tileRow = spawn.row
    }

    if (folderName) {
      ch.nametag = folderName
    } else {
      // Name based on project: first agent is "Lead", rest are numbered
      const prefix = projectName || 'Agent'
      let mainCount = 0
      for (const c of this.characters.values()) {
        if (!c.isSubagent && !c.isRemote) mainCount++
      }
      ch.nametag = mainCount === 0 ? `${prefix} Main` : `${prefix} #${mainCount + 1}`
    }
    if (folderName) {
      ch.folderName = folderName
    }
    if (!skipSpawnEffect) {
      ch.matrixEffect = 'spawn'
      ch.matrixEffectTimer = 0
      ch.matrixEffectSeeds = matrixEffectSeeds()
    }
    this.characters.set(id, ch)
  }

  removeAgent(id: number): void {
    const ch = this.characters.get(id)
    if (!ch) return
    if (ch.matrixEffect === 'despawn') return // already despawning
    // Disengage from conversation or meeting if in one
    if (ch.idleAction === IdleActionType.CONVERSATION) {
      disengageConversation(ch, this.buildIdleActionContext())
    }
    if (ch.idleAction === IdleActionType.MEETING) {
      disengageMeeting(ch, this.buildIdleActionContext())
      this.meetingOriginalSeats.delete(ch.id)
    }
    // Free seat and clear selection immediately
    if (ch.seatId) {
      const seat = this.seats.get(ch.seatId)
      if (seat) seat.assigned = false
    }
    if (this.selectedAgentId === id) this.selectedAgentId = null
    if (this.cameraFollowId === id) this.cameraFollowId = null
    // Start despawn animation instead of immediate delete
    ch.matrixEffect = 'despawn'
    ch.matrixEffectTimer = 0
    ch.matrixEffectSeeds = matrixEffectSeeds()
    ch.bubbleType = null
  }

  /** Find seat uid at a given tile position, or null */
  getSeatAtTile(col: number, row: number): string | null {
    for (const [uid, seat] of this.seats) {
      if (seat.seatCol === col && seat.seatRow === row) return uid
    }
    return null
  }

  /** Reassign an agent from their current seat to a new seat */
  reassignSeat(agentId: number, seatId: string): void {
    const ch = this.characters.get(agentId)
    if (!ch) return
    // Unassign old seat
    if (ch.seatId) {
      const old = this.seats.get(ch.seatId)
      if (old) old.assigned = false
    }
    // Assign new seat
    const seat = this.seats.get(seatId)
    if (!seat || seat.assigned) return
    seat.assigned = true
    ch.seatId = seatId
    // Pathfind to new seat (unblock own seat tile for this query)
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles)
    )
    if (path.length > 0) {
      ch.path = path
      ch.moveProgress = 0
      ch.state = CharacterState.WALK
      ch.frame = 0
      ch.frameTimer = 0
    } else {
      // Already at seat or no path — sit down
      ch.state = ch.isActive ? CharacterState.TYPE : CharacterState.SIT_IDLE
      ch.dir = seat.facingDir
      ch.frame = 0
      ch.frameTimer = 0
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC
      }
    }
  }

  /** Send an agent back to their currently assigned seat */
  sendToSeat(agentId: number): void {
    const ch = this.characters.get(agentId)
    if (!ch || !ch.seatId) return
    const seat = this.seats.get(ch.seatId)
    if (!seat) return
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles)
    )
    if (path.length > 0) {
      ch.path = path
      ch.moveProgress = 0
      ch.state = CharacterState.WALK
      ch.frame = 0
      ch.frameTimer = 0
    } else {
      // Already at seat — sit down
      ch.state = ch.isActive ? CharacterState.TYPE : CharacterState.SIT_IDLE
      ch.dir = seat.facingDir
      ch.frame = 0
      ch.frameTimer = 0
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC
      }
    }
  }

  /** Walk an agent to an arbitrary walkable tile (right-click command) */
  walkToTile(agentId: number, col: number, row: number): boolean {
    const ch = this.characters.get(agentId)
    if (!ch || ch.isSubagent) return false
    if (!isWalkable(col, row, this.tileMap, this.blockedTiles)) {
      // Also allow walking to own seat tile (blocked for others but not self)
      const key = this.ownSeatKey(ch)
      if (!key || key !== `${col},${row}`) return false
    }
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, col, row, this.tileMap, this.blockedTiles)
    )
    if (path.length === 0) return false
    ch.path = path
    ch.moveProgress = 0
    ch.state = CharacterState.WALK
    ch.frame = 0
    ch.frameTimer = 0
    return true
  }

  /** Create a sub-agent character with the parent's palette. Returns the sub-agent ID. */
  addSubagent(parentAgentId: number, parentToolId: string): number {
    const key = `${parentAgentId}:${parentToolId}`
    if (this.subagentIdMap.has(key)) return this.subagentIdMap.get(key)!

    const id = this.nextSubagentId--
    const parentCh = this.characters.get(parentAgentId)
    const { palette, hueShift } = this.pickDiversePalette()

    // Find the free seat closest to the parent agent, preferring meeting room zones
    const parentCol = parentCh ? parentCh.tileCol : 0
    const parentRow = parentCh ? parentCh.tileRow : 0
    const dist = (c: number, r: number) =>
      Math.abs(c - parentCol) + Math.abs(r - parentRow)

    // Build set of meeting room tiles for preference scoring
    const meetingTiles = this.zoneTiles.get(ZoneTypeValues.MEETING_ROOM)
    const meetingSet = new Set<string>()
    if (meetingTiles) {
      for (const t of meetingTiles) meetingSet.add(`${t.col},${t.row}`)
    }

    let bestSeatId: string | null = null
    let bestDist = Infinity
    let bestInMeeting = false
    for (const [uid, seat] of this.seats) {
      if (!seat.assigned && !this.isTileOccupiedBySitting(seat.seatCol, seat.seatRow)) {
        const d = dist(seat.seatCol, seat.seatRow)
        const inMeeting = meetingSet.has(`${seat.seatCol},${seat.seatRow}`)
        // Prefer meeting room seats, then closest
        if ((inMeeting && !bestInMeeting) || (inMeeting === bestInMeeting && d < bestDist)) {
          bestDist = d
          bestSeatId = uid
          bestInMeeting = inMeeting
        }
      }
    }

    let ch: Character
    if (bestSeatId) {
      const seat = this.seats.get(bestSeatId)!
      seat.assigned = true
      ch = createCharacter(id, palette, bestSeatId, seat, hueShift)
    } else {
      // No seats — spawn at closest walkable tile to parent
      let spawn = { col: 1, row: 1 }
      if (this.walkableTiles.length > 0) {
        let closest = this.walkableTiles[0]
        let closestDist = dist(closest.col, closest.row)
        for (let i = 1; i < this.walkableTiles.length; i++) {
          const d = dist(this.walkableTiles[i].col, this.walkableTiles[i].row)
          if (d < closestDist) {
            closest = this.walkableTiles[i]
            closestDist = d
          }
        }
        spawn = closest
      }
      ch = createCharacter(id, palette, null, null, hueShift)
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2
      ch.tileCol = spawn.col
      ch.tileRow = spawn.row
    }
    ch.isSubagent = true
    ch.parentAgentId = parentAgentId
    ch.nametag = 'Subtask'
    ch.matrixEffect = 'spawn'
    ch.matrixEffectTimer = 0
    ch.matrixEffectSeeds = matrixEffectSeeds()
    this.characters.set(id, ch)

    this.subagentIdMap.set(key, id)
    this.subagentMeta.set(id, { parentAgentId, parentToolId })

    // Show talking bubbles on both parent and sub-agent (plan exchange)
    this.showTalkingBubble(parentAgentId)
    this.showTalkingBubble(id)

    return id
  }

  /** Remove a specific sub-agent character and free its seat */
  removeSubagent(parentAgentId: number, parentToolId: string): void {
    const key = `${parentAgentId}:${parentToolId}`
    const id = this.subagentIdMap.get(key)
    if (id === undefined) return

    const ch = this.characters.get(id)
    if (ch) {
      if (ch.matrixEffect === 'despawn') {
        // Already despawning — just clean up maps
        this.subagentIdMap.delete(key)
        this.subagentMeta.delete(id)
        return
      }
      if (ch.seatId) {
        const seat = this.seats.get(ch.seatId)
        if (seat) seat.assigned = false
      }
      // Start despawn animation — keep character in map for rendering
      ch.matrixEffect = 'despawn'
      ch.matrixEffectTimer = 0
      ch.matrixEffectSeeds = matrixEffectSeeds()
      ch.bubbleType = null
    }
    // Clean up tracking maps immediately so keys don't collide
    this.subagentIdMap.delete(key)
    this.subagentMeta.delete(id)
    if (this.selectedAgentId === id) this.selectedAgentId = null
    if (this.cameraFollowId === id) this.cameraFollowId = null
  }

  /** Remove all sub-agents belonging to a parent agent */
  removeAllSubagents(parentAgentId: number): void {
    const toRemove: string[] = []
    for (const [key, id] of this.subagentIdMap) {
      const meta = this.subagentMeta.get(id)
      if (meta && meta.parentAgentId === parentAgentId) {
        const ch = this.characters.get(id)
        if (ch) {
          if (ch.matrixEffect === 'despawn') {
            // Already despawning — just clean up maps
            this.subagentMeta.delete(id)
            toRemove.push(key)
            continue
          }
          if (ch.seatId) {
            const seat = this.seats.get(ch.seatId)
            if (seat) seat.assigned = false
          }
          // Start despawn animation
          ch.matrixEffect = 'despawn'
          ch.matrixEffectTimer = 0
          ch.matrixEffectSeeds = matrixEffectSeeds()
          ch.bubbleType = null
        }
        this.subagentMeta.delete(id)
        if (this.selectedAgentId === id) this.selectedAgentId = null
        if (this.cameraFollowId === id) this.cameraFollowId = null
        toRemove.push(key)
      }
    }
    for (const key of toRemove) {
      this.subagentIdMap.delete(key)
    }
  }

  /** Look up the sub-agent character ID for a given parent+toolId, or null */
  getSubagentId(parentAgentId: number, parentToolId: string): number | null {
    return this.subagentIdMap.get(`${parentAgentId}:${parentToolId}`) ?? null
  }

  /** Randomize a character's palette and hue shift */
  shuffleAgentLook(id: number): void {
    const ch = this.characters.get(id)
    if (!ch) return
    const { palette, hueShift } = this.pickDiversePalette()
    ch.palette = palette
    ch.hueShift = hueShift
  }

  setAgentActive(id: number, active: boolean): void {
    const ch = this.characters.get(id)
    if (ch) {
      const wasActive = ch.isActive
      ch.isActive = active
      // Remote: just update flag, source window handles FSM
      if (ch.isRemote) {
        this.rebuildFurnitureInstances()
        return
      }
      const name = ch.nametag || `Agent ${id}`
      if (active && !wasActive) {
        addBehaviourEntry({ agentId: id, agentName: name, message: 'started working', type: 'status' })
      } else if (!active && wasActive) {
        addBehaviourEntry({ agentId: id, agentName: name, message: 'finished working', type: 'status' })
      }
      if (active) {
        ch.isWaiting = false
        ch.idleZoneTimer = 0
        // Disengage from conversation if in one
        if (ch.idleAction === IdleActionType.CONVERSATION) {
          disengageConversation(ch, this.buildIdleActionContext())
        }
        // Disengage from meeting if in one — only this agent leaves
        if (ch.idleAction === IdleActionType.MEETING) {
          disengageMeeting(ch, this.buildIdleActionContext())
          this.restoreMeetingSeat(ch)
        }
        // Clear any idle action
        if (ch.idleAction) {
          ch.idleAction = null
          ch.conversationPartnerId = null
          ch.conversationPhase = null
          ch.idleActionTimer = 0
          ch.bubbleType = null
          ch.bubbleTimer = 0
          ch.currentTool = null
        }
        // Clear any in-progress walk (e.g. walking to meeting seat)
        ch.path = []
        ch.moveProgress = 0
        // Reassign to a workspace zone seat when becoming active
        this.reassignToZoneSeat(ch, [ZoneTypeValues.WORKSPACE])
        // Walk to assigned seat if not already there (e.g. leaving a meeting across the room)
        if (ch.seatId) {
          const seat = this.seats.get(ch.seatId)
          if (seat && (ch.tileCol !== seat.seatCol || ch.tileRow !== seat.seatRow)) {
            const path = this.withOwnSeatUnblocked(ch, () =>
              findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles)
            )
            if (path.length > 0) {
              ch.path = path
              ch.moveProgress = 0
              ch.state = CharacterState.WALK
              ch.frame = 0
              ch.frameTimer = 0
            }
          }
        }
      }
      if (!active && wasActive) {
        // Transition from active → inactive: start zone delay timers
        // Only set on transition — repeated calls with active=false must not reset timers
        ch.idleZoneTimer = IDLE_ZONE_DELAY_SEC
        // seatTimer controls how long SIT_IDLE lasts — match the zone delay
        // so character sits at desk until zone transition fires
        ch.seatTimer = IDLE_ZONE_DELAY_SEC + 0.1 // slightly longer so zone fires first
        ch.path = []
        ch.moveProgress = 0
      }
      this.rebuildFurnitureInstances()
    }
  }

  /** Immediately reassign an idle agent to a rest/kitchen zone seat and walk there.
   *  Skips the IDLE_ZONE_DELAY_SEC wait. Used for agents that spawn as idle. */
  sendToRestZone(id: number): void {
    const ch = this.characters.get(id)
    if (!ch || ch.isActive) return
    const oldSeatId = ch.seatId
    this.reassignToZoneSeat(ch, [ZoneTypeValues.KITCHEN, ZoneTypeValues.REST_AREA])
    // Clear idle zone timer so it doesn't fire again
    ch.idleZoneTimer = 0
    if (ch.seatId && ch.seatId !== oldSeatId) {
      const seat = this.seats.get(ch.seatId)
      if (seat) {
        const path = this.withOwnSeatUnblocked(ch, () =>
          findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles)
        )
        if (path.length > 0) {
          ch.path = path
          ch.moveProgress = 0
          ch.state = CharacterState.WALK
          ch.frame = 0
          ch.frameTimer = 0
        }
      }
    }
  }

  /** Reassign a character to the closest free seat in the given zone types.
   *  If already seated in a matching zone, stays put. Frees old seat.
   *  When no zones are defined, picks any different free seat so idle agents leave their desk. */
  private reassignToZoneSeat(ch: Character, zoneTypes: ZoneType[]): void {
    const zones = this.layout.zones
    const hasZones = zones && this.zoneTiles.size > 0

    if (hasZones) {
      // Check if current seat is already in a matching zone
      if (ch.seatId) {
        const seat = this.seats.get(ch.seatId)
        if (seat) {
          const idx = seat.seatRow * this.layout.cols + seat.seatCol
          const zone = zones![idx]
          if (zone && zoneTypes.includes(zone as ZoneType)) return // already in right zone
        }
      }
    }

    let newSeatId: string | null
    if (hasZones) {
      newSeatId = this.findFreeSeatInZones(zoneTypes, ch.tileCol, ch.tileRow)
    } else {
      // No zones — pick any free seat that's different from current
      newSeatId = this.findFreeSeatExcluding(ch.seatId)
    }
    if (!newSeatId) return
    // Check we're not re-assigning to the same seat
    if (newSeatId === ch.seatId) return

    // Free old seat
    if (ch.seatId) {
      const old = this.seats.get(ch.seatId)
      if (old) old.assigned = false
    }
    // Assign new seat
    const seat = this.seats.get(newSeatId)
    if (!seat || seat.assigned) return
    seat.assigned = true
    ch.seatId = newSeatId
  }

  /** Rebuild furniture instances with auto-state applied (active agents turn electronics ON) */
  rebuildFurnitureInstances(): void {
    // Collect tiles where active agents face desks
    const autoOnTiles = new Set<string>()
    for (const ch of this.characters.values()) {
      if (!ch.isActive || !ch.seatId) continue
      const seat = this.seats.get(ch.seatId)
      if (!seat) continue
      // Find the desk tile(s) the agent faces from their seat
      const dCol = seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0
      const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0
      // Check tiles in the facing direction (desk could be 1-3 tiles deep)
      for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
        const tileCol = seat.seatCol + dCol * d
        const tileRow = seat.seatRow + dRow * d
        autoOnTiles.add(`${tileCol},${tileRow}`)
      }
      // Also check tiles to the sides of the facing direction (desks can be wide)
      for (let d = 1; d <= AUTO_ON_SIDE_DEPTH; d++) {
        const baseCol = seat.seatCol + dCol * d
        const baseRow = seat.seatRow + dRow * d
        if (dCol !== 0) {
          // Facing left/right: check tiles above and below
          autoOnTiles.add(`${baseCol},${baseRow - 1}`)
          autoOnTiles.add(`${baseCol},${baseRow + 1}`)
        } else {
          // Facing up/down: check tiles left and right
          autoOnTiles.add(`${baseCol - 1},${baseRow}`)
          autoOnTiles.add(`${baseCol + 1},${baseRow}`)
        }
      }
    }

    if (autoOnTiles.size === 0) {
      this.furniture = layoutToFurnitureInstances(this.layout.furniture)
      return
    }

    // Build modified furniture list with auto-state applied
    const modifiedFurniture: PlacedFurniture[] = this.layout.furniture.map((item) => {
      const entry = getCatalogEntry(item.type)
      if (!entry) return item
      // Check if any tile of this furniture overlaps an auto-on tile
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          if (autoOnTiles.has(`${item.col + dc},${item.row + dr}`)) {
            const onType = getOnStateType(item.type)
            if (onType !== item.type) {
              return { ...item, type: onType }
            }
            return item
          }
        }
      }
      return item
    })

    this.furniture = layoutToFurnitureInstances(modifiedFurniture)
  }

  setAgentTool(id: number, tool: string | null): void {
    const ch = this.characters.get(id)
    if (ch) {
      ch.currentTool = tool
    }
  }

  showPermissionBubble(id: number): void {
    const ch = this.characters.get(id)
    if (ch) {
      ch.bubbleType = 'permission'
      ch.bubbleTimer = 0
    }
  }

  clearPermissionBubble(id: number): void {
    const ch = this.characters.get(id)
    if (ch && (ch.bubbleType === 'permission' || ch.bubbleType === 'thinking')) {
      ch.bubbleType = null
      ch.bubbleTimer = 0
    }
  }

  showThinkingBubble(id: number): void {
    const ch = this.characters.get(id)
    if (ch && ch.bubbleType !== 'permission') {
      // Don't override permission bubble; thinking is lower priority
      ch.bubbleType = 'thinking'
      ch.bubbleTimer = 0 // stays until cleared (no auto-fade)
    }
  }

  showWaitingBubble(id: number): void {
    const ch = this.characters.get(id)
    if (ch) {
      ch.isWaiting = true
      ch.bubbleType = 'waiting'
      ch.bubbleTimer = WAITING_BUBBLE_DURATION_SEC
    }
  }

  showTalkingBubble(id: number): void {
    const ch = this.characters.get(id)
    if (ch && ch.bubbleType !== 'permission') {
      // Don't override permission bubble; talking is lower priority
      ch.bubbleType = 'talking'
      ch.bubbleTimer = TALKING_BUBBLE_DURATION_SEC
    }
  }

  /** Dismiss bubble on click — permission: instant, waiting: quick fade */
  dismissBubble(id: number): void {
    const ch = this.characters.get(id)
    if (!ch || !ch.bubbleType) return
    if (ch.bubbleType === 'permission') {
      ch.bubbleType = null
      ch.bubbleTimer = 0
    } else if (ch.bubbleType === 'waiting' || ch.bubbleType === 'talking' || ch.bubbleType === 'idle_chat' || ch.bubbleType === 'idle_think') {
      // Trigger immediate fade (0.3s remaining)
      ch.bubbleTimer = Math.min(ch.bubbleTimer, DISMISS_BUBBLE_FAST_FADE_SEC)
    }
  }

  update(dt: number): void {
    const toDelete: number[] = []
    for (const ch of this.characters.values()) {
      // Handle matrix effect animation
      if (ch.matrixEffect) {
        ch.matrixEffectTimer += dt
        if (ch.matrixEffectTimer >= MATRIX_EFFECT_DURATION) {
          if (ch.matrixEffect === 'spawn') {
            // Spawn complete — clear effect, resume normal FSM
            ch.matrixEffect = null
            ch.matrixEffectTimer = 0
            ch.matrixEffectSeeds = []
          } else {
            // Despawn complete — mark for deletion
            toDelete.push(ch.id)
          }
        }
        continue // skip normal FSM while effect is active
      }

      // Remote characters: source window is authority, animate locally using synced path/state
      if (ch.isRemote) {
        if (ch.syncTarget) {
          const target = ch.syncTarget
          const targetState = target.state as CharacterState
          const sitting = targetState === CharacterState.TYPE || targetState === CharacterState.SIT_IDLE
            || targetState === CharacterState.SIT_WAIT || targetState === CharacterState.BUILD

          if (sitting) {
            // Use source window's reported position directly (authoritative)
            ch.x = target.x
            ch.y = target.y
            ch.tileCol = target.tileCol
            ch.tileRow = target.tileRow
            ch.dir = target.dir as typeof ch.dir
            ch.state = targetState
            ch.currentTool = target.state === CharacterState.TYPE ? ch.currentTool : null
            // Animate seated states locally
            ch.frameTimer += dt
            if (targetState === CharacterState.TYPE || targetState === CharacterState.SIT_WAIT) {
              const dur = targetState === CharacterState.TYPE ? TYPE_FRAME_DURATION_SEC : SIT_WAIT_FRAME_DURATION_SEC
              if (ch.frameTimer >= dur) { ch.frameTimer -= dur; ch.frame = (ch.frame + 1) % 2 }
            } else if (targetState === CharacterState.BUILD) {
              if (ch.frameTimer >= BUILD_FRAME_DURATION_SEC) { ch.frameTimer -= BUILD_FRAME_DURATION_SEC; ch.frame = (ch.frame + 1) % 3 }
            }
          } else if (target.path && target.path.length > 0) {
            // Source is walking — find destination and walk there locally
            const dest = target.path[target.path.length - 1]
            const myDest = ch.path.length > 0 ? ch.path[ch.path.length - 1] : null

            // If destination changed or not currently walking, compute local path
            if (!myDest || myDest.col !== dest.col || myDest.row !== dest.row) {
              const newPath = this.withOwnSeatUnblocked(ch, () =>
                findPath(ch.tileCol, ch.tileRow, dest.col, dest.row, this.tileMap, this.blockedTiles)
              )
              if (newPath.length > 0) {
                ch.path = newPath
                ch.moveProgress = 0
                ch.state = CharacterState.WALK
                ch.frame = 0
                ch.frameTimer = 0
              }
            }

            // Walk along path at normal speed
            if (ch.state === CharacterState.WALK && ch.path.length > 0) {
              ch.frameTimer += dt
              if (ch.frameTimer >= WALK_FRAME_DURATION_SEC) {
                ch.frameTimer -= WALK_FRAME_DURATION_SEC
                ch.frame = (ch.frame + 1) % 4
              }
              const nextTile = ch.path[0]
              ch.dir = directionBetween(ch.tileCol, ch.tileRow, nextTile.col, nextTile.row)
              ch.moveProgress += (WALK_SPEED_PX_PER_SEC / TILE_SIZE) * dt
              const fromX = ch.tileCol * TILE_SIZE + TILE_SIZE / 2
              const fromY = ch.tileRow * TILE_SIZE + TILE_SIZE / 2
              const toX = nextTile.col * TILE_SIZE + TILE_SIZE / 2
              const toY = nextTile.row * TILE_SIZE + TILE_SIZE / 2
              const t = Math.min(ch.moveProgress, 1)
              ch.x = fromX + (toX - fromX) * t
              ch.y = fromY + (toY - fromY) * t
              if (ch.moveProgress >= 1) {
                ch.tileCol = nextTile.col
                ch.tileRow = nextTile.row
                ch.x = toX
                ch.y = toY
                ch.path.shift()
                ch.moveProgress = 0
              }
            }
          } else {
            // Idle or no path — snap to source position
            ch.x = target.x
            ch.y = target.y
            ch.tileCol = target.tileCol
            ch.tileRow = target.tileRow
            ch.state = targetState
            ch.dir = target.dir as typeof ch.dir
            ch.frame = target.frame
          }
        }
        // Tick bubble timers
        if (ch.bubbleType === 'waiting' || ch.bubbleType === 'talking' || ch.bubbleType === 'idle_chat' || ch.bubbleType === 'idle_think') {
          ch.bubbleTimer -= dt
          if (ch.bubbleTimer <= 0) { ch.bubbleType = null; ch.bubbleTimer = 0 }
        }
        continue
      }

      // Idle zone transition: after IDLE_ZONE_DELAY_SEC of being idle,
      // reassign to a rest/kitchen zone seat and walk there
      // Skip characters in a meeting — they stay at their meeting seat
      if (!ch.isActive && !ch.isSubagent && ch.idleAction !== IdleActionType.MEETING && ch.idleZoneTimer > 0) {
        ch.idleZoneTimer -= dt
        if (ch.idleZoneTimer <= 0) {
          ch.idleZoneTimer = 0
          // Still idle — reassign to a rest/kitchen zone and pathfind there
          const oldSeatId = ch.seatId
          this.reassignToZoneSeat(ch, [ZoneTypeValues.KITCHEN, ZoneTypeValues.REST_AREA])
          // If seat changed, pathfind to the new seat
          if (ch.seatId && ch.seatId !== oldSeatId) {
            const seat = this.seats.get(ch.seatId)
            if (seat) {
              const path = this.withOwnSeatUnblocked(ch, () =>
                findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles)
              )
              if (path.length > 0) {
                ch.path = path
                ch.moveProgress = 0
                ch.state = CharacterState.WALK
                ch.frame = 0
                ch.frameTimer = 0
              }
            }
          }
        }
      }

      // ── Seated Conversation Check ────────────────────────────────
      // SIT_IDLE characters can start conversations with nearby seated partners (not during meetings)
      if (ch.state === CharacterState.SIT_IDLE && ch.idleAction === null && !ch.isActive && !ch.isSubagent && !ch.isRemote && !this.meetingOriginalSeats.has(ch.id)) {
        if (Math.random() < SEATED_CONVERSATION_CHANCE_PER_SEC * dt) {
          const idleCtx = this.buildIdleActionContext()
          trySeatedConversation(ch, idleCtx)
        }
      }

      // ── Meeting Trigger ──────────────────────────────────────────
      // Once per tick (driven by first eligible character), try to start a meeting
      if (ch.state === CharacterState.SIT_IDLE && ch.idleAction === null && !ch.isActive && !ch.isSubagent && !ch.isRemote) {
        if (Math.random() < MEETING_CHANCE_PER_SEC * dt) {
          this.tryStartMeeting()
        }
      }

      // ── Idle Action System ──────────────────────────────────────
      // When a character enters IDLE with no action assigned, pick one from the weighted registry
      if (ch.state === CharacterState.IDLE && ch.idleAction === null && !ch.isActive && !ch.isSubagent && !ch.isRemote) {
        const idleCtx = this.buildIdleActionContext()
        const action = pickIdleAction(ch, idleCtx)
        if (!initIdleAction(ch, action, idleCtx)) {
          // Init failed — fall back to wander
          ch.idleAction = IdleActionType.WANDER
        }
      }

      // Update non-wander idle actions (conversation, visit, think, meeting)
      if (ch.idleAction && ch.idleAction !== IdleActionType.WANDER && !ch.isActive) {
        const wasMeeting = ch.idleAction === IdleActionType.MEETING
        const idleCtx = this.buildIdleActionContext()
        const stillRunning = updateIdleAction(ch, dt, idleCtx)
        if (!stillRunning) {
          // Action completed — restore meeting seats if applicable, then return to seat
          if (wasMeeting) {
            this.restoreMeetingSeat(ch)
            // Also restore seats for any other participants who ended simultaneously
            for (const other of this.characters.values()) {
              if (other.id !== ch.id && other.idleAction === null && this.meetingOriginalSeats.has(other.id)) {
                this.restoreMeetingSeat(other)
                this.returnToSeat(other)
              }
            }
          }
          this.returnToSeat(ch)
        }
      }

      // Determine zone-preferred walkable tiles for idle wandering
      let preferredTiles = this.walkableTiles
      if (!ch.isActive && ch.state === CharacterState.IDLE && this.zoneTiles.size > 0 && Math.random() < ZONE_WANDER_PREFERENCE) {
        // Idle characters prefer kitchen and rest areas
        const zoneTiles = this.getZoneWalkableTiles([ZoneTypeValues.KITCHEN, ZoneTypeValues.REST_AREA])
        if (zoneTiles.length > 0) preferredTiles = zoneTiles
      }

      // Temporarily unblock own seat so character can pathfind to it
      this.withOwnSeatUnblocked(ch, () =>
        updateCharacter(ch, dt, preferredTiles, this.seats, this.tileMap, this.blockedTiles)
      )

      // Tick bubble timer for waiting/talking/idle bubbles
      if (ch.bubbleType === 'waiting' || ch.bubbleType === 'talking' || ch.bubbleType === 'idle_chat' || ch.bubbleType === 'idle_think') {
        ch.bubbleTimer -= dt
        if (ch.bubbleTimer <= 0) {
          ch.bubbleType = null
          ch.bubbleTimer = 0
        }
      }
    }
    // Remove characters that finished despawn
    for (const id of toDelete) {
      this.characters.delete(id)
    }
  }

  getCharacters(): Character[] {
    return Array.from(this.characters.values())
  }

  /** Get character at pixel position (for hit testing). Returns id or null. */
  getCharacterAt(worldX: number, worldY: number): number | null {
    const chars = this.getCharacters().sort((a, b) => b.y - a.y)
    for (const ch of chars) {
      // Skip characters that are despawning
      if (ch.matrixEffect === 'despawn') continue
      // Character sprite is 16x24, anchored bottom-center
      // Apply sitting offset to match visual position
      const sittingOffset = isSittingState(ch.state) ? CHARACTER_SITTING_OFFSET_PX : 0
      const anchorY = ch.y + sittingOffset
      const left = ch.x - CHARACTER_HIT_HALF_WIDTH
      const right = ch.x + CHARACTER_HIT_HALF_WIDTH
      const top = anchorY - CHARACTER_HIT_HEIGHT
      const bottom = anchorY
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
        return ch.id
      }
    }
    return null
  }
}
