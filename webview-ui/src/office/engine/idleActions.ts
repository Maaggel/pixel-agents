import { CharacterState, Direction, IdleActionType } from '../types.js'
import type { Character, PlacedFurniture, PlacedProp, Seat, TileType as TileTypeVal, FloorColor } from '../types.js'
import { directionBetween, isSittingState } from './characters.js'
import { addBehaviourEntry } from '../../behaviourLog.js'
import {
  ITEM_FETCH_SEC,
  ITEM_DISPOSE_SEC,
  ITEM_BUBBLE_MAX_SEC,
  ITEM_COLOR_VARIANTS,
  TIDY_NEAR_DISTANCE_TILES,
  TIDY_NEAR_WEIGHT,
  PROP_MIN_AGE_SEC,
  PROP_ABANDONED_SEC,
  MAX_PROPS,
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
  EAT_MIN_DURATION_SEC,
  EAT_MAX_DURATION_SEC,
  SEATED_CONVERSATION_MAX_DISTANCE,
  IDLE_CHAT_BUBBLE_VARIANT_COUNT,
  MEETING_BUBBLE_SHOW_MIN_SEC,
  MEETING_BUBBLE_SHOW_MAX_SEC,
  MEETING_BUBBLE_GAP_MIN_SEC,
  MEETING_BUBBLE_GAP_MAX_SEC,
  MEETING_BUBBLE_INITIAL_MAX_DELAY_SEC,
  MEETING_MIN_PARTICIPANTS,
  OFFICE_MEAL_HOURS,
  OFFICE_DRINK_HOURS,
  NEAREST_PATH_CANDIDATES,
  PLANT_FADE_AT_DRYNESS,
  TOILET_SIT_MIN_SEC,
  TOILET_SIT_MAX_SEC,
  WASH_HANDS_SEC,
  USE_TOILET_WEIGHT,
  TOILET_HOURS,
  PLANT_NOTICE_DISTANCE_TILES,
  WATER_NEAR_PARCHED_WEIGHT,
  WATER_NEAR_FADING_WEIGHT,
  WATER_PARCHED_ELSEWHERE_WEIGHT,
  WATER_FADING_ELSEWHERE_WEIGHT,
  FETCH_DRINK_PREFERENCE,
  WATER_PLANT_SEC,
  WATERING_CAN_DEFAULT_USES,
} from '../../constants.js'
import { getCatalogEntry, getCatalogTypesMatching, getUtensilEntries } from '../layout/furnitureCatalog.js'
import { getOfficeHour } from './sunlight.js'

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
  /** Action requires character to be seated in a specific zone type */
  needsZone?: string
  /** Action is part of the "dynamic items" feature (toggleable in View options) */
  needsDynamicItems?: boolean
  /** Action requires a toilet nobody is using */
  needsToilet?: boolean
}

const IDLE_ACTION_REGISTRY: IdleActionEntry[] = [
  { type: IdleActionType.WANDER, weight: 10 },
  { type: IdleActionType.CONVERSATION, weight: 35, needsPartner: true },
  { type: IdleActionType.VISIT_FURNITURE, weight: 35, needsFurniture: true },
  { type: IdleActionType.STAND_AND_THINK, weight: 10 },
  { type: IdleActionType.EATING, weight: 230, needsZone: 'kitchen' },
  { type: IdleActionType.FETCH_ITEM, weight: 55, needsDynamicItems: true },
  { type: IdleActionType.TIDY_UP, weight: 15, needsDynamicItems: true },
  // weight comes from wateringUrge(): what is dry, and whether they are walking past it
  { type: IdleActionType.WATER_PLANTS, weight: 0, needsDynamicItems: true },
  { type: IdleActionType.USE_TOILET, weight: USE_TOILET_WEIGHT, needsToilet: true },
]

/**
 * How much more (or less) likely an action is at this hour of the office's day.
 *
 * Ranges may wrap past midnight, which is how the quiet night hours are written. The office day
 * is five minutes long, so a lunch rush lasts about half a minute of real time.
 */
function hourMultiplier(ranges: Array<[number, number, number]>): number {
  const hour = getOfficeHour()
  for (const [from, to, factor] of ranges) {
    const inRange = from <= to ? hour >= from && hour < to : hour >= from || hour < to
    if (inRange) return factor
  }
  return 1
}

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

// ── Dynamic items helpers ──────────────────────────────────────

/** Placed furniture matching an asset-name spec ('SINK', 'SINK,WATER_COOLER', '*BOOKSHELF*'). */
function findFurnitureByAssetName(ctx: IdleActionContext, spec: string): PlacedFurniture[] {
  const types = new Set(getCatalogTypesMatching(spec))
  if (types.size === 0) return []
  return ctx.furniture.filter(f => types.has(f.type))
}

interface FetchableUtensil { type: string; label: string; use: 'drink' | 'food' | 'item'; origins: PlacedFurniture[] }

/** Utensils whose origin furniture exists in the layout, paired with those origins.
 *  'food' is fetched by EATING; 'break' = drink + item, fetched by FETCH_ITEM. */
function findFetchableUtensils(ctx: IdleActionContext, want: 'food' | 'break'): FetchableUtensil[] {
  const out: FetchableUtensil[] = []
  for (const entry of getUtensilEntries()) {
    if (!entry.utensilOrigin) continue
    const use = entry.utensilUse ?? 'drink'
    if (use === 'water') continue // the watering can has its own errand
    if (want === 'food' ? use !== 'food' : use === 'food') continue
    const origins = findFurnitureByAssetName(ctx, entry.utensilOrigin)
    if (origins.length > 0) out.push({ type: entry.type, label: entry.label, use: use as FetchableUtensil['use'], origins })
  }
  return out
}

/** Is someone else already at this machine, or on their way to it? */
function originTaken(uid: string | undefined, ch: Character, ctx: IdleActionContext): boolean {
  if (!uid) return false
  for (const other of ctx.characters.values()) {
    if (other.id !== ch.id && other.fetchOriginUid === uid) return true
  }
  return false
}

/**
 * Start walking to an origin of `utensil`; on arrival the caller waits ITEM_FETCH_SEC and
 * receives it. A machine nobody else is using wins over a nearer one that is taken, so two agents
 * wanting coffee spread across the machines instead of piling onto the same one; with only one
 * machine the second arrival waits their turn beside it.
 */
