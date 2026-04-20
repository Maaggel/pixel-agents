import type { Character, ActiveSkillInfo } from '../types.js'
import { TILE_SIZE } from '../types.js'
import {
  SKILL_NAMESPACE_THEMES,
  SKILL_DEFAULT_THEME,
  SKILL_AURA_PULSE_PERIOD_SEC,
  SKILL_AURA_PEAK_ALPHA,
  SKILL_AURA_MIN_ALPHA,
  SKILL_AURA_RADIUS_PX,
  SKILL_AURA_CENTER_OFFSET_Y,
  CHARACTER_SITTING_OFFSET_PX,
} from '../../constants.js'
import type { SkillNamespaceTheme } from '../../constants.js'
import { isSittingState } from './characters.js'

export function getSkillTheme(skill: ActiveSkillInfo | null | undefined): SkillNamespaceTheme {
  if (!skill) return SKILL_DEFAULT_THEME
  if (skill.namespace && SKILL_NAMESPACE_THEMES[skill.namespace]) {
    return SKILL_NAMESPACE_THEMES[skill.namespace]
  }
  return SKILL_DEFAULT_THEME
}

/** Render a soft pulsing radial aura under the given character. Called once per frame. */
export function renderSkillAura(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  offsetX: number,
  offsetY: number,
  zoom: number,
  nowMs: number,
): void {
  if (!ch.activeSkill) return
  // Don't render aura during matrix spawn/despawn — the effect itself is the focus
  if (ch.matrixEffect) return

  const theme = getSkillTheme(ch.activeSkill)
  const [r, g, b] = theme.aura

  // Pulse alpha — smooth sinusoid between MIN and PEAK
  const t = ((nowMs / 1000) % SKILL_AURA_PULSE_PERIOD_SEC) / SKILL_AURA_PULSE_PERIOD_SEC
  const phase = 0.5 * (1 - Math.cos(2 * Math.PI * t)) // 0..1
  const alpha = SKILL_AURA_MIN_ALPHA + phase * (SKILL_AURA_PEAK_ALPHA - SKILL_AURA_MIN_ALPHA)

  const sittingOffset = isSittingState(ch.state) ? CHARACTER_SITTING_OFFSET_PX : 0
  const cx = offsetX + ch.x * zoom
  const cy = offsetY + (ch.y + sittingOffset + SKILL_AURA_CENTER_OFFSET_Y) * zoom
  const outerRadius = SKILL_AURA_RADIUS_PX * zoom

  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, outerRadius)
  grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`)
  grad.addColorStop(0.55, `rgba(${r}, ${g}, ${b}, ${(alpha * 0.45).toFixed(3)})`)
  grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)

  ctx.save()
  ctx.globalCompositeOperation = 'screen'
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // Silence unused import warning (TILE_SIZE) when this file is tree-shaken
  void TILE_SIZE
}

/**
 * Render a small book/scroll badge above the character indicating an active skill.
 * Rendered procedurally in device pixels so it stays crisp at any zoom.
 * Position is computed relative to where the main bubble would sit, offset above it.
 */
export function renderSkillBubble(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  offsetX: number,
  offsetY: number,
  zoom: number,
  bubbleVerticalOffsetPx: number,
): void {
  if (!ch.activeSkill) return
  if (ch.matrixEffect) return

  const theme = getSkillTheme(ch.activeSkill)
  const [r, g, b] = theme.aura

  const sittingOff = isSittingState(ch.state) ? CHARACTER_SITTING_OFFSET_PX : 0
  const charCenterX = offsetX + ch.x * zoom
  const charTopY = offsetY + (ch.y + sittingOff - bubbleVerticalOffsetPx) * zoom

  // Badge size in sprite-pixels: 11×11 — same width as existing bubbles so they align
  const bw = 11
  const bh = 11
  const badgeX = Math.round(charCenterX - (bw / 2) * zoom) + Math.round(9 * zoom) // offset right of main bubble
  const badgeY = Math.round(charTopY - bh * zoom - Math.round(12 * zoom)) // above main bubble

  ctx.save()
  // Background fill
  ctx.fillStyle = `rgb(${Math.round(r * 0.25)}, ${Math.round(g * 0.25)}, ${Math.round(b * 0.25)})`
  ctx.fillRect(badgeX, badgeY, bw * zoom, bh * zoom)
  // Outer border (1 pixel)
  ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
  ctx.fillRect(badgeX, badgeY, bw * zoom, zoom) // top
  ctx.fillRect(badgeX, badgeY + (bh - 1) * zoom, bw * zoom, zoom) // bottom
  ctx.fillRect(badgeX, badgeY, zoom, bh * zoom) // left
  ctx.fillRect(badgeX + (bw - 1) * zoom, badgeY, zoom, bh * zoom) // right

  // Book icon inside (2 pages + spine)
  // Page-left rectangle
  ctx.fillStyle = `rgb(${Math.min(255, r + 30)}, ${Math.min(255, g + 30)}, ${Math.min(255, b + 30)})`
  ctx.fillRect(badgeX + 2 * zoom, badgeY + 3 * zoom, 3 * zoom, 5 * zoom)
  // Page-right rectangle
  ctx.fillRect(badgeX + 6 * zoom, badgeY + 3 * zoom, 3 * zoom, 5 * zoom)
  // Spine
  ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
  ctx.fillRect(badgeX + 5 * zoom, badgeY + 2 * zoom, zoom, 7 * zoom)

  ctx.restore()
}
