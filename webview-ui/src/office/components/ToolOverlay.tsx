import { useState, useEffect } from 'react'
import type { ToolActivity } from '../types.js'
import type { OfficeState } from '../engine/officeState.js'
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js'
import { TILE_SIZE } from '../types.js'
import { isSittingState } from '../engine/characters.js'
import { TOOL_OVERLAY_VERTICAL_OFFSET, CHARACTER_SITTING_OFFSET_PX } from '../../constants.js'

interface ToolOverlayProps {
  officeState: OfficeState
  agentTools: Record<number, ToolActivity[]>
  subagentTools: Record<number, Record<string, ToolActivity[]>>
  subagentCharacters: SubagentCharacter[]
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
  onShuffleAgent: (id: number) => void
  alwaysShowActivities?: boolean
}

/** Derive a short human-readable activity string from tools/status */
function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
  remoteToolStatus?: string | null,
  idleHint?: 'thinking' | 'between-turns' | null,
): string {
  // Check local tool list first (VS Code webview has detailed tool tracking)
  const tools = agentTools[agentId]
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done)
    if (activeTool) {
      if (activeTool.permissionWait) return 'Needs approval'
      return activeTool.status
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1]
      if (lastTool) return lastTool.status
    }
  }

  // Fallback: use synced tool status from agentStateUpdate
  // (standalone browser doesn't have agentToolStart messages,
  // so agentTools is empty — use remoteToolStatus instead)
  if (remoteToolStatus) return remoteToolStatus

  if (isActive) {
    if (idleHint === 'between-turns') return 'Waiting...'
    return 'Thinking...'
  }
  return 'Idle'
}

/** Get the tool activities for a sub-agent character from the subagentTools state */
function getSubagentToolActivities(
  sub: SubagentCharacter,
  subagentTools: Record<number, Record<string, ToolActivity[]>>,
): ToolActivity[] | undefined {
  return subagentTools[sub.parentAgentId]?.[sub.parentToolId]
}

