import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentState } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer, clearAgentActivity } from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import { FILE_WATCHER_POLL_INTERVAL_MS, PROJECT_SCAN_INTERVAL_MS } from './constants.js';
import { readSessionMarker } from './agentDetector.js';

export function startFileWatching(
	agentId: number,
	filePath: string,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	// Primary: fs.watch (unreliable on macOS — may miss events)
	try {
		const watcher = fs.watch(filePath, () => {
			readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
		});
		fileWatchers.set(agentId, watcher);
	} catch (e) {
		console.log(`[Pixel Agents] fs.watch failed for agent ${agentId}: ${e}`);
	}

	// Secondary: fs.watchFile (stat-based polling, reliable on macOS)
	try {
		fs.watchFile(filePath, { interval: FILE_WATCHER_POLL_INTERVAL_MS }, () => {
			readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
		});
	} catch (e) {
		console.log(`[Pixel Agents] fs.watchFile failed for agent ${agentId}: ${e}`);
	}

	// Tertiary: manual poll as last resort
	const interval = setInterval(() => {
		if (!agents.has(agentId)) {
			clearInterval(interval);
			try { fs.unwatchFile(filePath); } catch { /* ignore */ }
			return;
		}
		readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
	}, FILE_WATCHER_POLL_INTERVAL_MS);
	pollingTimers.set(agentId, interval);
}

export function readNewLines(
	agentId: number,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;
	try {
		const stat = fs.statSync(agent.jsonlFile);
		if (stat.size <= agent.fileOffset) return;

		const buf = Buffer.alloc(stat.size - agent.fileOffset);
		const fd = fs.openSync(agent.jsonlFile, 'r');
		fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
		fs.closeSync(fd);
		agent.fileOffset = stat.size;

		const text = agent.lineBuffer + buf.toString('utf-8');
		const lines = text.split('\n');
		agent.lineBuffer = lines.pop() || '';

		const hasLines = lines.some(l => l.trim());
		if (hasLines) {
			// New data arriving — cancel timers (data flowing means agent is still active)
			cancelWaitingTimer(agentId, waitingTimers);
			cancelPermissionTimer(agentId, permissionTimers);
			if (agent.permissionSent) {
				agent.permissionSent = false;
				webview?.postMessage({ type: 'agentToolPermissionClear', id: agentId });
			}
		}

		for (const line of lines) {
			if (!line.trim()) continue;
			processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers, webview);
		}
	} catch (e) {
		console.log(`[Pixel Agents] Read error for agent ${agentId}: ${e}`);
	}
}

/** How recently a JSONL file must have been modified to be considered "active" (10 minutes) */
const ACTIVE_FILE_MAX_AGE_MS = 600_000;

/**
 * Scan for JSONL files that are active but not tracked by any agent.
 * Should be called AFTER layout + existingAgents have been sent to the webview,
 * so that agentCreated messages arrive in the right order.
 */
export function autoAdoptActiveConversations(
	projectDir: string,
	knownJsonlFiles: Set<string>,
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	activeAgentIdRef: { current: number | null },
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	const trackedFiles = new Set<string>();
	for (const agent of agents.values()) {
		if (agent.jsonlFile) trackedFiles.add(agent.jsonlFile);
	}

	const now = Date.now();
	try {
		const files = fs.readdirSync(projectDir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => path.join(projectDir, f));
		console.log(`[Pixel Agents] autoAdopt: ${files.length} JSONL files, ${trackedFiles.size} already tracked`);
		for (const f of files) {
			if (!trackedFiles.has(f)) {
				try {
					const stat = fs.statSync(f);
					const ageMs = now - stat.mtimeMs;
					if (ageMs < ACTIVE_FILE_MAX_AGE_MS) {
						console.log(`[Pixel Agents] Auto-adopting active JSONL: ${path.basename(f)} (age: ${Math.round(ageMs / 1000)}s)`);
						adoptFileWithoutTerminal(
							f, projectDir,
							nextAgentIdRef, agents, activeAgentIdRef,
							fileWatchers, pollingTimers, waitingTimers, permissionTimers,
							webview, persistAgents,
							true,
						);
					} else {
						console.log(`[Pixel Agents] Skipping stale JSONL: ${path.basename(f)} (age: ${Math.round(ageMs / 1000)}s)`);
					}
				} catch { /* stat error — skip */ }
			}
		}
	} catch (e) {
		console.log(`[Pixel Agents] autoAdopt: error reading dir: ${e}`);
	}
}

