import { TileType, TILE_SIZE } from '../types.js'
import type { TileType as TileTypeVal, FurnitureInstance, Character, SpriteData, Seat, FloorColor } from '../types.js'
import { getCachedSprite, getOutlineSprite } from '../sprites/spriteCache.js'
import { getCharacterSprites, BUBBLE_PERMISSION_SPRITE, BUBBLE_WAITING_SPRITE, BUBBLE_THINKING_SPRITE, BUBBLE_WORKING_SPRITE, TOOL_BUBBLE_SPRITES, IDLE_CHAT_BUBBLE_VARIANTS, BUBBLE_IDLE_THINK_SPRITE, BUBBLE_IDLE_EAT_SPRITE } from '../sprites/spriteData.js'
import { getCharacterSprite, isSittingState } from './characters.js'
import { renderMatrixEffect } from './matrixEffect.js'
import type { SunBeam } from './sunlight.js'
import { renderSunBeams } from './sunlight.js'
import { renderWindowEffects } from './windowEffects.js'
import { renderExteriorWalls, findExteriorWalls } from '../exteriorWall.js'
import { getColorizedFloorSprite, hasFloorSprites, WALL_COLOR } from '../floorTiles.js'
import { hasWallSprites, getWallInstances, wallColorToHex } from '../wallTiles.js'
import {
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_Z_SORT_OFFSET,
  OUTLINE_Z_SORT_OFFSET,
  SELECTED_OUTLINE_ALPHA,
  HOVERED_OUTLINE_ALPHA,
  GHOST_PREVIEW_SPRITE_ALPHA,
  GHOST_PREVIEW_TINT_ALPHA,
  SELECTION_DASH_PATTERN,
  BUTTON_MIN_RADIUS,
  BUTTON_RADIUS_ZOOM_FACTOR,
  BUTTON_ICON_SIZE_FACTOR,
  BUTTON_LINE_WIDTH_MIN,
  BUTTON_LINE_WIDTH_ZOOM_FACTOR,
  BUBBLE_FADE_DURATION_SEC,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  NAMETAG_VERTICAL_OFFSET_PX,
  NAMETAG_BG_COLOR,
  NAMETAG_TEXT_COLOR,
  NAMETAG_SUB_TEXT_COLOR,
  NAMETAG_PADDING_H,
  NAMETAG_PADDING_V,
  NAMETAG_MAX_CHARS,
  NAMETAG_DOT_GAP,
  FALLBACK_FLOOR_COLOR,
  GRID_LINE_COLOR,
  VOID_TILE_OUTLINE_COLOR,
  VOID_TILE_DASH_PATTERN,
  GHOST_BORDER_HOVER_FILL,
  GHOST_BORDER_HOVER_STROKE,
  GHOST_BORDER_STROKE,
  GHOST_VALID_TINT,
  GHOST_INVALID_TINT,
  SELECTION_HIGHLIGHT_COLOR,
  DELETE_BUTTON_BG,
  ROTATE_BUTTON_BG,
  ZONE_COLORS,
  ZONE_BORDER_COLORS,
  ZONE_LABEL_COLORS,
  ZONE_LABELS,
  VACUUM_TRAIL_PATCH_SIZE_PX,
  VACUUM_TRAIL_COLOR,
} from '../../constants.js'

/** Track unknown tool names to log each only once (for future sprite creation) */
const loggedUnknownTools = new Set<string>()

// ── Render functions ────────────────────────────────────────────

export function renderTileGrid(
  ctx: CanvasRenderingContext2D,
  tileMap: TileTypeVal[][],
  offsetX: number,
  offsetY: number,
  zoom: number,
  tileColors?: Array<FloorColor | null>,
  cols?: number,
): void {
  const s = TILE_SIZE * zoom
  const useSpriteFloors = hasFloorSprites()
  const tmRows = tileMap.length
  const tmCols = tmRows > 0 ? tileMap[0].length : 0
  const layoutCols = cols ?? tmCols

  // Floor tiles + wall base color
  for (let r = 0; r < tmRows; r++) {
    for (let c = 0; c < tmCols; c++) {
      const tile = tileMap[r][c]

      // Skip VOID tiles entirely (transparent)
      if (tile === TileType.VOID) continue

      if (tile === TileType.WALL || !useSpriteFloors) {
        // Wall tiles or fallback: solid color
        if (tile === TileType.WALL) {
          const colorIdx = r * layoutCols + c
          const wallColor = tileColors?.[colorIdx]
          ctx.fillStyle = wallColor ? wallColorToHex(wallColor) : WALL_COLOR
        } else {
          ctx.fillStyle = FALLBACK_FLOOR_COLOR
        }
        ctx.fillRect(offsetX + c * s, offsetY + r * s, s, s)
        continue
      }

      // Floor tile: get colorized sprite
      const colorIdx = r * layoutCols + c
      const color = tileColors?.[colorIdx] ?? { h: 0, s: 0, b: 0, c: 0 }
      const sprite = getColorizedFloorSprite(tile, color)
      const cached = getCachedSprite(sprite, zoom)
      ctx.drawImage(cached, offsetX + c * s, offsetY + r * s)
    }
  }

}

