import { useState, useEffect, useRef } from 'react'

export interface VacuumDetail {
  uid: string
  name: string
  state: string
  paused: boolean
  batteryPercent: number
  currentRoomIndex: number
  totalRooms: number
  cleanedRoomCount: number
  charging: boolean
  roomProgressPercent: number
}

interface VacuumControlPanelProps {
  getVacuumDetails: () => VacuumDetail[]
  onStart: (uid: string) => void
  onPause: (uid: string) => void
  onHome: (uid: string) => void
  onRename: (uid: string, name: string) => void
}

const STATE_LABELS: Record<string, string> = {
  docked: 'Docked',
  cleaning: 'Cleaning',
  traveling: 'Traveling',
  waiting: 'Waiting',
  returning: 'Returning',
}

const STATE_COLORS: Record<string, string> = {
  docked: 'var(--pixel-text-dim)',
  cleaning: 'var(--pixel-accent)',
  traveling: '#e5c07b',
  waiting: '#e5c07b',
  returning: '#c678dd',
}

function BatteryBar({ percent, charging }: { percent: number; charging: boolean }) {
  const color = percent > 0.5 ? '#98c379' : percent > 0.2 ? '#e5c07b' : '#e06c75'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <div style={{
        flex: 1,
        height: 6,
        background: 'rgba(255,255,255,0.08)',
        position: 'relative',
        overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute',
          left: 0, top: 0, bottom: 0,
          width: `${Math.round(percent * 100)}%`,
          background: color,
          transition: 'width 0.3s',
        }} />
      </div>
      {charging && (
        <span style={{ fontSize: '16px', color: '#e5c07b', lineHeight: 1 }} title="Charging">&#9889;</span>
      )}
      <span style={{ fontSize: '16px', color: 'var(--pixel-text-dim)', minWidth: 32, textAlign: 'right' }}>
        {Math.round(percent * 100)}%
      </span>
    </div>
  )
}

function VacuumCard({
  vacuum, onStart, onPause, onHome, onRename,
}: {
  vacuum: VacuumDetail
  onStart: (uid: string) => void
  onPause: (uid: string) => void
  onHome: (uid: string) => void
  onRename: (uid: string, name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(vacuum.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const commitName = () => {
    const trimmed = editName.trim().slice(0, 20)
    if (trimmed && trimmed !== vacuum.name) onRename(vacuum.uid, trimmed)
    setEditing(false)
  }

  const isDocked = vacuum.state === 'docked'
  const isActive = !isDocked
  const stateLabel = vacuum.paused ? 'Paused' : STATE_LABELS[vacuum.state] || vacuum.state
  const stateColor = vacuum.paused ? '#e5c07b' : STATE_COLORS[vacuum.state] || 'var(--pixel-text)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Row 1: Name + state */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {editing ? (
          <input
            ref={inputRef}
            value={editName}
            onChange={e => setEditName(e.target.value)}
            onBlur={commitName}
            onKeyDown={e => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setEditing(false) }}
            maxLength={20}
            style={{
              background: 'transparent',
              border: 'none',
              borderBottom: '1px solid var(--pixel-accent)',
              borderRadius: 0,
              color: 'var(--pixel-text)',
              fontSize: '18px',
              fontFamily: 'inherit',
              padding: 0,
              width: 90,
              outline: 'none',
            }}
          />
        ) : (
          <span
            onClick={() => { setEditName(vacuum.name); setEditing(true) }}
            style={{ fontSize: '18px', color: 'var(--pixel-text)', cursor: 'pointer' }}
            title="Click to rename"
          >
            {vacuum.name}
          </span>
        )}
        <span style={{ fontSize: '16px', color: stateColor, flex: 1, textAlign: 'right' }}>
          {stateLabel}
        </span>
      </div>

      {/* Row 2: Battery + controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <div style={{ flex: 1 }}>
          <BatteryBar percent={vacuum.batteryPercent} charging={vacuum.charging} />
        </div>
        {(isDocked || vacuum.paused) && (
          <span onClick={() => onStart(vacuum.uid)} style={iconBtn} title={vacuum.paused ? 'Resume' : 'Start'}>&#9654;</span>
        )}
        {isActive && !vacuum.paused && (
          <span onClick={() => onPause(vacuum.uid)} style={iconBtn} title="Pause">&#8214;</span>
        )}
        {isActive && (
          <span onClick={() => onHome(vacuum.uid)} style={iconBtn} title="Send home">&#8962;</span>
        )}
      </div>

      {/* Row 3: Room info (always reserve space to prevent resize) */}
      <div style={{ fontSize: '14px', color: 'var(--pixel-text-dim)', height: 17, overflow: 'hidden' }}>
        {isActive && vacuum.totalRooms > 0
          ? `Room ${vacuum.currentRoomIndex + 1} \u2022 ${Math.round(vacuum.roomProgressPercent * 100)}%`
          : '\u00A0'}
      </div>
    </div>
  )
}

const iconBtn: React.CSSProperties = {
  cursor: 'pointer',
  fontSize: '16px',
  color: 'var(--pixel-text-dim)',
  opacity: 0.7,
  lineHeight: 1,
  userSelect: 'none',
}

export function VacuumControlPanel({ getVacuumDetails, onStart, onPause, onHome, onRename }: VacuumControlPanelProps) {
  const [vacuums, setVacuums] = useState<VacuumDetail[]>([])

  useEffect(() => {
    const update = () => setVacuums(getVacuumDetails())
    update()
    const id = setInterval(update, 500)
    return () => clearInterval(id)
  }, [getVacuumDetails])

  if (vacuums.length === 0) return null

  return (
    <div style={{
      position: 'absolute',
      left: 6,
      top: '50%',
      transform: 'translateY(-50%)',
      zIndex: 50,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      background: 'rgba(30, 30, 46, 0.8)',
      padding: '5px 7px',
      minWidth: 170,
      maxWidth: 210,
      pointerEvents: 'auto',
    }}>
      {/* Shared room progress */}
      {vacuums[0].totalRooms > 0 && (
        <div style={{ fontSize: '14px', color: 'var(--pixel-text-dim)' }}>
          {vacuums[0].cleanedRoomCount}/{vacuums[0].totalRooms} rooms cleaned
        </div>
      )}

      {vacuums.map(v => (
        <VacuumCard
          key={v.uid}
          vacuum={v}
          onStart={onStart}
          onPause={onPause}
          onHome={onHome}
          onRename={onRename}
        />
      ))}
    </div>
  )
}
