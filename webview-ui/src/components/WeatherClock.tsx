import { useState, useEffect, useRef, useCallback } from 'react'
import { getSunPhase } from '../office/engine/sunlight.js'
import { getCurrentWeather, WeatherState } from '../office/engine/windowEffects.js'

// ── Pixel art sprites ──────────────────────────────────────

const SUN = [
  '.......*........',
  '....*...*...*...',
  '................',
  '....AAAAAA......',
  '...AABBBBAA.....',
  '...ABBBBBBA..*..',
  '..AABBBBBBAA....',
  '*..ABBBBBBA....*',
  '..AABBBBBBAA....',
  '...ABBBBBBA..*..',
  '...AABBBBAA.....',
  '....AAAAAA......',
  '................',
  '....*...*...*...',
  '.......*........',
  '................',
]

const SUN_RISING = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '.......*........',
  '....AAAAAA......',
  '...AABBBBAA.....',
  '*..ABBBBBBA..*..',
  '..AABBBBBBAA....',
  '..AABBBBBBAA....',
  'CCCCCCCCCCCCCCCC',
  '................',
]

const MOON = [
  '................',
  '.....AAAA.......',
  '....AABBBA......',
  '...AABBBBA......',
  '..AABBBA........',
  '..AABBA.........',
  '..AABBA.........',
  '..AABBA.........',
  '..AABBA.........',
  '..AABBA.........',
  '..AABBBA........',
  '...AABBBBA......',
  '....AABBBA......',
  '.....AAAA.......',
  '................',
  '................',
]

const RAIN_CLOUD = [
  '................',
  '......AA........',
  '....AACCAA......',
  '..AACCCCCCAA....',
  '.AACCCCCCCCA....',
  'AACCCCCCCCCCAA..',
  'ACCCCCCCCCCCCA..',
  'AACCCCCCCCCCAA..',
  '..AAAAAAAAAA....',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
]

const SUN_PALETTE: Record<string, string> = { A: '#E8A020', B: '#FFD866', '*': '#FFE888' }
const SUNRISE_PALETTE: Record<string, string> = { A: '#D07828', B: '#F0A848', '*': '#FFD070', C: '#443355' }
const MOON_PALETTE: Record<string, string> = { A: '#667888', B: '#A0B8D0' }
const DARK_CLOUD_PALETTE: Record<string, string> = { A: '#556070', C: '#3C4858' }
const SNOW_CLOUD_PALETTE: Record<string, string> = { A: '#7088A0', C: '#506878' }

function drawSprite(
  ctx: CanvasRenderingContext2D,
  pixels: string[],
  pal: Record<string, string>,
  x: number,
  y: number,
  s: number,
) {
  for (let r = 0; r < pixels.length; r++) {
    for (let c = 0; c < pixels[r].length; c++) {
      const ch = pixels[r][c]
      if (ch !== '.' && pal[ch]) {
        ctx.fillStyle = pal[ch]
        ctx.fillRect(x + c * s, y + r * s, s, s)
      }
    }
  }
}

function drawRainDrops(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, heavy: boolean) {
  ctx.fillStyle = '#5577AA'
  const cols = heavy ? [2, 4, 7, 9, 12, 14] : [3, 8, 12]
  const rows = heavy ? [0, 2, 1, 3, 0, 2] : [0, 2, 1]
  for (let i = 0; i < cols.length; i++) {
    ctx.fillRect(x + cols[i] * s, y + rows[i] * s, s, s * 2)
  }
}

function drawSnowFlakes(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, blizzard: boolean) {
  ctx.fillStyle = '#CCDDEE'
  const cols = blizzard ? [1, 3, 5, 7, 9, 11, 13, 15] : [2, 6, 10, 14]
  const rows = blizzard ? [0, 2, 1, 3, 0, 2, 1, 3] : [0, 2, 1, 3]
  for (let i = 0; i < cols.length; i++) {
    ctx.fillRect(x + cols[i] * s, y + rows[i] * s, s, s)
  }
}

