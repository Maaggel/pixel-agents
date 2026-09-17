import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getHost } from './host.js';
import type { KeyValueStore, MessageSink } from './host.js';
import { createAgentState } from './types.js';
import type { AgentState, PersistedAgent } from './types.js';
import { cancelPermissionTimer } from './timerManager.js';
import { startFileWatching, ensureProjectScan } from './fileWatcher.js';
import { JSONL_POLL_INTERVAL_MS, WORKSPACE_KEY_AGENTS } from './constants.js';
import { getPersonalityEngine } from './personalityEngine.js';

export function getProjectDirPath(cwd?: string): string | null {
	const workspacePath = cwd || getHost().workspaceFolders()[0]?.path;
	if (!workspacePath) return null;
	// Match Claude Code's hashing: replace : \ / and spaces with -
	const dirName = workspacePath.replace(/[:\\\/ ]/g, '-');
	const projectDir = path.join(os.homedir(), '.claude', 'projects', dirName);
	// Check if the dir exists as-is; if not, try case-insensitive match
	// (Windows drive letter may be uppercase or lowercase)
	if (!fs.existsSync(projectDir)) {
		try {
			const parent = path.dirname(projectDir);
			const basename = path.basename(projectDir);
			const entries = fs.readdirSync(parent);
			const match = entries.find(e => e.toLowerCase() === basename.toLowerCase());
			if (match) {
				const resolved = path.join(parent, match);
				console.log(`[Pixel Agents] Project dir (case-fixed): ${workspacePath} → ${match}`);
				return resolved;
			}
		} catch { /* parent doesn't exist */ }
	}
	return projectDir;
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
	store: KeyValueStore,
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
	store.update(WORKSPACE_KEY_AGENTS, persisted);
}

export function restoreAgents(
	store: KeyValueStore,
	nextAgentIdRef: { current: number },
	nextTerminalIndexRef: { current: number },
	agents: Map<number, AgentState>,
	knownJsonlFiles: Set<string>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	projectScanTimers: Map<string, ReturnType<typeof setInterval>>,
	activeAgentIdRef: { current: number | null },
	webview: MessageSink | undefined,
	doPersist: () => void,
): void {
	const rawPersisted = store.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS, []);
	if (rawPersisted.length === 0) return;

	const liveTerminals = getHost().terminals();
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
		// Name will be corrected by writeSyncState — register with best available now
		getPersonalityEngine()?.registerAgent(p.id, p.agentDefinitionId || `agent-${p.id}`, p.folderName || terminal.name || `Agent ${p.id}`);

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
	store.update(WORKSPACE_KEY_AGENTS,
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
			restoredProjectDir, knownJsonlFiles, projectScanTimers, activeAgentIdRef,
			nextAgentIdRef, agents, fileWatchers, pollingTimers, permissionTimers,
			webview, doPersist,
		);
	}
}