interface ZDrawable {
  zY: number
  draw: (ctx: CanvasRenderingContext2D) => void
}

export function renderScene(
  ctx: CanvasRenderingContext2D,
  furniture: FurnitureInstance[],
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  selectedAgentId: number | null,
  hoveredAgentId: number | null,
  vacuumDrawables?: Array<{ sprite: import('../types.js').SpriteData; x: number; y: number; zY: number }>,
): void {
  const drawables: ZDrawable[] = []

  // Furniture
  for (const f of furniture) {
    const cached = getCachedSprite(f.activeWorkSprite ?? f.activeInteractionSprite ?? f.activeMeetingSprite ?? f.activeIdleSprite ?? f.sprite, zoom)
    const fx = offsetX + f.x * zoom
    const fy = offsetY + f.y * zoom
    drawables.push({
      zY: f.zY,
      draw: (c) => {
        c.drawImage(cached, fx, fy)
      },
    })
  }

  // Characters
  for (const ch of characters) {
    const sprites = getCharacterSprites(ch.palette, ch.hueShift)
    const spriteData = getCharacterSprite(ch, sprites)
    const cached = getCachedSprite(spriteData, zoom)
    // Sitting offset: shift character down when seated so they visually sit in the chair
    const sittingOffset = isSittingState(ch.state) ? CHARACTER_SITTING_OFFSET_PX : 0
    // Anchor at bottom-center of character — round to integer device pixels
    const drawX = Math.round(offsetX + ch.x * zoom - cached.width / 2)
    const drawY = Math.round(offsetY + (ch.y + sittingOffset) * zoom - cached.height)

    // Sort characters by bottom of their tile (not center) so they render
    // in front of same-row furniture (e.g. chairs) but behind furniture
    // at lower rows (e.g. desks, bookshelves that occlude from below).
    const charZY = ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET

    // Matrix spawn/despawn effect — skip outline, use per-pixel rendering
    if (ch.matrixEffect) {
      const mDrawX = drawX
      const mDrawY = drawY
      const mSpriteData = spriteData
      const mCh = ch
      drawables.push({
        zY: charZY,
        draw: (c) => {
          renderMatrixEffect(c, mCh, mSpriteData, mDrawX, mDrawY, zoom)
        },
      })
      continue
    }

    // White outline: full opacity for selected, 50% for hover
    const isSelected = selectedAgentId !== null && ch.id === selectedAgentId
    const isHovered = hoveredAgentId !== null && ch.id === hoveredAgentId
    if (isSelected || isHovered) {
      const outlineAlpha = isSelected ? SELECTED_OUTLINE_ALPHA : HOVERED_OUTLINE_ALPHA
      const outlineData = getOutlineSprite(spriteData)
      const outlineCached = getCachedSprite(outlineData, zoom)
      const olDrawX = drawX - zoom  // 1 sprite-pixel offset, scaled
      const olDrawY = drawY - zoom  // outline follows sitting offset via drawY
      drawables.push({
        zY: charZY - OUTLINE_Z_SORT_OFFSET, // sort just before character
        draw: (c) => {
          c.save()
          c.globalAlpha = outlineAlpha
          c.drawImage(outlineCached, olDrawX, olDrawY)
          c.restore()
        },
      })
    }

    drawables.push({
      zY: charZY,
      draw: (c) => {
        c.drawImage(cached, drawX, drawY)
      },
    })
  }

  // Robot Vacuums (active, non-docked)
  if (vacuumDrawables) {
    for (const v of vacuumDrawables) {
      const cached = getCachedSprite(v.sprite, zoom)
      const vx = Math.round(offsetX + v.x * zoom)
      const vy = Math.round(offsetY + v.y * zoom)
      drawables.push({
        zY: v.zY,
        draw: (c) => c.drawImage(cached, vx, vy),
      })
    }
  }

  // Sort by Y (lower = in front = drawn later)
  drawables.sort((a, b) => a.zY - b.zY)

  for (const d of drawables) {
    d.draw(ctx)
  }
}

// ── Edit mode overlays ──────────────────────────────────────────

