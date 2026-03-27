import { TileType, TILE_SIZE } from '../types.js'
import type { TileType as TileTypeVal, FurnitureInstance } from '../types.js'
import {
  SUN_CYCLE_DURATION_SEC,
  SUN_NIGHT_FRACTION,
  SUN_BEAM_MAX_LENGTH,
  SUN_BEAM_OPACITY,
  SUN_BEAM_COLOR,
  SUN_ANGLE_MIN_RAD,
  SUN_ANGLE_MAX_RAD,
  SUN_BEAM_DEFAULT_INSET,
} from '../../constants.js'

// ── Sun cycle state ─────────────────────────────────────────────

let sunCycleTime = 0

/** Advance the sun cycle by dt seconds. */
export function updateSunCycle(dt: number): void {
  sunCycleTime = (sunCycleTime + dt) % SUN_CYCLE_DURATION_SEC
}

/** Reset sun cycle (e.g. on layout reload). */
export function resetSunCycle(): void {
  sunCycleTime = 0
}

/**
 * Compute current sun angle and intensity from cycle time.
 * Returns { angle: radians, intensity: 0-1 }.
 * During the "night" phase intensity fades to 0.
 */
export function getSunState(): { angle: number; intensity: number } {
  const dayDuration = SUN_CYCLE_DURATION_SEC * (1 - SUN_NIGHT_FRACTION)
  const nightDuration = SUN_CYCLE_DURATION_SEC * SUN_NIGHT_FRACTION

  if (sunCycleTime < dayDuration) {
    // Day phase: sweep angle from min → max
    const t = sunCycleTime / dayDuration // 0 → 1
    const angle = SUN_ANGLE_MIN_RAD + t * (SUN_ANGLE_MAX_RAD - SUN_ANGLE_MIN_RAD)

    // Fade in at sunrise (first 10%) and fade out at sunset (last 10%)
    let intensity = 1.0
    if (t < 0.1) {
      intensity = t / 0.1
    } else if (t > 0.9) {
      intensity = (1.0 - t) / 0.1
    }

    return { angle, intensity }
  } else {
    // Night phase: intensity = 0
    const nightT = (sunCycleTime - dayDuration) / nightDuration
    // Brief dawn glow at end of night
    const intensity = nightT > 0.8 ? (nightT - 0.8) / 0.2 * 0.3 : 0
    const angle = intensity > 0 ? SUN_ANGLE_MIN_RAD : 0
    return { angle, intensity }
  }
}

// ── Beam geometry ───────────────────────────────────────────────

/** A sunlight beam as a trapezoid polygon with fade info */
export interface SunBeam {
  /** Top-left x of beam at window (sprite pixels) */
  topLeftX: number
  /** Top-right x of beam at window (sprite pixels) */
  topRightX: number
  /** Bottom-left x at beam end (sprite pixels) */
  bottomLeftX: number
  /** Bottom-right x at beam end (sprite pixels) */
  bottomRightX: number
  /** Y of beam start — bottom edge of window (sprite pixels) */
  topY: number
  /** Y of beam end (sprite pixels) */
  bottomY: number
  /** Peak opacity (already scaled by sun intensity) */
  opacity: number
}

/**
 * Compute sunlight beams for all sunlight-emitting furniture.
 * Each beam is a straight trapezoid from the window edges projected at the sun angle.
 * Beams stop when hitting a full wall row (but pass through door openings).
 */
