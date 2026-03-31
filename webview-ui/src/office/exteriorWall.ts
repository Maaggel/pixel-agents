/**
 * Exterior wall rendering: brick/stone patterns on outer walls.
 * An "outer wall" is a wall tile whose row below is out-of-bounds or VOID.
 * Bricks cover the wall's visible face (tile + 3D extension above) and extend downward.
 *
 * Performance: patterns are rendered via getCachedSprite (one drawImage per tile),
 * not pixel-by-pixel.
 */

import { TileType, TILE_SIZE, ExteriorWallStyle } from './types.js'
import type { TileType as TileTypeVal, FloorColor, SpriteData } from './types.js'
import { getColorizedSprite } from './colorize.js'
import { getCachedSprite } from './sprites/spriteCache.js'

// ── Procedural brick/stone patterns (16×16 grayscale) ────────

/** Generate a standard brick pattern (16×16 sprite, 4 rows of bricks) */
function generateBrickPattern(): SpriteData {
  const w = 16, h = 16
  const sprite: string[][] = []
  const mortar = '#4a4a4a'
  const brick1 = '#808080'
  const brick2 = '#707070'
  const brick3 = '#7a7a7a'

  const brickW = 8
  const brickH = 4

  for (let y = 0; y < h; y++) {
    const row: string[] = []
    const brickRow = Math.floor(y / brickH)
    const isMortarY = y % brickH === 0
    const offset = (brickRow % 2) * Math.floor(brickW / 2)
    const rowInBrick = y % brickH  // 0=mortar, 1-3=face

    for (let x = 0; x < w; x++) {
      if (isMortarY) {
        row.push(mortar)
      } else {
        const brickX = (x + offset) % w
        const isMortarX = brickX % brickW === 0
        if (isMortarX) {
          row.push(mortar)
        } else {
          const brickId = Math.floor((x + offset) / brickW) + brickRow * 3
          // Add row-based shading: top of brick slightly lighter, bottom slightly darker
          const shade = rowInBrick === 1 ? brick3 : rowInBrick === 3 ? brick2 : brick1
          row.push(brickId % 3 === 0 ? brick2 : shade)
        }
      }
    }
    sprite.push(row)
  }
  return sprite
}

/** Generate a small brick pattern (16×16 sprite, 8 rows of smaller bricks) */
function generateSmallBrickPattern(): SpriteData {
  const w = 16, h = 16
  const sprite: string[][] = []
  const mortar = '#4a4a4a'
  const brick1 = '#808080'
  const brick2 = '#6e6e6e'
  const brick3 = '#757575'

  for (let y = 0; y < h; y++) {
    const row: string[] = []
    const brickRow = Math.floor(y / 2)
    const isMortarY = y % 2 === 0
    const offset = (brickRow % 2) * 3

    for (let x = 0; x < w; x++) {
      if (isMortarY) {
        row.push(mortar)
      } else {
        const brickX = (x + offset) % 6
        const isMortarX = brickX === 0
        if (isMortarX) {
          row.push(mortar)
        } else {
          const brickId = Math.floor((x + offset) / 6) + brickRow * 5
          row.push(brickId % 5 === 0 ? brick2 : brickId % 3 === 0 ? brick3 : brick1)
        }
      }
    }
    sprite.push(row)
  }
  return sprite
}

/** Generate a stone/cobble pattern (16×16 sprite) with more variation */
function generateStonePattern(): SpriteData {
  const w = 16, h = 16
  const sprite: string[][] = []
  const mortar = '#4a4a4a'

  // 8 stone shades for more nuance
  const stoneShades = [
    '#7a7a7a', '#858585', '#6f6f6f', '#828282',
    '#747474', '#8a8a8a', '#696969', '#7e7e7e',
  ]

  // Irregular stone layout — each character = stone id, 0 = mortar
  const stoneMap = [
    '1111222233334444',
    '1111222233334444',
    '1111222233334444',
    '0000000000000000',
    '5555556666677777',
    '5555556666677777',
    '5555556666677777',
    '0000000000000000',
    '88889999AAABBBBB',
    '88889999AAABBBBB',
    '88889999AAA0BBBB',
    '0000000000000000',
    'CCCDDDDEEEEEFFF',
    'CCCDDDDEEEEEFFF',
    'CCCDDDDEEEEEFFF',
    '0000000000000000',
  ]

  // Map stone ids to shade indices (pseudo-random distribution)
  const stoneToShade: Record<string, number> = {
    '1': 0, '2': 3, '3': 5, '4': 1,
    '5': 2, '6': 7, '7': 4, '8': 6,
    '9': 1, 'A': 3, 'B': 0, 'C': 5,
    'D': 2, 'E': 7, 'F': 4,
  }

  for (let y = 0; y < h; y++) {
    const row: string[] = []
    for (let x = 0; x < w; x++) {
      const ch = stoneMap[y]?.[x] ?? '0'
      if (ch === '0') {
        row.push(mortar)
      } else {
        const shadeIdx = stoneToShade[ch] ?? 0
        // Add per-pixel variation: edges of stones are slightly darker
        const mapRow = stoneMap[y] ?? ''
        const isEdgeH = (x > 0 && mapRow[x - 1] !== ch) || (x < w - 1 && mapRow[x + 1] !== ch)
        const aboveRow = y > 0 ? (stoneMap[y - 1] ?? '') : ''
        const belowRow = y < h - 1 ? (stoneMap[y + 1] ?? '') : ''
        const isEdgeV = (aboveRow[x] !== undefined && aboveRow[x] !== ch) || (belowRow[x] !== undefined && belowRow[x] !== ch)
        if (isEdgeH || isEdgeV) {
          // Darken edges slightly
          const darkerIdx = Math.max(0, shadeIdx - 2)
          row.push(stoneShades[darkerIdx < stoneShades.length ? darkerIdx : 0])
        } else {
          row.push(stoneShades[shadeIdx])
        }
      }
    }
    sprite.push(row)
  }
  return sprite
}

