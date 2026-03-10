import type * as vscode from 'vscode';
import type { AgentState } from './types.js';
import { PERMISSION_TIMER_DELAY_MS } from './constants.js';
import { sendAgentStateUpdate } from './agentDisplayState.js';

export function cancelPermissionTimer(
	agentId: number,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
	const timer = permissionTimers.get(agentId);
	if (timer) {
		clearTimeout(timer);
		permissionTimers.delete(agentId);
	}
}

export function startPermissionTimer(
	agentId: number,
	agents: Map<number, AgentState>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionExemptTools: Set<string>,
	webview: vscode.Webview | undefined,
): void {
	cancelPermissionTimer(agentId, permissionTimers);
	const timer = setTimeout(() => {
		permissionTimers.delete(agentId);
		const agent = agents.get(agentId);
		if (!agent) return;

		// Only flag if there are still active non-exempt tools (parent or sub-agent)
		let hasNonExempt = false;
		for (const toolId of agent.activeToolIds) {
			const toolName = agent.activeToolNames.get(toolId);
			if (!permissionExemptTools.has(toolName || '')) {
				hasNonExempt = true;
				break;
			}
		}

		// Check sub-agent tools for non-exempt tools
		const stuckSubagentParentToolIds: string[] = [];
		for (const [parentToolId, subToolNames] of agent.activeSubagentToolNames) {
			for (const [, toolName] of subToolNames) {
				if (!permissionExemptTools.has(toolName)) {
					stuckSubagentParentToolIds.push(parentToolId);
					hasNonExempt = true;
					break;
				}
			}
		}

		if (hasNonExempt) {
			agent.permissionSent = true;
			console.log(`[Pixel Agents] Agent ${agentId}: possible permission wait detected`);
			webview?.postMessage({
				type: 'agentToolPermission',
				id: agentId,
			});
			for (const parentToolId of stuckSubagentParentToolIds) {
				webview?.postMessage({
					type: 'subagentToolPermission',
					id: agentId,
					parentToolId,
				});
			}
			sendAgentStateUpdate(agentId, agents, webview);
		}
	}, PERMISSION_TIMER_DELAY_MS);
	permissionTimers.set(agentId, timer);
}
