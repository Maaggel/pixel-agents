import { TILE_SIZE, TileType } from '../types.js'
import type { FurnitureInstance, TileType as TileTypeVal } from '../types.js'
import {
  GLASS_DAY_TINT_OPACITY,
  GLASS_DAY_WEATHER_TINT_OPACITY,
  GLASS_NIGHT_OVERLAY_OPACITY,
  GLASS_NIGHT_COLOR,
  GLASS_DAY_SKY_COLOR,
  GLASS_EDGE_SKY_COLOR,
  GLASS_WEATHER_DARKEN_OPACITY,
  WEATHER_MIN_DURATION_SEC,
  WEATHER_MAX_DURATION_SEC,
  WEATHER_TRANSITION_DURATION_SEC,
  WEATHER_RAIN_PARTICLE_COUNT,
  WEATHER_SNOW_PARTICLE_COUNT,
  WEATHER_RAIN_SPEED_PX_SEC,
  WEATHER_SNOW_SPEED_PX_SEC,
  WEATHER_SNOW_DRIFT_AMPLITUDE_PX,
  WEATHER_SNOW_DRIFT_FREQ,
  WEATHER_RAIN_LENGTH_PX,
  WEATHER_RAIN_COLOR,
  WEATHER_SNOW_COLOR,
  WEATHER_SNOW_SIZE_PX,
  WEATHER_BLIZZARD_PARTICLE_COUNT,
  WEATHER_BLIZZARD_WIND_SPEED_PX_SEC,
  WEATHER_BLIZZARD_FALL_SPEED_PX_SEC,
  WEATHER_STATE_WEIGHTS,
  OUTDOOR_WEATHER_OPACITY,
  OUTDOOR_WEATHER_DENSITY,
  OUTDOOR_WEATHER_FULL_TILES,
  OUTDOOR_WEATHER_FADE_TILES,
  OUTDOOR_WEATHER_ALPHA_STEPS,
} from '../../constants.js'

// ── Weather types ──────────────────────────────────────────

export const WeatherState = {
  CLEAR: 'clear',
  RAIN_LIGHT: 'rain_light',
  RAIN_HEAVY: 'rain_heavy',
  SNOW: 'snow',
  BLIZZARD: 'blizzard',
} as const
export type WeatherState = (typeof WeatherState)[keyof typeof WeatherState]

interface WeatherParticle {
  /** Normalized x position (0-1) within virtual sky */
  x: number
  /** Normalized y position (0-1) within virtual sky */
  y: number
  /** Speed multiplier (randomized per particle for variation) */
  speed: number
  /** Phase offset for snow drift oscillation */
  driftPhase: number
  /** Particle size multiplier */
  size: number
}

// ── Weather state ──────────────────────────────────────────

let currentWeather: WeatherState = WeatherState.CLEAR
let nextWeather: WeatherState = WeatherState.CLEAR
/** Countdown timer to next weather change */
let weatherTimer = 0
/** 0-1 transition blend (0 = fully current, 1 = fully next) */
let weatherTransition = 0
let isTransitioning = false
/** When true, weather cycles randomly. When false, stays on a fixed state. */
let isRandomMode = true

const rainParticles: WeatherParticle[] = []
const snowParticles: WeatherParticle[] = []
const blizzardParticles: WeatherParticle[] = []

/** Initialize weather particles with random positions */
function initParticles(): void {
  rainParticles.length = 0
  snowParticles.length = 0
  blizzardParticles.length = 0
  for (let i = 0; i < WEATHER_RAIN_PARTICLE_COUNT; i++) {
    rainParticles.push({
      x: Math.random(),
      y: Math.random(),
      speed: 0.7 + Math.random() * 0.6,
      driftPhase: 0,
      size: 0.8 + Math.random() * 0.4,
    })
  }
  for (let i = 0; i < WEATHER_SNOW_PARTICLE_COUNT; i++) {
    snowParticles.push({
      x: Math.random(),
      y: Math.random(),
      speed: 0.5 + Math.random() * 1.0,
      driftPhase: Math.random() * Math.PI * 2,
      size: 0.6 + Math.random() * 0.8,
    })
  }
  for (let i = 0; i < WEATHER_BLIZZARD_PARTICLE_COUNT; i++) {
    blizzardParticles.push({
      x: Math.random(),
      y: Math.random(),
      speed: 0.6 + Math.random() * 0.8,
      driftPhase: Math.random() * Math.PI * 2,
      size: 0.5 + Math.random() * 1.0,
    })
  }
}

