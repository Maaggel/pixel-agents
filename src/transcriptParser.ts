import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type * as vscode from 'vscode';
import type { AgentState } from './types.js';
import {
	cancelPermissionTimer,
	startPermissionTimer,
} from './timerManager.js';
import {
	TOOL_DONE_DELAY_MS,
	BASH_COMMAND_DISPLAY_MAX_LENGTH,
	TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
	MISSING_SPRITES_MAX_ENTRIES,
} from './constants.js';
import { sendAgentStateUpdate } from './agentDisplayState.js';

export const PERMISSION_EXEMPT_TOOLS = new Set([
	'Task', 'Agent', 'AskUserQuestion', 'TaskOutput', 'TaskStop',
	'TodoWrite', 'ToolSearch', 'EnterPlanMode', 'ExitPlanMode', 'Skill',
]);

/** Tools that have dedicated bubble sprites in the webview */
const KNOWN_BUBBLE_TOOLS = new Set([
	'Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash',
	'Bash:build', 'Bash:test', 'Bash:git', 'Bash:install',
	'Task', 'Agent', 'WebFetch', 'WebSearch',
]);

// ── Persistent missing-sprites tracking ──────────────────────
const MISSING_SPRITES_FILE = path.join(os.homedir(), '.pixel-agents', 'missing-sprites.json');

/** In-memory cache loaded from disk on first access. Map<toolName, firstSeenISO>. */
let missingBubbleSpriteTools: Map<string, string> | null = null;
let savePending = false;

function ensureLoaded(): Map<string, string> {
	if (missingBubbleSpriteTools) return missingBubbleSpriteTools;
	missingBubbleSpriteTools = new Map();
	try {
		const raw = fs.readFileSync(MISSING_SPRITES_FILE, 'utf-8');
		const obj = JSON.parse(raw) as Record<string, string>;
		for (const [tool, ts] of Object.entries(obj)) {
			missingBubbleSpriteTools.set(tool, ts);
		}
	} catch { /* file doesn't exist yet — fine */ }
	return missingBubbleSpriteTools;
}

function saveToDisk(): void {
	if (savePending) return;
	savePending = true;
	// Debounce: write at most once per second
	setTimeout(() => {
		savePending = false;
		const map = ensureLoaded();
		const obj: Record<string, string> = {};
		for (const [k, v] of map) obj[k] = v;
		try {
			const dir = path.dirname(MISSING_SPRITES_FILE);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(MISSING_SPRITES_FILE, JSON.stringify(obj, null, 2));
		} catch (err) {
			console.log(`[Pixel Agents] Failed to save missing-sprites.json: ${err}`);
		}
	}, 1000);
}

function trackMissingSprite(toolName: string): void {
	const map = ensureLoaded();
	if (map.has(toolName)) return;
	// Cap size: if at limit, drop the oldest entry
	if (map.size >= MISSING_SPRITES_MAX_ENTRIES) {
		let oldestKey: string | null = null;
		let oldestTs = '';
		for (const [k, v] of map) {
			if (!oldestKey || v < oldestTs) { oldestKey = k; oldestTs = v; }
		}
		if (oldestKey) map.delete(oldestKey);
	}
	map.set(toolName, new Date().toISOString());
	console.log(`[Pixel Agents] Missing bubble sprite for tool: "${toolName}"`);
	saveToDisk();
}

/** Get the list of tools missing bubble sprites, sorted by first-seen time. */
export function getMissingBubbleSpriteTools(): Array<{ tool: string; firstSeen: Date }> {
	const map = ensureLoaded();
	return [...map.entries()]
		.sort((a, b) => a[1].localeCompare(b[1]))
		.map(([tool, ts]) => ({ tool, firstSeen: new Date(ts) }));
}

/** Clear all tracked missing sprites (e.g. after adding new sprite support). */
export function clearMissingBubbleSpriteTools(): void {
	const map = ensureLoaded();
	map.clear();
	saveToDisk();
}

