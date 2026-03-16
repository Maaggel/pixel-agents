export {
  TILE_SIZE,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_COLS,
  MAX_ROWS,
  MATRIX_EFFECT_DURATION_SEC as MATRIX_EFFECT_DURATION,
} from '../constants.js'

export const TileType = {
  WALL: 0,
  FLOOR_1: 1,
  FLOOR_2: 2,
  FLOOR_3: 3,
  FLOOR_4: 4,
  FLOOR_5: 5,
  FLOOR_6: 6,
  FLOOR_7: 7,
  VOID: 8,
} as const
export type TileType = (typeof TileType)[keyof typeof TileType]

/** Per-tile color settings for floor pattern colorization */
export interface FloorColor {
  /** Hue: 0-360 in colorize mode, -180 to +180 in adjust mode */
  h: number
  /** Saturation: 0-100 in colorize mode, -100 to +100 in adjust mode */
  s: number
  /** Brightness -100 to 100 */
  b: number
  /** Contrast -100 to 100 */
  c: number
  /** When true, use Photoshop-style Colorize (grayscale → fixed HSL). Default: adjust mode. */
  colorize?: boolean
}

export const CharacterState = {
  IDLE: 'idle',
  WALK: 'walk',
  TYPE: 'type',
  SIT_IDLE: 'sit_idle',
  SIT_WAIT: 'sit_wait',
  BUILD: 'build',
} as const
export type CharacterState = (typeof CharacterState)[keyof typeof CharacterState]

export const IdleActionType = {
  WANDER: 'wander',
  CONVERSATION: 'conversation',
  VISIT_FURNITURE: 'visit_furniture',
  STAND_AND_THINK: 'stand_and_think',
  MEETING: 'meeting',
  EATING: 'eating',
} as const
export type IdleActionType = (typeof IdleActionType)[keyof typeof IdleActionType]

export const Direction = {
  DOWN: 0,
  LEFT: 1,
  RIGHT: 2,
  UP: 3,
} as const
export type Direction = (typeof Direction)[keyof typeof Direction]

/** 2D array of hex color strings (or '' for transparent). [row][col] */
export type SpriteData = string[][]

export interface Seat {
  /** Chair furniture uid */
  uid: string
  /** Tile col where agent sits */
  seatCol: number
  /** Tile row where agent sits */
  seatRow: number
  /** Direction character faces when sitting (toward adjacent desk) */
  facingDir: Direction
  assigned: boolean
}

export interface FurnitureInstance {
  sprite: SpriteData
  /** Grid column of top-left footprint tile (for work cycle proximity check) */
  col: number
  /** Grid row of top-left footprint tile */
  row: number
  /** Footprint width in tiles */
  footprintW: number
  /** Footprint height in tiles */
  footprintH: number
  /** Pixel x (top-left) */
  x: number
  /** Pixel y (top-left) */
  y: number
  /** Y value used for depth sorting (typically bottom edge) */
  zY: number
  /** Stable furniture uid from PlacedFurniture (for meeting cycle state tracking) */
  uid?: string
  /** Cycle frame sprites for meeting animation. Present when catalog entry has meetingCycle. */
  meetingCycleSprites?: SpriteData[]
  randomMeetingCycle?: boolean
  /** Interval bounds in seconds. Undefined = use default. */
  meetingCycleIntervalMin?: number
  meetingCycleIntervalMax?: number
  /** Whether this furniture is inside or adjacent to a meeting zone tile. */
  isNearMeetingZone?: boolean
  /** Current cycle frame index (mutated by game loop). */
  meetingCycleIdx?: number
  /** Sprite to render instead of base sprite when meeting is active. Set/cleared by game loop. */
  activeMeetingSprite?: SpriteData | null
  /** Cycle frame sprites for work animation. Present when catalog entry has workCycle. */
  workCycleSprites?: SpriteData[]
  randomWorkCycle?: boolean
  workCycleIntervalMin?: number
  workCycleIntervalMax?: number
  workCycleIdx?: number
  /** Sprite to render instead of base sprite when an active agent is looking at this. Set/cleared by game loop. */
  activeWorkSprite?: SpriteData | null
  /** Cycle frame sprites for interaction animation. Present when catalog entry has interactionCycle. */
  interactionCycleSprites?: SpriteData[]
  randomInteractionCycle?: boolean
  interactionCycleIntervalMin?: number
  interactionCycleIntervalMax?: number
  interactionCycleIdx?: number
  /** Sprite to render instead of base sprite when a character is interacting with this. Set/cleared by game loop. */
  activeInteractionSprite?: SpriteData | null
  /** Cycle frame sprites for idle animation. Always runs when no other cycle is active. */
  idleCycleSprites?: SpriteData[]
  randomIdleCycle?: boolean
  idleCycleIntervalMin?: number
  idleCycleIntervalMax?: number
  idleCycleIdx?: number
  /** Sprite to render when no work/interaction/meeting cycle is active. Set/cleared by game loop. */
  activeIdleSprite?: SpriteData | null
}

