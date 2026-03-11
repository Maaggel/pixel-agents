import { useState, useEffect, useRef, useCallback } from 'react'
import { getBehaviourEntries, subscribeBehaviourLog, clearBehaviourLog } from '../behaviourLog.js'
import type { BehaviourEntry } from '../behaviourLog.js'

const ALL_TYPES = ['tool', 'status', 'idle', 'info'] as const
type EntryType = BehaviourEntry['type']

const TYPE_COLORS: Record<EntryType, string> = {
  tool: 'var(--pixel-accent)',
  status: '#98c379',
  idle: '#8888AA',
  info: 'var(--pixel-text-dim)',
}

const TYPE_LABELS: Record<EntryType, string> = {
  tool: 'Tools',
  status: 'Status',
  idle: 'Idle',
  info: 'Info',
}

const STORAGE_KEY = 'pixel-agents-log-filters'

function loadFilters(): Set<EntryType> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const arr = JSON.parse(stored) as string[]
      const valid = arr.filter((t): t is EntryType => ALL_TYPES.includes(t as EntryType))
      if (valid.length > 0) return new Set(valid)
    }
  } catch { /* ignore */ }
  return new Set(ALL_TYPES)
}

function saveFilters(filters: Set<EntryType>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...filters]))
  } catch { /* ignore */ }
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

interface BehaviourLogProps {
  onTriggerMeeting?: () => void
}

export function BehaviourLog({ onTriggerMeeting }: BehaviourLogProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [entries, setEntries] = useState<readonly BehaviourEntry[]>(getBehaviourEntries)
  const [isHovered, setIsHovered] = useState(false)
  const [activeFilters, setActiveFilters] = useState<Set<EntryType>>(loadFilters)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return subscribeBehaviourLog(() => {
      setEntries([...getBehaviourEntries()])
    })
  }, [])

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (logRef.current && isOpen) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [entries, isOpen])

  const handleToggle = useCallback(() => setIsOpen((p) => !p), [])

  const toggleFilter = useCallback((type: EntryType) => {
    setActiveFilters(prev => {
      const next = new Set(prev)
      if (next.has(type)) {
        // Don't allow disabling all filters
        if (next.size > 1) next.delete(type)
      } else {
        next.add(type)
      }
      saveFilters(next)
      return next
    })
  }, [])

  const filteredEntries = entries.filter(e => activeFilters.has(e.type))

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 10,
        right: 10,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {isOpen && (
        <div
          style={{
            width: 340,
            maxHeight: 280,
            marginBottom: 4,
            background: 'var(--pixel-bg)',
            border: '2px solid var(--pixel-border)',
            borderRadius: 0,
            boxShadow: 'var(--pixel-shadow)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '4px 8px',
              borderBottom: '2px solid var(--pixel-border)',
              fontSize: '20px',
              color: 'var(--pixel-text)',
              fontWeight: 'bold',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>Activity Log</span>
            <span style={{ fontSize: '16px', color: 'var(--pixel-text-dim)', display: 'flex', alignItems: 'center', gap: 8 }}>
              {filteredEntries.length} events
              {entries.length > 0 && (
                <button
                  onClick={clearBehaviourLog}
                  style={{
                    background: 'none',
                    border: '1px solid var(--pixel-border)',
                    borderRadius: 0,
                    padding: '1px 6px',
                    cursor: 'pointer',
                    fontSize: '14px',
                    color: 'var(--pixel-text-dim)',
                  }}
                  title="Clear activity log"
                >
                  Clear
                </button>
              )}
            </span>
          </div>

          {/* Filter bar */}
          <div
            style={{
              padding: '3px 8px',
              borderBottom: '1px solid var(--pixel-border)',
              display: 'flex',
              gap: 4,
              flexWrap: 'wrap',
            }}
          >
            {ALL_TYPES.map(type => {
              const active = activeFilters.has(type)
              return (
                <button
                  key={type}
                  onClick={() => toggleFilter(type)}
                  style={{
                    background: active ? 'var(--pixel-active-bg)' : 'none',
                    border: `1px solid ${active ? TYPE_COLORS[type] : 'var(--pixel-border)'}`,
                    borderRadius: 0,
                    padding: '1px 6px',
                    cursor: 'pointer',
                    fontSize: '14px',
                    color: active ? TYPE_COLORS[type] : 'var(--pixel-text-dim)',
                    opacity: active ? 1 : 0.5,
                  }}
                  title={`${active ? 'Hide' : 'Show'} ${TYPE_LABELS[type]} entries`}
                >
                  {TYPE_LABELS[type]}
                </button>
              )
            })}
          </div>

          {/* Log entries */}
          <div
            ref={logRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '4px 6px',
              fontSize: '17px',
              lineHeight: '1.4',
            }}
          >
            {filteredEntries.length === 0 ? (
              <div style={{ color: 'var(--pixel-text-dim)', padding: '8px 0', textAlign: 'center' }}>
                No activity yet
              </div>
            ) : (
              filteredEntries.map((entry, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 2 }}>
                  <span style={{ color: 'var(--pixel-text-dim)', flexShrink: 0, fontSize: '15px' }}>
                    {formatTime(entry.timestamp)}
                  </span>
                  <span style={{ color: TYPE_COLORS[entry.type] }}>
                    <b>{entry.agentName}</b>{' '}
                    <span style={{ color: 'var(--pixel-text)' }}>{entry.message}</span>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 4 }}>
        {onTriggerMeeting && (
          <button
            onClick={onTriggerMeeting}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            style={{
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              padding: '4px 10px',
              cursor: 'pointer',
              fontSize: '22px',
              color: 'var(--pixel-text)',
              boxShadow: 'var(--pixel-shadow)',
              opacity: isHovered ? 1 : 0.5,
              transition: 'opacity 0.3s',
            }}
            title="Trigger a meeting between idle agents"
          >
            Meeting
          </button>
        )}
        <button
          onClick={handleToggle}
          style={{
            background: isOpen ? 'var(--pixel-active-bg)' : 'var(--pixel-bg)',
            border: isOpen ? '2px solid var(--pixel-accent)' : '2px solid var(--pixel-border)',
            borderRadius: 0,
            padding: '4px 10px',
            cursor: 'pointer',
            fontSize: '22px',
            color: 'var(--pixel-text)',
            boxShadow: 'var(--pixel-shadow)',
            opacity: isOpen || isHovered ? 1 : 0.5,
            transition: 'opacity 0.3s',
          }}
          title="Show agent activity log"
        >
          Behaviour
        </button>
      </div>
    </div>
  )
}
