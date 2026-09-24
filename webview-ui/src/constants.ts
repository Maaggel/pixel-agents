import type { FloorColor } from './office/types.js'

// ── Grid & Layout ────────────────────────────────────────────
export const TILE_SIZE = 16
export const DEFAULT_COLS = 20
export const DEFAULT_ROWS = 11
export const MAX_COLS = 64
export const MAX_ROWS = 64

// ── Character Animation ─────────────────────────────────────
export const WALK_SPEED_PX_PER_SEC = 48
export const WALK_FRAME_DURATION_SEC = 0.15
export const TYPE_FRAME_DURATION_SEC = 0.3
export const BUILD_FRAME_DURATION_SEC = 0.4
export const SIT_WAIT_FRAME_DURATION_SEC = 0.8
export const WANDER_PAUSE_MIN_SEC = 0.5
export const WANDER_PAUSE_MAX_SEC = 3.0
export const WANDER_MOVES_BEFORE_REST_MIN = 1
export const WANDER_MOVES_BEFORE_REST_MAX = 3
export const SEAT_REST_MIN_SEC = 150.0
export const SEAT_REST_MAX_SEC = 420.0
/** How long agents sit at their desk before wandering after finishing work */
export const INITIAL_IDLE_SEAT_REST_MIN_SEC = 120.0
export const INITIAL_IDLE_SEAT_REST_MAX_SEC = 300.0
/** Chance (0-1) to return to the same seat after wandering. 0.4 = 40% same, 60% new seat. */
export const SEAT_RETURN_SAME_CHANCE = 0.4
/** Chance (0-1) to pick a completely random work seat instead of a nearby one. */
export const WORK_SEAT_RANDOM_CHANCE = 0.3
/** Weighted zone preferences for idle seat selection (rest > kitchen > work/any).
 *  Weights are relative - if a zone has no free seats, its weight is redistributed. */
export const IDLE_ZONE_WEIGHT_REST = 50
export const IDLE_ZONE_WEIGHT_KITCHEN = 30
export const IDLE_ZONE_WEIGHT_OTHER = 20

// ── Matrix Effect ────────────────────────────────────────────
export const MATRIX_EFFECT_DURATION_SEC = 0.3
export const MATRIX_TRAIL_LENGTH = 6
export const MATRIX_SPRITE_COLS = 16
export const MATRIX_SPRITE_ROWS = 24
export const MATRIX_FLICKER_FPS = 30
export const MATRIX_FLICKER_VISIBILITY_THRESHOLD = 180
export const MATRIX_COLUMN_STAGGER_RANGE = 0.3
export const MATRIX_HEAD_COLOR = '#ccffcc'
export const MATRIX_TRAIL_OVERLAY_ALPHA = 0.6
export const MATRIX_TRAIL_EMPTY_ALPHA = 0.5
export const MATRIX_TRAIL_MID_THRESHOLD = 0.33
export const MATRIX_TRAIL_DIM_THRESHOLD = 0.66

// ── Rendering ────────────────────────────────────────────────
export const CHARACTER_SITTING_OFFSET_PX = 6
export const CHARACTER_Z_SORT_OFFSET = 0.5
export const OUTLINE_Z_SORT_OFFSET = 0.001
export const SELECTED_OUTLINE_ALPHA = 1.0
export const HOVERED_OUTLINE_ALPHA = 0.5
export const GHOST_PREVIEW_SPRITE_ALPHA = 0.5
export const GHOST_PREVIEW_TINT_ALPHA = 0.25
export const SELECTION_DASH_PATTERN: [number, number] = [4, 3]
export const BUTTON_MIN_RADIUS = 6
export const BUTTON_RADIUS_ZOOM_FACTOR = 3
export const BUTTON_ICON_SIZE_FACTOR = 0.45
export const BUTTON_LINE_WIDTH_MIN = 1.5
export const BUTTON_LINE_WIDTH_ZOOM_FACTOR = 0.5
export const BUBBLE_FADE_DURATION_SEC = 0.5
export const BUBBLE_SITTING_OFFSET_PX = 10
export const BUBBLE_VERTICAL_OFFSET_PX = 24
export const FALLBACK_FLOOR_COLOR = '#808080'
export const NAMETAG_VERTICAL_OFFSET_PX = 26
export const NAMETAG_BG_COLOR = 'rgba(30, 30, 46, 0.75)'
export const NAMETAG_TEXT_COLOR = '#ccccdd'
export const NAMETAG_SUB_TEXT_COLOR = '#88aacc'
export const NAMETAG_PADDING_H = 3
export const NAMETAG_PADDING_V = 1
export const NAMETAG_MAX_CHARS = 20
export const NAMETAG_DOT_GAP = 3
export const NAMETAG_PROJECT_COLORS = [
  '#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#61afef', '#c678dd',
  '#d19a66', '#be5046', '#7ec8e3', '#b8bb26',
] as const