export function renderGridOverlay(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  zoom: number,
  cols: number,
  rows: number,
  tileMap?: TileTypeVal[][],
): void {
  const s = TILE_SIZE * zoom
  ctx.strokeStyle = GRID_LINE_COLOR
  ctx.lineWidth = 1
  ctx.beginPath()
  // Vertical lines — offset by 0.5 for crisp 1px lines
  for (let c = 0; c <= cols; c++) {
    const x = offsetX + c * s + 0.5
    ctx.moveTo(x, offsetY)
    ctx.lineTo(x, offsetY + rows * s)
  }
  // Horizontal lines
  for (let r = 0; r <= rows; r++) {
    const y = offsetY + r * s + 0.5
    ctx.moveTo(offsetX, y)
    ctx.lineTo(offsetX + cols * s, y)
  }
  ctx.stroke()

  // Draw faint dashed outlines on VOID tiles
  if (tileMap) {
    ctx.save()
    ctx.strokeStyle = VOID_TILE_OUTLINE_COLOR
    ctx.lineWidth = 1
    ctx.setLineDash(VOID_TILE_DASH_PATTERN)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (tileMap[r]?.[c] === TileType.VOID) {
          ctx.strokeRect(offsetX + c * s + 0.5, offsetY + r * s + 0.5, s - 1, s - 1)
        }
      }
    }
    ctx.restore()
  }
}

/** Draw faint expansion placeholders 1 tile outside grid bounds (ghost border). */
export function renderGhostBorder(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  zoom: number,
  cols: number,
  rows: number,
  ghostHoverCol: number,
  ghostHoverRow: number,
): void {
  const s = TILE_SIZE * zoom
  ctx.save()

  // Collect ghost border tiles: one ring around the grid
  const ghostTiles: Array<{ c: number; r: number }> = []
  // Top and bottom rows
  for (let c = -1; c <= cols; c++) {
    ghostTiles.push({ c, r: -1 })
    ghostTiles.push({ c, r: rows })
  }
  // Left and right columns (excluding corners already added)
  for (let r = 0; r < rows; r++) {
    ghostTiles.push({ c: -1, r })
    ghostTiles.push({ c: cols, r })
  }

  for (const { c, r } of ghostTiles) {
    const x = offsetX + c * s
    const y = offsetY + r * s
    const isHovered = c === ghostHoverCol && r === ghostHoverRow
    if (isHovered) {
      ctx.fillStyle = GHOST_BORDER_HOVER_FILL
      ctx.fillRect(x, y, s, s)
    }
    ctx.strokeStyle = isHovered ? GHOST_BORDER_HOVER_STROKE : GHOST_BORDER_STROKE
    ctx.lineWidth = 1
    ctx.setLineDash(VOID_TILE_DASH_PATTERN)
    ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1)
  }

  ctx.restore()
}

export function renderGhostPreview(
  ctx: CanvasRenderingContext2D,
  sprite: SpriteData,
  col: number,
  row: number,
  valid: boolean,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const cached = getCachedSprite(sprite, zoom)
  const x = offsetX + col * TILE_SIZE * zoom
  const y = offsetY + row * TILE_SIZE * zoom
  ctx.save()
  ctx.globalAlpha = GHOST_PREVIEW_SPRITE_ALPHA
  ctx.drawImage(cached, x, y)
  // Tint overlay
  ctx.globalAlpha = GHOST_PREVIEW_TINT_ALPHA
  ctx.fillStyle = valid ? GHOST_VALID_TINT : GHOST_INVALID_TINT
  ctx.fillRect(x, y, cached.width, cached.height)
  ctx.restore()
}

export function renderSelectionHighlight(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  w: number,
  h: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const s = TILE_SIZE * zoom
  const x = offsetX + col * s
  const y = offsetY + row * s
  ctx.save()
  ctx.strokeStyle = SELECTION_HIGHLIGHT_COLOR
  ctx.lineWidth = 2
  ctx.setLineDash(SELECTION_DASH_PATTERN)
  ctx.strokeRect(x + 1, y + 1, w * s - 2, h * s - 2)
  ctx.restore()
}

export function renderDeleteButton(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  w: number,
  _h: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): DeleteButtonBounds {
  const s = TILE_SIZE * zoom
  // Position at top-right corner of selected furniture
  const cx = offsetX + (col + w) * s + 1
  const cy = offsetY + row * s - 1
  const radius = Math.max(BUTTON_MIN_RADIUS, zoom * BUTTON_RADIUS_ZOOM_FACTOR)

  // Circle background
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fillStyle = DELETE_BUTTON_BG
  ctx.fill()

  // X mark
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = Math.max(BUTTON_LINE_WIDTH_MIN, zoom * BUTTON_LINE_WIDTH_ZOOM_FACTOR)
  ctx.lineCap = 'round'
  const xSize = radius * BUTTON_ICON_SIZE_FACTOR
  ctx.beginPath()
  ctx.moveTo(cx - xSize, cy - xSize)
  ctx.lineTo(cx + xSize, cy + xSize)
  ctx.moveTo(cx + xSize, cy - xSize)
  ctx.lineTo(cx - xSize, cy + xSize)
  ctx.stroke()
  ctx.restore()

  return { cx, cy, radius }
}

