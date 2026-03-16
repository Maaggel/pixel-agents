import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { createAgentState } from './types.js';
import type { AgentState } from './types.js';
import { cancelPermissionTimer } from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import { FILE_WATCHER_POLL_INTERVAL_MS, PROJECT_SCAN_INTERVAL_MS } from './constants.js';
import { sendAgentStateUpdate } from './agentDisplayState.js';
import { readSessionMarker } from './agentDetector.js';

export function startFileWatching(
	agentId: number,
	filePath: string,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	// Primary: fs.watch (unreliable on macOS — may miss events)
	try {
		const watcher = fs.watch(filePath, () => {
			readNewLines(agentId, agents, permissionTimers, webview);
		});
		fileWatchers.set(agentId, watcher);
	} catch (e) {
		console.log(`[Pixel Agents] fs.watch failed for agent ${agentId}: ${e}`);
	}

	// Secondary: fs.watchFile (stat-based polling, reliable on macOS)
	try {
		fs.watchFile(filePath, { interval: FILE_WATCHER_POLL_INTERVAL_MS }, () => {
			readNewLines(agentId, agents, permissionTimers, webview);
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
		readNewLines(agentId, agents, permissionTimers, webview);
	}, FILE_WATCHER_POLL_INTERVAL_MS);
	pollingTimers.set(agentId, interval);
}

export function readNewLines(
	agentId: number,
	agents: Map<number, AgentState>,
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
			// New data arriving — clear permission state (data flowing means not stuck)
			cancelPermissionTimer(agentId, permissionTimers);
			if (agent.permissionSent) {
				agent.permissionSent = false;
				webview?.postMessage({ type: 'agentToolPermissionClear', id: agentId });
			}
		}

		for (const line of lines) {
			if (!line.trim()) continue;
			processTranscriptLine(agentId, line, agents, permissionTimers, webview);
		}
	} catch (e) {
		console.log(`[Pixel Agents] Read error for agent ${agentId}: ${e}`);
	}
}

/** How recently a JSONL file must have been modified to be considered "active" (2 minutes) */
const ACTIVE_FILE_MAX_AGE_MS = 120_000;

/** Check if a JSONL file's last record indicates the session truly ended.
 *  Only `result` type means the session is complete (claude exited).
 *  `turn_duration` just means a turn finished — the session may still be active
 *  (user is reading the response, about to send next prompt). */
export function isSessionEnded(filePath: string): boolean {
	try {
		const fd = fs.openSync(filePath, 'r');
		try {
			const stat = fs.fstatSync(fd);
			// Read the last ~4KB to find the final line
			const tailSize = Math.min(4096, stat.size);
			const buf = Buffer.alloc(tailSize);
			fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize);
			const text = buf.toString('utf-8');
			const lines = text.split('\n').filter(l => l.trim());
			const lastLine = lines[lines.length - 1];
			if (!lastLine) return false;
			const record = JSON.parse(lastLine);
			// Only `result` = session truly complete (Claude exited)
			if (record.type === 'result') return true;
			return false;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return false;
	}
}