function startFetch(ch: Character, utensil: FetchableUtensil, ctx: IdleActionContext): boolean {
  const byDistance = nearestFirst(utensil.origins, ch, ctx)
  const free = byDistance.filter((o) => !originTaken(o.uid, ch, ctx))
  for (const origin of [...free, ...byDistance.filter((o) => !free.includes(o))]) {
    if (!walkToFurniture(ch, origin, ctx)) continue
    ch.itemTargetUid = utensil.type // utensil type to receive on arrival
    ch.fetchOriginUid = origin.uid ?? null
    ch.itemColor = pickRandom(ITEM_COLOR_VARIANTS) ?? null
    ch.idleActionTimer = ITEM_FETCH_SEC
    return true
  }
  return false
}

/** Pick something to fetch on a break, leaning towards a drink over something to read */
function pickBreakItem(options: FetchableUtensil[]): FetchableUtensil | null {
  if (options.length === 0) return null
  const weight = (u: FetchableUtensil) => (u.use === 'drink' ? FETCH_DRINK_PREFERENCE : 1)
  const total = options.reduce((sum, u) => sum + weight(u), 0)
  let roll = Math.random() * total
  for (const option of options) {
    roll -= weight(option)
    if (roll <= 0) return option
  }
  return options[options.length - 1]
}

function utensilLabel(type: string | null): string {
  if (!type) return 'item'
  return (getCatalogEntry(type)?.label ?? type).toLowerCase()
}

/** Disposal furniture for a utensil type (from its catalog entry), nearest first. */
function findDisposalFor(type: string, ch: Character, ctx: IdleActionContext): PlacedFurniture[] {
  const prefix = getCatalogEntry(type)?.utensilDisposal
  if (!prefix) return []
  return nearestFirst(findFurnitureByAssetName(ctx, prefix), ch, ctx)
}

/** A prop is "in use" while someone sits right next to it (eating in front of a plate, a mug by a seated agent). */
/**
 * Something finished with rather than in use: the empty a meal turns into. They are the utensils
 * with somewhere to be taken but nowhere to be fetched from, which is exactly what an empty is.
 */
function isFinishedWith(kind: string): boolean {
  const entry = getCatalogEntry(kind)
  return !!entry?.utensil && !!entry.utensilDisposal && !entry.utensilOrigin
}

/**
 * Is somebody still drinking this, or is it just sitting there?
 *
 * Only the person who put it down counts as using it, and only for a while: anyone else sitting
 * near a mug is simply sitting near a mug. Protecting it from whoever happens to be next to it
 * meant nothing on a desk was ever cleared away, because the person who fetched it is sitting at
 * that desk working. Something with no owner and no age - a mug placed in the layout - is never
 * in use; clearing those away is the point of them being tidyable.
 */
function isPropInUse(prop: PlacedProp, ctx: IdleActionContext): boolean {
  if (!prop.placedAt) return false
  if (ctx.nowSec - prop.placedAt >= PROP_ABANDONED_SEC) return false
  const owner = ctx.characters.get(prop.ownerId)
  if (!owner || !isSittingState(owner.state)) return false
  return Math.abs(owner.tileCol - prop.col) + Math.abs(owner.tileRow - prop.row) <= 1
}

/** Props old enough to be tidied, not in use, and not currently targeted by someone else */
/** The watering can, if the layout has one along with somewhere to fill it */
function findWateringCan(ctx: IdleActionContext): FetchableUtensil | null {
  for (const entry of getUtensilEntries()) {
    if (entry.utensilUse !== 'water' || !entry.utensilOrigin) continue
    const origins = findFurnitureByAssetName(ctx, entry.utensilOrigin)
    if (origins.length > 0) return { type: entry.type, label: entry.label, use: 'drink', origins }
  }
  return null
}

/**
 * Plants worth watering: the parched ones first and then the merely fading, nearest within each.
 *
 * Someone with a canful walks the worst first rather than the closest, which is what anyone would
 * do; `minDryness` lets the caller ask only about the parched ones.
 */
function findThirstyPlants(ch: Character, ctx: IdleActionContext, minDryness = PLANT_FADE_AT_DRYNESS): PlacedFurniture[] {
  const can = getCatalogEntry(findWateringCan(ctx)?.type ?? '')
  if (!can?.utensilTargets) return []
  const targeted = new Set<string>()
  for (const other of ctx.characters.values()) if (other.itemTargetUid) targeted.add(other.itemTargetUid)
  const parched: PlacedFurniture[] = []
  const fading: PlacedFurniture[] = []
  for (const f of findFurnitureByAssetName(ctx, can.utensilTargets)) {
    if (!f.uid || targeted.has(f.uid)) continue
    const dryness = ctx.plantDryness(f.uid)
    if (dryness < minDryness) continue
    // one on a shelf or boxed in by desks cannot be reached, so it never counts as thirsty
    const fp = ctx.getFurnitureFootprint(f.type)
    if (!findAdjacentWalkableTile(f, fp?.w ?? 1, fp?.h ?? 1, ctx.tileMap, ctx.blockedTiles, useSideFor(f.type))) continue
    ;(dryness >= 1 ? parched : fading).push(f)
  }
  return [...nearestFirst(parched, ch, ctx), ...nearestFirst(fading, ch, ctx)]
}

/** How much someone wants to go and water something, given what is dry and how near it is */
function wateringUrge(ch: Character, ctx: IdleActionContext): number {
  const candidates = findThirstyPlants(ch, ctx)
  if (candidates.length === 0) return 0
  let nearParched = false, nearFading = false, anyParched = false
  for (const f of candidates) {
    const parched = f.uid ? ctx.plantDryness(f.uid) >= 1 : false
    if (parched) anyParched = true
    if (tileDistance(f, ch) <= PLANT_NOTICE_DISTANCE_TILES) {
      if (parched) nearParched = true
      else nearFading = true
    }
  }
  if (nearParched) return WATER_NEAR_PARCHED_WEIGHT
  if (nearFading) return WATER_NEAR_FADING_WEIGHT
  return anyParched ? WATER_PARCHED_ELSEWHERE_WEIGHT : WATER_FADING_ELSEWHERE_WEIGHT
}

/** Something lying about that someone could carry to the sink: a left mug, or one the owner placed */
interface TidyTarget { uid: string; kind: string; col: number; row: number }