function drawStars(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, seed: number) {
  const pts = [[1, 2], [5, 0], [10, 3], [14, 1], [3, 5], [8, 4], [12, 6], [15, 5]]
  for (let i = 0; i < pts.length; i++) {
    const p = (seed + i * 1.7) % 3
    ctx.fillStyle = p < 1.5 ? '#FFFFFF' : '#889AAA'
    ctx.globalAlpha = p < 1.5 ? 0.7 : 0.3
    ctx.fillRect(x + pts[i][0] * s, y + pts[i][1] * s, s, s)
  }
  ctx.globalAlpha = 1
}

// ── Scene helpers ─────────────────────────────────────────

type SunPhase = 'sunrise' | 'morning' | 'midday' | 'afternoon' | 'sunset' | 'night'
type CelestialType = 'sun' | 'sunrise' | 'moon'
type WeatherSpriteType = 'rain' | 'heavy_rain' | 'snow' | 'blizzard' | null

function celestialForPhase(phase: SunPhase): CelestialType {
  if (phase === 'night') return 'moon'
  if (phase === 'sunrise' || phase === 'sunset') return 'sunrise'
  return 'sun'
}

function weatherSpriteType(w: WeatherState): WeatherSpriteType {
  if (w === WeatherState.RAIN_LIGHT) return 'rain'
  if (w === WeatherState.RAIN_HEAVY) return 'heavy_rain'
  if (w === WeatherState.SNOW) return 'snow'
  if (w === WeatherState.BLIZZARD) return 'blizzard'
  return null
}

const PX = 2
const SW = 16 * PX
const SH = 16 * PX

function renderCelestial(ctx: CanvasRenderingContext2D, phase: SunPhase, starSeed: number) {
  ctx.clearRect(0, 0, SW, SH)
  ctx.imageSmoothingEnabled = false
  const type = celestialForPhase(phase)
  if (type === 'moon') {
    drawStars(ctx, 0, 0, PX, starSeed)
    drawSprite(ctx, MOON, MOON_PALETTE, 0, 0, PX)
  } else if (type === 'sunrise') {
    drawSprite(ctx, SUN_RISING, SUNRISE_PALETTE, 0, 0, PX)
  } else {
    drawSprite(ctx, SUN, SUN_PALETTE, 0, 0, PX)
  }
}

function renderWeatherIcon(ctx: CanvasRenderingContext2D, weather: WeatherState) {
  ctx.clearRect(0, 0, SW, SH)
  ctx.imageSmoothingEnabled = false
  const ws = weatherSpriteType(weather)
  if (!ws) return
  const pal = (ws === 'snow' || ws === 'blizzard') ? SNOW_CLOUD_PALETTE : DARK_CLOUD_PALETTE
  drawSprite(ctx, RAIN_CLOUD, pal, 0, 0, PX)
  if (ws === 'rain') drawRainDrops(ctx, 0, 10 * PX, PX, false)
  else if (ws === 'heavy_rain') drawRainDrops(ctx, 0, 10 * PX, PX, true)
  else if (ws === 'snow') drawSnowFlakes(ctx, 0, 10 * PX, PX, false)
  else if (ws === 'blizzard') drawSnowFlakes(ctx, 0, 10 * PX, PX, true)
}

// ── Labels ────────────────────────────────────────────────

function weatherLabel(w: WeatherState): string {
  switch (w) {
    case WeatherState.CLEAR: return 'Clear'
    case WeatherState.RAIN_LIGHT: return 'Light Rain'
    case WeatherState.RAIN_HEAVY: return 'Heavy Rain'
    case WeatherState.SNOW: return 'Snow'
    case WeatherState.BLIZZARD: return 'Blizzard'
    default: return 'Clear'
  }
}

function phaseLabel(phase: SunPhase): string {
  switch (phase) {
    case 'sunrise': return 'Sunrise'
    case 'morning': return 'Morning'
    case 'midday': return 'Midday'
    case 'afternoon': return 'Afternoon'
    case 'sunset': return 'Sunset'
    case 'night': return 'Night'
    default: return ''
  }
}

// ── Crossfade hook ────────────────────────────────────────
// Two stacked canvases: "active" is visible (opacity 1), "pending" is hidden (opacity 0).
// On crossfade: draw new content on pending, then animate active→0 and pending→1 simultaneously.
// After done, swap roles.

