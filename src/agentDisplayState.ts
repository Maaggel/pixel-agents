import type * as vscode from 'vscode';
import type { AgentState } from './types.js';
import { TEXT_IDLE_DELAY_MS, THINKING_GRACE_MS, TOOL_ICON_HOLD_MS } from './constants.js';

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
 * Pure function: derive the display state from timestamps and active tools.
 * Checked in priority order — first match wins.
 *
 * 1. Has active tools           → working (show tool status)
 * 2. Turn ended (definitive)    → grace period ("Waiting...") or idle
 * 3. Fresh data flowing         → active ("Thinking..." — text output, etc.)
 * 4. User prompted recently     → active ("Thinking..." — waiting for first response)
 * 5. User prompted long ago     → idle (went silent)
 * 6. No activity ever           → idle
 */
export function computeAgentDisplayState(agent: AgentState, now?: number): AgentDisplayState {
	const t = now ?? Date.now();

	// ── 1. Active tools → working ──
	if (agent.activeToolIds.size > 0) {
		const currentTool = [...agent.activeToolNames.values()][0] ?? null;
		const toolStatus = [...agent.activeToolStatuses.values()][0] ?? null;
		return {
			isActive: true,
			currentTool,
			toolStatus,
			bubbleType: agent.permissionSent ? 'permission' : null,
			idleHint: null,
		};
	}

	// ── 1b. Tool just finished → hold its icon briefly ──
	// Fast tools (e.g. cd) complete before the next tick, so the webview never sees
	// the tool icon. Hold lastToolName for TOOL_ICON_HOLD_MS so the icon is visible.
	if (agent.lastToolDoneAt !== null && agent.lastToolName &&
		(t - agent.lastToolDoneAt) < TOOL_ICON_HOLD_MS) {
		return {
			isActive: true,
			currentTool: agent.lastToolName,
			toolStatus: agent.lastToolStatus,
			bubbleType: agent.permissionSent ? 'permission' : null,
			idleHint: null,
		};
	}

	// ── 2. Turn ended → grace period or idle ──
	// turn_duration is the definitive end signal — takes priority over fresh data
	if (agent.turnEndedAt !== null) {
		const elapsed = t - agent.turnEndedAt;
		if (elapsed < THINKING_GRACE_MS) {
			// Grace period: stay active, show "Waiting..."
			return {
				isActive: true,
				currentTool: null,
				toolStatus: null,
				bubbleType: null,
				idleHint: 'between-turns',
			};
		}
		// Grace expired → idle
		return {
			isActive: false,
			currentTool: null,
			toolStatus: null,
			bubbleType: null,
			idleHint: null,
		};
	}

	// ── 3. Fresh data flowing → active ──
	// If JSONL lines arrived recently (text output, thinking, etc.), agent is working.
	// This must be checked BEFORE the userPromptAt elapsed check, because the prompt
	// timestamp can be old (start of turn) while the agent is still actively responding.
	if (agent.lastDataAt > 0 && (t - agent.lastDataAt) < TEXT_IDLE_DELAY_MS) {
		return {
			isActive: true,
			currentTool: null,
			toolStatus: null,
			bubbleType: null,
			idleHint: 'thinking',
		};
	}

	// ── 4. User prompted → thinking or idle ──
	if (agent.userPromptAt !== null) {
		const elapsed = t - agent.userPromptAt;
		if (elapsed < TEXT_IDLE_DELAY_MS) {
			return {
				isActive: true,
				currentTool: null,
				toolStatus: null,
				bubbleType: null,
				idleHint: 'thinking',
			};
		}
		// Prompt was too long ago with no data flowing → idle
		return {
			isActive: false,
			currentTool: null,
			toolStatus: null,
			bubbleType: null,
			idleHint: null,
		};
	}

	// ── 5. Default: idle ──
	return {
		isActive: false,
		currentTool: null,
		toolStatus: null,
		bubbleType: null,
		idleHint: null,
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

/**
 * Periodic tick: re-evaluate all agents and send updates when state changes.
 * Called every ~1s from the state tick interval. This replaces per-agent timers
 * for idle/grace transitions — timestamps + periodic eval is simpler than setTimeout.
 */
let lastStates = new Map<number, string>();

export function tickAllAgents(
	agents: Map<number, AgentState>,
	webview: vscode.Webview | undefined,
): void {
	const now = Date.now();
	for (const [id, agent] of agents) {
		const state = computeAgentDisplayState(agent, now);
		const key = `${state.isActive}|${state.currentTool}|${state.toolStatus}|${state.bubbleType}|${state.idleHint}`;
		if (lastStates.get(id) !== key) {
			lastStates.set(id, key);
			webview?.postMessage({
				type: 'agentStateUpdate',
				id,
				...state,
			});
		}
	}
	// Clean up entries for removed agents
	for (const id of lastStates.keys()) {
		if (!agents.has(id)) lastStates.delete(id);
	}
	onDisplayStateChanged?.();
}