export function computeSunBeams(
  furniture: FurnitureInstance[],
  tileMap: TileTypeVal[][],
  sunAngle: number,
  sunIntensity: number,
): SunBeam[] {
  if (sunIntensity <= 0) return []

  const beams: SunBeam[] = []
  const rows = tileMap.length
  const cols = rows > 0 ? tileMap[0].length : 0

  for (const f of furniture) {
    if (!f.sunlight) continue

    // Window position in sprite-pixel coords, narrowed by inset
    const inset = f.sunlightInset ?? SUN_BEAM_DEFAULT_INSET
    const winLeftPx = f.col * TILE_SIZE + inset
    const winRightPx = (f.col + f.footprintW) * TILE_SIZE - inset
    const winBottomY = (f.row + f.footprintH) * TILE_SIZE

    const tan = Math.tan(sunAngle)

    // Skip wall rows directly below the window so beams don't overlap walls
    let startDist = 1
    for (let dist = 1; dist <= SUN_BEAM_MAX_LENGTH; dist++) {
      const checkRow = f.row + f.footprintH + dist - 1
      if (checkRow < 0 || checkRow >= rows) break
      if (tileMap[checkRow][Math.floor((winLeftPx + winRightPx) / 2 / TILE_SIZE)] === TileType.WALL) {
        startDist = dist + 1
      } else {
        break
      }
    }

    // Walk rows downward to find how far the beam can reach
    let maxDist = 0
    for (let dist = startDist; dist <= SUN_BEAM_MAX_LENGTH; dist++) {
      const beamRow = f.row + f.footprintH + dist - 1
      if (beamRow < 0 || beamRow >= rows) break

      // Check if this row is a solid wall across the beam path
      // Only block if ALL tiles the beam covers at this row are walls
      // (door openings = floor tiles will let light through)
      const beamCenterX = (winLeftPx + winRightPx) / 2 + tan * dist * TILE_SIZE
      const beamHalfW = (winRightPx - winLeftPx) / 2 + Math.abs(tan) * dist * TILE_SIZE * 0.3
      const testColLeft = Math.max(0, Math.floor((beamCenterX - beamHalfW) / TILE_SIZE))
      const testColRight = Math.min(cols - 1, Math.floor((beamCenterX + beamHalfW) / TILE_SIZE))

      let allWall = true
      for (let c = testColLeft; c <= testColRight; c++) {
        if (tileMap[beamRow][c] !== TileType.WALL) {
          allWall = false
          break
        }
      }
      if (allWall && testColLeft <= testColRight) break

      maxDist = dist
    }

    if (maxDist === 0) continue

    // Compute trapezoid corners — beam fans out based on window height.
    // Light from the top of the window travels further than from the bottom,
    // so the beam edge on the "drift side" comes from the top (more drift),
    // and the opposite edge comes from the bottom (less drift).
    const windowHeight = f.footprintH * TILE_SIZE
    const startDistPx = (startDist - 1) * TILE_SIZE
    const totalDistPx = (maxDist - startDist + 1) * TILE_SIZE
    // Extra horizontal drift for rays entering at the top of the window
    const topExtra = tan * windowHeight  // positive when sun goes right, negative when left

    // Left edge: use whichever origin (top or bottom of window) drifts further left
    // Right edge: use whichever origin drifts further right
    const leftExtra = Math.min(0, topExtra)   // negative or zero — extends left
    const rightExtra = Math.max(0, topExtra)   // positive or zero — extends right

    const startDriftBase = tan * startDistPx
    const endDriftBase = tan * (startDistPx + totalDistPx)

    beams.push({
      topLeftX: winLeftPx + startDriftBase + leftExtra,
      topRightX: winRightPx + startDriftBase + rightExtra,
      bottomLeftX: winLeftPx + endDriftBase + leftExtra,
      bottomRightX: winRightPx + endDriftBase + rightExtra,
      topY: winBottomY + startDistPx,
      bottomY: winBottomY + startDistPx + totalDistPx,
      opacity: SUN_BEAM_OPACITY * sunIntensity,
    })
  }

  return beams
}

// ── Sunlight beam color parsing (cached) ────────────────────────

let parsedBeamRGB: { r: number; g: number; b: number } | null = null

function getBeamRGB(): { r: number; g: number; b: number } {
  if (parsedBeamRGB) return parsedBeamRGB
  // Parse SUN_BEAM_COLOR "rgba(r, g, b, a)"
  const m = SUN_BEAM_COLOR.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (m) {
    parsedBeamRGB = { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) }
  } else {
    parsedBeamRGB = { r: 255, g: 220, b: 120 }
  }
  return parsedBeamRGB
}