const TRANSITION_MS = 1500

function useCrossfadeCanvas() {
  const aRef = useRef<HTMLCanvasElement>(null)
  const bRef = useRef<HTMLCanvasElement>(null)
  // true = A is the active (visible) canvas
  const activeIsA = useRef(true)
  const transRef = useRef({ active: false, rafId: 0 })
  const [aOp, setAOp] = useState(1)
  const [bOp, setBOp] = useState(0) // B starts hidden

  /** Draw directly on the active (visible) canvas — no transition */
  const drawActive = useCallback((draw: (ctx: CanvasRenderingContext2D) => void) => {
    const canvas = (activeIsA.current ? aRef : bRef).current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (ctx) draw(ctx)
  }, [])

  /** Crossfade from current content to new content */
  const crossfadeTo = useCallback((draw: (ctx: CanvasRenderingContext2D) => void) => {
    // Draw new content on the hidden (pending) canvas
    const pendingRef = activeIsA.current ? bRef : aRef
    const pendingCanvas = pendingRef.current
    if (!pendingCanvas) return
    const ctx = pendingCanvas.getContext('2d')
    if (!ctx) return
    draw(ctx)

    // Make pending visible at 0 opacity before animating
    const setPendingOp = activeIsA.current ? setBOp : setAOp
    const setActiveOp = activeIsA.current ? setAOp : setBOp
    setPendingOp(0)

    cancelAnimationFrame(transRef.current.rafId)
    transRef.current.active = true
    const start = performance.now()

    function animate(now: number) {
      const t = Math.min((now - start) / TRANSITION_MS, 1)
      setActiveOp(1 - t)  // old fades out
      setPendingOp(t)     // new fades in
      if (t < 1) {
        transRef.current.rafId = requestAnimationFrame(animate)
      } else {
        // Done — swap roles
        activeIsA.current = !activeIsA.current
        transRef.current.active = false
      }
    }
    transRef.current.rafId = requestAnimationFrame(animate)
  }, [])

  const isTransitioning = useCallback(() => transRef.current.active, [])

  useEffect(() => () => cancelAnimationFrame(transRef.current.rafId), [])

  return { aRef, bRef, aOp, bOp, drawActive, crossfadeTo, isTransitioning }
}

// ── Component ──────────────────────────────────────────────

interface WeatherClockProps {
  visible: boolean
}