/** Refine Bash tool name based on the command being run */
export function refineBashToolName(command: string): string {
	const cmd = command.trim().toLowerCase();
	// Build / compile commands
	if (/^(npm run build|yarn build|pnpm build|make\b|cmake\b|cargo build|go build|dotnet build|gradle build|mvn (compile|package)|tsc\b|esbuild\b|vite build|webpack|rollup|turbo build)/.test(cmd)) return 'Bash:build';
	if (/^npx (vsce|tsc)\b/.test(cmd)) return 'Bash:build';
	// Test commands
	if (/^(npm (run )?test|yarn test|pnpm test|jest\b|vitest\b|pytest\b|cargo test|go test|dotnet test|mvn test)/.test(cmd)) return 'Bash:test';
	// Git commands
	if (/^git\b/.test(cmd)) return 'Bash:git';
	// Install / dependency commands
	if (/^(npm (install|i|ci)|yarn (install)?$|pnpm (install|i)|pip install|cargo add|go get)/.test(cmd)) return 'Bash:install';
	return 'Bash';
}

export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
	const base = (p: unknown) => typeof p === 'string' ? path.basename(p) : '';
	switch (toolName) {
		case 'Read': return `Reading ${base(input.file_path)}`;
		case 'Edit': return `Editing ${base(input.file_path)}`;
		case 'Write': return `Writing ${base(input.file_path)}`;
		case 'Bash': {
			const cmd = (input.command as string) || '';
			return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
		}
		case 'Glob': return 'Searching files';
		case 'Grep': return 'Searching code';
		case 'WebFetch': return 'Fetching web content';
		case 'WebSearch': return 'Searching the web';
		case 'Task':
		case 'Agent': {
			const desc = typeof input.description === 'string' ? input.description : '';
			return desc ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}` : 'Running subtask';
		}
		case 'AskUserQuestion': return 'Waiting for your answer';
		case 'EnterPlanMode': return 'Planning';
		case 'NotebookEdit': return `Editing notebook`;
		default: return `Using ${toolName}`;
	}
}

export function processTranscriptLine(
	agentId: number,
	line: string,
	agents: Map<number, AgentState>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	const now = Date.now();
	agent.lastDataAt = now;

	try {
		const record = JSON.parse(line);

		if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
			const blocks = record.message.content as Array<{
				type: string; id?: string; name?: string; input?: Record<string, unknown>;
			}>;
			const hasToolUse = blocks.some(b => b.type === 'tool_use');

			if (hasToolUse) {
				// Tools starting → clear turn-ended state, set active
				agent.turnEndedAt = null;
				agent.lastToolUseAt = now;
				let hasNonExemptTool = false;
				for (const block of blocks) {
					if (block.type === 'tool_use' && block.id) {
						const rawToolName = block.name || '';
						const status = formatToolStatus(rawToolName, block.input || {});
						// Refine Bash into subcategories (build, test, git, install)
						const toolName = rawToolName === 'Bash'
							? refineBashToolName((block.input?.command as string) || '')
							: rawToolName;
						console.log(`[Pixel Agents] Agent ${agentId} tool start: ${block.id} ${status}`);
					// Track tools that don't have bubble sprites
					if (!KNOWN_BUBBLE_TOOLS.has(toolName) && !PERMISSION_EXEMPT_TOOLS.has(rawToolName)) {
						trackMissingSprite(toolName);
					}
						agent.activeToolIds.add(block.id);
						agent.activeToolStatuses.set(block.id, status);
						agent.activeToolNames.set(block.id, toolName);
						agent.lastToolStatus = status;
						if (!PERMISSION_EXEMPT_TOOLS.has(rawToolName)) {
							hasNonExemptTool = true;
						}
						webview?.postMessage({
							type: 'agentToolStart',
							id: agentId,
							toolId: block.id,
							status,
						});
						// When orchestrator delegates via Agent tool, activate matching specialist
						if (rawToolName === 'Agent' || rawToolName === 'Task') {
							const subType = block.input?.subagent_type as string | undefined;
							if (subType) {
								agent.activeAgentSubtypes.set(block.id, subType);
								webview?.postMessage({
									type: 'specialistActivated',
									id: agentId,
									toolId: block.id,
									definitionId: subType,
									description: typeof block.input?.description === 'string' ? block.input.description : '',
								});
							}
						}
					}
				}
				if (hasNonExemptTool) {
					startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
				}
				webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
				sendAgentStateUpdate(agentId, agents, webview);
			} else if (blocks.some(b => b.type === 'text')) {
				// Assistant text — agent is thinking
				webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
				sendAgentStateUpdate(agentId, agents, webview);
			}
		} else if (record.type === 'progress') {
			processProgressRecord(agentId, record, agents, permissionTimers, webview);
		} else if (record.type === 'user') {
			const content = record.message?.content;
			if (Array.isArray(content)) {
				const blocks = content as Array<{ type: string; tool_use_id?: string }>;
				const hasToolResult = blocks.some(b => b.type === 'tool_result');
				if (hasToolResult) {
					for (const block of blocks) {
						if (block.type === 'tool_result' && block.tool_use_id) {
							console.log(`[Pixel Agents] Agent ${agentId} tool done: ${block.tool_use_id}`);
							const completedToolId = block.tool_use_id;
							const completedToolName = agent.activeToolNames.get(completedToolId);
							if (completedToolName === 'Task' || completedToolName === 'Agent') {
								agent.activeSubagentToolIds.delete(completedToolId);
								agent.activeSubagentToolNames.delete(completedToolId);
								webview?.postMessage({
									type: 'subagentClear',
									id: agentId,
									parentToolId: completedToolId,
								});
								// Deactivate matching specialist
								const subType = agent.activeAgentSubtypes.get(completedToolId);
								if (subType) {
									agent.activeAgentSubtypes.delete(completedToolId);
									webview?.postMessage({
										type: 'specialistDeactivated',
										id: agentId,
										toolId: completedToolId,
										definitionId: subType,
									});
								}
							}
							agent.lastToolName = agent.activeToolNames.get(completedToolId) ?? null;
							agent.lastToolDoneAt = now;
							agent.activeToolIds.delete(completedToolId);
							agent.activeToolStatuses.delete(completedToolId);
							agent.activeToolNames.delete(completedToolId);
							const toolId = completedToolId;
							setTimeout(() => {
								webview?.postMessage({
									type: 'agentToolDone',
									id: agentId,
									toolId,
								});
							}, TOOL_DONE_DELAY_MS);
						}
					}
					sendAgentStateUpdate(agentId, agents, webview);
				} else {
					// New user text prompt — new turn starting
					agent.userPromptAt = now;
					agent.turnEndedAt = null;
					agent.lastToolStatus = null;
					agent.permissionSent = false;
					cancelPermissionTimer(agentId, permissionTimers);
					agent.activeToolIds.clear();
					agent.activeToolStatuses.clear();
					agent.activeToolNames.clear();
					agent.activeSubagentToolIds.clear();
					agent.activeSubagentToolNames.clear();
					webview?.postMessage({ type: 'agentToolsClear', id: agentId });
					webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
					sendAgentStateUpdate(agentId, agents, webview);
				}
			} else if (typeof content === 'string' && content.trim()) {
				// New user text prompt — new turn starting
				agent.userPromptAt = now;
				agent.turnEndedAt = null;
				agent.lastToolStatus = null;
				agent.permissionSent = false;
				cancelPermissionTimer(agentId, permissionTimers);
				agent.activeToolIds.clear();
				agent.activeToolStatuses.clear();
				agent.activeToolNames.clear();
				agent.activeSubagentToolIds.clear();
				agent.activeSubagentToolNames.clear();
				webview?.postMessage({ type: 'agentToolsClear', id: agentId });
				webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
				sendAgentStateUpdate(agentId, agents, webview);
			}
		} else if (record.type === 'system' && record.subtype === 'turn_duration') {
			// Definitive turn-end signal
			agent.turnEndedAt = now;
			agent.userPromptAt = null;
			agent.lastToolStatus = null;
			agent.permissionSent = false;
			cancelPermissionTimer(agentId, permissionTimers);

			agent.activeToolIds.clear();
			agent.activeToolStatuses.clear();
			agent.activeToolNames.clear();
			agent.activeSubagentToolIds.clear();
			agent.activeSubagentToolNames.clear();
			webview?.postMessage({ type: 'agentToolsClear', id: agentId });
			sendAgentStateUpdate(agentId, agents, webview);
		}
	} catch {
		// Ignore malformed lines
	}
}

function processProgressRecord(
	agentId: number,
	record: Record<string, unknown>,
	agents: Map<number, AgentState>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	const parentToolId = record.parentToolUseID as string | undefined;
	if (!parentToolId) return;

	const data = record.data as Record<string, unknown> | undefined;
	if (!data) return;

	const dataType = data.type as string | undefined;
	if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
		if (agent.activeToolIds.has(parentToolId)) {
			startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
		}
		return;
	}

	const parentToolName = agent.activeToolNames.get(parentToolId);
	if (parentToolName !== 'Task' && parentToolName !== 'Agent') {
		if (dataType === 'agent_progress') {
			console.log(`[Pixel Agents] Agent ${agentId}: agent_progress ignored — parent tool "${parentToolId}" has name "${parentToolName}" (expected Task/Agent)`);
		}
		return;
	}

	const msg = data.message as Record<string, unknown> | undefined;
	if (!msg) return;

	const msgType = msg.type as string;
	// Support both nested format (data.message.message.content) and
	// flat format (data.message.content) — Claude Code JSONL may use either
	const innerMsg = msg.message as Record<string, unknown> | undefined;
	const content = innerMsg?.content ?? msg.content;
	if (!Array.isArray(content)) return;

	if (msgType === 'assistant') {
		let hasNonExemptSubTool = false;
		for (const block of content) {
			if (block.type === 'tool_use' && block.id) {
				const toolName = block.name || '';
				const status = formatToolStatus(toolName, block.input || {});
				console.log(`[Pixel Agents] Agent ${agentId} subagent tool start: ${block.id} ${status} (parent: ${parentToolId})`);

				let subTools = agent.activeSubagentToolIds.get(parentToolId);
				if (!subTools) {
					subTools = new Set();
					agent.activeSubagentToolIds.set(parentToolId, subTools);
				}
				subTools.add(block.id);

				let subNames = agent.activeSubagentToolNames.get(parentToolId);
				if (!subNames) {
					subNames = new Map();
					agent.activeSubagentToolNames.set(parentToolId, subNames);
				}
				subNames.set(block.id, toolName);

				if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
					hasNonExemptSubTool = true;
				}

				webview?.postMessage({
					type: 'subagentToolStart',
					id: agentId,
					parentToolId,
					toolId: block.id,
					status,
				});
			}
		}
		if (hasNonExemptSubTool) {
			startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
		}
	} else if (msgType === 'user') {
		for (const block of content) {
			if (block.type === 'tool_result' && block.tool_use_id) {
				console.log(`[Pixel Agents] Agent ${agentId} subagent tool done: ${block.tool_use_id} (parent: ${parentToolId})`);

				const subTools = agent.activeSubagentToolIds.get(parentToolId);
				if (subTools) subTools.delete(block.tool_use_id);
				const subNames = agent.activeSubagentToolNames.get(parentToolId);
				if (subNames) subNames.delete(block.tool_use_id);

				const toolId = block.tool_use_id;
				setTimeout(() => {
					webview?.postMessage({
						type: 'subagentToolDone',
						id: agentId,
						parentToolId,
						toolId,
					});
				}, 300);
			}
		}
		let stillHasNonExempt = false;
		for (const [, subNames] of agent.activeSubagentToolNames) {
			for (const [, toolName] of subNames) {
				if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
					stillHasNonExempt = true;
					break;
				}
			}
			if (stillHasNonExempt) break;
		}
		if (stillHasNonExempt) {
			startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
		}
	}
}