/** Debug: throttle logging */
let _sunLastLog = 0

/**
 * Render all sunlight beams as smooth trapezoid polygons with vertical gradient fade.
 * Call this as a separate overlay pass (after furniture, before characters).
 * When tileMap is provided, beams are clipped to floor tiles only (no walls/void).
 */
export function renderSunBeams(
  ctx: CanvasRenderingContext2D,
  beams: SunBeam[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  tileMap?: TileTypeVal[][],
): void {
  if (beams.length === 0) return

  // Debug logging (once per 5 seconds to avoid spam)
  if (Date.now() - _sunLastLog > 5000) {
    _sunLastLog = Date.now()
    const hasTileMap = !!(tileMap && tileMap.length > 0)
    let wallCount = 0, floorCount = 0, maskedCount = 0, clipCount = 0
    if (hasTileMap) {
      const rows = tileMap!.length
      const cols = tileMap![0].length
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const tile = tileMap![row][col]
          if (tile === TileType.WALL) { wallCount++; continue }
          if (tile === TileType.VOID) continue
          const belowIsWall = row + 1 < rows && tileMap![row + 1][col] === TileType.WALL
          if (belowIsWall) { maskedCount++; continue }
          clipCount++
          floorCount++
        }
      }
    }
    console.log(`[Sunlight] beams=${beams.length}, tileMap=${hasTileMap}, walls=${wallCount}, floor=${floorCount}, maskedAboveWall=${maskedCount}, clipTiles=${clipCount}, zoom=${zoom}, offset=(${offsetX},${offsetY})`)
    for (const beam of beams) {
      console.log(`[Sunlight]   beam: top=(${beam.topLeftX.toFixed(1)},${beam.topY.toFixed(1)})-(${beam.topRightX.toFixed(1)},${beam.topY.toFixed(1)}), bottom=(${beam.bottomLeftX.toFixed(1)},${beam.bottomY.toFixed(1)})-(${beam.bottomRightX.toFixed(1)},${beam.bottomY.toFixed(1)}), opacity=${beam.opacity.toFixed(3)}`)
    }
  }

  const { r, g, b } = getBeamRGB()

  ctx.save()

  // Clip to exclude wall areas: wall tiles themselves + the tile above each wall
  // (wall sprites are 2×TILE_SIZE tall — the face extends one tile upward)
  if (tileMap && tileMap.length > 0) {
    const s = TILE_SIZE * zoom
    const rows = tileMap.length
    const cols = tileMap[0].length
    ctx.beginPath()
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const tile = tileMap[row][col]
        if (tile === TileType.WALL || tile === TileType.VOID) continue
        // Skip floor tiles directly above a wall — the wall face covers this area
        const belowIsWall = row + 1 < rows && tileMap[row + 1][col] === TileType.WALL
        if (belowIsWall) continue
        ctx.rect(offsetX + col * s, offsetY + row * s, s, s)
      }
    }
    ctx.clip()
  }

  for (const beam of beams) {
    const tl = { x: offsetX + beam.topLeftX * zoom, y: offsetY + beam.topY * zoom }
    const tr = { x: offsetX + beam.topRightX * zoom, y: offsetY + beam.topY * zoom }
    const br = { x: offsetX + beam.bottomRightX * zoom, y: offsetY + beam.bottomY * zoom }
    const bl = { x: offsetX + beam.bottomLeftX * zoom, y: offsetY + beam.bottomY * zoom }

    // Create vertical gradient from window (opaque) to beam end (transparent)
    const grad = ctx.createLinearGradient(0, tl.y, 0, bl.y)
    grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${beam.opacity})`)
    grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)

    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.moveTo(tl.x, tl.y)
    ctx.lineTo(tr.x, tr.y)
    ctx.lineTo(br.x, br.y)
    ctx.lineTo(bl.x, bl.y)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
}
