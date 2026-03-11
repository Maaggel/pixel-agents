import { useState, useCallback, useRef, useEffect } from 'react'
import { OfficeState } from './office/engine/officeState.js'
import { OfficeCanvas } from './office/components/OfficeCanvas.js'
import { ToolOverlay } from './office/components/ToolOverlay.js'
import { EditorToolbar } from './office/editor/EditorToolbar.js'
import { EditorState } from './office/editor/editorState.js'
import { EditTool } from './office/types.js'
import { isRotatable } from './office/layout/furnitureCatalog.js'
import { vscode } from './vscodeApi.js'
import { useExtensionMessages } from './hooks/useExtensionMessages.js'
import { PULSE_ANIMATION_DURATION_SEC, CHAR_VISUAL_REPORT_INTERVAL_MS } from './constants.js'
import { useEditorActions } from './hooks/useEditorActions.js'
import { useEditorKeyboard } from './hooks/useEditorKeyboard.js'
import { ZoomControls } from './components/ZoomControls.js'
import { BottomToolbar } from './components/BottomToolbar.js'
import { DebugView } from './components/DebugView.js'
import { ViewOptionsPanel } from './components/ViewOptionsPanel.js'
import type { ViewOptions } from './components/ViewOptionsPanel.js'
import { BehaviourLog } from './components/BehaviourLog.js'
import { addBehaviourEntry } from './behaviourLog.js'

// Game state lives outside React — updated imperatively by message handlers
const officeStateRef = { current: null as OfficeState | null }
const editorState = new EditorState()

function getOfficeState(): OfficeState {
  if (!officeStateRef.current) {
    officeStateRef.current = new OfficeState()
  }
  return officeStateRef.current
}

const actionBarBtnStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: '22px',
  background: 'var(--pixel-btn-bg)',
  color: 'var(--pixel-text-dim)',
  border: '2px solid transparent',
  borderRadius: 0,
  cursor: 'pointer',
}

const actionBarBtnDisabled: React.CSSProperties = {
  ...actionBarBtnStyle,
  opacity: 'var(--pixel-btn-disabled-opacity)',
  cursor: 'default',
}

function EditActionBar({ editor, editorState: es }: { editor: ReturnType<typeof useEditorActions>; editorState: EditorState }) {
  const [showResetConfirm, setShowResetConfirm] = useState(false)

  const undoDisabled = es.undoStack.length === 0
  const redoDisabled = es.redoStack.length === 0

  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 'var(--pixel-controls-z)',
        display: 'flex',
        gap: 4,
        alignItems: 'center',
        background: 'var(--pixel-bg)',
        border: '2px solid var(--pixel-border)',
        borderRadius: 0,
        padding: '4px 8px',
        boxShadow: 'var(--pixel-shadow)',
      }}
    >
      <button
        style={undoDisabled ? actionBarBtnDisabled : actionBarBtnStyle}
        onClick={undoDisabled ? undefined : editor.handleUndo}
        title="Undo (Ctrl+Z)"
      >
        Undo
      </button>
      <button
        style={redoDisabled ? actionBarBtnDisabled : actionBarBtnStyle}
        onClick={redoDisabled ? undefined : editor.handleRedo}
        title="Redo (Ctrl+Y)"
      >
        Redo
      </button>
      <button
        style={actionBarBtnStyle}
        onClick={editor.handleSave}
        title="Save layout"
      >
        Save
      </button>
      {!showResetConfirm ? (
        <button
          style={actionBarBtnStyle}
          onClick={() => setShowResetConfirm(true)}
          title="Reset to last saved layout"
        >
          Reset
        </button>
      ) : (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: '22px', color: 'var(--pixel-reset-text)' }}>Reset?</span>
          <button
            style={{ ...actionBarBtnStyle, background: 'var(--pixel-danger-bg)', color: '#fff' }}
            onClick={() => { setShowResetConfirm(false); editor.handleReset() }}
          >
            Yes
          </button>
          <button
            style={actionBarBtnStyle}
            onClick={() => setShowResetConfirm(false)}
          >
            No
          </button>
        </div>
      )}
    </div>
  )
}