export function WeatherClock({ visible }: WeatherClockProps) {
  const cel = useCrossfadeCanvas()
  const wx = useCrossfadeCanvas()

  const [phase, setPhase] = useState<SunPhase>('midday')
  const [weather, setWeather] = useState<WeatherState>(WeatherState.CLEAR)
  const [isHovered, setIsHovered] = useState(false)

  // Displayed labels (swapped at transition midpoint)
  const [dispPhase, setDispPhase] = useState<SunPhase>('midday')
  const [dispWeather, setDispWeather] = useState<WeatherState>(WeatherState.CLEAR)
  const [textOp, setTextOp] = useState(1)
  const textTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const prevCelType = useRef<CelestialType>(celestialForPhase('midday'))
  const prevWxType = useRef<WeatherSpriteType>(weatherSpriteType(WeatherState.CLEAR))
  const starSeed = useRef(0)

  // Poll game state
  useEffect(() => {
    if (!visible) return
    const tick = () => {
      setPhase(getSunPhase().phase as SunPhase)
      setWeather(getCurrentWeather())
    }
    tick()
    const id = setInterval(tick, 500)
    return () => clearInterval(id)
  }, [visible])

  // Celestial sprite change → crossfade
  useEffect(() => {
    if (!visible) return
    const newType = celestialForPhase(phase)
    if (newType !== prevCelType.current) {
      prevCelType.current = newType
      cel.crossfadeTo(ctx => renderCelestial(ctx, phase, starSeed.current))
    }
  }, [visible, phase, cel])

  // Weather sprite change → crossfade
  useEffect(() => {
    if (!visible) return
    const newType = weatherSpriteType(weather)
    if (newType !== prevWxType.current) {
      prevWxType.current = newType
      wx.crossfadeTo(ctx => renderWeatherIcon(ctx, weather))
    }
  }, [visible, weather, wx])

  // Text fade on any label change
  useEffect(() => {
    if (!visible) return
    if (phase === dispPhase && weather === dispWeather) return
    setTextOp(0)
    if (textTimerRef.current) clearTimeout(textTimerRef.current)
    textTimerRef.current = setTimeout(() => {
      setDispPhase(phase)
      setDispWeather(weather)
      setTextOp(1)
    }, TRANSITION_MS / 2)
  }, [visible, phase, weather, dispPhase, dispWeather])

  // Initial draw — draw directly on active canvases, no crossfade
  const didInit = useRef(false)
  useEffect(() => {
    if (!visible || didInit.current) return
    didInit.current = true
    cel.drawActive(ctx => renderCelestial(ctx, phase, 0))
    wx.drawActive(ctx => renderWeatherIcon(ctx, weather))
    // Sync prev refs so change detection doesn't immediately fire a crossfade
    prevCelType.current = celestialForPhase(phase)
    prevWxType.current = weatherSpriteType(weather)
    setDispPhase(phase)
    setDispWeather(weather)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, phase, weather])

  // Star twinkle (redraw active canvas, no transition)
  useEffect(() => {
    if (!visible || phase !== 'night') return
    const id = setInterval(() => {
      if (cel.isTransitioning()) return
      starSeed.current = (starSeed.current + 0.3) % 100
      cel.drawActive(ctx => renderCelestial(ctx, 'night', starSeed.current))
    }, 2000)
    return () => clearInterval(id)
  }, [visible, phase, cel])

  useEffect(() => () => { if (textTimerRef.current) clearTimeout(textTimerRef.current) }, [])

  if (!visible) return null

  const isNight = dispPhase === 'night'
  // Check both current and displayed weather — show icon if either has a sprite
  // (so the icon stays mounted during transitions to/from clear)
  const hasWxSprite = weatherSpriteType(weather) !== null || weatherSpriteType(dispWeather) !== null

  const cStyle: React.CSSProperties = {
    position: 'absolute', top: 0, left: 0,
    width: SW, height: SH,
    imageRendering: 'pixelated', display: 'block',
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 48,
        opacity: isHovered ? 1 : 0.6,
        transition: 'opacity 0.3s',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--pixel-bg)',
        border: '2px solid var(--pixel-border)',
        borderRadius: 0,
        padding: '3px 8px',
        boxShadow: 'var(--pixel-shadow)',
        pointerEvents: 'auto',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Celestial */}
      <div style={{ position: 'relative', width: SW, height: SH, flexShrink: 0 }}>
        <canvas ref={cel.aRef} width={SW} height={SH} style={{ ...cStyle, opacity: cel.aOp }} />
        <canvas ref={cel.bRef} width={SW} height={SH} style={{ ...cStyle, opacity: cel.bOp }} />
      </div>

      {/* Phase */}
      <span style={{
        fontSize: '18px',
        color: isNight ? '#8899BB' : 'var(--pixel-text)',
        whiteSpace: 'nowrap',
        opacity: textOp,
        transition: `opacity ${TRANSITION_MS / 2}ms ease`,
      }}>
        {phaseLabel(dispPhase)}
      </span>

      <div style={{ width: 2, height: 20, background: 'var(--pixel-border)', flexShrink: 0 }} />

      {/* Weather icon (only when not clear) */}
      {hasWxSprite && (
        <div style={{ position: 'relative', width: SW, height: SH, flexShrink: 0 }}>
          <canvas ref={wx.aRef} width={SW} height={SH} style={{ ...cStyle, opacity: wx.aOp }} />
          <canvas ref={wx.bRef} width={SW} height={SH} style={{ ...cStyle, opacity: wx.bOp }} />
        </div>
      )}

      {/* Weather label */}
      <span style={{
        fontSize: '14px',
        color: isNight ? '#667799' : 'var(--pixel-text-dim)',
        whiteSpace: 'nowrap',
        opacity: textOp,
        transition: `opacity ${TRANSITION_MS / 2}ms ease`,
      }}>
        {weatherLabel(dispWeather)}
      </span>
    </div>
  )
}