export interface ToolActivity {
  toolId: string
  status: string
  done: boolean
  permissionWait?: boolean
}

export const FurnitureType = {
  // Original hand-drawn sprites (kept for backward compat)
  DESK: 'desk',
  BOOKSHELF: 'bookshelf',
  PLANT: 'plant',
  COOLER: 'cooler',
  WHITEBOARD: 'whiteboard',
  CHAIR: 'chair',
  PC: 'pc',
  LAMP: 'lamp',
} as const
export type FurnitureType = (typeof FurnitureType)[keyof typeof FurnitureType]

export const ZoneType = {
  WORKSPACE: 'workspace',
  KITCHEN: 'kitchen',
  REST_AREA: 'rest_area',
  MEETING_ROOM: 'meeting_room',
} as const
export type ZoneType = (typeof ZoneType)[keyof typeof ZoneType]

export const EditTool = {
  TILE_PAINT: 'tile_paint',
  WALL_PAINT: 'wall_paint',
  FURNITURE_PLACE: 'furniture_place',
  FURNITURE_PICK: 'furniture_pick',
  SELECT: 'select',
  EYEDROPPER: 'eyedropper',
  ERASE: 'erase',
  ZONE_PAINT: 'zone_paint',
} as const
export type EditTool = (typeof EditTool)[keyof typeof EditTool]

export interface FurnitureCatalogEntry {
  type: string // FurnitureType enum or asset ID
  label: string
  footprintW: number
  footprintH: number
  sprite: SpriteData
  isDesk: boolean
  category?: string
  /** Orientation from rotation group: 'front' | 'back' | 'left' | 'right' */
  orientation?: string
  /** Whether this item can be placed on top of desk/table surfaces */
  canPlaceOnSurfaces?: boolean
  /** Number of tile rows from the top of the footprint that are "background" (allow placement, still block walking). Default 0. */
  backgroundTiles?: number
  /** Whether this item can be placed on wall tiles */
  canPlaceOnWalls?: boolean
  /** Whether idle characters can walk up to and interact with this furniture */
  interactable?: boolean
  /** Whether this furniture generates a seat (characters can sit here) */
  isSeat?: boolean
  /** Resolved cycle frame sprites for meeting animation. */
  meetingCycleSprites?: SpriteData[]
  randomMeetingCycle?: boolean
  /** Interval bounds in seconds for meeting cycle frame changes. */
  meetingCycleIntervalMin?: number
  meetingCycleIntervalMax?: number
  /** Resolved cycle frame sprites for work animation (shown when active agent looks at this). */
  workCycleSprites?: SpriteData[]
  randomWorkCycle?: boolean
  workCycleIntervalMin?: number
  workCycleIntervalMax?: number
  /** Resolved cycle frame sprites for interaction animation (shown when character interacts with this). */
  interactionCycleSprites?: SpriteData[]
  randomInteractionCycle?: boolean
  interactionCycleIntervalMin?: number
  interactionCycleIntervalMax?: number
  /** Resolved cycle frame sprites for idle animation (always runs when no other cycle is active). */
  idleCycleSprites?: SpriteData[]
  randomIdleCycle?: boolean
  idleCycleIntervalMin?: number
  idleCycleIntervalMax?: number
}

export interface PlacedFurniture {
  uid: string
  type: string // FurnitureType enum or asset ID
  col: number
  row: number
  /** Optional color override for furniture */
  color?: FloorColor
}