// ── Rendering - Overlay Colors (canvas, not CSS) ─────────────
export const SEAT_OWN_COLOR = 'rgba(0, 127, 212, 0.35)'
export const SEAT_AVAILABLE_COLOR = 'rgba(0, 200, 80, 0.35)'
export const SEAT_BUSY_COLOR = 'rgba(220, 50, 50, 0.35)'
export const GRID_LINE_COLOR = 'rgba(255,255,255,0.12)'
export const VOID_TILE_OUTLINE_COLOR = 'rgba(255,255,255,0.08)'
export const VOID_TILE_DASH_PATTERN: [number, number] = [2, 2]
export const GHOST_BORDER_HOVER_FILL = 'rgba(60, 130, 220, 0.25)'
export const GHOST_BORDER_HOVER_STROKE = 'rgba(60, 130, 220, 0.5)'
export const GHOST_BORDER_STROKE = 'rgba(255, 255, 255, 0.06)'
export const GHOST_VALID_TINT = '#00ff00'
export const GHOST_INVALID_TINT = '#ff0000'
export const SELECTION_HIGHLIGHT_COLOR = '#007fd4'
export const DELETE_BUTTON_BG = 'rgba(200, 50, 50, 0.85)'
export const ROTATE_BUTTON_BG = 'rgba(50, 120, 200, 0.85)'

// ── Camera ───────────────────────────────────────────────────
export const CAMERA_FOLLOW_LERP = 0.1
export const CAMERA_FOLLOW_SNAP_THRESHOLD = 0.5

// ── Zoom ─────────────────────────────────────────────────────
export const ZOOM_MIN = 1
export const ZOOM_MAX = 10
export const ZOOM_STEP = 0.5
export const ZOOM_DEFAULT_DPR_FACTOR = 2
export const ZOOM_LEVEL_FADE_DELAY_MS = 1500
export const ZOOM_LEVEL_HIDE_DELAY_MS = 2000
export const ZOOM_LEVEL_FADE_DURATION_SEC = 0.5
export const ZOOM_SCROLL_THRESHOLD = 50
export const PAN_MARGIN_FRACTION = 0.25
/** Touch: a second tap within this window (ms) and distance (CSS px) of the first, held down, drags the view */
export const TOUCH_DOUBLE_TAP_MS = 350
export const TOUCH_DOUBLE_TAP_MAX_DIST_PX = 40

// ── Editor ───────────────────────────────────────────────────
export const UNDO_STACK_MAX_SIZE = 50
export const LAYOUT_SAVE_DEBOUNCE_MS = 500
export const DEFAULT_FLOOR_COLOR: FloorColor = { h: 35, s: 30, b: 15, c: 0 }
export const DEFAULT_WALL_COLOR: FloorColor = { h: 240, s: 25, b: 0, c: 0 }
export const DEFAULT_NEUTRAL_COLOR: FloorColor = { h: 0, s: 0, b: 0, c: 0 }
export const DEFAULT_EXTERIOR_WALL_COLOR: FloorColor = { h: 10, s: 50, b: -15, c: 10 }

// ── Notification Sound ──────────────────────────────────────
export const NOTIFICATION_NOTE_1_HZ = 659.25   // E5
export const NOTIFICATION_NOTE_2_HZ = 1318.51  // E6 (octave up)
export const NOTIFICATION_NOTE_1_START_SEC = 0
export const NOTIFICATION_NOTE_2_START_SEC = 0.1
export const NOTIFICATION_NOTE_DURATION_SEC = 0.18
export const NOTIFICATION_VOLUME = 0.14