/** Returns true if a JSONL file hasn't been modified in > ACTIVE_FILE_MAX_AGE_MS (stale session). */
function isStaleSession(filePath: string): boolean {
	try {
		const age = Date.now() - fs.statSync(filePath).mtimeMs;
		return age > ACTIVE_FILE_MAX_AGE_MS;
	} catch {
		return true; // Can't stat → treat as stale
	}
}

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

		// Sort by modification time (most recent first) so we can limit adoption
		const candidates: Array<{ file: string; ageMs: number }> = [];
		for (const f of files) {
			if (trackedFiles.has(f)) continue;
			try {
				const stat = fs.statSync(f);
				const ageMs = now - stat.mtimeMs;
				if (ageMs < ACTIVE_FILE_MAX_AGE_MS && !isSessionEnded(f)) {
					candidates.push({ file: f, ageMs });
				} else {
					console.log(`[Pixel Agents] Skipping stale JSONL: ${path.basename(f)} (age: ${Math.round(ageMs / 1000)}s)`);
				}
			} catch { /* stat error — skip */ }
		}
		candidates.sort((a, b) => a.ageMs - b.ageMs);

		// Count live Claude terminals to limit adoption.
		// If no terminals are found (headless startup), adopt at most 1 (most recent).
		// Also count unbound definition agents — they should always be adoptable since
		// they represent configured agents that just need a JSONL file to track.
		const liveTerminalCount = vscode.window.terminals.filter(t =>
			t.name.startsWith('Claude') || t.name.startsWith('claude')
		).length;
		let unboundDefinitionCount = 0;
		for (const agent of agents.values()) {
			if (agent.agentDefinitionId && !agent.jsonlFile && !agent.terminalRef) {
				unboundDefinitionCount++;
			}
		}
		const maxAdopt = Math.max(
			liveTerminalCount - trackedFiles.size,
			liveTerminalCount === 0 ? 1 : 0,
			unboundDefinitionCount,
		);

		// ── Stale session reassignment (startup only) ──
		// If a definition agent is already bound to a JSONL that is stale (>2 min old),
		// but there's a fresher active file, reassign. This handles the case where a
		// terminal session went idle but a new CLI conversation started externally.
		if (candidates.length > 0) {
			const candidateFiles = new Set(candidates.map(c => c.file));
			for (const [agentId, agent] of agents) {
				if (!agent.agentDefinitionId || !agent.jsonlFile) continue;
				if (candidateFiles.has(agent.jsonlFile)) continue; // already tracking a candidate
				// Check if the bound file is stale
				try {
					const stat = fs.statSync(agent.jsonlFile);
					const age = now - stat.mtimeMs;
					if (age < ACTIVE_FILE_MAX_AGE_MS) continue; // still fresh
				} catch { continue; }
				// Pick the most recent candidate (first in sorted list)
				const best = candidates.find(c => !trackedFiles.has(c.file));
				if (best) {
					console.log(`[Pixel Agents] Agent ${agentId}: startup reassign from stale to active: ${path.basename(best.file)} (age: ${Math.round(best.ageMs / 1000)}s)`);
					reassignAgentToFile(
						agentId, best.file,
						agents, fileWatchers, pollingTimers, permissionTimers,
						webview, persistAgents,
					);
					trackedFiles.add(best.file);
					// Remove from candidates so it won't be adopted again
					const idx = candidates.indexOf(best);
					if (idx !== -1) candidates.splice(idx, 1);
				}
			}
		}

		let adopted = 0;
		for (const c of candidates) {
			if (adopted >= maxAdopt) {
				console.log(`[Pixel Agents] Skipping JSONL (adoption limit ${maxAdopt}): ${path.basename(c.file)} (age: ${Math.round(c.ageMs / 1000)}s)`);
				continue;
			}
			console.log(`[Pixel Agents] Auto-adopting active JSONL: ${path.basename(c.file)} (age: ${Math.round(c.ageMs / 1000)}s)`);
			adoptFileWithoutTerminal(
				c.file, projectDir,
				nextAgentIdRef, agents, activeAgentIdRef,
				fileWatchers, pollingTimers, permissionTimers,
				webview, persistAgents,
				true,
			);
			adopted++;
		}

		// ── Fallback: bind unbound definition agents to latest non-ended JSONL ──
		// If a definition agent (e.g. "Lead") still has no jsonlFile after the
		// active-window pass (because the JSONL was older than 2 min at startup),
		// bind it to the most recent non-ended JSONL regardless of age.
		// This ensures the character reacts when the user resumes the session.
		for (const agent of agents.values()) {
			if (!agent.agentDefinitionId || agent.jsonlFile || agent.terminalRef) continue;
			if (agent.projectDir !== projectDir) continue;
			// Find the most recent non-ended JSONL not already tracked
			let bestFile: string | null = null;
			let bestMtime = 0;
			for (const f of files) {
				if (trackedFiles.has(f)) continue;
				// Also skip files already adopted above
				let alreadyAdopted = false;
				for (const a of agents.values()) {
					if (a.jsonlFile === f) { alreadyAdopted = true; break; }
				}
				if (alreadyAdopted) continue;
				try {
					const stat = fs.statSync(f);
					if (stat.mtimeMs > bestMtime && !isSessionEnded(f)) {
						bestMtime = stat.mtimeMs;
						bestFile = f;
					}
				} catch { /* skip */ }
			}
			if (bestFile) {
				const ageMs = now - bestMtime;
				console.log(`[Pixel Agents] Agent ${agent.id}: fallback bind to latest JSONL: ${path.basename(bestFile)} (age: ${Math.round(ageMs / 1000)}s)`);
				agent.jsonlFile = bestFile;
				agent.fileOffset = 0;
				agent.lineBuffer = '';
				// Skip to end so we don't replay old history
				try { agent.fileOffset = fs.statSync(bestFile).size; } catch { /* start from 0 */ }
				trackedFiles.add(bestFile);
				startFileWatching(agent.id, bestFile, agents, fileWatchers, pollingTimers, permissionTimers, webview);
				persistAgents();
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
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	if (projectScanTimerRef.current) {
		console.log(`[Pixel Agents] ensureProjectScan: already running, skipping`);
		return;
	}

	console.log(`[Pixel Agents] ensureProjectScan: starting for ${projectDir}`);

	// Seed knownJsonlFiles with ALL existing JSONL files so the periodic scan
	// only reacts to truly new ones (e.g. /clear creating a new session).
	// Adoption of active sessions is handled by autoAdoptActiveConversations()
	// which has proper limits — do NOT adopt here.
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
			agents, fileWatchers, pollingTimers, permissionTimers,
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
					agents, fileWatchers, pollingTimers, permissionTimers,
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
							fileWatchers, pollingTimers, permissionTimers,
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
						fileWatchers, pollingTimers, permissionTimers,
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
				startFileWatching(existingId, jsonlFile, agents, fileWatchers, pollingTimers, permissionTimers, webview);
				readNewLines(existingId, agents, permissionTimers, webview);
				return;
			}
		}
	} else {
		// No marker — prefer the lead ('main') definition; fallback to single-match heuristic.
		// The lead is eligible even if it already has a JSONL from a previous session (no terminal):
		// a new terminal always represents the user's current active session.
		let preferred: [number, AgentState] | null = null;
		const unboundDetected: Array<[number, AgentState]> = [];
		for (const [existingId, existingAgent] of agents) {
			if (!existingAgent.terminalRef && existingAgent.projectDir === projectDir) {
				if (existingAgent.agentDefinitionId === 'main') {
					// Lead: bind regardless of whether it has an old JSONL
					preferred = [existingId, existingAgent];
				} else if (existingAgent.agentDefinitionId && !existingAgent.jsonlFile) {
					unboundDetected.push([existingId, existingAgent]);
				}
			}
		}
		const bindCandidate = preferred ?? (unboundDetected.length === 1 ? unboundDetected[0] : null);
		if (bindCandidate) {
			const [existingId, existingAgent] = bindCandidate;
			definitionId = existingAgent.agentDefinitionId;
			// If lead has an old JSONL from a previous session, stop watching it and reset state
			if (existingAgent.jsonlFile && existingAgent.jsonlFile !== jsonlFile) {
				reassignAgentToFile(existingId, jsonlFile, agents, fileWatchers, pollingTimers, permissionTimers, webview, persistAgents);
				existingAgent.terminalRef = terminal;
				activeAgentIdRef.current = existingId;
				persistAgents();
				console.log(`[Pixel Agents] Agent ${existingId}: terminal "${terminal.name}" took over lead from previous session`);
				webview?.postMessage({ type: 'agentBound', id: existingId, definitionId });
				return;
			}
			existingAgent.terminalRef = terminal;
			activeAgentIdRef.current = existingId;
			if (existingAgent.jsonlFile === jsonlFile) {
				// File scan already bound this JSONL — just attach terminal, preserve read offset
				persistAgents();
				console.log(`[Pixel Agents] Agent ${existingId}: terminal "${terminal.name}" attached (JSONL already watching)`);
			} else {
				existingAgent.jsonlFile = jsonlFile;
				existingAgent.fileOffset = 0;
				existingAgent.lineBuffer = '';
				persistAgents();
				console.log(`[Pixel Agents] Agent ${existingId}: auto-bound terminal "${terminal.name}" to definition "${definitionId}"`);
				startFileWatching(existingId, jsonlFile, agents, fileWatchers, pollingTimers, permissionTimers, webview);
				readNewLines(existingId, agents, permissionTimers, webview);
			}
			webview?.postMessage({ type: 'agentBound', id: existingId, definitionId });
			return;
		}
	}

	// Fallback: create a new ad-hoc agent
	const id = nextAgentIdRef.current++;
	const agent = createAgentState({ id, projectDir, jsonlFile, terminalRef: terminal, agentDefinitionId: definitionId });

	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();

	const projectName = vscode.workspace.workspaceFolders?.[0]?.name;
	console.log(`[Pixel Agents] Agent ${id}: adopted terminal "${terminal.name}" for ${path.basename(jsonlFile)}`);
	webview?.postMessage({ type: 'agentCreated', id, projectName });

	startFileWatching(id, jsonlFile, agents, fileWatchers, pollingTimers, permissionTimers, webview);
	readNewLines(id, agents, permissionTimers, webview);
}

