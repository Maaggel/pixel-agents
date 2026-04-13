import { TileType, TILE_SIZE } from '../types.js'
import type { TileType as TileTypeVal, FurnitureInstance } from '../types.js'
import {
  LAMP_LIGHT_RADIUS_DEFAULT,
  LAMP_LIGHT_COLOR,
  LAMP_LIGHT_OPACITY,
  LAMP_LIGHT_Y_OFFSET_PX,
} from '../../constants.js'

// ── Lamp light data ────────────────────────────────────────────

/** A lamp light pool: circular radial gradient centered on the lamp */
export interface LampLight {
  /** Center X in sprite pixels */
  cx: number
  /** Center Y in sprite pixels */
  cy: number
  /** Radius in sprite pixels */
  radius: number
  /** Light color [r, g, b] */
  color: [number, number, number]
  /** Peak opacity at center */
  opacity: number
}

/**
 * Compute lamp light pools for all active (ON-state) lamp furniture.
 * Only lamps with `isLamp: true` on their FurnitureInstance are included.
 */
export function computeLampLights(
  furniture: FurnitureInstance[],
): LampLight[] {
  const lights: LampLight[] = []

  for (const f of furniture) {
    if (!f.isLamp) continue

    // Center the light on the furniture sprite center, offset upward toward bulb
    const cx = f.x + (f.footprintW * TILE_SIZE) / 2
    const cy = f.y + (f.footprintH * TILE_SIZE) / 2 - LAMP_LIGHT_Y_OFFSET_PX
    const radiusTiles = f.lightRadius ?? LAMP_LIGHT_RADIUS_DEFAULT
    const radius = radiusTiles * TILE_SIZE
    const color = f.lightColor ?? LAMP_LIGHT_COLOR

    lights.push({ cx, cy, radius, color, opacity: LAMP_LIGHT_OPACITY })
  }

  return lights
}

/**
 * Render lamp light pools as radial gradient circles.
 * Clipped to floor tiles only (no walls, no void, no tiles above walls).
 * Same clipping logic as sunlight beams.
 */
export function renderLampLights(
  ctx: CanvasRenderingContext2D,
  lights: LampLight[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  tileMap?: TileTypeVal[][],
): void {
  if (lights.length === 0) return

  ctx.save()

  // Clip to floor tiles (exclude walls, void, and tiles directly above walls)
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

  // Render each lamp light as a radial gradient circle
  for (const light of lights) {
    const cx = offsetX + light.cx * zoom
    const cy = offsetY + light.cy * zoom
    const r = light.radius * zoom
    const [lr, lg, lb] = light.color

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    grad.addColorStop(0, `rgba(${lr}, ${lg}, ${lb}, ${light.opacity})`)
    grad.addColorStop(0.15, `rgba(${lr}, ${lg}, ${lb}, ${light.opacity * 0.85})`)
    grad.addColorStop(0.4, `rgba(${lr}, ${lg}, ${lb}, ${light.opacity * 0.45})`)
    grad.addColorStop(0.7, `rgba(${lr}, ${lg}, ${lb}, ${light.opacity * 0.15})`)
    grad.addColorStop(1, `rgba(${lr}, ${lg}, ${lb}, 0)`)

    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.restore()
}