// ── Zones ───────────────────────────────────────────────────
export const ZONE_OVERLAY_ALPHA = 0.2
export const ZONE_COLORS: Record<string, string> = {
  workspace: 'rgba(50, 140, 255, 0.18)',
  kitchen: 'rgba(255, 160, 40, 0.18)',
  rest_area: 'rgba(80, 200, 80, 0.18)',
  meeting_room: 'rgba(200, 80, 220, 0.18)',
}
export const ZONE_BORDER_COLORS: Record<string, string> = {
  workspace: 'rgba(50, 140, 255, 0.7)',
  kitchen: 'rgba(255, 160, 40, 0.7)',
  rest_area: 'rgba(80, 200, 80, 0.7)',
  meeting_room: 'rgba(200, 80, 220, 0.7)',
}
export const ZONE_LABEL_COLORS: Record<string, string> = {
  workspace: 'rgba(100, 180, 255, 0.85)',
  kitchen: 'rgba(255, 190, 80, 0.85)',
  rest_area: 'rgba(120, 230, 120, 0.85)',
  meeting_room: 'rgba(220, 130, 240, 0.85)',
}
export const ZONE_LABELS: Record<string, string> = {
  workspace: 'Workspace',
  kitchen: 'Kitchen',
  rest_area: 'Rest Area',
  meeting_room: 'Meeting Room',
}
export const ZONE_ICONS: Record<string, string> = {
  workspace: '\u{1F4BB}',
  kitchen: '\u{2615}',
  rest_area: '\u{1F6CB}',
  meeting_room: '\u{1F4AC}',
}
/** Probability (0-1) that an idle character picks a zone-appropriate tile vs random */
export const ZONE_WANDER_PREFERENCE = 0.7
/** Seconds to wait at current position before transitioning to idle zone */
export const IDLE_ZONE_DELAY_SEC = 10.0

// ── Sunlight ────────────────────────────────────────────────
/** Full sun cycle duration in seconds (left → right → fade out → pause → restart) */
export const SUN_CYCLE_DURATION_SEC = 300
/** Fraction of the cycle spent in the "off" (night) phase before restarting */
export const SUN_NIGHT_FRACTION = 0.15

/** The hours the office's day phase is read as, for the wall clocks */
export const OFFICE_SUNRISE_HOUR = 6
export const OFFICE_SUNSET_HOUR = 20
/** Frames on a twelve hour dial: quarter hours, so it reads "quarter past" and "half past" */
export const CLOCK_DIAL_FRAMES = 48

// ── The office's working day ─────────────────────────────────────
// Idle behaviour follows the office clock rather than being uniform round the clock: people eat
// around noon, drink coffee in the morning, and do much less of either at night. Each entry is
// [fromHour, toHour, multiplier] applied to that action's weight, first match wins.
/** Meals: a lunch hour, a lighter evening meal, almost nothing at night */
export const OFFICE_MEAL_HOURS: Array<[number, number, number]> = [
  [11.5, 13.5, 3], [18, 20, 1.5], [22, 6, 0.15],
]
/** Drinks: a morning rush, a smaller afternoon one, little at night */
export const OFFICE_DRINK_HOURS: Array<[number, number, number]> = [
  [7, 10, 2.5], [14, 16, 1.6], [22, 6, 0.3],
]
/** How many candidates get a real pathfind when choosing the nearest machine, bin or stray mug */
export const NEAREST_PATH_CANDIDATES = 5

/** Active agents that count as a full office: the load gauge and the racks read this as 100% */
export const OFFICE_FULL_LOAD_AGENTS = 6
/** At full load a load-reactive idle cycle runs this many times faster (server rack lights) */
export const LOAD_REACTIVE_SPEEDUP = 3

/** After dark a lamp stays lit only while someone is working within this many tiles of it */
export const LAMP_OCCUPANCY_RADIUS_TILES = 4
/** How often the office re-checks which desks are still occupied, in seconds */
export const LAMP_OCCUPANCY_CHECK_SEC = 6
/** Maximum sunlight beam length in tiles (at sunrise/sunset when sun is low) */
export const SUN_BEAM_MAX_LENGTH = 3
/** Minimum sunlight beam length in tiles (at midday when sun is high) */
export const SUN_BEAM_MIN_LENGTH = 1
/** Default inset in pixels from each side of window sprite for sunlight beam (narrows beam to glass area) */
export const SUN_BEAM_DEFAULT_INSET = 2
/** Peak sunlight beam opacity (at the window edge) */
export const SUN_BEAM_OPACITY = 0.15
/** Sunlight beam color at midday (warm yellow) */
export const SUN_BEAM_COLOR_MIDDAY: [number, number, number] = [255, 220, 120]
/** Sunlight beam color at sunrise/sunset (warm orange-red) */
export const SUN_BEAM_COLOR_EDGE: [number, number, number] = [255, 170, 80]
/** Minimum sun angle in radians (leftmost sweep, negative = left) */
export const SUN_ANGLE_MIN_RAD = -0.4
/** Maximum sun angle in radians (rightmost sweep, positive = right) */
export const SUN_ANGLE_MAX_RAD = 0.4