export function ToolOverlay({
  officeState,
  agentTools,
  subagentTools,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onShuffleAgent,
  alwaysShowActivities,
}: ToolOverlayProps) {
  const [, setTick] = useState(0)
  useEffect(() => {
    let rafId = 0
    const tick = () => {
      setTick((n) => n + 1)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  const el = containerRef.current
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const canvasW = Math.round(rect.width * dpr)
  const canvasH = Math.round(rect.height * dpr)
  const layout = officeState.getLayout()
  const mapW = layout.cols * TILE_SIZE * zoom
  const mapH = layout.rows * TILE_SIZE * zoom
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x)
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y)

  const selectedId = officeState.selectedAgentId
  const hoveredId = officeState.hoveredAgentId

  // All character IDs — include remote agents so their tool status is visible
  const allIds = Array.from(officeState.characters.keys()).filter((id) => {
    const ch = officeState.characters.get(id)
    return ch && ch.matrixEffect !== 'despawn'
  })

  return (
    <>
      {allIds.map((id) => {
        const ch = officeState.characters.get(id)
        if (!ch) return null

        const isSelected = selectedId === id
        const isHovered = hoveredId === id
        const isSub = ch.isSubagent

        // Show for hovered/selected agents, or all non-idle agents if alwaysShowActivities
        const isNonIdle = ch.isActive || ch.isWaiting
        if (!isSelected && !isHovered && !(alwaysShowActivities && isNonIdle)) return null

        // Position above character
        const sittingOffset = isSittingState(ch.state) ? CHARACTER_SITTING_OFFSET_PX : 0
        const screenX = (deviceOffsetX + ch.x * zoom) / dpr
        const screenY = (deviceOffsetY + (ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET) * zoom) / dpr

        // Get activity text
        const subHasPermission = isSub && ch.bubbleType === 'permission'
        let activityText: string
        let subLabel: string | undefined
        if (isSub) {
          const sub = subagentCharacters.find((s) => s.id === id)
          subLabel = sub?.label
          if (subHasPermission) {
            activityText = 'Needs approval'
          } else if (sub) {
            // Show actual tool activity if available, fall back to task label
            const subTools = getSubagentToolActivities(sub, subagentTools)
            if (subTools && subTools.length > 0) {
              const activeTool = [...subTools].reverse().find((t) => !t.done)
              if (activeTool) {
                activityText = activeTool.permissionWait ? 'Needs approval' : activeTool.status
              } else if (ch.isActive) {
                // All tools done but still active (mid-turn)
                const lastTool = subTools[subTools.length - 1]
                activityText = lastTool ? lastTool.status : sub.label
              } else {
                activityText = sub.label
              }
            } else {
              activityText = sub.label
            }
          } else {
            activityText = 'Subtask'
          }
        } else {
          activityText = getActivityText(id, agentTools, ch.isActive, ch.remoteToolStatus, ch.idleHint)
        }

        // Determine dot color
        const tools = isSub
          ? (() => { const sub = subagentCharacters.find((s) => s.id === id); return sub ? getSubagentToolActivities(sub, subagentTools) : undefined })()
          : (ch.isRemote ? undefined : agentTools[id])
        const hasPermission = subHasPermission || ch.bubbleType === 'permission' || tools?.some((t) => t.permissionWait && !t.done)
        const hasActiveTools = tools?.some((t) => !t.done) || !!ch.remoteToolStatus
        const isActive = ch.isActive

        let dotColor: string | null = null
        if (hasPermission) {
          dotColor = 'var(--pixel-status-permission)'
        } else if (isActive && hasActiveTools) {
          dotColor = 'var(--pixel-status-active)'
        }

        return (
          <div
            key={id}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY - 24,
              transform: 'translateX(-50%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              pointerEvents: isSelected ? 'auto' : 'none',
              zIndex: isSelected ? 'var(--pixel-overlay-selected-z)' : 'var(--pixel-overlay-z)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                background: 'var(--pixel-bg)',
                border: isSelected
                  ? '2px solid var(--pixel-border-light)'
                  : '2px solid var(--pixel-border)',
                borderRadius: 0,
                padding: isSelected ? '3px 6px 3px 8px' : '3px 8px',
                boxShadow: 'var(--pixel-shadow)',
                whiteSpace: 'nowrap',
                maxWidth: 220,
              }}
            >
              {dotColor && (
                <span
                  className={isActive && !hasPermission ? 'pixel-agents-pulse' : undefined}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: dotColor,
                    flexShrink: 0,
                  }}
                />
              )}
              <div style={{ overflow: 'hidden' }}>
                <span
                  style={{
                    fontSize: isSub ? '20px' : '22px',
                    fontStyle: isSub ? 'italic' : undefined,
                    color: 'var(--vscode-foreground)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: 'block',
                  }}
                >
                  {activityText}
                </span>
                {isSub && subLabel && activityText !== subLabel && (
                  <span
                    style={{
                      fontSize: '16px',
                      color: 'var(--pixel-text-dim)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: 'block',
                      fontStyle: 'italic',
                    }}
                  >
                    {subLabel}
                  </span>
                )}
                {ch.folderName && (
                  <span
                    style={{
                      fontSize: '16px',
                      color: 'var(--pixel-text-dim)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: 'block',
                    }}
                  >
                    {ch.folderName}
                  </span>
                )}
              </div>
              {isSelected && !isSub && (
                <>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onShuffleAgent(id)
                    }}
                    title="Shuffle appearance"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--pixel-close-text)',
                      cursor: 'pointer',
                      padding: '0 2px',
                      fontSize: '22px',
                      lineHeight: 1,
                      marginLeft: 2,
                      flexShrink: 0,
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-hover)'
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-text)'
                    }}
                  >
                    &#x21BB;
                  </button>
                </>
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}