export function ensureProjectScan(
	projectDir: string,
	knownJsonlFiles: Set<string>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	activeAgentIdRef: { current: number | null },
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	if (projectScanTimerRef.current) {
		console.log(`[Pixel Agents] ensureProjectScan: already running, skipping`);
		return;
	}

	console.log(`[Pixel Agents] ensureProjectScan: starting for ${projectDir}`);

	// Seed with all existing JSONL files so we only react to truly new ones
	try {
		const files = fs.readdirSync(projectDir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => path.join(projectDir, f));
		for (const f of files) {
			knownJsonlFiles.add(f);
		}
		console.log(`[Pixel Agents] ensureProjectScan: seeded ${files.length} known JSONL files`);
	} catch (e) {
		console.log(`[Pixel Agents] ensureProjectScan: error reading dir: ${e}`);
	}

	projectScanTimerRef.current = setInterval(() => {
		scanForNewJsonlFiles(
			projectDir, knownJsonlFiles, activeAgentIdRef, nextAgentIdRef,
			agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
			webview, persistAgents,
		);
	}, PROJECT_SCAN_INTERVAL_MS);
}

function scanForNewJsonlFiles(
	projectDir: string,
	knownJsonlFiles: Set<string>,
	activeAgentIdRef: { current: number | null },
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	let files: string[];
	try {
		files = fs.readdirSync(projectDir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => path.join(projectDir, f));
	} catch { return; }

	for (const file of files) {
		if (!knownJsonlFiles.has(file)) {
			knownJsonlFiles.add(file);
			if (activeAgentIdRef.current !== null) {
				// Active agent focused → /clear reassignment
				console.log(`[Pixel Agents] New JSONL detected: ${path.basename(file)}, reassigning to agent ${activeAgentIdRef.current}`);
				reassignAgentToFile(
					activeAgentIdRef.current, file,
					agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
					webview, persistAgents,
				);
			} else {
				// No active agent → try to adopt the focused terminal, or create a terminal-less agent
				const activeTerminal = vscode.window.activeTerminal;
				let adopted = false;
				if (activeTerminal) {
					let owned = false;
					for (const agent of agents.values()) {
						if (agent.terminalRef && agent.terminalRef === activeTerminal) {
							owned = true;
							break;
						}
					}
					if (!owned) {
						adoptTerminalForFile(
							activeTerminal, file, projectDir,
							nextAgentIdRef, agents, activeAgentIdRef,
							fileWatchers, pollingTimers, waitingTimers, permissionTimers,
							webview, persistAgents,
						);
						adopted = true;
					}
				}
				if (!adopted) {
					// No terminal to adopt — create agent without terminal (extension conversation or external CLI)
					adoptFileWithoutTerminal(
						file, projectDir,
						nextAgentIdRef, agents, activeAgentIdRef,
						fileWatchers, pollingTimers, waitingTimers, permissionTimers,
						webview, persistAgents,
					);
				}
			}
		}
	}
}