// ── Lamp Lighting ──────────────────────────────────────────
/** Default light radius in tiles for lamp furniture */
export const LAMP_LIGHT_RADIUS_DEFAULT = 3
/** Lamp light color (warm amber) */
export const LAMP_LIGHT_COLOR: [number, number, number] = [255, 200, 100]
/** Peak opacity of lamp light pool at center */
export const LAMP_LIGHT_OPACITY = 0.25
/** Sun intensity threshold below which lamps auto-toggle ON (0-1) */
export const LAMP_ON_INTENSITY_THRESHOLD = 0.3
/** Lamp light Y offset in sprite pixels (light emits from top of lamp sprite) */
export const LAMP_LIGHT_Y_OFFSET_PX = 4
/** Maximum random delay (seconds) for lamps with lampRandomToggle before toggling on/off */
export const LAMP_RANDOM_TOGGLE_MAX_DELAY_SEC = 2.0

// ── Window Glass Effects ────────────────────────────────────
/** Glass tint opacity at full sun during clear weather */
export const GLASS_DAY_TINT_OPACITY = 0.22
/** Glass tint opacity at full sun during rain/snow (subdued - overcast sky) */
export const GLASS_DAY_WEATHER_TINT_OPACITY = 0.06
/** Glass overlay opacity at full night (dark sky through window) */
export const GLASS_NIGHT_OVERLAY_OPACITY = 0.55
/** Night sky color visible through window glass */
export const GLASS_NIGHT_COLOR: [number, number, number] = [15, 20, 45]
/** Daytime sky color visible through window glass (light blue) */
export const GLASS_DAY_SKY_COLOR: [number, number, number] = [140, 180, 230]
/** Sunrise/sunset sky color through window glass */
export const GLASS_EDGE_SKY_COLOR: [number, number, number] = [220, 140, 80]

/** Extra dark overlay opacity behind weather particles (cloud cover) */
export const GLASS_WEATHER_DARKEN_OPACITY = 0.18

/** Semi-transparent glass tint for exterior windows (looking into the office) */
export const EXTERIOR_GLASS_TINT_COLOR: [number, number, number] = [180, 210, 240]
export const EXTERIOR_GLASS_TINT_OPACITY = 0.2

// ── Weather ────────────────────────────────────────────────
/** Minimum duration of a weather state in seconds before transition */
export const WEATHER_MIN_DURATION_SEC = 60
/** Maximum duration of a weather state in seconds before transition */
export const WEATHER_MAX_DURATION_SEC = 180
/** Duration of weather transition fade in seconds */
export const WEATHER_TRANSITION_DURATION_SEC = 8
/** Maximum rain particles active across all windows */
export const WEATHER_RAIN_PARTICLE_COUNT = 40
/** Maximum snow particles active across all windows */
export const WEATHER_SNOW_PARTICLE_COUNT = 25
/** Rain particle fall speed in sprite pixels per second */
export const WEATHER_RAIN_SPEED_PX_SEC = 60
/** Snow particle fall speed in sprite pixels per second */
export const WEATHER_SNOW_SPEED_PX_SEC = 12
/** Snow horizontal drift amplitude in sprite pixels */
export const WEATHER_SNOW_DRIFT_AMPLITUDE_PX = 1.2
/** Snow horizontal drift frequency (oscillations per second) */
export const WEATHER_SNOW_DRIFT_FREQ = 0.3
/** Rain streak length in sprite pixels */
export const WEATHER_RAIN_LENGTH_PX = 3
/** Rain color */
export const WEATHER_RAIN_COLOR = 'rgba(180, 200, 230, 0.9)'
/** Snow color */
export const WEATHER_SNOW_COLOR = 'rgba(240, 245, 255, 0.85)'
/** Snow particle size in sprite pixels */
export const WEATHER_SNOW_SIZE_PX = 1
/** Blizzard particle count (more than regular snow) */
export const WEATHER_BLIZZARD_PARTICLE_COUNT = 50
/** Blizzard horizontal wind speed in sprite pixels per second */
export const WEATHER_BLIZZARD_WIND_SPEED_PX_SEC = 25
/** Blizzard fall speed in sprite pixels per second */
export const WEATHER_BLIZZARD_FALL_SPEED_PX_SEC = 20
/** Probability weights for weather states: [clear, rain, snow] */
export const WEATHER_STATE_WEIGHTS = [0.5, 0.3, 0.2] as const

