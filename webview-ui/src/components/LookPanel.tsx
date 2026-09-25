import { useCallback, useMemo, useState } from 'react'
import type { CharacterLook } from '../office/lookFromName.js'
import { lookFromName, lookToStored } from '../office/lookFromName.js'
import { getPartCounts } from '../office/sprites/spriteData.js'
import { LOOK_HUE_STEP_DEG, LOOK_HUE_STEPS } from '../constants.js'

/**
 * Picking what somebody wears: a hairstyle, a shirt, a pair of legs and a skin, each with a hue of
 * its own. The choice is kept by the relay, not the browser, so it shows up in every other window
 * and on the tablet, and it outlives the tab - the same way the layout does.
 */
interface LookPanelProps {
  name: string
  look: CharacterLook
  onChange: (look: CharacterLook) => void
  onClose: () => void
}

const HUES = Array.from({ length: LOOK_HUE_STEPS }, (_, i) => i * LOOK_HUE_STEP_DEG)

export function LookPanel({ name, look, onChange, onClose }: LookPanelProps) {
  const counts = useMemo(() => getPartCounts(), [])
  const [current, setCurrent] = useState<CharacterLook>(look)

  const apply = useCallback((next: CharacterLook) => {
    setCurrent(next)
    onChange(next)
  }, [onChange])

  const parts = current.parts ?? lookFromName(name).parts!
  const stored = lookToStored({ ...current, parts })

  const set = (field: keyof typeof stored, value: number) => {
    const next = { ...stored, [field]: value }
    apply({
      palette: next.skin,
      hueShift: 0,
      parts: {
        hair: next.hair, hairHue: next.hairHue,
        top: next.top, topHue: next.topHue,
        legs: next.legs, legsHue: next.legsHue,
      },
    })
  }

  const rows: Array<{ label: string; part: keyof typeof stored; count: number; hue?: keyof typeof stored }> = [
    { label: 'Hair', part: 'hair', count: counts.hair, hue: 'hairHue' },
    { label: 'Top', part: 'top', count: counts.top, hue: 'topHue' },
    { label: 'Legs', part: 'legs', count: counts.legs, hue: 'legsHue' },
    { label: 'Skin', part: 'skin', count: counts.skin },
  ]

  return (
    <div style={panel}>
      <div style={header}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <button onClick={onClose} title="Close" style={closeButton}>&times;</button>
      </div>

      {rows.map((row) => (
        <div key={row.part} style={line}>
          <span style={label}>{row.label}</span>
          <div style={stepper}>
            <button
              style={stepButton}
              onClick={() => set(row.part, (stored[row.part] + row.count - 1) % row.count)}
              title={`Previous ${row.label.toLowerCase()}`}
            >&#x25C0;</button>
            <span style={value}>{stored[row.part]}</span>
            <button
              style={stepButton}
              onClick={() => set(row.part, (stored[row.part] + 1) % row.count)}
              title={`Next ${row.label.toLowerCase()}`}
            >&#x25B6;</button>
          </div>
          {row.hue ? (
            <div style={swatches}>
              {HUES.map((h) => (
                <button
                  key={h}
                  onClick={() => set(row.hue!, h)}
                  title={h === 0 ? 'As drawn' : `${h}°`}
                  style={{
                    ...swatch,
                    background: h === 0 ? 'var(--pixel-bg)' : `hsl(${h}, 60%, 50%)`,
                    outline: stored[row.hue!] === h ? '2px solid var(--pixel-accent)' : 'none',
                  }}
                />
              ))}
            </div>
          ) : <div style={swatches} />}
        </div>
      ))}

      <button
        style={resetButton}
        onClick={() => apply(lookFromName(name))}
        title="Back to the look this name gives on its own"
      >
        Reset to name
      </button>
    </div>
  )
}

const panel: React.CSSProperties = {
  position: 'absolute',
  top: 56,
  right: 12,
  zIndex: 'var(--pixel-panel-z)' as unknown as number,
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  boxShadow: '2px 2px 0px #0a0a14',
  padding: 8,
  width: 232,
  color: 'var(--pixel-text)',
  fontSize: 12,
}

const header: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
  marginBottom: 6,
  fontWeight: 'bold',
}

const closeButton: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--pixel-close-text)',
  cursor: 'pointer',
  fontSize: 18,
  lineHeight: 1,
  padding: '0 2px',
  flexShrink: 0,
}

const line: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginBottom: 5,
}

const label: React.CSSProperties = { width: 34, flexShrink: 0 }

const stepper: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }

const stepButton: React.CSSProperties = {
  background: 'var(--pixel-panel-bg)',
  border: '1px solid var(--pixel-border)',
  borderRadius: 0,
  color: 'var(--pixel-text)',
  cursor: 'pointer',
  fontSize: 10,
  lineHeight: 1,
  padding: '3px 4px',
}

const value: React.CSSProperties = { width: 16, textAlign: 'center' }

const swatches: React.CSSProperties = { display: 'flex', gap: 2, marginLeft: 'auto' }

const swatch: React.CSSProperties = {
  width: 12,
  height: 14,
  border: '1px solid var(--pixel-border)',
  borderRadius: 0,
  cursor: 'pointer',
  padding: 0,
}

const resetButton: React.CSSProperties = {
  width: '100%',
  marginTop: 4,
  background: 'var(--pixel-panel-bg)',
  border: '1px solid var(--pixel-border)',
  borderRadius: 0,
  color: 'var(--pixel-text)',
  cursor: 'pointer',
  fontSize: 11,
  padding: '4px 0',
}
