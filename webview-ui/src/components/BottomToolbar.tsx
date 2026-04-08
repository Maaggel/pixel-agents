import { useState, useEffect } from 'react'
import { SettingsModal } from './SettingsModal.js'

interface BottomToolbarProps {
  isEditMode: boolean
  onToggleEditMode: () => void
  isDebugMode: boolean
  onToggleDebugMode: () => void
  showNametags: boolean
  onToggleNametags: () => void
  showBackups?: boolean
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 10,
  left: 10,
  zIndex: 'var(--pixel-controls-z)',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  padding: '4px 6px',
  boxShadow: 'var(--pixel-shadow)',
}

const btnBase: React.CSSProperties = {
  padding: '5px 10px',
  fontSize: '24px',
  color: 'var(--pixel-text)',
  background: 'var(--pixel-btn-bg)',
  border: '2px solid transparent',
  borderRadius: 0,
  cursor: 'pointer',
}

const btnActive: React.CSSProperties = {
  ...btnBase,
  background: 'var(--pixel-active-bg)',
  border: '2px solid var(--pixel-accent)',
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 99998,
  background: 'rgba(10, 10, 20, 0.8)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const modalStyle: React.CSSProperties = {
  background: '#1e1e2e',
  border: '2px solid #444466',
  boxShadow: '4px 4px 0 #0a0a14',
  width: '90vw',
  maxWidth: 900,
  height: '80vh',
  display: 'flex',
  flexDirection: 'column',
}

const modalHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  padding: '8px 12px',
  borderBottom: '2px solid #444466',
}

const closeBtnStyle: React.CSSProperties = {
  background: '#444466',
  border: '2px solid #555577',
  color: '#cccccc',
  fontFamily: 'monospace',
  fontSize: '13px',
  padding: '4px 12px',
  cursor: 'pointer',
}


export function BottomToolbar({
  isEditMode,
  onToggleEditMode,
  isDebugMode,
  onToggleDebugMode,
  showNametags,
  onToggleNametags,
  showBackups,
}: BottomToolbarProps) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isBackupsOpen, setIsBackupsOpen] = useState(false)

  // Listen for restore message from the backups iframe
  useEffect(() => {
    if (!isBackupsOpen) return
    function onMessage(e: MessageEvent) {
      if (e.data?.type === 'backupRestored') {
        setIsBackupsOpen(false)
        window.location.reload()
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [isBackupsOpen])

  return (
    <>
      <div style={panelStyle}>
        <button
          onClick={onToggleEditMode}
          onMouseEnter={() => setHovered('edit')}
          onMouseLeave={() => setHovered(null)}
          style={
            isEditMode
              ? { ...btnActive }
              : {
                  ...btnBase,
                  background: hovered === 'edit' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
                }
          }
          title="Edit office layout"
        >
          Layout
        </button>
        {isEditMode && showBackups && (
          <button
            onClick={() => setIsBackupsOpen(true)}
            onMouseEnter={() => setHovered('backups')}
            onMouseLeave={() => setHovered(null)}
            style={{
              ...btnBase,
              background: hovered === 'backups' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
            }}
            title="View layout backups"
          >
            Backups
          </button>
        )}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setIsSettingsOpen((v) => !v)}
            onMouseEnter={() => setHovered('settings')}
            onMouseLeave={() => setHovered(null)}
            style={
              isSettingsOpen
                ? { ...btnActive }
                : {
                    ...btnBase,
                    background: hovered === 'settings' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
                  }
            }
            title="Settings"
          >
            Settings
          </button>
          <SettingsModal
            isOpen={isSettingsOpen}
            onClose={() => setIsSettingsOpen(false)}
            isDebugMode={isDebugMode}
            onToggleDebugMode={onToggleDebugMode}
            showNametags={showNametags}
            onToggleNametags={onToggleNametags}
          />
        </div>
      </div>

      {isBackupsOpen && (
        <div style={overlayStyle} onClick={() => setIsBackupsOpen(false)}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
            <div style={modalHeaderStyle}>
              <button style={closeBtnStyle} onClick={() => setIsBackupsOpen(false)}>Close</button>
            </div>
            <iframe
              src="./backups"
              style={{ flex: 1, border: 'none', background: '#1e1e2e' }}
            />
          </div>
        </div>
      )}
    </>
  )
}