initParticles()

function pickRandomWeather(exclude?: WeatherState): WeatherState {
  // Weights: [clear, rain_light, rain_heavy, snow, blizzard]
  const states: WeatherState[] = [WeatherState.CLEAR, WeatherState.RAIN_LIGHT, WeatherState.RAIN_HEAVY, WeatherState.SNOW, WeatherState.BLIZZARD]
  // Split the rain weight between light and heavy, snow weight between snow and blizzard
  const rainW = WEATHER_STATE_WEIGHTS[1]
  const snowW = WEATHER_STATE_WEIGHTS[2]
  const weights: number[] = [WEATHER_STATE_WEIGHTS[0], rainW * 0.6, rainW * 0.4, snowW * 0.7, snowW * 0.3]
  // Zero out excluded state's weight
  if (exclude !== undefined) {
    const idx = states.indexOf(exclude)
    if (idx >= 0) weights[idx] = 0
  }
  const total = weights.reduce((a, b) => a + b, 0)
  let r = Math.random() * total
  for (let i = 0; i < states.length; i++) {
    r -= weights[i]
    if (r <= 0) return states[i]
  }
  return WeatherState.CLEAR
}

function randomDuration(): number {
  return WEATHER_MIN_DURATION_SEC + Math.random() * (WEATHER_MAX_DURATION_SEC - WEATHER_MIN_DURATION_SEC)
}

/** Reset weather system (e.g. on layout reload) */
export function resetWeather(): void {
  currentWeather = WeatherState.CLEAR
  nextWeather = WeatherState.CLEAR
  weatherTimer = randomDuration()
  weatherTransition = 0
  isTransitioning = false
  initParticles()
}

/**
 * Set weather to a specific state (disables random cycling),
 * or pass 'random' to re-enable automatic cycling.
 */
export function setWeather(state: WeatherState | 'random'): void {
  if (state === 'random') {
    isRandomMode = true
    weatherTimer = randomDuration()
    return
  }
  isRandomMode = false
  if (currentWeather === state && !isTransitioning) return
  // Transition smoothly to the requested state
  nextWeather = state
  isTransitioning = true
  weatherTransition = 0
}

/** Per-state severity weights for sunbeam attenuation */
const WEATHER_SEVERITY: Record<string, number> = {
  [WeatherState.CLEAR]: 0,
  [WeatherState.RAIN_LIGHT]: 0.25,
  [WeatherState.RAIN_HEAVY]: 0.8,
  [WeatherState.SNOW]: 0.3,
  [WeatherState.BLIZZARD]: 1.0,
}

/**
 * Get the current weather severity (0 = clear, 1 = full weather).
 * Used to attenuate sunlight beams during rain/snow.
 */
export function getWeatherSeverity(): number {
  const blend = isTransitioning ? weatherTransition : 0
  const curSev = WEATHER_SEVERITY[currentWeather] ?? 0
  const nextSev = isTransitioning ? (WEATHER_SEVERITY[nextWeather] ?? 0) : curSev
  return curSev * (1 - blend) + nextSev * blend
}

/** Get current effective weather state (or 'random' if auto-cycling). */
export function getWeatherMode(): WeatherState | 'random' {
  return isRandomMode ? 'random' : currentWeather
}

/** Get the actual current weather state (ignoring random mode). */
export function getCurrentWeather(): WeatherState {
  return currentWeather
}

// Start with a random initial duration
weatherTimer = randomDuration()

