import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { createAgentState } from './types.js';
import type { AgentState, PersistedAgent } from './types.js';
import { cancelPermissionTimer } from './timerManager.js';
import { startFileWatching, readNewLines, ensureProjectScan } from './fileWatcher.js';
import { JSONL_POLL_INTERVAL_MS, TERMINAL_NAME_PREFIX, WORKSPACE_KEY_AGENTS, WORKSPACE_KEY_AGENT_SEATS } from './constants.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';
import { computeAgentDisplayState, sendAgentStateUpdate } from './agentDisplayState.js';

export function getProjectDirPath(cwd?: string): string | null {
	const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspacePath) return null;
	const dirName = workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
	const projectDir = path.join(os.homedir(), '.claude', 'projects', dirName);
	console.log(`[Pixel Agents] Project dir: ${workspacePath} → ${dirName}`);
	return projectDir;
}

export async function launchNewTerminal(
	nextAgentIdRef: { current: number },
	nextTerminalIndexRef: { current: number },
	agents: Map<number, AgentState>,
	activeAgentIdRef: { current: number | null },
	knownJsonlFiles: Set<string>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	folderPath?: string,
): Promise<void> {
	const folders = vscode.workspace.workspaceFolders;
	const cwd = folderPath || folders?.[0]?.uri.fsPath;
	const isMultiRoot = !!(folders && folders.length > 1);
	const idx = nextTerminalIndexRef.current++;
	const terminal = vscode.window.createTerminal({
		name: `${TERMINAL_NAME_PREFIX} #${idx}`,
		cwd,
	});
	terminal.show();

	const sessionId = crypto.randomUUID();
	terminal.sendText(`claude --session-id ${sessionId}`);

	const projectDir = getProjectDirPath(cwd);
	if (!projectDir) {
		console.log(`[Pixel Agents] No project dir, cannot track agent`);
		return;
	}

	// Pre-register expected JSONL file so project scan won't treat it as a /clear file
	const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
	knownJsonlFiles.add(expectedFile);

	// Create agent immediately (before JSONL file exists)
	const id = nextAgentIdRef.current++;
	const folderName = isMultiRoot && cwd ? path.basename(cwd) : undefined;
	const agent = createAgentState({ id, projectDir, jsonlFile: expectedFile, terminalRef: terminal, folderName });

	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();
	const customName = vscode.workspace.getConfiguration('pixel-agents').get<string>('projectName', '');
	const projectName = folderPath ? path.basename(folderPath) : (customName || folders?.[0]?.name) || undefined;
	console.log(`[Pixel Agents] Agent ${id}: created for terminal ${terminal.name}`);
	webview?.postMessage({ type: 'agentCreated', id, folderName, projectName });

	ensureProjectScan(
		projectDir, knownJsonlFiles, projectScanTimerRef, activeAgentIdRef,
		nextAgentIdRef, agents, fileWatchers, pollingTimers, permissionTimers,
		webview, persistAgents,
	);

	// Poll for the specific JSONL file to appear
	const pollTimer = setInterval(() => {
		try {
			if (fs.existsSync(agent.jsonlFile)) {
				console.log(`[Pixel Agents] Agent ${id}: found JSONL file ${path.basename(agent.jsonlFile)}`);
				clearInterval(pollTimer);
				jsonlPollTimers.delete(id);
				startFileWatching(id, agent.jsonlFile, agents, fileWatchers, pollingTimers, permissionTimers, webview);
				readNewLines(id, agents, permissionTimers, webview);
			}
		} catch { /* file may not exist yet */ }
	}, JSONL_POLL_INTERVAL_MS);
	jsonlPollTimers.set(id, pollTimer);
}

/**
 * Unbind a detected agent from its terminal without removing it.
 * The agent stays in the map (character stays idle) but all file watching stops.
 */
export function unbindAgent(
	agentId: number,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	// Stop JSONL poll timer
	const jpTimer = jsonlPollTimers.get(agentId);
	if (jpTimer) { clearInterval(jpTimer); }
	jsonlPollTimers.delete(agentId);

	// Stop file watching
	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) { clearInterval(pt); }
	pollingTimers.delete(agentId);
	try { fs.unwatchFile(agent.jsonlFile); } catch { /* ignore */ }

	// Cancel timers
	cancelPermissionTimer(agentId, permissionTimers);

	// Clear session state but keep agent in the map
	agent.terminalRef = null;
	agent.jsonlFile = '';
	agent.fileOffset = 0;
	agent.lineBuffer = '';
	agent.activeToolIds.clear();
	agent.activeToolStatuses.clear();
	agent.activeToolNames.clear();
	agent.activeSubagentToolIds.clear();
	agent.activeSubagentToolNames.clear();
	agent.lastDataAt = 0;
	agent.lastToolUseAt = null;
	agent.turnEndedAt = null;
	agent.userPromptAt = null;
	agent.lastToolStatus = null;
	agent.permissionSent = false;

	console.log(`[Pixel Agents] Agent ${agentId}: unbound from terminal (returning to idle)`);
}

