import { useState } from 'react'
import type { PersonalitySnapshot } from '../hooks/useExtensionMessages.js'
import type { OfficeState } from '../office/engine/officeState.js'
import type { ToolActivity } from '../office/types.js'

// Mood emoji + label mapping
const MOOD_DISPLAY: Record<string, { emoji: string; label: string; color: string }> = {
  neutral: { emoji: '\u{1F610}', label: 'Neutral', color: '#aaaaaa' },
  focused: { emoji: '\u{1F9D0}', label: 'Focused', color: '#5599dd' },
  productive: { emoji: '\u{26A1}', label: 'Productive', color: '#44bb44' },
  accomplished: { emoji: '\u{1F3C6}', label: 'Accomplished', color: '#ffcc00' },
  satisfied: { emoji: '\u{1F60A}', label: 'Satisfied', color: '#88cc44' },
  frustrated: { emoji: '\u{1F624}', label: 'Frustrated', color: '#dd5544' },
  impatient: { emoji: '\u{23F3}', label: 'Impatient', color: '#dd8844' },
  tired: { emoji: '\u{1F634}', label: 'Tired', color: '#8877aa' },
  relaxed: { emoji: '\u{1F60C}', label: 'Relaxed', color: '#66bbaa' },
  energized: { emoji: '\u{1F525}', label: 'Energized', color: '#ff8833' },
  curious: { emoji: '\u{1F914}', label: 'Curious', color: '#aa88dd' },
}

// Trait label pairs (low ↔ high)
const TRAIT_LABELS: Record<string, [string, string, string]> = {
  methodical: ['Exploratory', 'Methodical', 'Dives straight into editing vs researches first (Read/Grep ratio)'],
  collaborative: ['Independent', 'Collaborative', 'Works solo vs delegates to sub-agents (Task/Agent usage)'],
  careful: ['Bold', 'Careful', 'Acts fast vs checks carefully (error/retry frequency)'],
  specialist: ['Generalist', 'Specialist', 'Works across many file types vs focuses on a few'],
}

const STAT_INFO: Record<string, string> = {
  turns: 'A turn is one complete prompt-to-response cycle',
  tools: 'Total tool invocations (Read, Edit, Bash, etc.)',
  active: 'Cumulative time spent actively working (not idle)',
  topTools: 'Most frequently used tools — reflects work style',
  moodHistory: 'Recent emotional state changes with triggers',
}