function adoptFileWithoutTerminal(
	jsonlFile: string,
	projectDir: string,
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	activeAgentIdRef: { current: number | null },
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
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

	// Try to bind to an existing unbound config agent:
	// 1. By marker definitionId if available
	// 2. Fallback: if only one unbound config agent exists, bind to it
	let bindTarget: [number, AgentState] | null = null;
	if (marker) {
		for (const [existingId, existingAgent] of agents) {
			if (existingAgent.agentDefinitionId === marker.definitionId && !existingAgent.terminalRef && !existingAgent.jsonlFile) {
				bindTarget = [existingId, existingAgent];
				break;
			}
		}
	}
	if (!bindTarget) {
		// No marker match — prefer the lead ('main') definition if it's unbound.
		// If the lead has no live terminal, its old session is already orphaned — new session takes over.
		for (const [existingId, existingAgent] of agents) {
			if (existingAgent.agentDefinitionId === 'main' && !existingAgent.terminalRef
				&& existingAgent.projectDir === projectDir) {
				if (!existingAgent.jsonlFile) {
					// Lead is unbound — bind normally
					bindTarget = [existingId, existingAgent];
					break;
				} else {
					// Lead has no terminal → its old session is orphaned; new session takes over
					console.log(`[Pixel Agents] Agent ${existingId}: lead reassigned to new JSONL (old session orphaned)`);
					reassignAgentToFile(existingId, jsonlFile, agents, fileWatchers, pollingTimers, permissionTimers, webview, persistAgents);
					webview?.postMessage({ type: 'agentBound', id: existingId, definitionId: 'main' });
					return;
				}
			}
		}
	}

	if (!bindTarget) {
		// Fallback: if exactly one other unbound config agent in this project, bind to it
		const unboundConfigAgents: Array<[number, AgentState]> = [];
		for (const [existingId, existingAgent] of agents) {
			if (existingAgent.agentDefinitionId && !existingAgent.terminalRef && !existingAgent.jsonlFile
				&& existingAgent.projectDir === projectDir) {
				unboundConfigAgents.push([existingId, existingAgent]);
			}
		}
		if (unboundConfigAgents.length === 1) {
			bindTarget = unboundConfigAgents[0];
		}
	}
	if (bindTarget) {
		const [existingId, existingAgent] = bindTarget;
		existingAgent.jsonlFile = jsonlFile;
		existingAgent.fileOffset = fileOffset;
		existingAgent.lineBuffer = '';
		activeAgentIdRef.current = existingId;
		persistAgents();
		const defId = marker?.definitionId ?? existingAgent.agentDefinitionId ?? '';
		console.log(`[Pixel Agents] Agent ${existingId}: bound file to definition "${defId}"`);
		webview?.postMessage({ type: 'agentBound', id: existingId, definitionId: defId });
		startFileWatching(existingId, jsonlFile, agents, fileWatchers, pollingTimers, permissionTimers, webview);
		readNewLines(existingId, agents, permissionTimers, webview);
		sendAgentStateUpdate(existingId, agents, webview);
		return;
	}

	const id = nextAgentIdRef.current++;
	const agent = createAgentState({ id, projectDir, jsonlFile, fileOffset, agentDefinitionId: marker?.definitionId ?? null });
	agent.lastDataAt = Date.now(); // Give adopted agents a grace period before being considered stale

	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();

	const projectName = vscode.workspace.workspaceFolders?.[0]?.name;
	console.log(`[Pixel Agents] Agent ${id}: adopted file ${path.basename(jsonlFile)} (no terminal, offset=${fileOffset})`);
	webview?.postMessage({ type: 'agentCreated', id, projectName });

	startFileWatching(id, jsonlFile, agents, fileWatchers, pollingTimers, permissionTimers, webview);
	readNewLines(id, agents, permissionTimers, webview);
}

export function reassignAgentToFile(
	agentId: number,
	newFilePath: string,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
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
	cancelPermissionTimer(agentId, permissionTimers);
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
	webview?.postMessage({ type: 'agentToolsClear', id: agentId });
	webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });

	// Swap to new file
	agent.jsonlFile = newFilePath;
	agent.fileOffset = 0;
	agent.lineBuffer = '';
	persistAgents();

	// Start watching new file
	startFileWatching(agentId, newFilePath, agents, fileWatchers, pollingTimers, permissionTimers, webview);
	readNewLines(agentId, agents, permissionTimers, webview);
}