/** Advance weather state machine and particles */
export function updateWeather(dt: number): void {
  // Update weather state machine
  if (isTransitioning) {
    weatherTransition += dt / WEATHER_TRANSITION_DURATION_SEC
    if (weatherTransition >= 1) {
      weatherTransition = 0
      currentWeather = nextWeather
      isTransitioning = false
      if (isRandomMode) weatherTimer = randomDuration()
    }
  } else if (isRandomMode) {
    weatherTimer -= dt
    if (weatherTimer <= 0) {
      nextWeather = pickRandomWeather(currentWeather)
      isTransitioning = true
      weatherTransition = 0
    }
  }

  // Update rain particles
  for (const p of rainParticles) {
    p.y += (WEATHER_RAIN_SPEED_PX_SEC / 32) * p.speed * dt
    if (p.y > 1) {
      p.y -= 1
      p.x = Math.random()
    }
  }

  // Update snow particles
  for (const p of snowParticles) {
    p.y += (WEATHER_SNOW_SPEED_PX_SEC / 32) * p.speed * dt
    p.driftPhase += WEATHER_SNOW_DRIFT_FREQ * Math.PI * 2 * dt
    if (p.y > 1) {
      p.y -= 1
      p.x = Math.random()
      p.driftPhase = Math.random() * Math.PI * 2
    }
  }

  // Update blizzard particles (strong horizontal wind + fast fall)
  for (const p of blizzardParticles) {
    p.y += (WEATHER_BLIZZARD_FALL_SPEED_PX_SEC / 32) * p.speed * dt
    p.x += (WEATHER_BLIZZARD_WIND_SPEED_PX_SEC / 32) * p.speed * dt
    p.driftPhase += 0.8 * Math.PI * 2 * dt
    if (p.y > 1 || p.x > 1.5) {
      // Spawn from top edge or left edge so all sections get coverage
      if (Math.random() < 0.5) {
        p.x = -0.2 + Math.random() * 1.0
        p.y = -0.1 + Math.random() * 0.1
      } else {
        p.x = -0.2 + Math.random() * 0.1
        p.y = Math.random()
      }
      p.driftPhase = Math.random() * Math.PI * 2
    }
  }
}

/** Rain intensity info: how many particles to draw and streak length multiplier */
export interface RainLevel {
  /** Fraction of rain particles to draw (0-1) */
  particleFraction: number
  /** Streak length multiplier */
  streakScale: number
  /** Speed multiplier */
  speedScale: number
}

const RAIN_LEVELS: Record<string, RainLevel> = {
  [WeatherState.RAIN_LIGHT]: { particleFraction: 0.35, streakScale: 0.7, speedScale: 0.7 },
  [WeatherState.RAIN_HEAVY]: { particleFraction: 1.0, streakScale: 1.5, speedScale: 1.3 },
}

/** Get effective weather intensities for rendering (handles transitions) */
function getWeatherIntensities(): { rainLevel: RainLevel | null; rainAlpha: number; snow: number; blizzard: number } {
  const blend = isTransitioning ? weatherTransition : 0
  let rainAlpha = 0
  let snow = 0
  let blizzard = 0

  let currentRainLevel: RainLevel | null = null
  let nextRainLevel: RainLevel | null = null

  const currentWeight = 1 - blend

  if (currentWeather === WeatherState.RAIN_LIGHT || currentWeather === WeatherState.RAIN_HEAVY) {
    currentRainLevel = RAIN_LEVELS[currentWeather]
    rainAlpha += currentWeight
  }
  if (currentWeather === WeatherState.SNOW) snow += currentWeight
  if (currentWeather === WeatherState.BLIZZARD) blizzard += currentWeight

  if (isTransitioning) {
    if (nextWeather === WeatherState.RAIN_LIGHT || nextWeather === WeatherState.RAIN_HEAVY) {
      nextRainLevel = RAIN_LEVELS[nextWeather]
      rainAlpha += blend
    }
    if (nextWeather === WeatherState.SNOW) snow += blend
    if (nextWeather === WeatherState.BLIZZARD) blizzard += blend
  }

  let rainLevel: RainLevel | null = null
  if (currentRainLevel && nextRainLevel) {
    rainLevel = {
      particleFraction: currentRainLevel.particleFraction * currentWeight + nextRainLevel.particleFraction * blend,
      streakScale: currentRainLevel.streakScale * currentWeight + nextRainLevel.streakScale * blend,
      speedScale: currentRainLevel.speedScale * currentWeight + nextRainLevel.speedScale * blend,
    }
  } else if (currentRainLevel) {
    rainLevel = currentRainLevel
  } else if (nextRainLevel) {
    rainLevel = nextRainLevel
  }

  return { rainLevel, rainAlpha, snow, blizzard }
}

// ── Glass tint rendering ───────────────────────────────────

/**
 * Compute the glass overlay color and opacity based on sun intensity and color.
 * Returns [r, g, b, alpha].
 */