function adoptTerminalForFile(
	terminal: vscode.Terminal,
	jsonlFile: string,
	projectDir: string,
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	activeAgentIdRef: { current: number | null },
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	// Check for session marker to bind to a detected agent
	const sessionId = path.basename(jsonlFile, '.jsonl');
	const marker = readSessionMarker(sessionId);
	let definitionId: string | null = null;

	if (marker) {
		definitionId = marker.definitionId;
		// Try to find an existing detected agent to bind to
		for (const [existingId, existingAgent] of agents) {
			if (existingAgent.agentDefinitionId === definitionId && !existingAgent.terminalRef) {
				// Bind to existing detected agent instead of creating a new one
				existingAgent.terminalRef = terminal;
				existingAgent.jsonlFile = jsonlFile;
				existingAgent.fileOffset = 0;
				existingAgent.lineBuffer = '';
				activeAgentIdRef.current = existingId;
				persistAgents();
				console.log(`[Pixel Agents] Agent ${existingId}: bound terminal "${terminal.name}" to definition "${definitionId}"`);
				webview?.postMessage({ type: 'agentBound', id: existingId, definitionId });
				startFileWatching(existingId, jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
				readNewLines(existingId, agents, waitingTimers, permissionTimers, webview);
				return;
			}
		}
	} else {
		// No marker — try heuristic: if only one detected agent is unbound, auto-bind
		const unboundDetected: Array<[number, AgentState]> = [];
		for (const [existingId, existingAgent] of agents) {
			if (existingAgent.agentDefinitionId && !existingAgent.terminalRef && !existingAgent.jsonlFile) {
				unboundDetected.push([existingId, existingAgent]);
			}
		}
		if (unboundDetected.length === 1) {
			const [existingId, existingAgent] = unboundDetected[0];
			definitionId = existingAgent.agentDefinitionId;
			existingAgent.terminalRef = terminal;
			existingAgent.jsonlFile = jsonlFile;
			existingAgent.fileOffset = 0;
			existingAgent.lineBuffer = '';
			activeAgentIdRef.current = existingId;
			persistAgents();
			console.log(`[Pixel Agents] Agent ${existingId}: auto-bound terminal "${terminal.name}" to definition "${definitionId}" (only unbound agent)`);
			webview?.postMessage({ type: 'agentBound', id: existingId, definitionId });
			startFileWatching(existingId, jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
			readNewLines(existingId, agents, waitingTimers, permissionTimers, webview);
			return;
		}
	}

	// Fallback: create a new ad-hoc agent
	const id = nextAgentIdRef.current++;
	const agent: AgentState = {
		id,
		terminalRef: terminal,
		projectDir,
		jsonlFile,
		fileOffset: 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
		agentDefinitionId: definitionId,
	};

	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();

	const projectName = vscode.workspace.workspaceFolders?.[0]?.name;
	console.log(`[Pixel Agents] Agent ${id}: adopted terminal "${terminal.name}" for ${path.basename(jsonlFile)}`);
	webview?.postMessage({ type: 'agentCreated', id, projectName });

	startFileWatching(id, jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
	readNewLines(id, agents, waitingTimers, permissionTimers, webview);
}

function adoptFileWithoutTerminal(
	jsonlFile: string,
	projectDir: string,
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	activeAgentIdRef: { current: number | null },
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	skipToEnd?: boolean,
): void {
	// Skip if another agent already tracks this file
	for (const agent of agents.values()) {
		if (agent.jsonlFile === jsonlFile) return;
	}

	// When adopting an existing active file, skip to end so we don't replay stale history
	let fileOffset = 0;
	if (skipToEnd) {
		try {
			fileOffset = fs.statSync(jsonlFile).size;
		} catch { /* start from 0 */ }
	}

	// Check for session marker to bind to a detected agent
	const sessionId = path.basename(jsonlFile, '.jsonl');
	const marker = readSessionMarker(sessionId);
	if (marker) {
		for (const [existingId, existingAgent] of agents) {
			if (existingAgent.agentDefinitionId === marker.definitionId && !existingAgent.terminalRef && !existingAgent.jsonlFile) {
				existingAgent.jsonlFile = jsonlFile;
				existingAgent.fileOffset = fileOffset;
				existingAgent.lineBuffer = '';
				activeAgentIdRef.current = existingId;
				persistAgents();
				console.log(`[Pixel Agents] Agent ${existingId}: bound file to definition "${marker.definitionId}"`);
				webview?.postMessage({ type: 'agentBound', id: existingId, definitionId: marker.definitionId });
				startFileWatching(existingId, jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
				readNewLines(existingId, agents, waitingTimers, permissionTimers, webview);
				return;
			}
		}
	}

	const id = nextAgentIdRef.current++;
	const agent: AgentState = {
		id,
		terminalRef: null,
		projectDir,
		jsonlFile,
		fileOffset,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
		agentDefinitionId: marker?.definitionId ?? null,
	};

	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();

	const projectName = vscode.workspace.workspaceFolders?.[0]?.name;
	console.log(`[Pixel Agents] Agent ${id}: adopted file ${path.basename(jsonlFile)} (no terminal, offset=${fileOffset})`);
	webview?.postMessage({ type: 'agentCreated', id, projectName });

	startFileWatching(id, jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
	readNewLines(id, agents, waitingTimers, permissionTimers, webview);
}

export function reassignAgentToFile(
	agentId: number,
	newFilePath: string,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	// Stop old file watching
	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) { clearInterval(pt); }
	pollingTimers.delete(agentId);
	try { fs.unwatchFile(agent.jsonlFile); } catch { /* ignore */ }

	// Clear activity
	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);
	clearAgentActivity(agent, agentId, permissionTimers, webview);

	// Swap to new file
	agent.jsonlFile = newFilePath;
	agent.fileOffset = 0;
	agent.lineBuffer = '';
	persistAgents();

	// Start watching new file
	startFileWatching(agentId, newFilePath, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
	readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
}