// ── Pattern cache ──────────────────────────────────────────

const basePatterns: Record<string, SpriteData> = {}

function getBasePattern(style: ExteriorWallStyle): SpriteData | null {
  if (style === ExteriorWallStyle.NONE) return null
  if (!basePatterns[style]) {
    if (style === ExteriorWallStyle.BRICK) basePatterns[style] = generateBrickPattern()
    else if (style === ExteriorWallStyle.BRICK_SMALL) basePatterns[style] = generateSmallBrickPattern()
    else if (style === ExteriorWallStyle.STONE) basePatterns[style] = generateStonePattern()
  }
  return basePatterns[style] ?? null
}

// ── Exterior wall detection ────────────────────────────────

/**
 * Find all exterior edge tiles: wall or floor tiles whose row below is
 * out of bounds or VOID. These form the bottom edge of the building.
 */
export function findExteriorWalls(tileMap: TileTypeVal[][]): Array<{ col: number; row: number; isWall: boolean }> {
  const result: Array<{ col: number; row: number; isWall: boolean }> = []
  const tmRows = tileMap.length
  const tmCols = tmRows > 0 ? tileMap[0].length : 0

  for (let r = 0; r < tmRows; r++) {
    for (let c = 0; c < tmCols; c++) {
      const tile = tileMap[r][c]
      if (tile === TileType.VOID) continue
      const isWall = tile === TileType.WALL
      const belowOOB = r + 1 >= tmRows
      const belowVoid = !belowOOB && tileMap[r + 1][c] === TileType.VOID
      if (belowOOB || belowVoid) {
        result.push({ col: c, row: r, isWall })
      }
    }
  }
  return result
}

// ── Rendering ──────────────────────────────────────────────

/**
 * Render exterior wall faces on outer walls using cached sprites (fast drawImage).
 * Wall tiles: bricks cover the 3D wall face (1 tile above + tile itself) + extra height below.
 * Floor tiles: bricks only for extra height below the floor.
 */
export function renderExteriorWalls(
  ctx: CanvasRenderingContext2D,
  tileMap: TileTypeVal[][],
  offsetX: number,
  offsetY: number,
  zoom: number,
  style: ExteriorWallStyle,
  color: FloorColor,
  height: number,
): void {
  if (style === ExteriorWallStyle.NONE) return

  const pattern = getBasePattern(style)
  if (!pattern) return

  const exteriorTiles = findExteriorWalls(tileMap)
  if (exteriorTiles.length === 0) return

  const s = TILE_SIZE * zoom

  // Get colorized pattern sprite and cache as canvas for fast rendering
  const cacheKey = `ext-${style}-${color.h}-${color.s}-${color.b}-${color.c}`
  const colorized = getColorizedSprite(cacheKey, pattern, { ...color, colorize: true })
  const cachedTile = getCachedSprite(colorized, zoom)

  for (const { col, row, isWall } of exteriorTiles) {
    const baseX = offsetX + col * s

    if (isWall) {
      // Wall tiles: cover the 3D face (1 tile above) + tile itself + extra height below
      // The wall sprite extends 1 tile above the tile position — cover that with bricks too
      const faceStartY = offsetY + (row - 1) * s  // 1 tile above = wall 3D face
      const totalTiles = 2 + height  // face + tile + extra

      for (let h = 0; h < totalTiles; h++) {
        ctx.drawImage(cachedTile, baseX, faceStartY + h * s)
      }
    } else {
      // Floor tiles: bricks only for extra height below
      if (height > 0) {
        const startY = offsetY + (row + 1) * s
        for (let h = 0; h < height; h++) {
          ctx.drawImage(cachedTile, baseX, startY + h * s)
        }
      }
    }
  }
}
