import type * as vscode from 'vscode';

// ── Agent Detection ────────────────────────────────────────────

export interface DetectedAgentDefinition {
	/** Stable ID: 'main' or filename stem like 'backend' */
	definitionId: string;
	/** Display name: 'Orchestrator' or title-cased filename */
	name: string;
	/** Source of the definition */
	source: 'claude-md' | 'agent-file';
	/** Absolute path to the .md file */
	filePath: string;
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
	activeToolIds: Set<string>;
	activeToolStatuses: Map<string, string>;
	activeToolNames: Map<string, string>;
	activeSubagentToolIds: Map<string, Set<string>>; // parentToolId → active sub-tool IDs
	activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId → (subToolId → toolName)
	isWaiting: boolean;
	permissionSent: boolean;
	hadToolsInTurn: boolean;
	/** Links to DetectedAgentDefinition.definitionId, or null for ad-hoc agents */
	agentDefinitionId: string | null;
	/** Workspace folder name (only set for multi-root workspaces) */
	folderName?: string;
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
