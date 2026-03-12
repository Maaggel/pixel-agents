import type * as vscode from 'vscode';

// ── Agent Detection ────────────────────────────────────────────

export interface DetectedAgentDefinition {
	/** Stable ID: 'main' or filename stem like 'backend' */
	definitionId: string;
	/** Display name: 'Orchestrator' or title-cased filename */
	name: string;
	/** Source of the definition */
	source: 'claude-md' | 'agent-file' | 'default';
	/** Absolute path to the .md file (optional for 'default' source) */
	filePath?: string;
	/** Workspace folder path this agent belongs to */
	workspaceFolder: string;
}

export interface PixelAgentConfig {
	id: number;
	name: string;
	palette: number;
	hueShift: number;
	seatId: string | null;
}

export interface PixelAgentsConfigFile {
	version: 1;
	nextId: number;
	agents: Record<string, PixelAgentConfig>;
}

// ── Agent State ────────────────────────────────────────────────

export interface AgentState {
	id: number;
	terminalRef: vscode.Terminal | null;
	projectDir: string;
	jsonlFile: string;
	fileOffset: number;
	lineBuffer: string;
	// ── Active tool tracking (real-time) ──
	activeToolIds: Set<string>;
	activeToolStatuses: Map<string, string>;
	activeToolNames: Map<string, string>;
	activeSubagentToolIds: Map<string, Set<string>>; // parentToolId → active sub-tool IDs
	activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId → (subToolId → toolName)
	// ── Timestamp-based state (replaces boolean flags) ──
	/** When the last JSONL data was received (any record type) */
	lastDataAt: number;
	/** When the last tool_use was seen (for "was recently working" detection) */
	lastToolUseAt: number | null;
	/** When turn_duration fired (definitive turn end) */
	turnEndedAt: number | null;
	/** When a user prompt was detected (turn start) */
	userPromptAt: number | null;
	/** Last tool status string for display during grace period */
	lastToolStatus: string | null;
	/** Name of the most recently completed tool (for brief icon hold after fast tools) */
	lastToolName: string | null;
	/** When the last tool_result was processed */
	lastToolDoneAt: number | null;
	/** Whether permission prompt was detected */
	permissionSent: boolean;
	// ── Identity ──
	/** Links to DetectedAgentDefinition.definitionId, or null for ad-hoc agents */
	agentDefinitionId: string | null;
	/** Workspace folder name (only set for multi-root workspaces) */
	folderName?: string;
}

/** Create a new AgentState with sensible defaults. Only id, projectDir, jsonlFile are required. */
export function createAgentState(opts: {
	id: number;
	projectDir: string;
	jsonlFile: string;
	terminalRef?: vscode.Terminal | null;
	fileOffset?: number;
	agentDefinitionId?: string | null;
	folderName?: string;
}): AgentState {
	return {
		id: opts.id,
		terminalRef: opts.terminalRef ?? null,
		projectDir: opts.projectDir,
		jsonlFile: opts.jsonlFile,
		fileOffset: opts.fileOffset ?? 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		lastDataAt: 0,
		lastToolUseAt: null,
		turnEndedAt: null,
		userPromptAt: null,
		lastToolStatus: null,
		lastToolName: null,
		lastToolDoneAt: null,
		permissionSent: false,
		agentDefinitionId: opts.agentDefinitionId ?? null,
		folderName: opts.folderName,
	};
}

export interface PersistedAgent {
	id: number;
	terminalName: string;
	jsonlFile: string;
	projectDir: string;
	/** Links to DetectedAgentDefinition.definitionId, or null for ad-hoc agents */
	agentDefinitionId?: string | null;
	/** Workspace folder name (only set for multi-root workspaces) */
	folderName?: string;
}

// ── Cross-Window Sync ──────────────────────────────────────────

/** Position + animation state synced from the source window */
export interface SyncCharacterVisual {
	x: number;
	y: number;
	tileCol: number;
	tileRow: number;
	state: string;
	dir: number;
	frame: number;
	moveProgress: number;
	/** Remaining path tiles for walk state — remote windows animate locally */
	path?: Array<{ col: number; row: number }>;
}

export interface SyncAgentState {
	localId: number;
	definitionId: string | null;
	name: string;
	palette: number;
	hueShift: number;
	seatId: string | null;
	isActive: boolean;
	currentTool: string | null;
	/** Full tool status string for display (e.g., "Edit: src/foo.ts") */
	currentToolStatus: string | null;
	isWaiting: boolean;
	bubbleType: 'permission' | 'waiting' | null;
	idleHint: 'thinking' | 'between-turns' | null;
	folderName?: string;
	visual?: SyncCharacterVisual;
}

export interface SyncWindowState {
	windowId: string;
	workspaceName: string;
	workspaceFolder: string;
	pid: number;
	agents: SyncAgentState[];
	updatedAt: number;
}