function getGlassTint(
  sunIntensity: number,
  sunColor: [number, number, number],
  weatherAmount: number,
): [number, number, number, number] {
  if (sunIntensity <= 0) {
    // Full night - dark overlay
    return [...GLASS_NIGHT_COLOR, GLASS_NIGHT_OVERLAY_OPACITY]
  }

  // Blend between night and day based on sun intensity
  const edgeness = Math.max(0, Math.min(1,
    (sunColor[0] - 240) / (255 - 240),
  ))

  // Sky color: blend day sky <-> edge sky
  const skyR = Math.round(GLASS_DAY_SKY_COLOR[0] + edgeness * (GLASS_EDGE_SKY_COLOR[0] - GLASS_DAY_SKY_COLOR[0]))
  const skyG = Math.round(GLASS_DAY_SKY_COLOR[1] + edgeness * (GLASS_EDGE_SKY_COLOR[1] - GLASS_DAY_SKY_COLOR[1]))
  const skyB = Math.round(GLASS_DAY_SKY_COLOR[2] + edgeness * (GLASS_EDGE_SKY_COLOR[2] - GLASS_DAY_SKY_COLOR[2]))

  // Blend between night color and sky color
  const r = Math.round(GLASS_NIGHT_COLOR[0] + sunIntensity * (skyR - GLASS_NIGHT_COLOR[0]))
  const g = Math.round(GLASS_NIGHT_COLOR[1] + sunIntensity * (skyG - GLASS_NIGHT_COLOR[1]))
  const b = Math.round(GLASS_NIGHT_COLOR[2] + sunIntensity * (skyB - GLASS_NIGHT_COLOR[2]))

  // Opacity: high at night, lower during day. Reduced during weather (overcast sky).
  const dayTint = GLASS_DAY_TINT_OPACITY + weatherAmount * (GLASS_DAY_WEATHER_TINT_OPACITY - GLASS_DAY_TINT_OPACITY)
  const alpha = GLASS_NIGHT_OVERLAY_OPACITY + sunIntensity * (dayTint - GLASS_NIGHT_OVERLAY_OPACITY)

  return [r, g, b, alpha]
}

// ── Render ─────────────────────────────────────────────────

/** Pre-computed window effect data for a single frame (shared across all windows). */
export interface WindowEffectFrameData {
  tintR: number
  tintG: number
  tintB: number
  tintAlpha: number
  rainLevel: RainLevel | null
  rainAlpha: number
  snow: number
  blizzard: number
}

/**
 * Compute shared per-frame window effect data (tint color + weather intensities).
 * Call once per frame, then pass to renderSingleWindowEffect for each window.
 */
export function computeWindowEffectFrameData(
  sunIntensity: number,
  sunColor: [number, number, number],
): WindowEffectFrameData {
  const { rainLevel, rainAlpha, snow, blizzard } = getWeatherIntensities()
  const weatherAmount = Math.max(rainAlpha, snow, blizzard)
  const [tintR, tintG, tintB, tintAlpha] = getGlassTint(sunIntensity, sunColor, weatherAmount)
  return { tintR, tintG, tintB, tintAlpha, rainLevel, rainAlpha, snow, blizzard }
}

/**
 * Render glass tint + weather particles for a single window.
 * Designed to be called from a z-sorted drawable so characters render on top.
 */