function App() {
  const editor = useEditorActions(getOfficeState, editorState)

  const isEditDirty = useCallback(() => editor.isEditMode && editor.isDirty, [editor.isEditMode, editor.isDirty])

  const { agents, selectedAgent, agentTools, agentStatuses, subagentTools, subagentCharacters, layoutReady, loadedAssets, showNametags, setShowNametags } = useExtensionMessages(getOfficeState, editor.setLastSavedLayout, isEditDirty)

  // Report local character positions to the extension for cross-window sync
  useEffect(() => {
    const timer = setInterval(() => {
      const os = officeStateRef.current
      if (!os) return
      const states: Record<number, { x: number; y: number; tileCol: number; tileRow: number; state: string; dir: number; frame: number; moveProgress: number; path?: Array<{ col: number; row: number }> }> = {}
      for (const ch of os.characters.values()) {
        if (ch.isSubagent || ch.isRemote) continue
        states[ch.id] = {
          x: ch.x, y: ch.y,
          tileCol: ch.tileCol, tileRow: ch.tileRow,
          state: ch.state, dir: ch.dir,
          frame: ch.frame, moveProgress: ch.moveProgress,
          path: ch.path.length > 0 ? ch.path : undefined,
        }
      }
      vscode.postMessage({ type: 'characterVisualStates', states })
    }, CHAR_VISUAL_REPORT_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  const [isDebugMode, setIsDebugMode] = useState(false)

  const handleToggleDebugMode = useCallback(() => setIsDebugMode((prev) => !prev), [])

  const handleToggleNametags = useCallback(() => {
    const newVal = !showNametags
    setShowNametags(newVal)
    vscode.postMessage({ type: 'setShowNametags', enabled: newVal })
  }, [showNametags, setShowNametags])

  const [viewOptions, setViewOptions] = useState<ViewOptions>(() => {
    try {
      const saved = localStorage.getItem('pixel-agents-view-options')
      if (saved) return JSON.parse(saved) as ViewOptions
    } catch { /* ignore */ }
    return { showZoom: true, showBottomBar: true, showNametags: true, alwaysShowActivities: false }
  })
  const handleViewOptionsChange = useCallback((opts: ViewOptions) => {
    setViewOptions(opts)
    try { localStorage.setItem('pixel-agents-view-options', JSON.stringify(opts)) } catch { /* ignore */ }
    // Sync nametags toggle with existing setting
    if (opts.showNametags !== showNametags) {
      setShowNametags(opts.showNametags)
      vscode.postMessage({ type: 'setShowNametags', enabled: opts.showNametags })
    }
  }, [showNametags, setShowNametags])

  // Keep viewOptions.showNametags in sync with the extension-level setting
  useEffect(() => {
    if (viewOptions.showNametags !== showNametags) {
      setViewOptions((prev) => ({ ...prev, showNametags }))
    }
  }, [showNametags]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleTriggerMeeting = useCallback(() => {
    const os = officeStateRef.current
    if (!os) return
    const reason = os.tryStartMeeting()
    if (reason) {
      console.log(`[App] Meeting failed: ${reason}`)
      addBehaviourEntry({ agentId: 0, agentName: 'System', message: `Meeting: ${reason}`, type: 'info' })
    }
  }, [])

  const handleSelectAgent = useCallback((id: number) => {
    vscode.postMessage({ type: 'focusAgent', id })
  }, [])

  const containerRef = useRef<HTMLDivElement>(null)

  const [editorTickForKeyboard, setEditorTickForKeyboard] = useState(0)
  useEditorKeyboard(
    editor.isEditMode,
    editorState,
    editor.handleDeleteSelected,
    editor.handleRotateSelected,
    editor.handleToggleState,
    editor.handleUndo,
    editor.handleRedo,
    useCallback(() => setEditorTickForKeyboard((n) => n + 1), []),
    editor.handleToggleEditMode,
  )

  const handleShuffleAgent = useCallback((id: number) => {
    const os = getOfficeState()
    os.shuffleAgentLook(id)
    // Persist the new palette
    const seats: Record<number, { palette: number; hueShift: number; seatId: string | null }> = {}
    for (const ch of os.characters.values()) {
      if (ch.isSubagent) continue
      seats[ch.id] = { palette: ch.palette, hueShift: ch.hueShift, seatId: ch.seatId }
    }
    vscode.postMessage({ type: 'saveAgentSeats', seats })
  }, [])

  const handleClick = useCallback((agentId: number) => {
    const os = getOfficeState()
    // Remote agents cannot be focused (no local terminal)
    const ch = os.characters.get(agentId)
    if (ch?.isRemote) return
    // If clicked agent is a sub-agent, focus the parent's terminal instead
    const meta = os.subagentMeta.get(agentId)
    const focusId = meta ? meta.parentAgentId : agentId
    vscode.postMessage({ type: 'focusAgent', id: focusId })
  }, [])

  const officeState = getOfficeState()

  // Force dependency on editorTickForKeyboard to propagate keyboard-triggered re-renders
  void editorTickForKeyboard

  // Show "Press R to rotate" hint when a rotatable item is selected or being placed
  const showRotateHint = editor.isEditMode && (() => {
    if (editorState.selectedFurnitureUid) {
      const item = officeState.getLayout().furniture.find((f) => f.uid === editorState.selectedFurnitureUid)
      if (item && isRotatable(item.type)) return true
    }
    if (editorState.activeTool === EditTool.FURNITURE_PLACE && isRotatable(editorState.selectedFurnitureType)) {
      return true
    }
    return false
  })()

  if (!layoutReady) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--vscode-foreground)' }}>
        Loading...
      </div>
    )
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <style>{`
        @keyframes pixel-agents-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        .pixel-agents-pulse { animation: pixel-agents-pulse ${PULSE_ANIMATION_DURATION_SEC}s ease-in-out infinite; }
      `}</style>

      <OfficeCanvas
        officeState={officeState}
        onClick={handleClick}
        isEditMode={editor.isEditMode}
        editorState={editorState}
        onEditorTileAction={editor.handleEditorTileAction}
        onEditorEraseAction={editor.handleEditorEraseAction}
        onEditorSelectionChange={editor.handleEditorSelectionChange}
        onDeleteSelected={editor.handleDeleteSelected}
        onRotateSelected={editor.handleRotateSelected}
        onDragMove={editor.handleDragMove}
        editorTick={editor.editorTick}
        zoom={editor.zoom}
        onZoomChange={editor.handleZoomChange}
        panRef={editor.panRef}
        showNametags={showNametags}
      />

      {viewOptions.showZoom && (
        <ZoomControls zoom={editor.zoom} onZoomChange={editor.handleZoomChange} />
      )}

      {/* Vignette overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'var(--pixel-vignette)',
          pointerEvents: 'none',
          zIndex: 40,
        }}
      />

      {viewOptions.showBottomBar && (
        <BottomToolbar
          isEditMode={editor.isEditMode}
          onToggleEditMode={editor.handleToggleEditMode}
          isDebugMode={isDebugMode}
          onToggleDebugMode={handleToggleDebugMode}
          showNametags={showNametags}
          onToggleNametags={handleToggleNametags}
        />
      )}

      {editor.isEditMode && editor.isDirty && (
        <EditActionBar editor={editor} editorState={editorState} />
      )}

      {showRotateHint && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: '50%',
            transform: editor.isDirty ? 'translateX(calc(-50% + 100px))' : 'translateX(-50%)',
            zIndex: 49,
            background: 'var(--pixel-hint-bg)',
            color: '#fff',
            fontSize: '20px',
            padding: '3px 8px',
            borderRadius: 0,
            border: '2px solid var(--pixel-accent)',
            boxShadow: 'var(--pixel-shadow)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          Press <b>R</b> to rotate
        </div>
      )}

      {editor.isEditMode && (() => {
        // Compute selected furniture color from current layout
        const selUid = editorState.selectedFurnitureUid
        const selColor = selUid
          ? officeState.getLayout().furniture.find((f) => f.uid === selUid)?.color ?? null
          : null
        return (
          <EditorToolbar
            activeTool={editorState.activeTool}
            selectedTileType={editorState.selectedTileType}
            selectedFurnitureType={editorState.selectedFurnitureType}
            selectedFurnitureUid={selUid}
            selectedFurnitureColor={selColor}
            selectedZoneType={editorState.selectedZoneType}
            floorColor={editorState.floorColor}
            wallColor={editorState.wallColor}
            onToolChange={editor.handleToolChange}
            onTileTypeChange={editor.handleTileTypeChange}
            onFloorColorChange={editor.handleFloorColorChange}
            onWallColorChange={editor.handleWallColorChange}
            onSelectedFurnitureColorChange={editor.handleSelectedFurnitureColorChange}
            onFurnitureTypeChange={editor.handleFurnitureTypeChange}
            onZoneTypeChange={editor.handleZoneTypeChange}
            loadedAssets={loadedAssets}
          />
        )
      })()}

      <ViewOptionsPanel options={viewOptions} onChange={handleViewOptionsChange} />

      <ToolOverlay
        officeState={officeState}
        agentTools={agentTools}
        subagentTools={subagentTools}
        subagentCharacters={subagentCharacters}
        containerRef={containerRef}
        zoom={editor.zoom}
        panRef={editor.panRef}
        onShuffleAgent={handleShuffleAgent}
        alwaysShowActivities={viewOptions.alwaysShowActivities}
      />

      <BehaviourLog onTriggerMeeting={handleTriggerMeeting} />

      {isDebugMode && (
        <DebugView
          agents={agents}
          selectedAgent={selectedAgent}
          agentTools={agentTools}
          agentStatuses={agentStatuses}
          subagentTools={subagentTools}
          onSelectAgent={handleSelectAgent}
        />
      )}
    </div>
  )
}

export default App