function findStaleProps(ctx: IdleActionContext): TidyTarget[] {
  const targeted = new Set<string>()
  for (const other of ctx.characters.values()) {
    if (other.itemTargetUid) targeted.add(other.itemTargetUid)
  }
  const out: TidyTarget[] = ctx.props
    .filter(p => !targeted.has(p.uid)
      && !!getCatalogEntry(p.kind)?.utensilDisposal
      // An empty plate is finished with, so it can go at once and from under someone's nose.
      // Anything still full waits out its minimum lifetime, and waits for whoever is drinking it.
      && (isFinishedWith(p.kind) || (ctx.nowSec - p.placedAt >= PROP_MIN_AGE_SEC && !isPropInUse(p, ctx))))
    .map(p => ({ uid: p.uid, kind: p.kind, col: p.col, row: p.row }))
  // Cups, plates and glasses from the layout count too: they are exactly the things someone would
  // clear away, and hiding one only lasts until the layout is loaded again.
  for (const item of ctx.tidyableFurniture) {
    if (!item.uid || targeted.has(item.uid)) continue
    if (isPropInUse({ col: item.col, row: item.row } as PlacedProp, ctx)) continue
    out.push({ uid: item.uid, kind: item.type, col: item.col, row: item.row })
  }
  return out
}

/** Is any stale, unused prop within TIDY_NEAR_DISTANCE_TILES of the character? */
function hasStalePropNearby(ch: Character, ctx: IdleActionContext): boolean {
  return findStaleProps(ctx).some(p => Math.abs(p.col - ch.tileCol) + Math.abs(p.row - ch.tileRow) <= TIDY_NEAR_DISTANCE_TILES)
}

/** Walk to a tile adjacent to `target` (footprint from the catalog, or 1×1). Returns false if unreachable. */
function walkToFurniture(ch: Character, target: PlacedFurniture, ctx: IdleActionContext): boolean {
  const footprint = ctx.getFurnitureFootprint(target.type)
  const fw = footprint ? footprint.w : 1
  const fh = footprint ? footprint.h : 1
  const adj = findAdjacentWalkableTile(target, fw, fh, ctx.tileMap, ctx.blockedTiles, useSideFor(target.type))
  if (!adj) return false
  const path = ctx.findPathUnblocked(ch, adj.col, adj.row)
  if (path.length === 0 && (ch.tileCol !== adj.col || ch.tileRow !== adj.row)) return false
  ch.preConversationDir = adj.facingDir
  if (path.length > 0) {
    ch.path = path
    ch.moveProgress = 0
    ch.state = CharacterState.WALK
    ch.frame = 0
    ch.frameTimer = 0
  }
  return true
}

/** True once a walkToFurniture() trip has finished; faces the target on arrival. */
function arrivedAtFurniture(ch: Character): boolean {
  if (ch.state === CharacterState.WALK || ch.path.length > 0) return false
  ch.dir = ch.preConversationDir ?? ch.dir
  ch.preConversationDir = null
  ch.state = CharacterState.IDLE
  ch.frame = 0
  return true
}

function showItemBubble(ch: Character, itemType: string): void {
  ch.bubbleType = 'idle_item'
  ch.bubbleItemType = itemType
  ch.bubbleTimer = ITEM_BUBBLE_MAX_SEC
}

function showTidyBubble(ch: Character): void {
  ch.bubbleType = 'idle_tidy'
  ch.bubbleTimer = ITEM_BUBBLE_MAX_SEC
}

function clearItemBubble(ch: Character): void {
  if (ch.bubbleType === 'idle_item' || ch.bubbleType === 'idle_tidy') {
    ch.bubbleType = null
    ch.bubbleTimer = 0
  }
  ch.bubbleItemType = null
}

function pickRandom<T>(list: T[]): T | null {
  return list.length > 0 ? list[Math.floor(Math.random() * list.length)] : null
}

/** Straight-line tiles between a character and something, ignoring walls. */
function tileDistance(a: { col: number; row: number }, ch: Character): number {
  return Math.abs(a.col - ch.tileCol) + Math.abs(a.row - ch.tileRow)
}

/**
 * Nearest first, by how far there is to *walk*.
 *
 * Anything an agent goes to is chosen this way: the coffee machine it uses, the bin it takes the
 * paper to, the mug it clears away. Straight-line distance is not good enough - a bin three tiles
 * away through a wall would beat one eight tiles along the corridor, and the agent would set off
 * around the building past three closer ones.
 *
 * Measuring is a pathfind each, so only the closest few by straight line are measured and the
 * rest keep that cheap order behind them. Anything unreachable sorts last rather than being
 * dropped, because the caller may still find a way to it.
 */
function nearestFirst<T extends { col: number; row: number; type?: string }>(
  list: T[], ch: Character, ctx?: IdleActionContext,
): T[] {
  const byLine = [...list].sort((a, b) => tileDistance(a, ch) - tileDistance(b, ch))
  if (!ctx || byLine.length < 2) return byLine
  const measured = byLine.slice(0, NEAREST_PATH_CANDIDATES).map((item) => {
    const footprint = item.type ? ctx.getFurnitureFootprint(item.type) : null
    // a stray mug on the floor has no uid or type; it stands in as a one tile piece of furniture
    const asFurniture: PlacedFurniture = { uid: '', type: item.type ?? '', col: item.col, row: item.row }
    const adj = findAdjacentWalkableTile(
      asFurniture, footprint?.w ?? 1, footprint?.h ?? 1,
      ctx.tileMap, ctx.blockedTiles, item.type ? useSideFor(item.type) : 'front',
    )
    if (!adj) return { item, steps: Infinity }
    if (adj.col === ch.tileCol && adj.row === ch.tileRow) return { item, steps: 0 }
    const path = ctx.findPathUnblocked(ch, adj.col, adj.row)
    return { item, steps: path.length === 0 ? Infinity : path.length }
  })
  measured.sort((a, b) => a.steps - b.steps)
  return [...measured.map((m) => m.item), ...byLine.slice(NEAREST_PATH_CANDIDATES)]
}

/** Check if a character's current seat is in the given zone type */
function isCharacterInZone(ch: Character, zoneType: string, ctx: IdleActionContext): boolean {
  if (!ctx.zones || !ch.seatId) return false
  const seat = ctx.seats.get(ch.seatId)
  if (!seat) return false
  const idx = seat.seatRow * ctx.layoutCols + seat.seatCol
  return ctx.zones[idx] === zoneType
}