export function renderSingleWindowEffect(
  ctx: CanvasRenderingContext2D,
  win: FurnitureInstance,
  offsetX: number,
  offsetY: number,
  zoom: number,
  fd: WindowEffectFrameData,
): void {
  const sections = win.glassSections
  if (!sections || sections.length === 0) return

  const winScreenX = offsetX + win.x * zoom
  const winScreenY = offsetY + win.y * zoom
  const winW = win.footprintW * TILE_SIZE * zoom
  const winH = win.footprintH * TILE_SIZE * zoom
  // Fixed reference size for particle space (2×2 tiles) so density is
  // consistent across all window sizes - smaller windows clip into the center
  const refW = 2 * TILE_SIZE * zoom
  const refH = 2 * TILE_SIZE * zoom
  const particleBaseX = winScreenX + (winW - refW) / 2
  const particleBaseY = winScreenY + (winH - refH) / 2

  for (const sec of sections) {
    const sx = winScreenX + sec.x * zoom
    const sy = winScreenY + sec.y * zoom
    const sw = sec.w * zoom
    const sh = sec.h * zoom

    // Glass tint overlay
    ctx.fillStyle = `rgba(${fd.tintR}, ${fd.tintG}, ${fd.tintB}, ${fd.tintAlpha})`
    ctx.fillRect(sx, sy, sw, sh)

    // Weather particles - clip to this glass section, render in window-space coords
    const hasWeather = (fd.rainLevel && fd.rainAlpha > 0) || fd.snow > 0 || fd.blizzard > 0
    if (hasWeather) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(sx, sy, sw, sh)
      ctx.clip()

      // Subtle dark overlay behind weather (cloud cover effect)
      const wi = Math.max(fd.rainAlpha, fd.snow, fd.blizzard)
      ctx.fillStyle = `rgba(0, 0, 0, ${GLASS_WEATHER_DARKEN_OPACITY * wi})`
      ctx.fillRect(sx, sy, sw, sh)

      // Rain - particles in fixed ref space, clipped to glass section
      if (fd.rainLevel && fd.rainAlpha > 0) {
        ctx.globalAlpha = fd.rainAlpha
        ctx.strokeStyle = WEATHER_RAIN_COLOR
        ctx.lineWidth = Math.max(1, zoom * 0.5)
        const count = Math.floor(rainParticles.length * fd.rainLevel.particleFraction)
        for (let i = 0; i < count; i++) {
          const p = rainParticles[i]
          const px = particleBaseX + p.x * refW
          const py = particleBaseY + p.y * refH
          const len = WEATHER_RAIN_LENGTH_PX * zoom * p.size * fd.rainLevel.streakScale
          ctx.beginPath()
          ctx.moveTo(px, py)
          ctx.lineTo(px - 0.3 * zoom, py + len)
          ctx.stroke()
        }
      }

      // Snow - particles in fixed ref space, clipped to glass section
      if (fd.snow > 0) {
        ctx.globalAlpha = fd.snow
        ctx.fillStyle = WEATHER_SNOW_COLOR
        for (const p of snowParticles) {
          const drift = Math.sin(p.driftPhase) * WEATHER_SNOW_DRIFT_AMPLITUDE_PX * zoom
          const px = particleBaseX + ((p.x * refW + drift) % refW + refW) % refW
          const py = particleBaseY + p.y * refH
          const r = WEATHER_SNOW_SIZE_PX * zoom * p.size * 0.5
          ctx.beginPath()
          ctx.arc(px, py, Math.max(0.5, r), 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // Blizzard - dense snow with strong horizontal wind
      if (fd.blizzard > 0) {
        ctx.globalAlpha = fd.blizzard
        ctx.fillStyle = WEATHER_SNOW_COLOR
        for (const p of blizzardParticles) {
          const wobble = Math.sin(p.driftPhase) * 1.5 * zoom
          const px = particleBaseX + p.x * refW
          const py = particleBaseY + p.y * refH + wobble
          const r = WEATHER_SNOW_SIZE_PX * zoom * p.size * 0.5
          ctx.beginPath()
          ctx.arc(px, py, Math.max(0.5, r), 0, Math.PI * 2)
          ctx.fill()
          // Wind streak trail
          ctx.strokeStyle = WEATHER_SNOW_COLOR
          ctx.lineWidth = Math.max(0.5, zoom * 0.3)
          ctx.beginPath()
          ctx.moveTo(px, py)
          ctx.lineTo(px - 2 * zoom * p.size, py + 0.5 * zoom * p.size)
          ctx.stroke()
        }
      }

      ctx.restore()
    }
  }
}

// ── Outdoor weather ────────────────────────────────────────
//
// The windows show the weather through the glass. This lets it fall outside as well: on the empty
// ground around the building, over the outside face of every outer wall, and on floor painted with
// the Outdoors zone. Void is what the layout already means by "not the building", so nothing needs
// marking for the common case; the zone is for outdoor spaces that have a floor, like a patio.
//
// It is drawn in front of the scene, not under it. A walled-in light well is usually a single void
// tile, and the wall below it draws its face straight over that tile - the only outdoors you can
// see there is the brick of the outer wall, so that is what the rain has to fall in front of. And
// it only ever touches the tiles on screen: a void halo around a large office is hundreds of tiles,
// and zoomed in, most of them are nowhere near the view.

/** Where it rains outdoors and how hard: a strength per tile over the grid plus a fading halo */
export interface OutdoorWeatherMap {
  /** Tile coordinates of the map's top-left corner - it starts outside the grid, for the halo */
  col0: number
  row0: number
  cols: number
  rows: number
  /** Strength per tile, 0 = dry, quantised to OUTDOOR_WEATHER_ALPHA_STEPS levels, row-major */
  level: Uint8Array
  /** 1 where only the bottom half of the tile is outdoors - the brick reaching up the face of a wall */
  half: Uint8Array
}

let outdoorCache: { tileMap: TileTypeVal[][]; zones: Array<string | null> | undefined; map: OutdoorWeatherMap } | null = null

/**
 * Work out, once per layout, which tiles are outdoors. Void gets the weather at full strength close
 * to the building and fading to nothing a few tiles out, measured as the distance to the nearest
 * part of the building - so a light well enclosed by walls, being right beside them, gets all of
 * it, and the open ground trails off instead of stopping at the edge of the grid. Void that a wall
 * sprite is drawn over - the tile above any wall, where its dark top and face stand - is not ground
 * you can see, and stays dry. The outside face of an outer wall (a wall with void below it) gets it
 * at full strength over exactly the part the brick facade covers: the wall tile, and the tile above
 * too when that is void, else only the bottom half of it. Other floor tiles get it only when
 * painted with the Outdoors zone.
 */
export function getOutdoorWeatherMap(
  tileMap: TileTypeVal[][],
  zones: Array<string | null> | undefined,
  zoneCols: number,
): OutdoorWeatherMap {
  if (outdoorCache && outdoorCache.tileMap === tileMap && outdoorCache.zones === zones) return outdoorCache.map

  const gridRows = tileMap.length
  const gridCols = gridRows > 0 ? tileMap[0].length : 0
  const F = OUTDOOR_WEATHER_FADE_TILES
  const cols = gridCols + 2 * F
  const rows = gridRows + 2 * F
  const col0 = -F
  const row0 = -F
  const at = (c: number, r: number) => (r - row0) * cols + (c - col0)
  const isVoid = (c: number, r: number) =>
    r < 0 || c < 0 || r >= gridRows || c >= gridCols || tileMap[r][c] === TileType.VOID

  // Distance from the building, in tiles, allowing diagonals - a breadth-first flood outward from
  // every tile that is not void
  const dist = new Int16Array(cols * rows).fill(-1)
  const queue: number[] = []
  for (let r = row0; r < row0 + rows; r++) {
    for (let c = col0; c < col0 + cols; c++) {
      if (!isVoid(c, r)) { dist[at(c, r)] = 0; queue.push(c, r) }
    }
  }
  for (let q = 0; q < queue.length; q += 2) {
    const c = queue[q], r = queue[q + 1]
    const d = dist[at(c, r)]
    if (d >= F) continue
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nc = c + dc, nr = r + dr
        if (nc < col0 || nr < row0 || nc >= col0 + cols || nr >= row0 + rows) continue
        const i = at(nc, nr)
        if (dist[i] !== -1) continue
        dist[i] = d + 1
        queue.push(nc, nr)
      }
    }
  }

  const steps = OUTDOOR_WEATHER_ALPHA_STEPS
  const full = OUTDOOR_WEATHER_FULL_TILES
  const level = new Uint8Array(cols * rows)
  const half = new Uint8Array(cols * rows)
  const isWall = (c: number, r: number) =>
    r >= 0 && c >= 0 && r < gridRows && c < gridCols && tileMap[r][c] === TileType.WALL
  for (let r = row0; r < row0 + rows; r++) {
    for (let c = col0; c < col0 + cols; c++) {
      const i = at(c, r)
      if (!isVoid(c, r)) {
        if (zones?.[r * zoneCols + c] === 'outdoor') level[i] = steps
        // The outside face of an outer wall
        if (isWall(c, r) && isVoid(c, r + 1)) {
          level[i] = steps
          half[i] = 0
          const above = at(c, r - 1)
          if (isVoid(c, r - 1)) { level[above] = steps; half[above] = 0 }
          else if (level[above] === 0) { level[above] = steps; half[above] = 1 }
        }
        continue
      }
      // Hidden behind the wall below it, unless that wall is an outer one whose brick covers it
      if (isWall(c, r + 1)) {
        if (isVoid(c, r + 2)) level[i] = steps
        continue
      }
      const d = dist[i]
      if (d < 0 || d >= F) continue
      const strength = d <= full ? 1 : 1 - (d - full) / (F - full)
      level[i] = Math.round(strength * steps)
    }
  }

  const map = { col0, row0, cols, rows, level, half }
  outdoorCache = { tileMap, zones, map }
  return map
}

