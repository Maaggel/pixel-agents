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
export const WANDER_MOVES_BEFORE_REST_MIN = 2
export const WANDER_MOVES_BEFORE_REST_MAX = 4
export const SEAT_REST_MIN_SEC = 60.0
export const SEAT_REST_MAX_SEC = 180.0
/** How long agents sit at their desk before wandering after finishing work */
export const INITIAL_IDLE_SEAT_REST_MIN_SEC = 45.0
export const INITIAL_IDLE_SEAT_REST_MAX_SEC = 120.0
/** Chance (0-1) to return to the same seat after wandering. 0.4 = 40% same, 60% new seat. */
export const SEAT_RETURN_SAME_CHANCE = 0.4
/** Chance (0-1) to pick a completely random work seat instead of a nearby one. */
export const WORK_SEAT_RANDOM_CHANCE = 0.3
/** Weighted zone preferences for idle seat selection (rest > kitchen > work/any).
 *  Weights are relative — if a zone has no free seats, its weight is redistributed. */
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

// ── Editor ───────────────────────────────────────────────────
export const UNDO_STACK_MAX_SIZE = 50
export const LAYOUT_SAVE_DEBOUNCE_MS = 500
export const DEFAULT_FLOOR_COLOR: FloorColor = { h: 35, s: 30, b: 15, c: 0 }
export const DEFAULT_WALL_COLOR: FloorColor = { h: 240, s: 25, b: 0, c: 0 }
export const DEFAULT_NEUTRAL_COLOR: FloorColor = { h: 0, s: 0, b: 0, c: 0 }

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
/** Maximum sunlight beam length in tiles */
export const SUN_BEAM_MAX_LENGTH = 3
/** Default inset in pixels from each side of window sprite for sunlight beam (narrows beam to glass area) */
export const SUN_BEAM_DEFAULT_INSET = 2
/** Peak sunlight beam opacity (at the window edge) */
export const SUN_BEAM_OPACITY = 0.15
/** Sunlight beam color (warm yellow) */
export const SUN_BEAM_COLOR = 'rgba(255, 220, 120, 1)'
/** Minimum sun angle in radians (leftmost sweep, negative = left) */
export const SUN_ANGLE_MIN_RAD = -0.4
/** Maximum sun angle in radians (rightmost sweep, positive = right) */
export const SUN_ANGLE_MAX_RAD = 0.4

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
/** Max Manhattan distance (in tiles) for two seated agents to have a seated conversation */
export const SEATED_CONVERSATION_MAX_DISTANCE = 4
/** Number of idle chat bubble emoji variants */
export const IDLE_CHAT_BUBBLE_VARIANT_COUNT = 16
/** Chance per second that a SIT_IDLE character will try to start a seated conversation */
export const SEATED_CONVERSATION_CHANCE_PER_SEC = 0.05

// ── Meetings ───────────────────────────────────────────────
export const MEETING_MIN_DURATION_SEC = 45.0
export const MEETING_MAX_DURATION_SEC = 120.0
/** Chance per second that a meeting starts (when enough idle agents + meeting zone seats exist) */
export const MEETING_CHANCE_PER_SEC = 0.008
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
