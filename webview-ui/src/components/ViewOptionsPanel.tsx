import { useState, useCallback } from 'react'

export interface ViewOptions {
  showZoom: boolean
  showBottomBar: boolean
  showNametags: boolean
  alwaysShowActivities: boolean
  showSunlight: boolean
  showVacuumPanel: boolean
}

interface ViewOptionsPanelProps {
  options: ViewOptions
  onChange: (options: ViewOptions) => void
}

const labelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'pointer',
  fontSize: '20px',
  color: 'var(--pixel-text)',
  whiteSpace: 'nowrap',
}

const checkboxStyle: React.CSSProperties = {
  width: 14,
  height: 14,
  accentColor: 'var(--pixel-accent)',
  cursor: 'pointer',
}

export function ViewOptionsPanel({ options, onChange }: ViewOptionsPanelProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [isHovered, setIsHovered] = useState(false)

  const toggle = useCallback((key: keyof ViewOptions) => {
    onChange({ ...options, [key]: !options[key] })
  }, [options, onChange])

  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        right: 56,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <button
        onClick={() => setIsOpen((p) => !p)}
        style={{
          background: 'var(--pixel-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          padding: '2px 6px',
          cursor: 'pointer',
          fontSize: '18px',
          color: 'var(--pixel-text-dim)',
          boxShadow: 'var(--pixel-shadow)',
          opacity: isOpen || isHovered ? 1 : 0.4,
          transition: 'opacity 0.3s',
        }}
        title="View options"
      >
        View
      </button>

      {isOpen && (
        <div
          style={{
            marginTop: 4,
            background: 'var(--pixel-bg)',
            border: '2px solid var(--pixel-border)',
            borderRadius: 0,
            padding: '6px 10px',
            boxShadow: 'var(--pixel-shadow)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            opacity: isHovered ? 1 : 0.6,
            transition: 'opacity 0.3s',
          }}
        >
          <label style={labelStyle}>
            <input type="checkbox" checked={options.showZoom} onChange={() => toggle('showZoom')} style={checkboxStyle} />
            Zoom controls
          </label>
          <label style={labelStyle}>
            <input type="checkbox" checked={options.showBottomBar} onChange={() => toggle('showBottomBar')} style={checkboxStyle} />
            Bottom menu
          </label>
          <label style={labelStyle}>
            <input type="checkbox" checked={options.showNametags} onChange={() => toggle('showNametags')} style={checkboxStyle} />
            Nameplates
          </label>
          <label style={labelStyle}>
            <input type="checkbox" checked={options.alwaysShowActivities} onChange={() => toggle('alwaysShowActivities')} style={checkboxStyle} />
            Always show activities
          </label>
          <label style={labelStyle}>
            <input type="checkbox" checked={options.showSunlight} onChange={() => toggle('showSunlight')} style={checkboxStyle} />
            Sunlight
          </label>
          <label style={labelStyle}>
            <input type="checkbox" checked={options.showVacuumPanel} onChange={() => toggle('showVacuumPanel')} style={checkboxStyle} />
            Vacuum panel
          </label>
        </div>
      )}
    </div>
  )
}