// ── Robot Vacuum ────────────────────────────────────────────
/** Vacuum movement speed in pixels per second (slower than characters) */
export const VACUUM_SPEED_PX_PER_SEC = 10
/** Min seconds to wait when blocked by an avatar before rerouting */
export const VACUUM_WAIT_DURATION_MIN_SEC = 1.0
/** Max seconds to wait when blocked by an avatar before rerouting */
export const VACUUM_WAIT_DURATION_MAX_SEC = 2.0
/** Max tiles a vacuum can clean before needing to return to base for recharge */
export const VACUUM_MAX_TILES_PER_CHARGE = 250
/** Furniture type prefix used to identify robot vacuum items */
export const ROBOT_VACUUM_TYPE_PREFIX = 'ROBOT_VACUUM'
/** Interval in seconds between dock charging animation frame changes */
export const VACUUM_DOCK_CYCLE_INTERVAL_SEC = 0.5
/** Duration in seconds for vacuum speech bubble display */
export const VACUUM_SPEECH_DURATION_SEC = 4.0
/** Minimum seconds between automatic vacuum cleaning cycles */
export const VACUUM_AUTO_CYCLE_MIN_SEC = 180
/** Maximum seconds between automatic vacuum cleaning cycles */
export const VACUUM_AUTO_CYCLE_MAX_SEC = 600
/** Duration in seconds for vacuum cleaning trail to fade out */
export const VACUUM_TRAIL_FADE_SEC = 8.0
/** Opacity of the vacuum cleaning trail at full strength */
export const VACUUM_TRAIL_OPACITY = 0.08
/** Vacuum trail tint color (slight blue for wet/water look) */
export const VACUUM_TRAIL_COLOR = '40, 80, 140'
/** Sprite-pixel distance between trail patch spawns (smaller = denser trail) */
export const VACUUM_TRAIL_SPAWN_INTERVAL_PX = 4
/** Trail patch size in sprite pixels (slightly smaller than vacuum for a streak effect) */
export const VACUUM_TRAIL_PATCH_SIZE_PX = 10

// ── Cross-Window Sync ───────────────────────────────────────
/** Interval (ms) for reporting local character visual states to the extension */
export const CHAR_VISUAL_REPORT_INTERVAL_MS = 250

// ── Game Logic ───────────────────────────────────────────────
export const MAX_DELTA_TIME_SEC = 0.1
export const WAITING_BUBBLE_DURATION_SEC = 2.0
export const TALKING_BUBBLE_DURATION_SEC = 3.0
export const TOOL_BUBBLE_MIN_DISPLAY_MS = 1200
export const AGENT_CLOSE_GRACE_MS = 1500
export const DISMISS_BUBBLE_FAST_FADE_SEC = 0.3
export const INACTIVE_SEAT_TIMER_MIN_SEC = 3.0
export const INACTIVE_SEAT_TIMER_RANGE_SEC = 2.0
export const PALETTE_COUNT = 6
export const HUE_SHIFT_MIN_DEG = 45
export const HUE_SHIFT_RANGE_DEG = 271
/** Deterministic look from nametag: hue is quantised to LOOK_HUE_STEPS steps of LOOK_HUE_STEP_DEG (0 = original skin) */
export const LOOK_HUE_STEPS = 8
export const LOOK_HUE_STEP_DEG = 45
export const LOOK_OVERRIDES_STORAGE_KEY = 'pixel-agents-look-overrides'
export const AUTO_ON_FACING_DEPTH = 3
export const AUTO_ON_SIDE_DEPTH = 2
export const CHARACTER_HIT_HALF_WIDTH = 8
export const CHARACTER_HIT_HEIGHT = 24
export const TOOL_OVERLAY_VERTICAL_OFFSET = 32
export const PULSE_ANIMATION_DURATION_SEC = 1.5