export interface OfficeLayout {
  version: 1
  cols: number
  rows: number
  tiles: TileType[]
  furniture: PlacedFurniture[]
  /** Per-tile color settings, parallel to tiles array. null = wall/no color */
  tileColors?: Array<FloorColor | null>
  /** Per-tile zone designation, parallel to tiles array. null = unzoned */
  zones?: Array<ZoneType | null>
}

export interface Character {
  id: number
  state: CharacterState
  dir: Direction
  /** Pixel position */
  x: number
  y: number
  /** Current tile column */
  tileCol: number
  /** Current tile row */
  tileRow: number
  /** Remaining path steps (tile coords) */
  path: Array<{ col: number; row: number }>
  /** 0-1 lerp between current tile and next tile */
  moveProgress: number
  /** Current tool name for typing vs reading animation, or null */
  currentTool: string | null
  /** Palette index (0-5) */
  palette: number
  /** Hue shift in degrees (0 = no shift, ≥45 for repeated palettes) */
  hueShift: number
  /** Animation frame index */
  frame: number
  /** Time accumulator for animation */
  frameTimer: number
  /** Timer for idle wander decisions */
  wanderTimer: number
  /** Number of wander moves completed in current roaming cycle */
  wanderCount: number
  /** Max wander moves before returning to seat for rest */
  wanderLimit: number
  /** Whether the agent is actively working */
  isActive: boolean
  /** Whether the agent is waiting for user response (turn complete) */
  isWaiting: boolean
  /** Assigned seat uid, or null if no seat */
  seatId: string | null
  /** Active speech bubble type, or null if none showing */
  bubbleType: 'permission' | 'waiting' | 'talking' | 'thinking' | 'idle_chat' | 'idle_think' | 'idle_eat' | null
  /** Countdown timer for bubble (waiting: 2→0, permission: unused) */
  bubbleTimer: number
  /** Timer to stay seated while inactive after seat reassignment (counts down to 0) */
  seatTimer: number
  /** Whether this character represents a sub-agent (spawned by Task tool) */
  isSubagent: boolean
  /** Parent agent ID if this is a sub-agent, null otherwise */
  parentAgentId: number | null
  /** Active matrix spawn/despawn effect, or null */
  matrixEffect: 'spawn' | 'despawn' | null
  /** Timer counting up from 0 to MATRIX_EFFECT_DURATION */
  matrixEffectTimer: number
  /** Per-column random seeds (16 values) for staggered rain timing */
  matrixEffectSeeds: number[]
  /** Countdown timer before idle character transitions to idle zone (seconds) */
  idleZoneTimer: number
  /** Current idle action type, or null if not performing an idle action */
  idleAction: IdleActionType | null
  /** Partner character ID during a conversation action */
  conversationPartnerId: number | null
  /** Countdown timer for idle action phases (conversation duration, visit duration, think duration) */
  idleActionTimer: number
  /** Conversation phase tracking */
  conversationPhase: 'approaching' | 'talking' | 'leaving' | null
  /** Index into IDLE_CHAT_BUBBLE_VARIANTS for current chat bubble emoji */
  chatBubbleVariant: number
  /** Direction before conversation started (to restore after) */
  preConversationDir: Direction | null
  /** Unique ID grouping characters in the same meeting (so multiple meetings can coexist) */
  meetingGroupId: number | null
  /** Workspace folder name (only set for multi-root workspaces) */
  folderName?: string
  /** Display name shown as nametag above character */
  nametag?: string
  /** Agent definition ID from .pixel_agents config (e.g., 'main', 'backend') */
  definitionId?: string
  /** Color string for project indicator dot in nametag (derived from workspace folder) */
  projectColor?: string
  /** Whether this character is from a remote VS Code window (cross-window sync) */
  isRemote?: boolean
  /** Full tool status from the source window (e.g., "Edit: src/foo.ts") for remote display */
  remoteToolStatus?: string | null
  /** Hint from backend: 'thinking' (fresh prompt) vs 'between-turns' (grace period) */
  idleHint?: 'thinking' | 'between-turns' | null
  /** Target state from the source window — remote characters animate locally using synced path */
  syncTarget?: {
    x: number
    y: number
    tileCol: number
    tileRow: number
    state: string
    dir: number
    frame: number
    moveProgress: number
    path?: Array<{ col: number; row: number }>
  }
}