export function renderRotateButton(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  _w: number,
  _h: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): RotateButtonBounds {
  const s = TILE_SIZE * zoom
  // Position to the left of the delete button (which is at top-right corner)
  const radius = Math.max(BUTTON_MIN_RADIUS, zoom * BUTTON_RADIUS_ZOOM_FACTOR)
  const cx = offsetX + col * s - 1
  const cy = offsetY + row * s - 1

  // Circle background
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fillStyle = ROTATE_BUTTON_BG
  ctx.fill()

  // Circular arrow icon
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = Math.max(BUTTON_LINE_WIDTH_MIN, zoom * BUTTON_LINE_WIDTH_ZOOM_FACTOR)
  ctx.lineCap = 'round'
  const arcR = radius * BUTTON_ICON_SIZE_FACTOR
  ctx.beginPath()
  // Draw a 270-degree arc
  ctx.arc(cx, cy, arcR, -Math.PI * 0.8, Math.PI * 0.7)
  ctx.stroke()
  // Draw arrowhead at the end of the arc
  const endAngle = Math.PI * 0.7
  const endX = cx + arcR * Math.cos(endAngle)
  const endY = cy + arcR * Math.sin(endAngle)
  const arrowSize = radius * 0.35
  ctx.beginPath()
  ctx.moveTo(endX + arrowSize * 0.6, endY - arrowSize * 0.3)
  ctx.lineTo(endX, endY)
  ctx.lineTo(endX + arrowSize * 0.7, endY + arrowSize * 0.5)
  ctx.stroke()
  ctx.restore()

  return { cx, cy, radius }
}

// ── Speech bubbles ──────────────────────────────────────────────

export function renderBubbles(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  for (const ch of characters) {
    if (!ch.bubbleType) continue

    // Compute opacity: permission = full, talking/waiting/idle = fade in last 0.5s
    let alpha = 1.0
    if ((ch.bubbleType === 'waiting' || ch.bubbleType === 'talking' || ch.bubbleType === 'idle_chat' || ch.bubbleType === 'idle_think' || ch.bubbleType === 'idle_eat') && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC) {
      alpha = ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC
    }

    // Character anchor position
    const sittingOff = isSittingState(ch.state) ? BUBBLE_SITTING_OFFSET_PX : 0
    const charCenterX = offsetX + ch.x * zoom
    const charTopY = offsetY + (ch.y + sittingOff - BUBBLE_VERTICAL_OFFSET_PX) * zoom

    // Select sprite based on bubble type
    let sprite: SpriteData
    if (ch.bubbleType === 'talking' && ch.currentTool) {
      // Tool-specific icon bubble (falls back to working gear sprite for unknown tools)
      const toolSprite = TOOL_BUBBLE_SPRITES[ch.currentTool]
      if (toolSprite) {
        sprite = toolSprite
      } else {
        // Log unknown tool for future sprite creation
        if (!loggedUnknownTools.has(ch.currentTool)) {
          loggedUnknownTools.add(ch.currentTool)
          console.log(`[Pixel Agents] Unknown tool bubble: "${ch.currentTool}" — using default working sprite`)
        }
        sprite = BUBBLE_WORKING_SPRITE
      }
    } else if (ch.bubbleType === 'permission') {
      sprite = BUBBLE_PERMISSION_SPRITE
    } else if (ch.bubbleType === 'thinking') {
      sprite = BUBBLE_THINKING_SPRITE
    } else if (ch.bubbleType === 'idle_chat') {
      sprite = IDLE_CHAT_BUBBLE_VARIANTS[ch.chatBubbleVariant % IDLE_CHAT_BUBBLE_VARIANTS.length]
    } else if (ch.bubbleType === 'idle_think') {
      sprite = BUBBLE_IDLE_THINK_SPRITE
    } else if (ch.bubbleType === 'idle_eat') {
      sprite = BUBBLE_IDLE_EAT_SPRITE
    } else if (ch.bubbleType === 'talking') {
      // Active with no specific tool — show working bubble (not thinking cloud)
      sprite = BUBBLE_WORKING_SPRITE
    } else {
      sprite = BUBBLE_WAITING_SPRITE
    }

    const cached = getCachedSprite(sprite, zoom)
    const bubbleX = Math.round(charCenterX - cached.width / 2)
    const bubbleY = Math.round(charTopY - cached.height - 1 * zoom)

    ctx.save()
    if (alpha < 1.0) ctx.globalAlpha = alpha
    ctx.drawImage(cached, bubbleX, bubbleY)
    ctx.restore()
  }
}