// ── Idle Actions ────────────────────────────────────────────
export const CONVERSATION_MIN_DURATION_SEC = 15.0
export const CONVERSATION_MAX_DURATION_SEC = 40.0
export const CONVERSATION_BUBBLE_SHOW_MIN_SEC = 2.5
export const CONVERSATION_BUBBLE_SHOW_MAX_SEC = 4.5
export const CONVERSATION_BUBBLE_GAP_MIN_SEC = 1.0
export const CONVERSATION_BUBBLE_GAP_MAX_SEC = 3.0
export const CONVERSATION_BUBBLE_INITIAL_MAX_DELAY_SEC = 2.0
export const THINK_MIN_DURATION_SEC = 0.5
export const THINK_MAX_DURATION_SEC = 3.0
export const VISIT_MIN_DURATION_SEC = 3.0
export const VISIT_MAX_DURATION_SEC = 6.0
export const EAT_MIN_DURATION_SEC = 15.0
export const EAT_MAX_DURATION_SEC = 35.0
// ── Dynamic items (utensils: catalog entries with utensil/utensilOrigin/utensilDisposal) ──
/** Seconds standing at the origin furniture (coffee machine, fridge...) before the item appears */
export const ITEM_FETCH_SEC = 2.5
/** Seconds standing at the disposal furniture (sink, bin...) to drop an item off */
export const ITEM_DISPOSE_SEC = 1.0
/** Standing over a plant with the can */
export const WATER_PLANT_SEC = 2.0
/**
 * A plant is worth watering again this long after its last drink (seconds), give or take.
 * Sixteen plants on a ten minute cycle made watering the office's main occupation, so they last
 * longer than that: the wilt is still plain to see, there is just less of a treadmill.
 */
export const PLANT_DRY_AFTER_SEC = 960
/**
 * How much plants differ from each other in how fast they dry, as a fraction either way.
 * A fresh figure is drawn each time one is watered, so the office never wilts in lockstep: one
 * plant is drooping while its neighbour is still fine.
 */
export const PLANT_DRY_VARIATION = 0.45
// ── Steam ────────────────────────────────────────────────────────
/** How long a fresh drink steams for, in office seconds */
export const STEAM_DURATION_SEC = 100
/** Wisps drawn above a steaming cup */
export const STEAM_WISPS = 4
/** How far a wisp climbs before it fades out, in sprite pixels */
export const STEAM_RISE_PX = 10
/** Sprite pixels a wisp climbs per second */
export const STEAM_SPEED_PX_SEC = 3.2
/** How far a wisp wanders sideways as it climbs, in sprite pixels */
export const STEAM_DRIFT_PX = 1.6
/** The thickest a wisp gets, before its own fade and the drink going cold */
export const STEAM_MAX_ALPHA = 0.8
export const STEAM_COLOR = '#ffffff'
/** How far up its climb a wisp stops being a single pixel and curls out into a puff */
export const STEAM_PUFF_AT = 0.28

/** A plant starts looking faded at this fraction of the way to wanting water */
export const PLANT_FADE_AT_DRYNESS = 0.6

// ── Noticing a dry plant ─────────────────────────────────────────
// Walking past one is what usually sets someone off to fetch the can, the same way walking past a
// stray mug is what gets it cleared away. A parched plant is noticed from further off and acted
// on far more readily than one that has merely started to fade.
export const PLANT_NOTICE_DISTANCE_TILES = 7
// Enough to keep the plants alive without the office becoming obsessed with them: at the first
// numbers tried, watering was half of everything anyone did and nobody ever fetched a drink.
/** Weight when a parched plant is close by */
export const WATER_NEAR_PARCHED_WEIGHT = 32
/** Weight when a merely fading plant is close by */
export const WATER_NEAR_FADING_WEIGHT = 10
/** Weight when something is parched, but nowhere near */
export const WATER_PARCHED_ELSEWHERE_WEIGHT = 6
/** Weight when nothing is worse than fading, and none of it is close */
export const WATER_FADING_ELSEWHERE_WEIGHT = 2

/**
 * How much more likely someone is to fetch a drink than a thing to read.
 * People wander off for coffee and water far more often than for a book or a printout, and
 * without this the four of them came up equally and a glass of water was a rare sight.
 */