/** Is there any weather to draw at all? Clear skies cost nothing. */
export function isWeatherActive(): boolean {
  const { rainLevel, rainAlpha, snow, blizzard } = getWeatherIntensities()
  return (!!rainLevel && rainAlpha > 0) || snow > 0 || blizzard > 0
}

/** The tile range of the map that is actually on the canvas, or null if none of it is */
function visibleRange(
  map: OutdoorWeatherMap, offsetX: number, offsetY: number, zoom: number, canvasW: number, canvasH: number,
): { c0: number; c1: number; r0: number; r1: number } | null {
  const s = TILE_SIZE * zoom
  const c0 = Math.max(map.col0, Math.floor(-offsetX / s))
  const c1 = Math.min(map.col0 + map.cols - 1, Math.floor((canvasW - 1 - offsetX) / s))
  const r0 = Math.max(map.row0, Math.floor(-offsetY / s))
  const r1 = Math.min(map.row0 + map.rows - 1, Math.floor((canvasH - 1 - offsetY) / s))
  return c0 > c1 || r0 > r1 ? null : { c0, c1, r0, r1 }
}

/**
 * Screen rectangles the outdoor weather will draw into this frame - one per run of wet tiles in a
 * row, clipped to the canvas. The headless renderer damages these, since rain never looks the same
 * twice; empty when the sky is clear.
 */
