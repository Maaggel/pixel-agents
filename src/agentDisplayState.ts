import type * as vscode from 'vscode';
import type { AgentState } from './types.js';

/**
 * Consolidated display state for an agent character.
 * Computed by the backend and sent to all renderers (webview, standalone browser).
 * The renderer uses this to drive the character FSM — it doesn't compute state itself.
 */
export interface AgentDisplayState {
	isActive: boolean;
	currentTool: string | null;
	toolStatus: string | null;
	bubbleType: 'permission' | 'waiting' | null;
	/** Hint for the renderer's idle label: 'thinking' (fresh prompt) vs 'between-turns' (grace period) */
	idleHint: 'thinking' | 'between-turns' | null;
}

/**
 * Derive the display state from the backend's agent tracking state.
 * Single source of truth — used by both webview messages and sync files.
 */
export function computeAgentDisplayState(agent: AgentState): AgentDisplayState {
	let currentTool: string | null = null;
	let toolStatus: string | null = null;

	if (agent.activeToolNames.size > 0) {
		currentTool = [...agent.activeToolNames.values()][0] ?? null;
	}
	if (agent.activeToolStatuses.size > 0) {
		toolStatus = [...agent.activeToolStatuses.values()][0] ?? null;
	} else if (agent.lastToolStatus && !agent.isWaiting) {
		// Grace period: tools cleared but agent still active. Show last tool status.
		toolStatus = agent.lastToolStatus;
	}

	// Determine idle hint for the renderer
	// - 'thinking': agent is actively processing (fresh prompt, no tools used yet)
	// - 'between-turns': agent finished a turn, in grace period before going idle
	// - null: agent has active tools or is fully idle
	let idleHint: 'thinking' | 'between-turns' | null = null;
	if (!agent.isWaiting && agent.activeToolIds.size === 0) {
		idleHint = agent.hasBeenActive ? 'between-turns' : 'thinking';
	}

	return {
		isActive: !agent.isWaiting,
		currentTool,
		toolStatus,
		bubbleType: agent.permissionSent ? 'permission' : (agent.isWaiting ? 'waiting' : null),
		idleHint,
	};
}

// Callback to trigger sync file writes when display state changes
let onDisplayStateChanged: (() => void) | null = null;

/** Register a callback that fires whenever any agent's display state changes. */
export function registerDisplayStateCallback(cb: () => void): void {
	onDisplayStateChanged = cb;
}

/**
 * Send the current display state for an agent to the webview.
 * Call this after any mutation to the agent's tracking state.
 * Also triggers sync file write so standalone browsers get the update.
 */
export function sendAgentStateUpdate(
	agentId: number,
	agents: Map<number, AgentState>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;
	const state = computeAgentDisplayState(agent);
	webview?.postMessage({
		type: 'agentStateUpdate',
		id: agentId,
		...state,
	});
	onDisplayStateChanged?.();
}