export function removeAgent(
	agentId: number,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	persistAgents: () => void,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	// Stop JSONL poll timer
	const jpTimer = jsonlPollTimers.get(agentId);
	if (jpTimer) { clearInterval(jpTimer); }
	jsonlPollTimers.delete(agentId);

	// Stop file watching
	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) { clearInterval(pt); }
	pollingTimers.delete(agentId);
	try { fs.unwatchFile(agent.jsonlFile); } catch { /* ignore */ }

	// Cancel timers
	cancelPermissionTimer(agentId, permissionTimers);

	// Remove from maps
	agents.delete(agentId);
	persistAgents();
}

export function persistAgents(
	agents: Map<number, AgentState>,
	context: vscode.ExtensionContext,
): void {
	const persisted: PersistedAgent[] = [];
	for (const agent of agents.values()) {
		persisted.push({
			id: agent.id,
			terminalName: agent.terminalRef?.name ?? '',
			jsonlFile: agent.jsonlFile,
			projectDir: agent.projectDir,
			agentDefinitionId: agent.agentDefinitionId,
			folderName: agent.folderName,
		});
	}
	context.workspaceState.update(WORKSPACE_KEY_AGENTS, persisted);
}

export function restoreAgents(
	context: vscode.ExtensionContext,
	nextAgentIdRef: { current: number },
	nextTerminalIndexRef: { current: number },
	agents: Map<number, AgentState>,
	knownJsonlFiles: Set<string>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	activeAgentIdRef: { current: number | null },
	webview: vscode.Webview | undefined,
	doPersist: () => void,
): void {
	const rawPersisted = context.workspaceState.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS, []);
	if (rawPersisted.length === 0) return;

	const liveTerminals = vscode.window.terminals;
	console.log(`[Pixel Agents] restoreAgents: ${rawPersisted.length} persisted, ${liveTerminals.length} live terminals`);

	// ── Only restore agents that have a matching live terminal. ──
	// Terminal-less sessions (extension-based, or terminal lost after reload) will
	// be re-discovered by autoAdoptActiveConversations which has proper limits.
	// This prevents unbounded accumulation of phantom agents across reloads.
	let maxId = 0;
	let maxIdx = 0;
	let restoredProjectDir: string | null = null;
	const restoredIds = new Set<number>();

	for (const p of rawPersisted) {
		const terminal = liveTerminals.find(t => t.name === p.terminalName);
		if (!terminal) {
			console.log(`[Pixel Agents] restoreAgents: skipping agent ${p.id} (no terminal "${p.terminalName}")`);
			continue;
		}

		// Skip if agent is already in the map (webview was reopened)
		if (agents.has(p.id)) {
			knownJsonlFiles.add(p.jsonlFile);
			restoredIds.add(p.id);
			if (p.id > maxId) maxId = p.id;
			const match = p.terminalName.match(/#(\d+)$/);
			if (match) {
				const idx = parseInt(match[1], 10);
				if (idx > maxIdx) maxIdx = idx;
			}
			restoredProjectDir = p.projectDir;
			continue;
		}

		const agent = createAgentState({
			id: p.id, projectDir: p.projectDir, jsonlFile: p.jsonlFile,
			terminalRef: terminal, agentDefinitionId: p.agentDefinitionId, folderName: p.folderName,
		});
		agent.lastDataAt = Date.now();

		agents.set(p.id, agent);
		knownJsonlFiles.add(p.jsonlFile);
		restoredIds.add(p.id);
		console.log(`[Pixel Agents] Restored agent ${p.id} → terminal "${terminal.name}"`);

		if (p.id > maxId) maxId = p.id;
		const match = p.terminalName.match(/#(\d+)$/);
		if (match) {
			const idx = parseInt(match[1], 10);
			if (idx > maxIdx) maxIdx = idx;
		}

		restoredProjectDir = p.projectDir;

		// Start file watching if JSONL exists, skipping to end of file.
		try {
			if (p.jsonlFile && fs.existsSync(p.jsonlFile)) {
				const stat = fs.statSync(p.jsonlFile);
				agent.fileOffset = stat.size;
				startFileWatching(p.id, p.jsonlFile, agents, fileWatchers, pollingTimers, permissionTimers, webview);
			} else if (p.jsonlFile) {
				const pollTimer = setInterval(() => {
					try {
						if (fs.existsSync(agent.jsonlFile)) {
							console.log(`[Pixel Agents] Restored agent ${p.id}: found JSONL file`);
							clearInterval(pollTimer);
							jsonlPollTimers.delete(p.id);
							const stat = fs.statSync(agent.jsonlFile);
							agent.fileOffset = stat.size;
							startFileWatching(p.id, agent.jsonlFile, agents, fileWatchers, pollingTimers, permissionTimers, webview);
						}
					} catch { /* file may not exist yet */ }
				}, JSONL_POLL_INTERVAL_MS);
				jsonlPollTimers.set(p.id, pollTimer);
			}
		} catch { /* ignore errors during restore */ }
	}

	// Immediately persist only the restored agents — wipes any accumulated phantoms.
	// This runs synchronously before any async state update from dispose() could interfere.
	context.workspaceState.update(WORKSPACE_KEY_AGENTS,
		rawPersisted.filter(p => restoredIds.has(p.id)).map(p => ({
			id: p.id, terminalName: p.terminalName,
			jsonlFile: p.jsonlFile, projectDir: p.projectDir,
			agentDefinitionId: p.agentDefinitionId, folderName: p.folderName,
		}))
	);

	// Advance counters past restored IDs
	if (maxId >= nextAgentIdRef.current) {
		nextAgentIdRef.current = maxId + 1;
	}
	if (maxIdx >= nextTerminalIndexRef.current) {
		nextTerminalIndexRef.current = maxIdx + 1;
	}

	// Already persisted cleaned list in Phase 2 above.

	// Start project scan for /clear detection
	if (restoredProjectDir) {
		ensureProjectScan(
			restoredProjectDir, knownJsonlFiles, projectScanTimerRef, activeAgentIdRef,
			nextAgentIdRef, agents, fileWatchers, pollingTimers, permissionTimers,
			webview, doPersist,
		);
	}
}

export function sendExistingAgents(
	agents: Map<number, AgentState>,
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) return;
	const agentIds: number[] = [];
	for (const id of agents.keys()) {
		agentIds.push(id);
	}
	agentIds.sort((a, b) => a - b);

	// Include persisted palette/seatId from separate key
	const agentMeta = context.workspaceState.get<Record<string, { palette?: number; seatId?: string }>>(WORKSPACE_KEY_AGENT_SEATS, {});

	// Include folderName per agent
	const folderNames: Record<number, string> = {};
	for (const [id, agent] of agents) {
		if (agent.folderName) {
			folderNames[id] = agent.folderName;
		}
	}
	const customProjectName = vscode.workspace.getConfiguration('pixel-agents').get<string>('projectName', '');
	const projectName = customProjectName || vscode.workspace.workspaceFolders?.[0]?.name;
	console.log(`[Pixel Agents] sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`);

	webview.postMessage({
		type: 'existingAgents',
		agents: agentIds,
		agentMeta,
		folderNames,
		projectName,
	});

	sendCurrentAgentStatuses(agents, webview);
}

export function sendCurrentAgentStatuses(
	agents: Map<number, AgentState>,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) return;
	for (const [agentId, agent] of agents) {
		// Re-send active tools (for React UI tool list)
		for (const [toolId, status] of agent.activeToolStatuses) {
			webview.postMessage({
				type: 'agentToolStart',
				id: agentId,
				toolId,
				status,
			});
		}
		// Re-send idle status (for React UI status display)
		const state = computeAgentDisplayState(agent);
		if (!state.isActive) {
			webview.postMessage({
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		}
		// Send consolidated display state (drives character FSM)
		sendAgentStateUpdate(agentId, agents, webview);
	}
}

export function sendLayout(
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
	defaultLayout?: Record<string, unknown> | null,
): void {
	if (!webview) return;
	const layout = migrateAndLoadLayout(context, defaultLayout);
	webview.postMessage({
		type: 'layoutLoaded',
		layout,
	});
}