/** Find a walkable tile adjacent to the given furniture piece */
type UseSide = 'front' | 'back' | 'left' | 'right'

/** Which side of a furniture item characters should stand on: explicit `useSide`, else its rotation orientation, else front. */
function useSideFor(type: string): UseSide {
  const entry = getCatalogEntry(type)
  if (entry?.useSide) return entry.useSide
  const o = entry?.orientation
  if (o === 'back' || o === 'left' || o === 'right') return o
  return 'front'
}

/**
 * Pick a walkable tile next to `furniture`. Tiles on `preferredSide` win when any is
 * free; otherwise any free side (so a coffee machine against a wall still works).
 * 'front' = below the footprint (sprites are drawn facing the viewer).
 */
function findAdjacentWalkableTile(
  furniture: PlacedFurniture,
  footprintW: number,
  footprintH: number,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
  preferredSide: UseSide = 'front',
): { col: number; row: number; facingDir: Direction } | null {
  const candidates: Array<{ col: number; row: number; facingDir: Direction; side: UseSide }> = []
  const rows = tileMap.length
  const cols = rows > 0 ? tileMap[0].length : 0
  // Half-tile items have fractional col/row (e.g. 3.5); tile lookups need whole tiles or
  // tileMap[4.5] is undefined and the next index throws (this crashed the game loop before the guard).
  const walkable = (c: number, r: number) => r >= 0 && r < rows && c >= 0 && c < cols
    && !blockedTiles.has(`${c},${r}`) && tileMap[r] !== undefined && tileMap[r][c] > 0 && tileMap[r][c] !== 8
  furniture = { ...furniture, col: Math.floor(furniture.col), row: Math.floor(furniture.row) }

  // Check tiles around the furniture footprint
  for (let dc = 0; dc < footprintW; dc++) {
    // Below furniture
    const belowRow = furniture.row + footprintH
    const belowCol = furniture.col + dc
    if (walkable(belowCol, belowRow)) candidates.push({ col: belowCol, row: belowRow, facingDir: Direction.UP, side: 'front' })
    // Above furniture
    const aboveRow = furniture.row - 1
    const aboveCol = furniture.col + dc
    if (walkable(aboveCol, aboveRow)) candidates.push({ col: aboveCol, row: aboveRow, facingDir: Direction.DOWN, side: 'back' })
  }
  for (let dr = 0; dr < footprintH; dr++) {
    // Left of furniture
    const leftCol = furniture.col - 1
    const leftRow = furniture.row + dr
    if (walkable(leftCol, leftRow)) candidates.push({ col: leftCol, row: leftRow, facingDir: Direction.RIGHT, side: 'left' })
    // Right of furniture
    const rightCol = furniture.col + footprintW
    const rightRow = furniture.row + dr
    if (walkable(rightCol, rightRow)) candidates.push({ col: rightCol, row: rightRow, facingDir: Direction.LEFT, side: 'right' })
  }

  // Something standing on a desk can be reached across it. A mug on the back row of a desk that is
  // against a wall has no free tile beside it at all, but anyone in front of the desk can lean over
  // and take it, which is what it looks like from the outside.
  if (candidates.length === 0 && getCatalogEntry(furniture.type)?.canPlaceOnSurfaces) {
    const overable = (c: number, r: number) => r >= 0 && r < rows && c >= 0 && c < cols
      && tileMap[r] !== undefined && tileMap[r][c] > 0 && tileMap[r][c] !== 8 && blockedTiles.has(`${c},${r}`)
    for (let dc = 0; dc < footprintW; dc++) {
      const col = furniture.col + dc
      if (overable(col, furniture.row + footprintH) && walkable(col, furniture.row + footprintH + 1)) {
        candidates.push({ col, row: furniture.row + footprintH + 1, facingDir: Direction.UP, side: 'front' })
      }
      if (overable(col, furniture.row - 1) && walkable(col, furniture.row - 2)) {
        candidates.push({ col, row: furniture.row - 2, facingDir: Direction.DOWN, side: 'back' })
      }
    }
    for (let dr = 0; dr < footprintH; dr++) {
      const row = furniture.row + dr
      if (overable(furniture.col - 1, row) && walkable(furniture.col - 2, row)) {
        candidates.push({ col: furniture.col - 2, row, facingDir: Direction.RIGHT, side: 'left' })
      }
      if (overable(furniture.col + footprintW, row) && walkable(furniture.col + footprintW + 1, row)) {
        candidates.push({ col: furniture.col + footprintW + 1, row, facingDir: Direction.LEFT, side: 'right' })
      }
    }
  }

  if (candidates.length === 0) return null
  const preferred = candidates.filter(c => c.side === preferredSide)
  const pool = preferred.length > 0 ? preferred : candidates
  const pick = pool[Math.floor(Math.random() * pool.length)]
  return { col: pick.col, row: pick.row, facingDir: pick.facingDir }
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
  ctx.onIdleEvent?.('conversation', [ch.id, partner.id])
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
  /** Per-tile zone array (parallel to layout tiles), or undefined if no zones */
  zones?: Array<string | null>
  /** Number of columns in the layout grid (needed for zone index lookup) */
  layoutCols: number
  /** Callback to get catalog footprint for a furniture type */
  getFurnitureFootprint: (type: string) => { w: number; h: number } | null
  /** Find path with own seat unblocked */
  findPathUnblocked: (ch: Character, toCol: number, toRow: number) => Array<{ col: number; row: number }>
  /** Callback for personality tracking of idle events */
  onIdleEvent?: (type: string, agentIds: number[]) => void
  /** The office's own clock in seconds, which is what props age by - not the wall clock, or a
   * simulation that fast-forwards sees mugs that never get old enough to clear away */
  nowSec: number
  /** Dynamic items feature enabled (View options) */
  dynamicItems: boolean
  /** Props currently lying around the office */
  props: PlacedProp[]
  /** Remove a prop (picked up). Returns it, or null if it was already gone. */
  takeProp: (uid: string) => PlacedProp | null
  /** Has this plant gone long enough without water to be worth a trip? */
  isPlantThirsty: (uid: string) => boolean
  /** How dry a plant is: under 1 it is fine, 1 and over it wants water */
  plantDryness: (uid: string) => number
  /** Remember that a plant has just been watered */
  markPlantWatered: (uid: string) => void
  /** Cups and plates placed in the editor, which agents may also clear away */
  tidyableFurniture: PlacedFurniture[]
  /** Clear one of those away (hidden until the layout reloads), returning what was carried off */
  takeLayoutItem: (uid: string) => { kind: string; color: FloorColor | null } | null
  /** Food props next to the character turn into their "empty" variant (finished eating) */
  finishFoodNear: (ch: Character) => void
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

  // Filter eligible actions (weight may be boosted situationally)
  const eligible: Array<{ type: IdleActionType; weight: number }> = []
  for (const entry of IDLE_ACTION_REGISTRY) {
    if (entry.needsPartner && idlePartnerCount === 0) continue
    if (entry.needsFurniture && !hasInterestingFurniture) continue
    if (entry.needsZone && !isCharacterInZone(ch, entry.needsZone, ctx)) continue
    if (entry.needsToilet) {
      if (findFreeToilets(ch, ctx).length === 0) continue
      eligible.push({ type: entry.type, weight: entry.weight * hourMultiplier(TOILET_HOURS) })
      continue
    }
    if (entry.needsDynamicItems) {
      if (!ctx.dynamicItems || ch.heldItem !== null) continue
      if (entry.type === IdleActionType.FETCH_ITEM && (ctx.props.length >= MAX_PROPS || findFetchableUtensils(ctx, 'break').length === 0)) continue
      if (entry.type === IdleActionType.WATER_PLANTS) {
        if (!findWateringCan(ctx)) continue
        const urge = wateringUrge(ch, ctx)
        if (urge === 0) continue
        eligible.push({ type: entry.type, weight: urge })
        continue
      }
      if (entry.type === IdleActionType.TIDY_UP) {
        if (findStaleProps(ctx).length === 0) continue
        // Walking past a stray mug/plate: much more likely to grab it
        if (hasStalePropNearby(ch, ctx)) { eligible.push({ type: entry.type, weight: TIDY_NEAR_WEIGHT }); continue }
      }
    }
    // The office day shapes when people eat and drink
    let weight = entry.weight
    if (entry.type === IdleActionType.EATING) weight *= hourMultiplier(OFFICE_MEAL_HOURS)
    else if (entry.type === IdleActionType.FETCH_ITEM) weight *= hourMultiplier(OFFICE_DRINK_HOURS)
    eligible.push({ type: entry.type, weight })
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
      // Wander uses existing updateCharacter logic - no extra init needed
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
        ctx.onIdleEvent?.('conversation', [ch.id, partner.id])
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

    case IdleActionType.USE_TOILET:
      return startUseToilet(ch, ctx)

    case IdleActionType.VISIT_FURNITURE: {
      // Pick a random interesting furniture piece - try several until one works
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

        const adj = findAdjacentWalkableTile(target, fw, fh, ctx.tileMap, ctx.blockedTiles, useSideFor(target.type))
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
          // Already at the tile - start visiting immediately
          ch.dir = adj.facingDir
          ch.conversationPhase = 'talking' // "talking" phase = standing at furniture
        }
        // Store facing direction for when we arrive (use preConversationDir to avoid
        // corrupting wanderTimer which is a float timer, not a Direction)
        ch.preConversationDir = adj.facingDir
        const entry = getCatalogEntry(target.type)
        const label = entry?.label ?? target.type.replace(/_/g, ' ').toLowerCase()
        logIdle(ch, `going to look at the ${label}`)
        ctx.onIdleEvent?.('furniture_visit', [ch.id])
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

    case IdleActionType.EATING: {
      // Eating happens at the character's current kitchen zone seat
      if (!ch.seatId) return false
      const seat = ctx.seats.get(ch.seatId)
      if (!seat) return false

      // Dynamic items: fetch food (a plate from the fridge...) first, then come back and eat it.
      // 'leaving' marks the fetch leg; updateEating switches to 'approaching' once the food is in hand.
      if (ctx.dynamicItems && ch.heldItem === null && ctx.props.length < MAX_PROPS) {
        const food = pickRandom(findFetchableUtensils(ctx, 'food'))
        if (food && startFetch(ch, food, ctx)) {
          ch.conversationPhase = 'leaving'
          showItemBubble(ch, food.type)
          logIdle(ch, `going to get some ${food.label.toLowerCase()}`)
          ctx.onIdleEvent?.('eating', [ch.id])
          return true
        }
      }

      ch.idleActionTimer = randomRange(EAT_MIN_DURATION_SEC, EAT_MAX_DURATION_SEC)

      // Check if already at seat
      if (ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
        ch.conversationPhase = 'talking'
        ch.state = CharacterState.SIT_IDLE
        ch.dir = seat.facingDir
        ch.frame = 0
        ch.frameTimer = 0
        ch.bubbleType = 'idle_eat'
        ch.bubbleTimer = ch.idleActionTimer + 1 // keep showing for full duration
      } else {
        // Walk back to seat first
        ch.conversationPhase = 'approaching'
        const path = ctx.findPathUnblocked(ch, seat.seatCol, seat.seatRow)
        if (path.length > 0) {
          ch.path = path
          ch.moveProgress = 0
          ch.state = CharacterState.WALK
          ch.frame = 0
          ch.frameTimer = 0
        } else {
          return false // can't reach seat
        }
      }
      logIdle(ch, 'having a meal in the kitchen')
      ctx.onIdleEvent?.('eating', [ch.id])
      return true
    }

    case IdleActionType.FETCH_ITEM: {
      // Walk to a drink's origin (coffee machine...), wait, walk away carrying it
      const choice = pickBreakItem(findFetchableUtensils(ctx, 'break'))
      if (!choice || !startFetch(ch, choice, ctx)) return false
      ch.conversationPhase = 'approaching'
      showItemBubble(ch, choice.type)
      logIdle(ch, `going to get a ${choice.label.toLowerCase()}`)
      return true
    }

    case IdleActionType.TIDY_UP: {
      // Pick up a stray item and carry it to a sink
      const prop = nearestFirst(findStaleProps(ctx), ch, ctx)[0] ?? null
      if (!prop) return false
      const propAsFurniture: PlacedFurniture = { uid: prop.uid, type: '', col: prop.col, row: prop.row }
      if (!walkToFurniture(ch, propAsFurniture, ctx)) return false
      ch.itemTargetUid = prop.uid
      ch.conversationPhase = 'approaching'
      showTidyBubble(ch)
      logIdle(ch, `going to pick up a stray ${utensilLabel(prop.kind)}`)
      return true
    }

    case IdleActionType.WATER_PLANTS: {
      // Fetch the can from the tap, then do the rounds of the thirsty plants
      const can = findWateringCan(ctx)
      if (!can || !startFetch(ch, can, ctx)) return false
      ch.conversationPhase = 'leaving' // the filling leg
      ch.wateringLeft = 0
      showItemBubble(ch, can.type)
      logIdle(ch, 'going to fill the watering can')
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
    case IdleActionType.EATING:
      return updateEating(ch, dt, ctx)
    case IdleActionType.FETCH_ITEM:
      return updateFetchItem(ch, dt, ctx)
    case IdleActionType.TIDY_UP:
      return updateTidyUp(ch, dt, ctx)
    case IdleActionType.USE_TOILET:
      return updateUseToilet(ch, dt, ctx)
    case IdleActionType.WATER_PLANTS:
      return updateWaterPlants(ch, dt, ctx)
    default:
      return false
  }
}

// ── Dynamic items: update loops ────────────────────────────────

function updateFetchItem(ch: Character, dt: number, ctx: IdleActionContext): boolean {
  if (!ctx.dynamicItems) { ch.itemTargetUid = null; ch.fetchOriginUid = null; clearItemBubble(ch); clearIdleAction(ch); return false }
  if (ch.conversationPhase === 'approaching') {
    // Arrived, but the machine may be in use: stand and wait rather than brewing over someone
    if (arrivedAtFurniture(ch) && !someoneIsUsing(ch, ctx)) ch.conversationPhase = 'talking'
    return true
  }
  if (ch.conversationPhase === 'talking') {
    ch.idleActionTimer -= dt
    if (ch.idleActionTimer <= 0) {
      ch.heldItem = ch.itemTargetUid
      ch.itemTargetUid = null
      ch.fetchOriginUid = null // the machine is free for whoever is waiting
      clearItemBubble(ch)
      logIdle(ch, `got a ${utensilLabel(ch.heldItem)}`)
      clearIdleAction(ch)
      return false // back to seat, carrying the item
    }
    return true
  }
  return false
}

/**
 * Watering the plants: fill the can at the tap, walk the thirsty plants in turn, and go back for
 * more water when the can runs dry. When nothing is left to water the can goes back where it came
 * from rather than being left on a desk.
 */
function updateWaterPlants(ch: Character, dt: number, ctx: IdleActionContext): boolean {
  if (!ctx.dynamicItems) { ch.heldItem = null; ch.itemTargetUid = null; ch.fetchOriginUid = null; clearItemBubble(ch); clearIdleAction(ch); return false }

  // At the tap: wait your turn, fill up, then head for the nearest thirsty plant
  if (ch.conversationPhase === 'leaving') {
    if (!arrivedAtFurniture(ch)) return true
    if (someoneIsUsing(ch, ctx)) return true
    ch.idleActionTimer -= dt
    if (ch.idleActionTimer > 0) return true
    const canType = ch.itemTargetUid ?? ch.heldItem
    ch.heldItem = canType
    ch.itemTargetUid = null
    ch.fetchOriginUid = null // filled; the tap is free again
    ch.wateringLeft = getCatalogEntry(canType ?? '')?.utensilUses ?? WATERING_CAN_DEFAULT_USES
    if (startWateringNextPlant(ch, ctx)) return true
    return startReturningCan(ch, ctx) // nothing to water after all
  }

  // Walking to a plant, then standing over it
  if (ch.conversationPhase === 'approaching') {
    if (!arrivedAtFurniture(ch)) return true
    ch.idleActionTimer -= dt
    if (ch.idleActionTimer > 0) return true
    if (ch.itemTargetUid) {
      ctx.markPlantWatered(ch.itemTargetUid)
      logIdle(ch, 'watered a plant')
      ch.itemTargetUid = null
      ch.wateringLeft = Math.max(0, ch.wateringLeft - 1)
    }
    if (ch.wateringLeft > 0 && startWateringNextPlant(ch, ctx)) return true
    return startReturningCan(ch, ctx) // out of water, or out of plants
  }

  // Back at the tap with the can
  if (ch.conversationPhase === 'talking') {
    if (!arrivedAtFurniture(ch)) return true
    ch.idleActionTimer -= dt
    if (ch.idleActionTimer > 0) return true
    if (findThirstyPlants(ch, ctx).length > 0) {
      ch.wateringLeft = getCatalogEntry(ch.heldItem ?? '')?.utensilUses ?? WATERING_CAN_DEFAULT_USES
      logIdle(ch, 'refilling the watering can')
      if (startWateringNextPlant(ch, ctx)) return true
    }
    ch.heldItem = null // the can goes back where it lives
    ch.fetchOriginUid = null
    clearItemBubble(ch)
    logIdle(ch, 'put the watering can back')
    clearIdleAction(ch)
    return false
  }
  return false
}

/** Head for the nearest plant that wants water; false when there is none to walk to */
function startWateringNextPlant(ch: Character, ctx: IdleActionContext): boolean {
  for (const plant of findThirstyPlants(ch, ctx)) {
    if (!walkToFurniture(ch, plant, ctx)) continue
    ch.itemTargetUid = plant.uid ?? null
    ch.conversationPhase = 'approaching'
    ch.idleActionTimer = WATER_PLANT_SEC
    return true
  }
  return false
}

/** Carry the can back to where it was filled */
function startReturningCan(ch: Character, ctx: IdleActionContext): boolean {
  const can = findWateringCan(ctx)
  for (const origin of can ? nearestFirst(can.origins, ch, ctx) : []) {
    if (!walkToFurniture(ch, origin, ctx)) continue
    ch.fetchOriginUid = origin.uid ?? null
    ch.conversationPhase = 'talking'
    ch.idleActionTimer = ITEM_DISPOSE_SEC
    return true
  }
  ch.heldItem = null // nowhere to put it back, so do not carry it round the office forever
  clearItemBubble(ch)
  clearIdleAction(ch)
  return false
}

/**
 * Someone else is at this machine right now, rather than merely heading for it.
 *
 * "At it" means still holding the claim: a fetcher waiting for their drink, or someone at the
 * fridge collecting a meal. The claim is dropped the moment the item is handed over, so sitting
 * down to eat does not keep the fridge busy.
 */
function someoneIsUsing(ch: Character, ctx: IdleActionContext): boolean {
  if (!ch.fetchOriginUid) return false
  for (const other of ctx.characters.values()) {
    if (other.id === ch.id || other.fetchOriginUid !== ch.fetchOriginUid) continue
    const collecting = other.idleAction === IdleActionType.EATING
      ? other.conversationPhase === 'leaving'
      : other.conversationPhase === 'talking'
    if (collecting) return true
  }
  return false
}

function updateTidyUp(ch: Character, dt: number, ctx: IdleActionContext): boolean {
  if (!ctx.dynamicItems) { ch.itemTargetUid = null; clearItemBubble(ch); clearIdleAction(ch); return false }
  if (ch.conversationPhase === 'approaching') {
    if (!arrivedAtFurniture(ch)) return true
    const uid = ch.itemTargetUid
    const taken = uid ? (ctx.takeProp(uid) ?? ctx.takeLayoutItem(uid)) : null
    ch.itemTargetUid = null
    if (!taken) { clearItemBubble(ch); clearIdleAction(ch); return false } // someone else took it
    const prop = { kind: taken.kind, color: taken.color ?? null }
    ch.heldItem = prop.kind
    ch.itemColor = prop.color
    // Carry it to the nearest reachable disposal furniture (from the utensil's catalog entry)
    for (const target of findDisposalFor(prop.kind, ch, ctx)) {
      if (walkToFurniture(ch, target, ctx)) {
        ch.conversationPhase = 'leaving'
        ch.idleActionTimer = ITEM_DISPOSE_SEC
        logIdle(ch, `carrying the ${utensilLabel(prop.kind)} to the ${(getCatalogEntry(target.type)?.label ?? 'sink').toLowerCase()}`)
        return true
      }
    }
    // Nothing reachable - keep the item; it gets placed on the desk when seated
    clearItemBubble(ch)
    clearIdleAction(ch)
    return false
  }
  if (ch.conversationPhase === 'leaving') {
    if (!arrivedAtFurniture(ch)) return true
    ch.idleActionTimer -= dt
    if (ch.idleActionTimer <= 0) {
      logIdle(ch, `disposed of the ${utensilLabel(ch.heldItem)}`)
      ch.heldItem = null
      ch.itemColor = null
      clearItemBubble(ch)
      clearIdleAction(ch)
      return false
    }
    return true
  }
  return false
}

/** Cycle a single character's conversation bubble independently.
 *  Uses wanderTimer as a gap cooldown between bubbles. */
function cycleConversationBubble(ch: Character, dt: number): void {
  if (ch.bubbleType === 'permission') return // don't override permission bubbles

  if (ch.bubbleType === 'idle_chat') {
    // Bubble is currently showing - main loop handles its timer countdown
    return
  }

  // No bubble showing - count down the gap timer (stored in wanderTimer)
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

/** Cycle meeting bubbles - longer show/gap durations than conversations */
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

/** Get all characters currently in the same meeting (matched by meetingGroupId). */
function getMeetingParticipants(ch: Character, ctx: IdleActionContext): Character[] {
  const participants: Character[] = []
  for (const [, other] of ctx.characters) {
    if (other.idleAction === IdleActionType.MEETING && other.id !== ch.id && other.meetingGroupId === ch.meetingGroupId) {
      participants.push(other)
    }
  }
  return participants
}

function updateMeeting(ch: Character, dt: number, ctx: IdleActionContext): boolean {
  if (ch.conversationPhase === 'approaching') {
    // Wait for walk to meeting seat
    if (ch.state !== CharacterState.WALK && ch.path.length === 0) {
      // Arrived - sit down facing forward (seat's facing direction)
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
      // Not enough participants - end meeting for this character
      logIdle(ch, 'meeting ended (not enough participants)')
      ch.bubbleType = null
      ch.bubbleTimer = 0
      clearIdleAction(ch)
      return false
    }

    if (ch.idleActionTimer <= 0) {
      // Meeting time's up - end for ALL remaining participants simultaneously
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

  // Partner gone or became active - disengage
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
        // Both arrived - face each other
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
      // Conversation done - disengage both and clear bubbles
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
      // No bubble - just a brief pause before doing something else
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

function updateEating(ch: Character, dt: number, ctx: IdleActionContext): boolean {
  if (ch.conversationPhase === 'leaving') {
    // Fetch leg: wait at the origin, receive the food, then head back to the kitchen seat
    if (!arrivedAtFurniture(ch)) return true
    if (someoneIsUsing(ch, ctx)) return true // someone else is at the fridge: wait
    ch.idleActionTimer -= dt
    if (ch.idleActionTimer > 0) return true
    ch.heldItem = ch.itemTargetUid
    ch.itemTargetUid = null
    ch.fetchOriginUid = null // done at the fridge; it should not read as taken while they eat
    clearItemBubble(ch)
    logIdle(ch, `got some ${utensilLabel(ch.heldItem)}`)
    const seat = ch.seatId ? ctx.seats.get(ch.seatId) : null
    if (!seat) { clearIdleAction(ch); return false }
    ch.idleActionTimer = randomRange(EAT_MIN_DURATION_SEC, EAT_MAX_DURATION_SEC)
    ch.conversationPhase = 'approaching'
    if (ch.tileCol !== seat.seatCol || ch.tileRow !== seat.seatRow) {
      const path = ctx.findPathUnblocked(ch, seat.seatCol, seat.seatRow)
      if (path.length === 0) { clearIdleAction(ch); return false } // seat unreachable - keep the plate, place it wherever we sit
      ch.path = path
      ch.moveProgress = 0
      ch.state = CharacterState.WALK
      ch.frame = 0
      ch.frameTimer = 0
    }
    return true
  }

  if (ch.conversationPhase === 'approaching') {
    // Wait for walk to seat
    if (ch.state !== CharacterState.WALK && ch.path.length === 0) {
      // Arrived - sit down and start eating
      ch.conversationPhase = 'talking'
      ch.state = CharacterState.SIT_IDLE
      ch.frame = 0
      ch.frameTimer = 0
      ch.bubbleType = 'idle_eat'
      ch.bubbleTimer = ch.idleActionTimer + 1 // keep showing for full duration
    }
    return true
  }

  if (ch.conversationPhase === 'talking') {
    ch.idleActionTimer -= dt

    if (ch.idleActionTimer <= 0) {
      logIdle(ch, 'finished eating')
      ctx.finishFoodNear(ch)
      ch.bubbleType = null
      ch.bubbleTimer = 0
      clearIdleAction(ch)
      return false
    }
    return true
  }

  return false
}

/** Clear idle action state and prepare character to return to seat */
/** Toilets nobody is using and nobody else is on their way to. */
function findFreeToilets(ch: Character, ctx: IdleActionContext): PlacedFurniture[] {
  const taken = new Set<string>()
  for (const other of ctx.characters.values()) {
    if (other.id !== ch.id && other.itemTargetUid) taken.add(other.itemTargetUid)
  }
  const free: PlacedFurniture[] = []
  for (const f of ctx.furniture) {
    if (!f.uid || taken.has(f.uid)) continue
    if (!getCatalogEntry(f.type)?.privacySeat) continue
    const seat = ctx.seats.get(f.uid)
    if (!seat) continue
    let occupied = false
    for (const other of ctx.characters.values()) {
      if (other.tileCol === seat.seatCol && other.tileRow === seat.seatRow) { occupied = true; break }
    }
    if (!occupied) free.push(f)
  }
  return nearestFirst(free, ch, ctx)
}

/**
 * Go to the toilet, and wash your hands afterwards.
 *
 * A toilet is borrowed as a seat for the duration - which is what unblocks the tile for whoever is
 * walking to it, and what tells the room to shut and lock its doors - and given back on the way to
 * the sink, so they head home to their own desk when they are done.
 */
function startUseToilet(ch: Character, ctx: IdleActionContext): boolean {
  for (const toilet of findFreeToilets(ch, ctx)) {
    const seat = ctx.seats.get(toilet.uid!)
    if (!seat) continue
    const previousSeat = ch.seatId
    ch.seatId = toilet.uid!
    const path = ctx.findPathUnblocked(ch, seat.seatCol, seat.seatRow)
    const alreadyThere = ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow
    if (path.length === 0 && !alreadyThere) { ch.seatId = previousSeat; continue }

    ch.preToiletSeatId = previousSeat
    ch.itemTargetUid = toilet.uid!
    ch.idleActionTimer = randomRange(TOILET_SIT_MIN_SEC, TOILET_SIT_MAX_SEC)
    ch.conversationPhase = 'approaching'
    if (path.length > 0) {
      ch.path = path
      ch.moveProgress = 0
      ch.state = CharacterState.WALK
      ch.frame = 0
      ch.frameTimer = 0
    }
    logIdle(ch, 'off to the toilet')
    return true
  }
  return false
}

/** Give the toilet back and head for the nearest sink, or straight home if there is not one. */
function leaveToiletForSink(ch: Character, ctx: IdleActionContext): void {
  ch.seatId = ch.preToiletSeatId ?? null
  ch.preToiletSeatId = null
  ch.itemTargetUid = null
  ch.state = CharacterState.IDLE
  ch.frame = 0
  ch.frameTimer = 0

  for (const sink of nearestFirst(findFurnitureByAssetName(ctx, 'SINK'), ch, ctx)) {
    const fp = ctx.getFurnitureFootprint(sink.type)
    const adj = findAdjacentWalkableTile(sink, fp?.w ?? 1, fp?.h ?? 1, ctx.tileMap, ctx.blockedTiles, useSideFor(sink.type))
    if (!adj) continue
    const path = ctx.findPathUnblocked(ch, adj.col, adj.row)
    if (path.length === 0 && (ch.tileCol !== adj.col || ch.tileRow !== adj.row)) continue
    ch.path = path
    ch.moveProgress = 0
    if (path.length > 0) { ch.state = CharacterState.WALK; ch.frame = 0; ch.frameTimer = 0 }
    ch.conversationPhase = 'leaving'
    ch.idleActionTimer = -1 // the wash has not started; it begins on arrival
    return
  }
  // no sink to be found: that is the end of it
  clearIdleAction(ch)
}

function updateUseToilet(ch: Character, dt: number, ctx: IdleActionContext): boolean {
  if (ch.conversationPhase === 'approaching') {
    if (ch.state !== CharacterState.WALK && ch.path.length === 0) {
      const seat = ch.seatId ? ctx.seats.get(ch.seatId) : null
      ch.dir = seat ? seat.facingDir : ch.dir
      ch.state = CharacterState.SIT_IDLE
      ch.frame = 0
      ch.frameTimer = 0
      ch.conversationPhase = 'talking'
    }
    return true
  }

  if (ch.conversationPhase === 'talking') {
    ch.idleActionTimer -= dt
    if (ch.idleActionTimer <= 0) leaveToiletForSink(ch, ctx)
    return ch.idleAction === IdleActionType.USE_TOILET
  }

  if (ch.conversationPhase === 'leaving') {
    if (ch.state === CharacterState.WALK || ch.path.length > 0) return true
    if (ch.idleActionTimer < 0) {
      ch.idleActionTimer = WASH_HANDS_SEC
      ch.state = CharacterState.IDLE
      ch.frame = 0
      ch.bubbleType = 'idle_tidy'
      ch.bubbleTimer = WASH_HANDS_SEC + 1
      return true
    }
    ch.idleActionTimer -= dt
    if (ch.idleActionTimer <= 0) {
      ch.bubbleType = null
      ch.bubbleTimer = 0
      logIdle(ch, 'washed their hands')
      clearIdleAction(ch)
      return false
    }
    return true
  }

  clearIdleAction(ch)
  return false
}

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
  ch.fetchOriginUid = null
  ch.meetingGroupId = null
  ch.currentTool = null
  // Don't clear bubbleType here - let it fade naturally or get cleared by the caller
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
 *  Only removes THIS character - others continue if enough remain.
 *  If fewer than MEETING_MIN_PARTICIPANTS remain, ends meeting for all. */
export function disengageMeeting(ch: Character, ctx: IdleActionContext): void {
  if (ch.idleAction !== IdleActionType.MEETING) return

  const groupId = ch.meetingGroupId
  clearIdleAction(ch)
  ch.bubbleType = null
  ch.bubbleTimer = 0
  ch.state = CharacterState.IDLE
  ch.frame = 0

  // Check remaining participants in the same meeting group
  const remaining: Character[] = []
  for (const [, other] of ctx.characters) {
    if (other.id !== ch.id && other.idleAction === IdleActionType.MEETING && other.meetingGroupId === groupId) {
      remaining.push(other)
    }
  }

  // If not enough remain in this group, end meeting for all in this group
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