export const FETCH_DRINK_PREFERENCE = 3
/** Plants one canful stretches to before a trip back to the tap, if the can says nothing else */
export const WATERING_CAN_DEFAULT_USES = 3
/** A prop must lie around at least this long before someone tidies it away */
export const PROP_MIN_AGE_SEC = 90
/** Tidy-up is much more likely when a stale, unused prop lies within this many tiles (Manhattan) of the agent */
export const TIDY_NEAR_DISTANCE_TILES = 6
/** TIDY_UP weight when such a prop is near (registry weight applies otherwise) */
export const TIDY_NEAR_WEIGHT = 70
/** Hard cap on props in the office - beyond it, carried items are simply "finished" */
export const MAX_PROPS = 12
/** Props are drawn this many sprite px above the tile bottom so they sit on the tabletop, not its front edge */
export const PROP_SURFACE_LIFT_PX = 5

/** How far in front of a wall sprite a wall-mounted item sorts (z units, half a pixel) */
export const WALL_MOUNTED_Z_EPSILON = 0.5
/** Safety timeout for fetch/tidy bubbles - the action clears them earlier when it finishes */
export const ITEM_BUBBLE_MAX_SEC = 60
/** Random look given to a fetched utensil (adjust-mode hue shifts, like the editor's furniture color sliders).
 *  `null` = the sprite's original colors. */
export const ITEM_COLOR_VARIANTS: Array<{ h: number; s: number; b: number; c: number } | null> = [
  null,
  { h: 60, s: 0, b: 0, c: 0 },
  { h: 120, s: 0, b: 0, c: 0 },
  { h: 180, s: 0, b: 0, c: 0 },
  { h: -120, s: 0, b: 0, c: 0 },
  { h: -60, s: 0, b: 0, c: 0 },
  { h: 0, s: -80, b: 10, c: 0 },
]
/** Held-item anchor per facing direction, in sprite px relative to the character's bottom-centre.
 *  UP draws the item behind the body (z-sorted just before the character). */
export const HELD_ITEM_OFFSETS: Record<number, { dx: number; dy: number; behind: boolean }> = {
  0: { dx: 1, dy: -13, behind: false },   // DOWN - front hand
  1: { dx: -3, dy: -14, behind: true },   // UP - hidden partly behind the body
  2: { dx: 5, dy: -13, behind: false },   // RIGHT - hand in front
  3: { dx: -12, dy: -13, behind: false }, // LEFT - mirrored
}
/** Max Manhattan distance (in tiles) for two seated agents to have a seated conversation */
export const SEATED_CONVERSATION_MAX_DISTANCE = 4
/** Number of idle chat bubble emoji variants */
export const IDLE_CHAT_BUBBLE_VARIANT_COUNT = 16
/** Chance per second that a SIT_IDLE character will try to start a seated conversation */
export const SEATED_CONVERSATION_CHANCE_PER_SEC = 0.05

// ── Doors ──────────────────────────────────────────────────
/**
 * A door is walked through, never walked around: it is not in the blocked set, so pathfinding
 * behaves as if the doorway were open floor. What a door does is open when someone reaches it
 * and close again afterwards - and, when it is the door to a room with a toilet in it, lock.
 */
/** How far ahead on the path a door opens - 1 tile, so it is open by the time they step in. */
export const DOOR_OPEN_AHEAD_TILES = 1
/** Chance that someone closes the door behind them. People mostly do. */
export const DOOR_CLOSE_BEHIND_CHANCE = 0.65
/**
 * Chance per second that someone standing next to a door another person left open closes it.
 * This is how an open door eventually shuts without a timer doing it invisibly: the same
 * walking-past-it-and-noticing that gets a mug cleared away or a plant watered.
 */
export const DOOR_PASSING_CLOSE_CHANCE_PER_SEC = 0.22
/** A door stays open at least this long, so it cannot shut in the face of whoever opened it. */
export const DOOR_MIN_OPEN_SEC = 1.6
/** Seconds a door holds open behind the last person through before it may be closed. */
export const DOOR_CLOSE_DELAY_SEC = 0.8
/**
 * A room bigger than this is not a room worth locking. It stops a toilet placed out in the open
 * plan from flood-filling the whole office and locking every door in the building.
 */
export const PRIVACY_ROOM_MAX_TILES = 140
/**
 * How far a door sign will look for a room to report on. Without this a lone sign would latch
 * onto whatever qualifying room happened to be nearest, even one across the office.
 */
export const SIGN_ROOM_MAX_DISTANCE_TILES = 10

