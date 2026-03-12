import { useEffect, useRef } from 'react'

interface DevConsoleProps {
  logs: string[]
  version?: string
  onClose: () => void
}

/** Color-code log entries by event type keyword */
function entryColor(entry: string): string {
  if (entry.includes('] BIND  ')) return '#4ec9b0'   // teal
  if (entry.includes('] UNBIND')) return '#f48771'   // red-orange
  if (entry.includes('] CREATE')) return '#9cdcfe'   // light blue
  if (entry.includes('] CLOSE ')) return '#f48771'   // red-orange
  if (entry.includes('] TICK  ')) return '#6a9955'   // green (dim)
  if (entry.includes('] STATUS')) return '#dcdcaa'   // yellow
  if (entry.includes('] CONN  ')) return '#569cd6'   // blue
  return 'var(--pixel-text-dim)'
}

export function DevConsole({ logs, version, onClose }: DevConsoleProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs.length])

  return (
    <div
      style={{
        position: 'absolute',
        top: 36,
        right: 8,
        width: 420,
        height: 280,
        background: 'var(--pixel-bg)',
        border: '2px solid var(--pixel-border)',
        boxShadow: '3px 3px 0px #0a0a14',
        zIndex: 55,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'monospace',
        fontSize: '16px',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '4px 8px',
          background: 'var(--pixel-border)',
          color: 'var(--pixel-text)',
          fontSize: '16px',
          fontFamily: 'inherit',
          flexShrink: 0,
        }}
      >
        <span style={{ fontWeight: 'bold', letterSpacing: '0.05em' }}>
          Dev Console{version ? <span style={{ fontWeight: 'normal', color: 'var(--pixel-text-dim)', marginLeft: 6, fontSize: '13px' }}>{version}</span> : null}
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--pixel-text-dim)',
            cursor: 'pointer',
            fontSize: '12px',
            padding: '0 2px',
            lineHeight: 1,
          }}
          title="Close Dev Console"
        >
          ✕
        </button>
      </div>

      {/* Log area */}
      <div
        style={{
          overflowY: 'auto',
          flex: 1,
          padding: '6px 8px',
          minHeight: 60,
        }}
      >
        {logs.length === 0 ? (
          <span style={{ color: 'var(--pixel-text-dim)', fontStyle: 'italic' }}>
            No events yet...
          </span>
        ) : (
          logs.map((entry, i) => (
            <div
              key={i}
              style={{
                color: entryColor(entry),
                lineHeight: '1.5',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {entry}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