function InfoTip({ text }: { text: string }) {
  const [show, setShow] = useState(false)
  return (
    <span
      style={{ position: 'relative', cursor: 'help', marginLeft: 4 }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <span style={{ color: 'var(--pixel-text-dim)', fontSize: '14px' }}>(i)</span>
      {show && (
        <div style={{
          position: 'absolute', right: 0, top: 18, width: 220,
          background: 'var(--pixel-bg)', border: '2px solid var(--pixel-border)',
          padding: '6px 8px', fontSize: '15px', color: 'var(--pixel-text-dim)',
          zIndex: 200, boxShadow: 'var(--pixel-shadow)', lineHeight: 1.3,
        }}>
          {text}
        </div>
      )}
    </span>
  )
}

interface PersonalityPanelProps {
  personality: PersonalitySnapshot | null
  allPersonalities: Record<string, PersonalitySnapshot>
  selectedKey: string | null
  onSelectAgent: (key: string) => void
  onClose: () => void
  officeState?: OfficeState
  agentTools?: Record<number, ToolActivity[]>
}

/** Derive current activity text for a personality by finding its matching character */
function getActivityForPersonality(p: PersonalitySnapshot, os?: OfficeState, tools?: Record<number, ToolActivity[]>): string | null {
  if (!os) return null
  for (const ch of os.characters.values()) {
    if (ch.definitionId === p.agentKey || ch.nametag === p.name) {
      if (ch.isActive) {
        const agentTools = tools?.[ch.id]
        if (agentTools) {
          const active = [...agentTools].reverse().find(t => !t.done)
          if (active) return active.status
        }
        if (ch.remoteToolStatus) return ch.remoteToolStatus
        if (ch.idleHint === 'thinking') return 'Thinking...'
        return 'Working'
      }
      if (ch.idleAction === 'conversation') return 'Chatting with a colleague'
      if (ch.idleAction === 'meeting') return 'In a meeting'
      if (ch.idleAction === 'eating') return 'Having a snack'
      if (ch.idleAction === 'visit_furniture') return 'Looking around the office'
      if (ch.idleAction === 'stand_and_think') return 'Lost in thought'
      if (ch.idleAction === 'wander') return 'Stretching their legs'
      return 'Idle'
    }
  }
  return null
}

export function PersonalityPanel({ personality, allPersonalities, selectedKey, onSelectAgent, onClose, officeState, agentTools }: PersonalityPanelProps) {
  const [tab, setTab] = useState<'overview' | 'thoughts' | 'stats'>('overview')
  const [showList, setShowList] = useState(!personality)

  const agents = Object.entries(allPersonalities)
  const active = personality ?? (agents.length > 0 ? agents[0][1] : null)

  if (!active && agents.length === 0) return null

  const moodInfo = active ? (MOOD_DISPLAY[active.mood.current] ?? MOOD_DISPLAY.neutral) : MOOD_DISPLAY.neutral

  return (
    <div style={{
      position: 'fixed',
      right: 8,
      top: 8,
      width: 320,
      maxHeight: 'calc(100vh - 16px)',
      background: 'var(--pixel-bg)',
      border: '2px solid var(--pixel-border)',
      borderRadius: 0,
      boxShadow: 'var(--pixel-shadow)',
      zIndex: 100,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      fontSize: '20px',
    }}>
      {/* Header with agent switcher */}
      <div style={{
        padding: '8px 10px',
        borderBottom: '2px solid var(--pixel-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 4,
      }}>
        <button
          onClick={() => setShowList(p => !p)}
          title="Agent list"
          style={{
            background: 'none', border: 'none',
            color: 'var(--pixel-text-dim)', cursor: 'pointer',
            fontSize: '20px', padding: '0 2px',
          }}
        >
          {showList ? '\u25B2' : '\u25BC'}
        </button>
        <span style={{ color: 'var(--pixel-text)', fontWeight: 'bold', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {active?.name ?? 'Agents'}
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'none', border: 'none',
            color: 'var(--pixel-text-dim)', cursor: 'pointer',
            fontSize: '18px', padding: '0 4px',
          }}
        >
          X
        </button>
      </div>

      {/* Agent list dropdown */}
      {showList && (
        <div style={{
          borderBottom: '1px solid var(--pixel-border)',
          maxHeight: 150,
          overflow: 'auto',
        }}>
          {agents.map(([key, p]) => {
            const mi = MOOD_DISPLAY[p.mood.current] ?? MOOD_DISPLAY.neutral
            const isActive = key === selectedKey || (!selectedKey && active === p)
            return (
              <button
                key={key}
                onClick={() => { onSelectAgent(key); setShowList(false) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  width: '100%', padding: '4px 10px',
                  background: isActive ? 'rgba(255,255,255,0.06)' : 'transparent',
                  border: 'none', borderRadius: 0, cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ fontSize: '16px' }}>{mi.emoji}</span>
                <span style={{ color: 'var(--pixel-text)', fontSize: '18px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.name}
                </span>
                <span style={{ color: mi.color, fontSize: '12px' }}>{mi.label}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Mood + activity display */}
      {active && (() => {
        const activity = getActivityForPersonality(active, officeState, agentTools)
        return (
          <div style={{
            padding: '8px 10px',
            borderBottom: '1px solid var(--pixel-border)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: '24px' }}>{moodInfo.emoji}</span>
              <div>
                <div style={{ color: moodInfo.color, fontWeight: 'bold' }}>
                  {moodInfo.label}
                </div>
                {active.latestThought && (
                  <div style={{
                    color: 'var(--pixel-text-dim)',
                    fontSize: '18px',
                    fontStyle: 'italic',
                    marginTop: 2,
                  }}>
                    &ldquo;{active.latestThought.text}&rdquo;
                  </div>
                )}
              </div>
            </div>
            {activity && (
              <div style={{
                marginTop: 6,
                padding: '3px 8px',
                background: 'rgba(255,255,255,0.04)',
                fontSize: '17px',
                color: 'var(--pixel-text-dim)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: activity === 'Idle' ? '#666' : 'var(--pixel-status-active)',
                  flexShrink: 0,
                }} />
                {activity}
              </div>
            )}
          </div>
        )
      })()}

      {/* Tab buttons */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid var(--pixel-border)',
      }}>
        {(['overview', 'thoughts', 'stats'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              padding: '4px',
              background: tab === t ? 'var(--pixel-border)' : 'transparent',
              border: 'none',
              borderRadius: 0,
              color: tab === t ? 'var(--pixel-text)' : 'var(--pixel-text-dim)',
              cursor: 'pointer',
              fontSize: '18px',
              textTransform: 'capitalize',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 10px' }}>
        {active && tab === 'overview' && <OverviewTab personality={active} />}
        {active && tab === 'thoughts' && <ThoughtsTab personality={active} />}
        {active && tab === 'stats' && <StatsTab personality={active} />}
      </div>
    </div>
  )
}

function OverviewTab({ personality }: { personality: PersonalitySnapshot }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Personality traits */}
      <div>
        <div style={{ color: 'var(--pixel-text)', fontWeight: 'bold', marginBottom: 6 }}>
          Personality <InfoTip text="Traits evolve slowly over time based on actual work patterns — how the agent reads, edits, delegates, and handles errors." />
        </div>
        {Object.entries(personality.traits).map(([key, value]) => {
          const [lowLabel, highLabel, info] = TRAIT_LABELS[key] ?? [key, key, '']
          return (
            <div key={key} style={{ marginBottom: 4 }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: '15px',
                color: 'var(--pixel-text-dim)',
                marginBottom: 1,
              }}>
                <span>{lowLabel}</span>
                <span>{highLabel}{info && <InfoTip text={info} />}</span>
              </div>
              <div style={{
                height: 6,
                background: 'rgba(255,255,255,0.08)',
                borderRadius: 0,
                position: 'relative',
              }}>
                <div style={{
                  position: 'absolute',
                  left: `${value * 100}%`,
                  top: -1,
                  width: 4,
                  height: 8,
                  background: 'var(--pixel-accent)',
                  transform: 'translateX(-50%)',
                }} />
              </div>
            </div>
          )
        })}
      </div>

      {/* Sentiment */}
      <div>
        <div style={{ color: 'var(--pixel-text)', fontWeight: 'bold', marginBottom: 4 }}>
          Overall Sentiment
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: '18px',
        }}>
          <span>{personality.averageSentiment > 0.2 ? '\u{1F60A}' : personality.averageSentiment < -0.2 ? '\u{1F61E}' : '\u{1F610}'}</span>
          <span style={{
            color: personality.averageSentiment > 0.2 ? '#88cc44' : personality.averageSentiment < -0.2 ? '#dd5544' : '#aaaaaa',
          }}>
            {personality.averageSentiment > 0.2 ? 'Positive' : personality.averageSentiment < -0.2 ? 'Negative' : 'Neutral'}
          </span>
        </div>
      </div>

      {/* Relationships */}
      <div>
        <div style={{ color: 'var(--pixel-text)', fontWeight: 'bold', marginBottom: 4 }}>
          Relationships <InfoTip text="Built from idle interactions: conversations, meetings, and collaborations between agents. Grows over time as agents interact." />
        </div>
        {personality.relationships.length > 0 ? (
          personality.relationships.map((rel) => {
            const level = rel.familiarity > 70 ? 'Close friend' : rel.familiarity > 40 ? 'Friend' : rel.familiarity > 15 ? 'Colleague' : 'Acquaintance'
            const sentimentIcon = rel.sentiment > 10 ? '\u{2764}' : rel.sentiment > 0 ? '\u{1F91D}' : '\u{1F610}'
            return (
              <div key={rel.agentId} style={{
                padding: '4px 6px',
                marginBottom: 3,
                background: 'rgba(255,255,255,0.03)',
                borderLeft: `2px solid ${rel.sentiment > 10 ? '#88cc44' : rel.sentiment > 0 ? '#5599dd' : '#666666'}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: 'var(--pixel-text)', fontSize: '17px' }}>{sentimentIcon} {rel.name}</span>
                  <span style={{ color: 'var(--pixel-text-dim)', fontSize: '15px' }}>{level}</span>
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: '14px', color: 'var(--pixel-text-dim)', marginTop: 2 }}>
                  <span>Familiarity: {rel.familiarity}</span>
                  <span>Collab: {rel.collaboration}</span>
                </div>
              </div>
            )
          })
        ) : (
          <div style={{ color: 'var(--pixel-text-dim)', fontStyle: 'italic', fontSize: '17px' }}>
            No relationships yet — agents build bonds through conversations, meetings, and working together.
          </div>
        )}
      </div>
    </div>
  )
}

function ThoughtsTab({ personality }: { personality: PersonalitySnapshot }) {
  if (personality.recentThoughts.length === 0) {
    return (
      <div style={{ color: 'var(--pixel-text-dim)', fontStyle: 'italic', padding: '8px 0' }}>
        No thoughts yet — this agent hasn&apos;t started working.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {personality.recentThoughts.map((thought, i) => {
        const moodInfo = MOOD_DISPLAY[thought.mood] ?? MOOD_DISPLAY.neutral
        const time = new Date(thought.timestamp)
        const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
        return (
          <div key={i} style={{
            padding: '4px 6px',
            background: 'rgba(255,255,255,0.03)',
            borderLeft: `2px solid ${moodInfo.color}`,
          }}>
            <div style={{ color: 'var(--pixel-text)', fontSize: '13px' }}>
              &ldquo;{thought.text}&rdquo;
            </div>
            <div style={{ color: 'var(--pixel-text-dim)', fontSize: '14px', marginTop: 2 }}>
              {moodInfo.emoji} {moodInfo.label} &middot; {timeStr} &middot; {thought.trigger.replace('_', ' ')}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function StatsTab({ personality }: { personality: PersonalitySnapshot }) {
  const activeMinutes = Math.round(personality.stats.activeTimeSec / 60)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div style={{ color: 'var(--pixel-text)', fontWeight: 'bold', marginBottom: 4 }}>
          Work Summary <InfoTip text="Statistics accumulated across all sessions in this project." />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 12px', fontSize: '17px' }}>
          <span style={{ color: 'var(--pixel-text-dim)' }}>Turns completed <InfoTip text={STAT_INFO.turns} /></span>
          <span style={{ color: 'var(--pixel-text)' }}>{personality.stats.totalTurns}</span>
          <span style={{ color: 'var(--pixel-text-dim)' }}>Tools used <InfoTip text={STAT_INFO.tools} /></span>
          <span style={{ color: 'var(--pixel-text)' }}>{personality.stats.totalTools}</span>
          <span style={{ color: 'var(--pixel-text-dim)' }}>Active time <InfoTip text={STAT_INFO.active} /></span>
          <span style={{ color: 'var(--pixel-text)' }}>{activeMinutes}m</span>
        </div>
      </div>

      {personality.stats.topTools.length > 0 && (
        <div>
          <div style={{ color: 'var(--pixel-text)', fontWeight: 'bold', marginBottom: 4 }}>
            Top Tools <InfoTip text={STAT_INFO.topTools} />
          </div>
          {personality.stats.topTools.map((tool) => (
            <div key={tool.name} style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '17px',
              padding: '1px 0',
            }}>
              <span style={{ color: 'var(--pixel-text-dim)' }}>{tool.name}</span>
              <span style={{ color: 'var(--pixel-text)' }}>{tool.count}</span>
            </div>
          ))}
        </div>
      )}

      {/* Mood timeline (simple text version — graph comes later) */}
      {personality.moodHistory.length > 0 && (
        <div>
          <div style={{ color: 'var(--pixel-text)', fontWeight: 'bold', marginBottom: 4 }}>
            Recent Mood Changes <InfoTip text={STAT_INFO.moodHistory} />
          </div>
          {personality.moodHistory.slice(-8).reverse().map(([ts, mood, _intensity, trigger], i) => {
            const moodInfo = MOOD_DISPLAY[mood] ?? MOOD_DISPLAY.neutral
            const time = new Date(ts)
            const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
            return (
              <div key={i} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: '15px',
                padding: '1px 0',
                color: 'var(--pixel-text-dim)',
              }}>
                <span>{moodInfo.emoji}</span>
                <span style={{ color: moodInfo.color }}>{moodInfo.label}</span>
                <span>&middot;</span>
                <span>{timeStr}</span>
                <span>&middot;</span>
                <span>{trigger.replace('_', ' ')}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
