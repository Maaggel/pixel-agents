import { TILE_SIZE } from '../types.js'
import type { FurnitureInstance } from '../types.js'
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
interface RainLevel {
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
    // Full night — dark overlay
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

/**
 * Render glass tint overlays and weather particles on all windows.
 * Call after renderScene() — windows are on walls so z-order with characters is not an issue.
 */
export function renderWindowEffects(
  ctx: CanvasRenderingContext2D,
  furniture: FurnitureInstance[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  sunIntensity: number,
  sunColor: [number, number, number],
): void {
  const windows = furniture.filter(f => f.glassSections && f.glassSections.length > 0)
  if (windows.length === 0) return

  const { rainLevel, rainAlpha, snow, blizzard } = getWeatherIntensities()
  const weatherAmount = Math.max(rainAlpha, snow, blizzard)
  const [tintR, tintG, tintB, tintAlpha] = getGlassTint(sunIntensity, sunColor, weatherAmount)

  ctx.save()

  // Fixed reference size for particle space (2×2 tiles) so density is
  // consistent across all window sizes — smaller windows clip into the center
  const refW = 2 * TILE_SIZE * zoom
  const refH = 2 * TILE_SIZE * zoom

  for (const win of windows) {
    const sections = win.glassSections!
    const winScreenX = offsetX + win.x * zoom
    const winScreenY = offsetY + win.y * zoom
    const winW = win.footprintW * TILE_SIZE * zoom
    const winH = win.footprintH * TILE_SIZE * zoom
    // Center the fixed-size particle field on the window
    const particleBaseX = winScreenX + (winW - refW) / 2
    const particleBaseY = winScreenY + (winH - refH) / 2

    for (const sec of sections) {
      const sx = winScreenX + sec.x * zoom
      const sy = winScreenY + sec.y * zoom
      const sw = sec.w * zoom
      const sh = sec.h * zoom

      // Glass tint overlay
      ctx.fillStyle = `rgba(${tintR}, ${tintG}, ${tintB}, ${tintAlpha})`
      ctx.fillRect(sx, sy, sw, sh)

      // Weather particles — clip to this glass section, render in window-space coords
      const hasWeather = (rainLevel && rainAlpha > 0) || snow > 0 || blizzard > 0
      if (hasWeather) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(sx, sy, sw, sh)
        ctx.clip()

        // Subtle dark overlay behind weather (cloud cover effect)
        const wi = Math.max(rainAlpha, snow, blizzard)
        ctx.fillStyle = `rgba(0, 0, 0, ${GLASS_WEATHER_DARKEN_OPACITY * wi})`
        ctx.fillRect(sx, sy, sw, sh)

        // Rain — particles in fixed ref space, clipped to glass section
        if (rainLevel && rainAlpha > 0) {
          ctx.globalAlpha = rainAlpha
          ctx.strokeStyle = WEATHER_RAIN_COLOR
          ctx.lineWidth = Math.max(1, zoom * 0.5)
          const count = Math.floor(rainParticles.length * rainLevel.particleFraction)
          for (let i = 0; i < count; i++) {
            const p = rainParticles[i]
            const px = particleBaseX + p.x * refW
            const py = particleBaseY + p.y * refH
            const len = WEATHER_RAIN_LENGTH_PX * zoom * p.size * rainLevel.streakScale
            ctx.beginPath()
            ctx.moveTo(px, py)
            ctx.lineTo(px - 0.3 * zoom, py + len)
            ctx.stroke()
          }
        }

        // Snow — particles in fixed ref space, clipped to glass section
        if (snow > 0) {
          ctx.globalAlpha = snow
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

        // Blizzard — dense snow with strong horizontal wind
        if (blizzard > 0) {
          ctx.globalAlpha = blizzard
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

  ctx.restore()
}