export function outdoorWeatherRects(
  map: OutdoorWeatherMap, offsetX: number, offsetY: number, zoom: number, canvasW: number, canvasH: number,
): Array<{ x: number; y: number; w: number; h: number }> {
  const out: Array<{ x: number; y: number; w: number; h: number }> = []
  if (!isWeatherActive()) return out
  const v = visibleRange(map, offsetX, offsetY, zoom, canvasW, canvasH)
  if (!v) return out
  const s = TILE_SIZE * zoom
  for (let r = v.r0; r <= v.r1; r++) {
    let runStart = -1
    for (let c = v.c0; c <= v.c1 + 1; c++) {
      const wet = c <= v.c1 && map.level[(r - map.row0) * map.cols + (c - map.col0)] > 0
      if (wet && runStart < 0) runStart = c
      if (!wet && runStart >= 0) {
        // Drawing is clipped to the wet tiles, so a streak never reaches past them
        out.push({ x: offsetX + runStart * s, y: offsetY + r * s, w: (c - runStart) * s, h: s })
        runStart = -1
      }
    }
  }
  return out
}

/** A stable per-cell shift, so the particle pattern does not visibly repeat every two tiles */
function cellShift(cc: number, cr: number): number {
  return ((Math.imul(cc, 73856093) ^ Math.imul(cr, 19349663)) >>> 0) / 4294967296
}

/** The wrap of a value into [0, 1) */
const frac = (v: number) => v - Math.floor(v)

/**
 * Draw the outdoor weather. The particles are the same ones the windows use, laid over the ground
 * in two-tile cells (the space the windows draw them in), thinned and faded. Each strength level
 * is one batched path, so a screen full of rain is a handful of draw calls, not one per drop.
 */