// ── Vacuum overlays (outline + nametag) ─────────────────────

interface VacuumOverlay {
  uid: string; name: string; state: string; paused: boolean
  x: number; y: number; sprite: SpriteData | null
  selected: boolean; hovered: boolean
  autoCycleTimerSec: number | null
}

const STATE_DISPLAY: Record<string, string> = {
  docked: 'Docked',
  cleaning: 'Cleaning',
  traveling: 'Traveling',
  waiting: 'Waiting',
  returning: 'Returning',
  paused: 'Paused',
}

function renderVacuumOverlays(
  ctx: CanvasRenderingContext2D,
  overlays: VacuumOverlay[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  for (const v of overlays) {
    if (!v.selected && !v.hovered) continue
    if (!v.sprite) continue

    const spriteW = v.sprite[0]?.length ?? TILE_SIZE
    const sx = Math.round(offsetX + (v.x - TILE_SIZE / 2) * zoom)
    const sy = Math.round(offsetY + (v.y - TILE_SIZE / 2) * zoom)
    const sw = spriteW * zoom

    // Outline (offset by -1 zoom-pixel to center around the small vacuum sprite)
    if (v.selected || v.hovered) {
      const outlineData = getOutlineSprite(v.sprite)
      const outlineCanvas = getCachedSprite(outlineData, zoom)
      ctx.save()
      ctx.globalAlpha = v.selected ? SELECTED_OUTLINE_ALPHA : HOVERED_OUTLINE_ALPHA
      ctx.drawImage(outlineCanvas, sx - zoom, sy - zoom)
      ctx.restore()
    }

    // Nametag + state info (above sprite — matches agent nametag sizing)
    const fontSize = Math.max(7, Math.round(zoom * 3.5))
    ctx.font = `${fontSize}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'

    const cx = sx + sw / 2
    const tagY = sy - Math.round(2 * zoom)

    // State line
    const stateText = STATE_DISPLAY[v.state] || v.state
    let infoText = stateText
    if (v.autoCycleTimerSec !== null) {
      const mins = Math.floor(v.autoCycleTimerSec / 60)
      const secs = Math.floor(v.autoCycleTimerSec % 60)
      infoText = `Next: ${mins}:${secs.toString().padStart(2, '0')}`
    }

    const nameMetrics = ctx.measureText(v.name)
    const infoMetrics = ctx.measureText(infoText)
    const maxW = Math.max(nameMetrics.width, infoMetrics.width)
    const padH = Math.round(NAMETAG_PADDING_H * zoom / 2)
    const padV = Math.round(NAMETAG_PADDING_V * zoom / 2)
    const lineH = fontSize + 2
    const bgW = maxW + padH * 2
    const bgH = lineH * 2 + padV * 2

    // Background
    ctx.fillStyle = NAMETAG_BG_COLOR
    ctx.fillRect(cx - bgW / 2, tagY - bgH, bgW, bgH)

    // Name (top line)
    ctx.fillStyle = NAMETAG_TEXT_COLOR
    ctx.fillText(v.name, cx, tagY - lineH - padV)

    // State / timer (bottom line)
    ctx.fillStyle = NAMETAG_SUB_TEXT_COLOR
    ctx.fillText(infoText, cx, tagY - padV)
  }
}

// ── Vacuum speech bubbles ────────────────────────────────────

function renderVacuumSpeechBubbles(
  ctx: CanvasRenderingContext2D,
  bubbles: Array<{ text: string; x: number; y: number; opacity: number }>,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const fontSize = Math.max(10, Math.round(3.5 * zoom))
  ctx.font = `${fontSize}px "FS Pixel Sans Unicode", monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'

  for (const b of bubbles) {
    ctx.save()
    ctx.globalAlpha = b.opacity

    const sx = Math.round(offsetX + b.x * zoom)
    const sy = Math.round(offsetY + b.y * zoom) - Math.round(2 * zoom)

    const metrics = ctx.measureText(b.text)
    const padH = Math.round(2 * zoom)
    const padV = Math.round(1.5 * zoom)
    const bgW = metrics.width + padH * 2
    const bgH = fontSize + padV * 2

    // Background
    ctx.fillStyle = 'rgba(30, 30, 46, 0.85)'
    ctx.fillRect(sx - bgW / 2, sy - bgH, bgW, bgH)

    // Text
    ctx.fillStyle = '#e0e0e0'
    ctx.fillText(b.text, sx, sy - padV)

    ctx.restore()
  }
}

// ── Nametags ─────────────────────────────────────────────────

export function renderNametags(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  for (const ch of characters) {
    if (!ch.nametag) continue
    if (ch.matrixEffect === 'despawn') continue

    let label = ch.nametag
    if (label.length > NAMETAG_MAX_CHARS) {
      label = label.slice(0, NAMETAG_MAX_CHARS - 1) + '\u2026'
    }

    const fontSize = Math.max(7, Math.round(zoom * 3.5))
    ctx.font = `${fontSize}px sans-serif`
    const metrics = ctx.measureText(label)
    const textW = metrics.width
    const textH = fontSize

    // Project dot dimensions
    const hasDot = !!ch.projectColor
    const dotRadius = Math.max(2, Math.round(fontSize * 0.25))
    const dotExtra = hasDot ? dotRadius * 2 + NAMETAG_DOT_GAP : 0

    const sittingOff = isSittingState(ch.state) ? BUBBLE_SITTING_OFFSET_PX : 0
    const cx = Math.round(offsetX + ch.x * zoom)
    const cy = Math.round(offsetY + (ch.y + sittingOff - NAMETAG_VERTICAL_OFFSET_PX) * zoom)

    const totalW = textW + dotExtra
    const bgX = cx - totalW / 2 - NAMETAG_PADDING_H * zoom / 2
    const bgY = cy - textH - NAMETAG_PADDING_V * zoom / 2
    const bgW = totalW + NAMETAG_PADDING_H * zoom
    const bgH = textH + NAMETAG_PADDING_V * zoom

    ctx.save()
    ctx.fillStyle = NAMETAG_BG_COLOR
    ctx.fillRect(bgX, bgY, bgW, bgH)

    // Draw project color dot
    if (hasDot) {
      const dotX = bgX + NAMETAG_PADDING_H * zoom / 2 + dotRadius
      const dotY = bgY + bgH / 2
      ctx.beginPath()
      ctx.arc(dotX, dotY, dotRadius, 0, Math.PI * 2)
      ctx.fillStyle = ch.projectColor!
      ctx.fill()
    }

    ctx.fillStyle = ch.isSubagent ? NAMETAG_SUB_TEXT_COLOR : NAMETAG_TEXT_COLOR
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    // Offset text right by half the dot space so it centers in remaining area
    const textCx = cx + dotExtra / 2
    ctx.fillText(label, textCx, cy + NAMETAG_PADDING_V * zoom / 4)
    ctx.restore()
  }
}

export interface ButtonBounds {
  /** Center X in device pixels */
  cx: number
  /** Center Y in device pixels */
  cy: number
  /** Radius in device pixels */
  radius: number
}

export type DeleteButtonBounds = ButtonBounds
export type RotateButtonBounds = ButtonBounds

export interface EditorRenderState {
  showGrid: boolean
  ghostSprite: SpriteData | null
  ghostCol: number
  ghostRow: number
  ghostValid: boolean
  /** Secondary ghost sprite (e.g. dock shown alongside vacuum during placement) */
  ghostExtraSprite: SpriteData | null
  ghostExtraCol: number
  ghostExtraRow: number
  selectedCol: number
  selectedRow: number
  selectedW: number
  selectedH: number
  hasSelection: boolean
  isRotatable: boolean
  /** Updated each frame by renderDeleteButton */
  deleteButtonBounds: DeleteButtonBounds | null
  /** Updated each frame by renderRotateButton */
  rotateButtonBounds: RotateButtonBounds | null
  /** Whether to show ghost border (expansion tiles outside grid) */
  showGhostBorder: boolean
  /** Hovered ghost border tile col (-1 to cols) */
  ghostBorderHoverCol: number
  /** Hovered ghost border tile row (-1 to rows) */
  ghostBorderHoverRow: number
  /** Zone overlay data (parallel to tiles array, null = unzoned) */
  zones?: Array<string | null>
  /** Number of columns in the zone grid */
  zoneCols?: number
}

export interface SelectionRenderState {
  selectedAgentId: number | null
  hoveredAgentId: number | null
  hoveredTile: { col: number; row: number } | null
  seats: Map<string, Seat>
  characters: Map<number, Character>
  showNametags?: boolean
}

// ── Zone overlay ─────────────────────────────────────────────

function renderZoneOverlay(
  ctx: CanvasRenderingContext2D,
  zones: Array<string | null>,
  cols: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const ts = TILE_SIZE * zoom
  const rows = Math.ceil(zones.length / cols)
  const borderWidth = Math.max(1, Math.floor(zoom * 0.5))

  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i]
    if (!zone) continue
    const color = ZONE_COLORS[zone]
    if (!color) continue
    const c = i % cols
    const r = Math.floor(i / cols)
    const x = offsetX + c * ts
    const y = offsetY + r * ts

    // Fill zone tile
    ctx.fillStyle = color
    ctx.fillRect(x, y, ts, ts)

    // Draw borders on edges where the zone changes
    const borderColor = ZONE_BORDER_COLORS[zone] || color
    ctx.fillStyle = borderColor
    // Top edge
    if (r === 0 || zones[(r - 1) * cols + c] !== zone) {
      ctx.fillRect(x, y, ts, borderWidth)
    }
    // Bottom edge
    if (r === rows - 1 || zones[(r + 1) * cols + c] !== zone) {
      ctx.fillRect(x, y + ts - borderWidth, ts, borderWidth)
    }
    // Left edge
    if (c === 0 || zones[r * cols + (c - 1)] !== zone) {
      ctx.fillRect(x, y, borderWidth, ts)
    }
    // Right edge
    if (c === cols - 1 || zones[r * cols + (c + 1)] !== zone) {
      ctx.fillRect(x + ts - borderWidth, y, borderWidth, ts)
    }
  }

  // Second pass: draw labels (so they're on top of all fills/borders)
  if (zoom >= 3) {
    for (let i = 0; i < zones.length; i++) {
      const zone = zones[i]
      if (!zone) continue
      const c = i % cols
      const r = Math.floor(i / cols)
      const x = offsetX + c * ts
      const y = offsetY + r * ts
      const label = ZONE_LABELS[zone]
      if (label) {
        const fontSize = Math.max(8, Math.floor(zoom * 2.5))
        ctx.font = `bold ${fontSize}px sans-serif`
        ctx.fillStyle = ZONE_LABEL_COLORS[zone] || 'rgba(255,255,255,0.7)'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(label, x + ts / 2, y + ts / 2, ts - 2)
      }
    }
  }
}

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  tileMap: TileTypeVal[][],
  furniture: FurnitureInstance[],
  characters: Character[],
  zoom: number,
  panX: number,
  panY: number,
  selection?: SelectionRenderState,
  editor?: EditorRenderState,
  tileColors?: Array<FloorColor | null>,
  layoutCols?: number,
  layoutRows?: number,
  sunBeams?: SunBeam[],
  sunBeamColor?: [number, number, number],
  sunIntensity?: number,
  vacuumDrawables?: Array<{ sprite: import('../types.js').SpriteData; x: number; y: number; zY: number }>,
  vacuumTrails?: Array<{ px: number; py: number; opacity: number }>,
  vacuumSpeechBubbles?: Array<{ text: string; x: number; y: number; opacity: number }>,
  vacuumOverlays?: VacuumOverlay[],
  exteriorWall?: { style: import('../types.js').ExteriorWallStyle; color: FloorColor; height: number },
): { offsetX: number; offsetY: number } {
  // Clear
  ctx.clearRect(0, 0, canvasWidth, canvasHeight)

  // Use layout dimensions (fallback to tileMap size)
  const cols = layoutCols ?? (tileMap.length > 0 ? tileMap[0].length : 0)
  const rows = layoutRows ?? tileMap.length

  // Center map in viewport + pan offset (integer device pixels)
  const mapW = cols * TILE_SIZE * zoom
  const mapH = rows * TILE_SIZE * zoom
  const offsetX = Math.floor((canvasWidth - mapW) / 2) + Math.round(panX)
  const offsetY = Math.floor((canvasHeight - mapH) / 2) + Math.round(panY)

  // Draw tiles (floor + wall base color)
  renderTileGrid(ctx, tileMap, offsetX, offsetY, zoom, tileColors, layoutCols)

  // Vacuum cleaning trail (small patches centered on vacuum's actual path)
  if (vacuumTrails && vacuumTrails.length > 0) {
    const patchSize = VACUUM_TRAIL_PATCH_SIZE_PX * zoom
    const halfPatch = patchSize / 2
    for (const t of vacuumTrails) {
      ctx.fillStyle = `rgba(${VACUUM_TRAIL_COLOR}, ${t.opacity})`
      ctx.fillRect(
        Math.round(offsetX + t.px * zoom - halfPatch),
        Math.round(offsetY + t.py * zoom - halfPatch),
        patchSize,
        patchSize,
      )
    }
  }

  // Zone overlay (below furniture, on top of floor)
  if (editor?.zones && editor.zoneCols) {
    renderZoneOverlay(ctx, editor.zones, editor.zoneCols, offsetX, offsetY, zoom)
  }

  // Build wall instances for z-sorting with furniture and characters
  const wallInstances = hasWallSprites()
    ? getWallInstances(tileMap, tileColors, layoutCols)
    : []
  const allFurniture = wallInstances.length > 0
    ? [...wallInstances, ...furniture]
    : furniture

  // Draw walls + furniture + characters (z-sorted)
  const selectedId = selection?.selectedAgentId ?? null
  const hoveredId = selection?.hoveredAgentId ?? null
  renderScene(ctx, allFurniture, characters, offsetX, offsetY, zoom, selectedId, hoveredId, vacuumDrawables)

  // Exterior wall faces — after scene so bricks render on top of wall sprites
  if (exteriorWall && exteriorWall.style !== 'none') {
    renderExteriorWalls(ctx, tileMap, offsetX, offsetY, zoom, exteriorWall.style, exteriorWall.color, exteriorWall.height)

    // Re-draw placed furniture (not wall sprites) on exterior walls
    // so windows, paintings etc. appear on top of bricks
    const exteriorTiles = findExteriorWalls(tileMap)
    const exteriorSet = new Set(exteriorTiles.map(t => `${t.col},${t.row}`))
    for (const t of exteriorTiles) {
      if (t.isWall && t.row > 0) exteriorSet.add(`${t.col},${t.row - 1}`)
    }
    for (const f of furniture) {
      if (!f.uid) continue
      let overlaps = false
      for (let fr = 0; fr < f.footprintH && !overlaps; fr++) {
        for (let fc = 0; fc < f.footprintW && !overlaps; fc++) {
          if (exteriorSet.has(`${f.col + fc},${f.row + fr}`)) overlaps = true
        }
      }
      if (overlaps) {
        const sprite = f.activeWorkSprite ?? f.activeInteractionSprite ?? f.activeMeetingSprite ?? f.activeIdleSprite ?? f.sprite
        const cached = getCachedSprite(sprite, zoom)
        ctx.drawImage(cached, offsetX + f.x * zoom, offsetY + f.y * zoom)
      }
    }
  }

  // Window glass effects (tint + weather) — after scene and exterior bricks
  // so effects are visible on top of wall sprites and brick textures
  if (sunBeamColor) {
    renderWindowEffects(ctx, allFurniture, offsetX, offsetY, zoom, sunIntensity ?? 0, sunBeamColor)
  }

  // Sunlight overlay (on top of furniture + floor, masked to exclude walls)
  if (sunBeams && sunBeams.length > 0) {
    renderSunBeams(ctx, sunBeams, offsetX, offsetY, zoom, tileMap, sunBeamColor)
  }

  // Nametags (above characters, below bubbles)
  if (selection?.showNametags) {
    renderNametags(ctx, characters, offsetX, offsetY, zoom)
  }

  // Speech bubbles (always on top of everything including nametags)
  renderBubbles(ctx, characters, offsetX, offsetY, zoom)

  // Vacuum overlays (outlines + nametags)
  if (vacuumOverlays && vacuumOverlays.length > 0) {
    renderVacuumOverlays(ctx, vacuumOverlays, offsetX, offsetY, zoom)
  }

  // Vacuum speech bubbles
  if (vacuumSpeechBubbles && vacuumSpeechBubbles.length > 0) {
    renderVacuumSpeechBubbles(ctx, vacuumSpeechBubbles, offsetX, offsetY, zoom)
  }

  // Editor overlays
  if (editor) {
    if (editor.showGrid) {
      renderGridOverlay(ctx, offsetX, offsetY, zoom, cols, rows, tileMap)
    }
    if (editor.showGhostBorder) {
      renderGhostBorder(ctx, offsetX, offsetY, zoom, cols, rows, editor.ghostBorderHoverCol, editor.ghostBorderHoverRow)
    }
    if (editor.ghostSprite && editor.ghostCol >= 0) {
      // Render extra ghost first (e.g. dock behind vacuum)
      if (editor.ghostExtraSprite) {
        renderGhostPreview(ctx, editor.ghostExtraSprite, editor.ghostExtraCol, editor.ghostExtraRow, editor.ghostValid, offsetX, offsetY, zoom)
      }
      renderGhostPreview(ctx, editor.ghostSprite, editor.ghostCol, editor.ghostRow, editor.ghostValid, offsetX, offsetY, zoom)
    }
    if (editor.hasSelection) {
      renderSelectionHighlight(ctx, editor.selectedCol, editor.selectedRow, editor.selectedW, editor.selectedH, offsetX, offsetY, zoom)
      editor.deleteButtonBounds = renderDeleteButton(ctx, editor.selectedCol, editor.selectedRow, editor.selectedW, editor.selectedH, offsetX, offsetY, zoom)
      if (editor.isRotatable) {
        editor.rotateButtonBounds = renderRotateButton(ctx, editor.selectedCol, editor.selectedRow, editor.selectedW, editor.selectedH, offsetX, offsetY, zoom)
      } else {
        editor.rotateButtonBounds = null
      }
    } else {
      editor.deleteButtonBounds = null
      editor.rotateButtonBounds = null
    }
  }

  return { offsetX, offsetY }
}