// ── Meetings ───────────────────────────────────────────────
export const MEETING_MIN_DURATION_SEC = 45.0
export const MEETING_MAX_DURATION_SEC = 120.0
/**
 * Chance per second that a meeting starts (when enough idle agents + meeting zone seats exist).
 * Rolled once per tick, so this is the real rate: one attempt every ~5.5 idle minutes. A meeting
 * pulls in most of the office for 45-120 s, so raising this eats the time drinks, meals, tidying
 * and plant care live in.
 */
export const MEETING_CHANCE_PER_SEC = 0.003
/** Minimum idle non-subagent agents required to start a meeting */
export const MEETING_MIN_PARTICIPANTS = 2
export const MEETING_BUBBLE_SHOW_MIN_SEC = 3.0
export const MEETING_BUBBLE_SHOW_MAX_SEC = 6.0
export const MEETING_BUBBLE_GAP_MIN_SEC = 1.5
export const MEETING_BUBBLE_GAP_MAX_SEC = 4.0
export const MEETING_BUBBLE_INITIAL_MAX_DELAY_SEC = 3.0
/** Default interval in seconds between meeting cycle frame changes (when no min/max defined) */
export const MEETING_CYCLE_DEFAULT_INTERVAL_SEC = 3.0
/** Offset applied when only one bound (min or max) is defined for meeting cycle interval */
export const MEETING_CYCLE_INTERVAL_OFFSET_SEC = 2.0
/** Default interval in seconds between work cycle frame changes (when no min/max defined) */
export const WORK_CYCLE_DEFAULT_INTERVAL_SEC = 3.0
/** Offset applied when only one bound (min or max) is defined for work cycle interval */
export const WORK_CYCLE_INTERVAL_OFFSET_SEC = 2.0
/** Default interval in seconds between interaction cycle frame changes (when no min/max defined) */
export const INTERACTION_CYCLE_DEFAULT_INTERVAL_SEC = 3.0
/** Offset applied when only one bound (min or max) is defined for interaction cycle interval */
export const INTERACTION_CYCLE_INTERVAL_OFFSET_SEC = 2.0
/** Default interval in seconds between idle cycle frame changes (when no min/max defined) */
export const IDLE_CYCLE_DEFAULT_INTERVAL_SEC = 3.0
/** Offset applied when only one bound (min or max) is defined for idle cycle interval */
export const IDLE_CYCLE_INTERVAL_OFFSET_SEC = 2.0

// ── Skill Aura / Overlay ────────────────────────────────────
/** Per-namespace visual theming for active skills. Used by aura, bubble, overlay. */
export interface SkillNamespaceTheme {
  /** RGB aura color at peak alpha */
  aura: [number, number, number]
  /** CSS color for the overlay label + bubble tint */
  label: string
  /** Friendly label shown above the skill name (e.g. "Flutter Craft") */
  displayName: string
}
export const SKILL_NAMESPACE_THEMES: Record<string, SkillNamespaceTheme> = {
  'flutter-craft':          { aura: [80, 170, 240],  label: '#5aaef0', displayName: 'Flutter Craft' },
  'flutter-mobile-design':  { aura: [240, 110, 190], label: '#f06ebe', displayName: 'Flutter Mobile Design' },
  'superpowers':            { aura: [190, 130, 240], label: '#be82f0', displayName: 'Superpowers' },
  'everything-claude-code': { aura: [240, 160, 80],  label: '#f0a050', displayName: 'Everything Claude Code' },
  'flutter-craft-x':        { aura: [80, 200, 160],  label: '#50c8a0', displayName: 'Flutter Craft X' },
}
/** Theme for bare skills (no namespace) */
export const SKILL_DEFAULT_THEME: SkillNamespaceTheme = {
  aura: [220, 220, 220], label: '#e0e0e0', displayName: 'Skill',
}
/** Aura pulse period in seconds (full ebb-and-flow cycle) */
export const SKILL_AURA_PULSE_PERIOD_SEC = 2.4
/** Peak aura opacity at the center of the pulse */
export const SKILL_AURA_PEAK_ALPHA = 0.45
/** Minimum aura opacity (trough of pulse) */
export const SKILL_AURA_MIN_ALPHA = 0.18
/** Aura radius in sprite pixels (before zoom) */
export const SKILL_AURA_RADIUS_PX = 22
/** Extra vertical center offset for aura (negative = raise toward character chest) */
export const SKILL_AURA_CENTER_OFFSET_Y = -10