export function renderOutdoorWeather(
  ctx: CanvasRenderingContext2D,
  map: OutdoorWeatherMap,
  offsetX: number,
  offsetY: number,
  zoom: number,
  canvasW: number,
  canvasH: number,
): void {
  const { rainLevel, rainAlpha, snow, blizzard } = getWeatherIntensities()
  const raining = !!rainLevel && rainAlpha > 0
  if (!raining && snow <= 0 && blizzard <= 0) return
  const v = visibleRange(map, offsetX, offsetY, zoom, canvasW, canvasH)
  if (!v) return

  // Sort the visible wet tiles by strength first, so each strength is drawn in a single pass
  const steps = OUTDOOR_WEATHER_ALPHA_STEPS
  const byLevel: number[][] = Array.from({ length: steps + 1 }, () => [])
  for (let r = v.r0; r <= v.r1; r++) {
    for (let c = v.c0; c <= v.c1; c++) {
      const lv = map.level[(r - map.row0) * map.cols + (c - map.col0)]
      if (lv > 0) byLevel[lv].push(c, r)
    }
  }

  const s = TILE_SIZE * zoom
  const cell = 2 * TILE_SIZE // world px - the same space the windows draw particles in

  /**
   * Visit every particle of a set that lands on the given tile, with its screen position. A particle
   * belongs to the tile whose quarter of the cell it falls in, after the cell's own shift.
   */
  const eachOnTile = (
    set: WeatherParticle[], count: number, c: number, r: number,
    xOf: (p: WeatherParticle) => number,
    visit: (p: WeatherParticle, sx: number, sy: number) => void,
  ) => {
    const qx = c & 1, qy = r & 1
    const shift = cellShift(c >> 1, r >> 1)
    const tileX = offsetX + c * s
    const tileY = offsetY + r * s
    for (let i = 0; i < count; i++) {
      const p = set[i]
      const wx = frac(xOf(p) + shift) * cell
      const wy = frac(p.y) * cell
      if ((wx >= TILE_SIZE ? 1 : 0) !== qx || (wy >= TILE_SIZE ? 1 : 0) !== qy) continue
      visit(p, tileX + (wx - qx * TILE_SIZE) * zoom, tileY + (wy - qy * TILE_SIZE) * zoom)
    }
  }

  // Clip to the wet area itself: a streak starting low in a tile would otherwise run on into the
  // office below it, and a wind-blown one into the wall beside it
  ctx.save()
  ctx.beginPath()
  const hs = Math.round(s / 2)
  for (let r = v.r0; r <= v.r1; r++) {
    for (let c = v.c0; c <= v.c1; c++) {
      const i = (r - map.row0) * map.cols + (c - map.col0)
      if (map.level[i] === 0) continue
      const x = offsetX + c * s, y = offsetY + r * s
      if (map.half[i]) ctx.rect(x, y + hs, s, s - hs)
      else ctx.rect(x, y, s, s)
    }
  }
  ctx.clip()
  for (let lv = 1; lv <= steps; lv++) {
    const tiles = byLevel[lv]
    if (tiles.length === 0) continue
    const strength = (lv / steps) * OUTDOOR_WEATHER_OPACITY

    if (raining) {
      const count = Math.floor(rainParticles.length * rainLevel!.particleFraction * OUTDOOR_WEATHER_DENSITY)
      ctx.globalAlpha = rainAlpha * strength
      ctx.strokeStyle = WEATHER_RAIN_COLOR
      ctx.lineWidth = Math.max(1, zoom * 0.5)
      ctx.beginPath()
      for (let t = 0; t < tiles.length; t += 2) {
        eachOnTile(rainParticles, count, tiles[t], tiles[t + 1], (p) => p.x, (p, sx, sy) => {
          const len = WEATHER_RAIN_LENGTH_PX * zoom * p.size * rainLevel!.streakScale
          ctx.moveTo(sx, sy)
          ctx.lineTo(sx - 0.3 * zoom, sy + len)
        })
      }
      ctx.stroke()
    }

    if (snow > 0) {
      const count = Math.floor(snowParticles.length * OUTDOOR_WEATHER_DENSITY)
      ctx.globalAlpha = snow * strength
      ctx.fillStyle = WEATHER_SNOW_COLOR
      ctx.beginPath()
      for (let t = 0; t < tiles.length; t += 2) {
        eachOnTile(snowParticles, count, tiles[t], tiles[t + 1],
          (p) => p.x + (Math.sin(p.driftPhase) * WEATHER_SNOW_DRIFT_AMPLITUDE_PX) / cell,
          (p, sx, sy) => {
            const size = Math.max(1, Math.round(WEATHER_SNOW_SIZE_PX * zoom * p.size))
            ctx.rect(sx, sy, size, size)
          })
      }
      ctx.fill()
    }

    if (blizzard > 0) {
      const count = Math.floor(blizzardParticles.length * OUTDOOR_WEATHER_DENSITY)
      ctx.globalAlpha = blizzard * strength
      ctx.fillStyle = WEATHER_SNOW_COLOR
      ctx.strokeStyle = WEATHER_SNOW_COLOR
      ctx.lineWidth = Math.max(0.5, zoom * 0.3)
      ctx.beginPath()
      const flakes: number[] = []
      for (let t = 0; t < tiles.length; t += 2) {
        eachOnTile(blizzardParticles, count, tiles[t], tiles[t + 1], (p) => p.x, (p, sx, sy) => {
          const size = Math.max(1, Math.round(WEATHER_SNOW_SIZE_PX * zoom * p.size))
          flakes.push(sx, sy, size)
          // Wind streak behind each flake
          ctx.moveTo(sx, sy)
          ctx.lineTo(sx - 2 * zoom * p.size, sy + 0.5 * zoom * p.size)
        })
      }
      ctx.stroke()
      ctx.beginPath()
      for (let i = 0; i < flakes.length; i += 3) ctx.rect(flakes[i], flakes[i + 1], flakes[i + 2], flakes[i + 2])
      ctx.fill()
    }
  }
  ctx.restore()
}
