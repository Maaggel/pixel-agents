import * as fs from 'fs';
import * as path from 'path';
import type { Host, MessageSink, TerminalHandle } from './host.js';
import { createAgentState } from './types.js';
import type { AgentState, DetectedAgentDefinition, SyncAgentState, SyncWindowState } from './types.js';
import { createSyncManager } from './syncManager.js';
import type { SyncManager } from './syncManager.js';
import {
	removeAgent,
	unbindAgent,
	restoreAgents,
	persistAgents,
	getProjectDirPath,
} from './agentManager.js';
import { ensureProjectScan, autoAdoptActiveConversations, startFileWatching, readNewLines } from './fileWatcher.js';
import type { LiveClaudeSession } from './claudeSessions.js';
import { WORKSPACE_KEY_AGENT_SEATS, SYNC_WRITE_DEBOUNCE_MS, JSONL_POLL_INTERVAL_MS } from './constants.js';
import { writeLayoutToFile, readLayoutFromFile, watchLayoutFile } from './layoutPersistence.js';
import type { LayoutWatcher } from './layoutPersistence.js';
import { detectAgents, ensurePixelAgentsConfig, watchAgentDefinitions, readPixelAgentsConfig, readSessionMarker } from './agentDetector.js';
import type { AgentDefinitionWatcher } from './agentDetector.js';
import { PersonalityEngine, setPersonalityEngine } from './personalityEngine.js';
import { computeAgentDisplayState, registerDisplayStateCallback, tickAllAgents } from './agentDisplayState.js';
import { createRelayClient } from './relayClient.js';
import type { RelayClient } from './relayClient.js';

/**
 * Backend-only agent manager. Tracks terminals, watches JSONL files,
 * writes sync files for the standalone viewer to read and pushes state
 * to the remote relay when configured.
 *
 * Environment access (workspace folders, terminals, settings, persistence)
 * goes through the injected Host so the same class runs inside VS Code
 * (vscodeHost.ts) and as a headless Linux service (daemon.ts).
 */
export class PixelAgentsBackend {
	nextAgentId = { current: 1 };
	nextTerminalIndex = { current: 1 };
	agents = new Map<number, AgentState>();

	// Per-agent timers
	fileWatchers = new Map<number, fs.FSWatcher>();
	pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
	jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();
	permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

	// /clear detection: project-level scan for new JSONL files
	activeAgentId = { current: null as number | null };
	knownJsonlFiles = new Set<string>();
	projectScanTimers = new Map<string, ReturnType<typeof setInterval>>();

	// Cross-window layout sync
	private layoutWatcher: LayoutWatcher | null = null;

	// Agent detection
	private detectedDefinitions: DetectedAgentDefinition[] = [];
	private agentDefinitionWatcher: AgentDefinitionWatcher | null = null;

	// Cross-window sync
	private syncManager: SyncManager | null = null;
	private relayClient: RelayClient | null = null;
	private readonly windowId: string;
	private syncWriteTimer: ReturnType<typeof setTimeout> | null = null;
	private stateTickInterval: ReturnType<typeof setInterval> | null = null;
	private characterVisuals = new Map<number, import('./types.js').SyncCharacterVisual>();

	// Personality engine
	private personalityEngine: PersonalityEngine | null = null;


	/**
	 * No-op webview proxy. Functions that take a webview parameter call
	 * postMessage on it - this stub intercepts those calls to trigger
	 * sync file writes (so the standalone viewer sees the update) and
	 * emit dev logs. No actual webview receives these messages.
	 */
	private readonly webviewProxy: MessageSink = {
		postMessage: (msg: unknown) => {
			const m = msg as { type?: string };
			if (m.type === 'agentStateUpdate') {
				this.scheduleSyncWrite();
			}
			if (m.type === 'agentBound' || m.type === 'agentUnbound' || m.type === 'agentCreated' || m.type === 'agentClosed' || m.type === 'agentStatus') {
				this.emitDevLog(msg as Record<string, unknown>);
			}
		},
	};

	constructor(private readonly host: Host) {
		this.windowId = PixelAgentsBackend.workspaceSyncId(host);
	}

	private log(msg: string): void {
		this.host.log(msg);
	}

	/** Deterministic sync ID from workspace folder path. Same workspace = same file. */
	private static workspaceSyncId(host: Host): string {
		const folder = host.workspaceFolders()[0]?.path ?? 'unknown';
		let hash = 0;
		for (let i = 0; i < folder.length; i++) {
			hash = ((hash << 5) - hash + folder.charCodeAt(i)) | 0;
		}
		const hex = (hash >>> 0).toString(16).padStart(8, '0');
		const base = folder.replace(/[\\/]/g, '-').replace(/[^a-zA-Z0-9-]/g, '').slice(-30);
		return `${base}-${hex}`;
	}

	private persistAgents = (): void => {
		persistAgents(this.agents, this.host.workspaceState);
		this.scheduleSyncWrite();
	};

	// ── Initialization ───────────────────────────────────────────

	/**
	 * Initialize agent tracking, file watching, and sync writing.
	 * Called from activate(). No webview needed.
	 */
	init(): void {
		const log = (msg: string) => this.log(msg);
		log(`[Init] Window ID: ${this.windowId}`);
		log(`[Init] Workspace folders: ${this.host.workspaceFolders().map(f => f.path).join(', ') || '(none)'}`);

		// Initialize personality engine (uses workspace sync ID as project hash)
		this.personalityEngine = new PersonalityEngine(this.windowId);
		setPersonalityEngine(this.personalityEngine);
		log(`[Init] Personality engine initialized`);

		restoreAgents(
			this.host.workspaceState,
			this.nextAgentId, this.nextTerminalIndex,
			this.agents, this.knownJsonlFiles,
			this.fileWatchers, this.pollingTimers, this.permissionTimers,
			this.jsonlPollTimers, this.projectScanTimers, this.activeAgentId,
			this.webviewProxy, this.persistAgents,
		);
		log(`[Init] Restored ${this.agents.size} agents, ${this.knownJsonlFiles.size} known JSONL files`);

		this.detectAgents();

		// Scan all workspace folders for active JSONL files (multi-root support).
		// In registry mode the host feeds exact sessions via applyLiveSessions() instead.
		const scannedDirs = new Set<string>();
		const folders = this.host.discovery() === 'registry' ? [] : this.host.workspaceFolders();
		if (this.host.discovery() === 'registry') log('[Init] Discovery: session registry (heuristic JSONL scan disabled)');
		for (const folder of folders) {
			const projectDir = getProjectDirPath(folder.path);
			log(`[Init] Folder "${folder.name}" → projectDir: ${projectDir ?? '(null)'}`);
			if (!projectDir || scannedDirs.has(projectDir)) continue;
			scannedDirs.add(projectDir);
			const dirExists = projectDir ? fs.existsSync(projectDir) : false;
			log(`[Init]   Directory exists: ${dirExists}${dirExists ? `, contents: ${fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl')).length} JSONL files` : ''}`);
			ensureProjectScan(
				projectDir, this.knownJsonlFiles, this.projectScanTimers, this.activeAgentId,
				this.nextAgentId, this.agents,
				this.fileWatchers, this.pollingTimers, this.permissionTimers,
				this.webviewProxy, this.persistAgents,
			);
			autoAdoptActiveConversations(
				projectDir, this.knownJsonlFiles,
				this.nextAgentId, this.agents, this.activeAgentId,
				this.fileWatchers, this.pollingTimers, this.permissionTimers,
				this.webviewProxy, this.persistAgents,
			);
		}

		this.bindActiveAgentsToDefinitions();
		this.startLayoutWatcher();
		this.startSyncManager();

		log(`[Init] Complete. Agents: ${this.agents.size}, File watchers: ${this.fileWatchers.size}`);
		for (const [id, agent] of this.agents) {
			log(`[Init]   Agent #${id}: terminal=${!!agent.terminalRef} jsonl=${agent.jsonlFile ? 'yes' : 'no'} def=${agent.agentDefinitionId ?? 'none'}`);
		}
	}

	// ── Terminal lifecycle (called by the VS Code host; unused headless) ──

	/** The focused terminal changed. Pass null when no terminal is focused. */
	onActiveTerminalChanged(terminal: TerminalHandle | null): void {
		this.activeAgentId.current = null;
		if (!terminal) return;
		for (const [id, agent] of this.agents) {
			if (agent.terminalRef && agent.terminalRef === terminal) {
				this.activeAgentId.current = id;
				break;
			}
		}
	}

	/** A terminal was closed - unbind definition agents, remove ad-hoc ones. */
	onTerminalClosed(closed: TerminalHandle): void {
		for (const [id, agent] of this.agents) {
			if (agent.terminalRef && agent.terminalRef === closed) {
				if (this.activeAgentId.current === id) {
					this.activeAgentId.current = null;
				}
				if (agent.agentDefinitionId) {
					unbindAgent(
						id, this.agents,
						this.fileWatchers, this.pollingTimers, this.permissionTimers,
						this.jsonlPollTimers,
					);
					this.webviewProxy.postMessage({ type: 'agentUnbound', id, definitionId: agent.agentDefinitionId });
				} else {
					removeAgent(
						id, this.agents,
						this.fileWatchers, this.pollingTimers, this.permissionTimers,
						this.jsonlPollTimers, this.persistAgents,
					);
					this.webviewProxy.postMessage({ type: 'agentClosed', id });
				}
				this.scheduleSyncWrite();
			}
		}
	}

	// ── Registry-driven discovery (headless daemon) ──────────────

	/**
	 * Reconcile tracked agents with the exact set of live Claude Code sessions
	 * for this backend's folder. Idempotent - call on every registry poll.
	 *
	 *  - A session already tracked: refresh pid/name only.
	 *  - A new session: bind the unbound 'main' definition (Lead) first, then any
	 *    single unbound definition, otherwise create an ad-hoc agent.
	 *  - A tracked file whose session is gone: definition agents unbind (character
	 *    goes idle), ad-hoc agents are removed.
	 */
	applyLiveSessions(sessions: LiveClaudeSession[]): void {
		const folder = this.host.workspaceFolders()[0];
		if (!folder) return;
		const projectDir = getProjectDirPath(folder.path);
		if (!projectDir) return;

		const live = new Map<string, LiveClaudeSession>();
		for (const s of sessions) {
			if (path.resolve(s.cwd) === path.resolve(folder.path)) live.set(s.jsonlFile, s);
		}
		let changed = false;

		// 1. Drop agents whose session has exited
		for (const [id, agent] of [...this.agents]) {
			if (!agent.jsonlFile || live.has(agent.jsonlFile)) continue;
			if (agent.pid === null) continue; // not registry-bound (e.g. placeholder) - leave alone
			this.log(`[Registry] Session ended: pid ${agent.pid} ${path.basename(agent.jsonlFile, '.jsonl').slice(0, 8)} → agent #${id}`);
			if (this.activeAgentId.current === id) this.activeAgentId.current = null;
			if (agent.agentDefinitionId) {
				unbindAgent(id, this.agents, this.fileWatchers, this.pollingTimers, this.permissionTimers, this.jsonlPollTimers);
				agent.pid = null;
				agent.sessionName = null;
				this.webviewProxy.postMessage({ type: 'agentUnbound', id, definitionId: agent.agentDefinitionId });
			} else {
				removeAgent(id, this.agents, this.fileWatchers, this.pollingTimers, this.permissionTimers, this.jsonlPollTimers, this.persistAgents);
				this.webviewProxy.postMessage({ type: 'agentClosed', id });
			}
			changed = true;
		}

		// 2. Bind or refresh live sessions
		for (const session of live.values()) {
			const tracked = [...this.agents.values()].find(a => a.jsonlFile === session.jsonlFile);
			if (tracked) {
				const name = session.nameSource === 'user' ? session.name : null;
				if (tracked.pid !== session.pid || tracked.sessionName !== name) {
					tracked.pid = session.pid;
					tracked.sessionName = name;
					tracked.terminalRef = { name: `claude:${session.pid}` };
					changed = true;
				}
				continue;
			}
			this.bindSession(session, projectDir);
			changed = true;
		}

		if (changed) {
			this.knownJsonlFiles.clear();
			for (const f of live.keys()) this.knownJsonlFiles.add(f);
			this.persistAgents();
		}
	}

	private bindSession(session: LiveClaudeSession, projectDir: string): void {
		const unbound = [...this.agents.values()].filter(a =>
			a.agentDefinitionId && a.projectDir === projectDir && !a.jsonlFile && a.pid === null);
		let agent: AgentState | undefined = unbound.find(a => a.agentDefinitionId === 'main');
		if (!agent) {
			// Session marker (written by VS Code launches) can name a specific definition
			const marker = readSessionMarker(session.sessionId);
			if (marker) agent = unbound.find(a => a.agentDefinitionId === marker.definitionId);
		}
		if (!agent && unbound.length === 1) agent = unbound[0];

		// Start at the end of the transcript so history isn't replayed;
		// lastDataAt from mtime so the display state reflects recent activity.
		let fileOffset = 0;
		let lastDataAt = Date.now();
		try {
			const stat = fs.statSync(session.jsonlFile);
			fileOffset = stat.size;
			lastDataAt = stat.mtimeMs;
		} catch { /* transcript not written yet - poll below */ }

		if (agent) {
			agent.jsonlFile = session.jsonlFile;
			agent.fileOffset = fileOffset;
			agent.lineBuffer = '';
		} else {
			const id = this.nextAgentId.current++;
			agent = createAgentState({ id, projectDir, jsonlFile: session.jsonlFile, fileOffset });
			this.agents.set(id, agent);
			this.webviewProxy.postMessage({ type: 'agentCreated', id, projectName: this.getProjectName() });
		}
		agent.pid = session.pid;
		agent.sessionName = session.nameSource === 'user' ? session.name : null;
		agent.terminalRef = { name: `claude:${session.pid}` };
		agent.lastDataAt = lastDataAt;
		this.activeAgentId.current = agent.id;

		const shortId = session.sessionId.slice(0, 8);
		this.log(`[Registry] Bound pid ${session.pid} session ${shortId} (${session.source}) → agent #${agent.id}${agent.agentDefinitionId ? ` "${agent.agentDefinitionId}"` : ''}${agent.sessionName ? ` name="${agent.sessionName}"` : ''}`);
		if (agent.agentDefinitionId) {
			this.webviewProxy.postMessage({ type: 'agentBound', id: agent.id, definitionId: agent.agentDefinitionId });
		}

		const agentId = agent.id;
		if (fs.existsSync(session.jsonlFile)) {
			startFileWatching(agentId, session.jsonlFile, this.agents, this.fileWatchers, this.pollingTimers, this.permissionTimers, this.webviewProxy);
			readNewLines(agentId, this.agents, this.permissionTimers, this.webviewProxy);
		} else {
			// Brand-new session: transcript appears after the first prompt
			const pollTimer = setInterval(() => {
				const a = this.agents.get(agentId);
				if (!a || a.jsonlFile !== session.jsonlFile) { clearInterval(pollTimer); this.jsonlPollTimers.delete(agentId); return; }
				if (!fs.existsSync(session.jsonlFile)) return;
				clearInterval(pollTimer);
				this.jsonlPollTimers.delete(agentId);
				this.log(`[Registry] Transcript appeared for pid ${session.pid} → agent #${agentId}`);
				startFileWatching(agentId, session.jsonlFile, this.agents, this.fileWatchers, this.pollingTimers, this.permissionTimers, this.webviewProxy);
				readNewLines(agentId, this.agents, this.permissionTimers, this.webviewProxy);
			}, JSONL_POLL_INTERVAL_MS);
			this.jsonlPollTimers.set(agentId, pollTimer);
		}
	}

	// ── Agent detection ──────────────────────────────────────────

	private detectAgents(): void {
		const folders = this.host.workspaceFolders();
		if (folders.length === 0) return;

		const allDefinitions: DetectedAgentDefinition[] = [];
		for (const folder of folders) {
			const defs = detectAgents(folder.path);
			allDefinitions.push(...defs);
		}
		this.detectedDefinitions = allDefinitions;

		if (allDefinitions.length === 0) {
			console.log('[Pixel Agents] No agent definitions detected');
			return;
		}

		let paletteCounter = 0;
		const pickPalette = (): number => paletteCounter++ % 6;

		// Track used IDs to detect cross-folder collisions
		const usedIds = new Set<number>();
		for (const id of this.agents.keys()) usedIds.add(id);

		for (const folder of folders) {
			const folderDefs = allDefinitions.filter(d => d.workspaceFolder === folder.path);
			if (folderDefs.length === 0) continue;

			const config = ensurePixelAgentsConfig(folder.path, folderDefs, pickPalette);

			for (const def of folderDefs) {
				const agentConfig = config.agents[def.definitionId];
				if (!agentConfig) continue;
				let id = agentConfig.id;
				if (usedIds.has(id)) {
					id = this.nextAgentId.current++;
					console.log(`[Pixel Agents] ID collision: config id ${agentConfig.id} for "${def.definitionId}" in ${folder.name} → reassigned to ${id}`);
				}
				usedIds.add(id);

				const agentProjectDir = getProjectDirPath(def.workspaceFolder);
				let alreadyCovered = this.agents.has(id);
				if (!alreadyCovered && agentProjectDir) {
					for (const existingAgent of this.agents.values()) {
						if (existingAgent.agentDefinitionId === def.definitionId
							&& existingAgent.projectDir === agentProjectDir) {
							alreadyCovered = true;
							break;
						}
					}
				}
				if (!alreadyCovered && agentProjectDir) {
					const agent = createAgentState({
						id,
						projectDir: agentProjectDir,
						jsonlFile: '',
						agentDefinitionId: def.definitionId,
						folderName: undefined,
					});
					this.agents.set(id, agent);
					console.log(`[Pixel Agents] Created backend entry for detected agent ${id} ("${def.definitionId}") projectDir=${agentProjectDir}`);
				}
				if (id >= this.nextAgentId.current) {
					this.nextAgentId.current = id + 1;
				}
			}
		}

		this.scheduleSyncWrite();
		this.startAgentDefinitionWatchers();
	}

	private bindActiveAgentsToDefinitions(): void {
		const unboundDefinitions = new Map<string, { definitionId: string; configId: number; projectDir: string }>();
		const folders = this.host.workspaceFolders();
		for (const def of this.detectedDefinitions) {
			for (const folder of folders) {
				if (def.workspaceFolder !== folder.path) continue;
				const config = readPixelAgentsConfig(folder.path);
				if (config?.agents[def.definitionId]) {
					const configId = config.agents[def.definitionId].id;
					const defProjectDir = getProjectDirPath(def.workspaceFolder);
					let alreadyBound = false;
					if (defProjectDir) {
						for (const agent of this.agents.values()) {
							if (agent.agentDefinitionId === def.definitionId
								&& agent.projectDir === defProjectDir
								&& (agent.jsonlFile || agent.terminalRef)) {
								alreadyBound = true;
								break;
							}
						}
					}
					if (!alreadyBound && defProjectDir) {
						const key = `${defProjectDir}::${def.definitionId}`;
						unboundDefinitions.set(key, { definitionId: def.definitionId, configId, projectDir: defProjectDir });
					}
				}
			}
		}

		if (unboundDefinitions.size === 0) return;

		const removePlaceholder = (definitionId: string, projectDir: string, adoptedAgentId: number): void => {
			for (const [existingId, existingAgent] of this.agents) {
				if (existingId !== adoptedAgentId
					&& existingAgent.agentDefinitionId === definitionId
					&& existingAgent.projectDir === projectDir
					&& !existingAgent.jsonlFile && !existingAgent.terminalRef) {
					this.agents.delete(existingId);
					console.log(`[Pixel Agents] Removed placeholder agent ${existingId} for definition "${definitionId}"`);
					break;
				}
			}
		};

		for (const [_id, agent] of this.agents) {
			if (agent.agentDefinitionId) continue;
			if (!agent.jsonlFile) continue;

			const sessionId = path.basename(agent.jsonlFile, '.jsonl');
			const marker = readSessionMarker(sessionId);
			if (marker) {
				const key = `${agent.projectDir}::${marker.definitionId}`;
				if (unboundDefinitions.has(key)) {
					agent.agentDefinitionId = marker.definitionId;
					unboundDefinitions.delete(key);
					removePlaceholder(marker.definitionId, agent.projectDir, agent.id);
					console.log(`[Pixel Agents] Agent ${agent.id}: bound restored agent to definition "${marker.definitionId}"`);
					this.webviewProxy.postMessage({ type: 'agentBound', id: agent.id, definitionId: marker.definitionId });
					this.persistAgents();
				}
			}
		}

		for (const [key, { definitionId, projectDir }] of unboundDefinitions) {
			const unmatchedInProject = [...this.agents.values()].filter(a =>
				!a.agentDefinitionId && a.jsonlFile && a.projectDir === projectDir
			);
			if (unmatchedInProject.length === 1) {
				const agent = unmatchedInProject[0];
				agent.agentDefinitionId = definitionId;
				unboundDefinitions.delete(key);
				removePlaceholder(definitionId, projectDir, agent.id);
				console.log(`[Pixel Agents] Agent ${agent.id}: auto-bound to definition "${definitionId}" (only match in ${projectDir})`);
				this.webviewProxy.postMessage({ type: 'agentBound', id: agent.id, definitionId });
				this.persistAgents();
			}
		}
	}

	private startAgentDefinitionWatchers(): void {
		this.agentDefinitionWatcher?.dispose();
		const folders = this.host.workspaceFolders();
		if (folders.length === 0) return;
		const folder = folders[0];
		this.agentDefinitionWatcher = watchAgentDefinitions(folder.path, () => {
			this.detectAgents();
		});
	}

	// ── Layout ───────────────────────────────────────────────────

	private startLayoutWatcher(): void {
		if (this.layoutWatcher) return;
		this.layoutWatcher = watchLayoutFile(() => {
			// Layout changes are read by the standalone server directly
			console.log('[Pixel Agents] External layout change detected');
		});
	}

	/** Export current saved layout to webview-ui/public/assets/default-layout.json (dev utility) */
	/** Re-read the project name setting and push it to the standalone viewer. */
	refreshProjectName(): void {
		this.scheduleSyncWrite();
	}

	/** Returns the written path. Throws when there is no saved layout or no workspace folder. */
	exportDefaultLayout(): string {
		const layout = readLayoutFromFile();
		if (!layout) {
			throw new Error('No saved layout found.');
		}
		const workspaceRoot = this.host.workspaceFolders()[0]?.path;
		if (!workspaceRoot) {
			throw new Error('No workspace folder found.');
		}
		const targetPath = path.join(workspaceRoot, 'webview-ui', 'public', 'assets', 'default-layout.json');
		const json = JSON.stringify(layout, null, 2);
		fs.writeFileSync(targetPath, json, 'utf-8');
		return targetPath;
	}

	// ── Cross-window sync ────────────────────────────────────────

	private startSyncManager(): void {
		if (this.syncManager) return;
		this.syncManager = createSyncManager(this.windowId, (_windows) => {
			// Remote window changes - standalone viewer reads sync files directly
		});
		// Initialize remote relay if configured
		const { url: relayUrl, token: relayToken } = this.host.relaySettings();
		if (relayUrl && relayToken) {
			this.relayClient = createRelayClient(relayUrl, relayToken, (layout) => {
				this.layoutWatcher?.markOwnWrite();
				writeLayoutToFile(layout);
			}, (msg) => this.log(msg), (msg) => {
				// Route idle interaction events from the online viewer to the personality engine
				// msg.agentKeys contains personality keys (not browser runtime IDs)
				if (this.personalityEngine) {
					const keys: string[] = msg.agentKeys ?? [];
					const runtimeIds = keys.map((k: string) => this.personalityEngine!.getRuntimeId(k)).filter((id: number | null): id is number => id !== null);
					switch (msg.interactionType) {
						case 'conversation':
							if (runtimeIds.length >= 2) this.personalityEngine.onConversation(runtimeIds[0], runtimeIds[1]);
							break;
						case 'meeting':
							if (runtimeIds.length >= 2) this.personalityEngine.onMeeting(runtimeIds);
							break;
						case 'eating':
							if (runtimeIds.length >= 1) this.personalityEngine.onEating(runtimeIds[0]);
							break;
						case 'furniture_visit':
							if (runtimeIds.length >= 1) this.personalityEngine.onFurnitureVisit(runtimeIds[0]);
							break;
					}
				}
			});
		}
		registerDisplayStateCallback(() => this.scheduleSyncWrite());
		this.stateTickInterval = setInterval(() => {
			// tickAllAgents sends to webviewProxy (no-op for webview, triggers sync write)
			tickAllAgents(this.agents, this.webviewProxy);
			this.scheduleSyncWrite();
		}, 1000);
		this.scheduleSyncWrite();
	}

	private scheduleSyncWrite(): void {
		if (this.syncWriteTimer) clearTimeout(this.syncWriteTimer);
		this.syncWriteTimer = setTimeout(() => {
			this.syncWriteTimer = null;
			this.writeSyncState();
		}, SYNC_WRITE_DEBOUNCE_MS);
	}

	private getProjectName(): string {
		const custom = this.host.customProjectName();
		if (custom) return custom;
		return this.host.workspaceFolders()[0]?.name ?? 'Project';
	}

	private writeSyncState(): void {
		if (!this.syncManager) return;
		const folder = this.host.workspaceFolders()[0];
		if (!folder) return;

		const agentSeats = this.host.workspaceState.get<Record<string, { palette?: number; hueShift?: number; seatId?: string }>>(WORKSPACE_KEY_AGENT_SEATS, {});
		const config = readPixelAgentsConfig(folder.path);

		const agents: SyncAgentState[] = [];
		const coveredDefinitions = new Set<string>();
		const seenJsonlFiles = new Map<string, AgentState>();
		const unnamedCounts = new Map<string, number>();

		for (const agent of this.agents.values()) {
			if (!agent.terminalRef && !agent.jsonlFile && !agent.agentDefinitionId) continue;
			if (agent.jsonlFile) {
				const existing = seenJsonlFiles.get(agent.jsonlFile);
				if (existing) {
					const keepExisting = existing.lastDataAt >= agent.lastDataAt || (existing.terminalRef && !agent.terminalRef);
					if (keepExisting) continue;
					const idx = agents.findIndex(a => a.localId === existing.id);
					if (idx !== -1) agents.splice(idx, 1);
				}
				seenJsonlFiles.set(agent.jsonlFile, agent);
			}

			const agentProjectName = this.getProjectName();
			let palette = 0;
			let hueShift = 0;
			let seatId: string | null = null;
			let lookExplicit = false;
			const unnamedIdx = unnamedCounts.get(agentProjectName) ?? 0;
			let name = unnamedIdx === 0 ? `${agentProjectName} Lead` : `${agentProjectName} #${unnamedIdx + 1}`;

			if (agent.agentDefinitionId && config?.agents[agent.agentDefinitionId]) {
				const ac = config.agents[agent.agentDefinitionId];
				palette = ac.palette;
				hueShift = ac.hueShift;
				seatId = ac.seatId;
				lookExplicit = ac.lookSetByUser === true;
				name = agent.sessionName ?? `${agentProjectName} ${ac.name}`;
				coveredDefinitions.add(agent.agentDefinitionId);
			} else {
				if (agent.sessionName) name = agent.sessionName;
				unnamedCounts.set(agentProjectName, unnamedIdx + 1);
				const meta = agentSeats[String(agent.id)];
				if (meta) {
					palette = meta.palette ?? 0;
					hueShift = meta.hueShift ?? 0;
					seatId = meta.seatId ?? null;
					lookExplicit = meta.palette !== undefined;
				}
			}

			// Keep personality engine name in sync with display name
			const pKey = agent.agentDefinitionId || `agent-${agent.id}`;
			this.personalityEngine?.registerAgent(agent.id, pKey, name);

			const displayState = computeAgentDisplayState(agent);
			agents.push({
				localId: agent.id,
				definitionId: agent.agentDefinitionId,
				name,
				palette,
				hueShift,
				seatId,
				isActive: displayState.isActive,
				currentTool: displayState.currentTool,
				currentToolStatus: displayState.toolStatus,
				isWaiting: !displayState.isActive,
				bubbleType: displayState.bubbleType,
				idleHint: displayState.idleHint,
				folderName: agent.folderName,
				visual: this.characterVisuals.get(agent.id),
				personalityKey: agent.agentDefinitionId || `agent-${agent.id}`,
				activeSkill: agent.activeSkill,
				lookExplicit,
			});
		}

		// Activate specialist agents based on orchestrator's active delegations
		// Collect all active subagent_types from agents that have terminals (orchestrators)
		const activeSpecialists = new Set<string>();
		const specialistToolStatus = new Map<string, string>();
		for (const agent of this.agents.values()) {
			if (!agent.terminalRef) continue;
			for (const [toolId, subType] of agent.activeAgentSubtypes) {
				activeSpecialists.add(subType);
				const status = agent.activeToolStatuses.get(toolId);
				if (status) specialistToolStatus.set(subType, status);
			}
		}
		// Apply active state to matching specialist agents
		for (const a of agents) {
			if (a.definitionId && activeSpecialists.has(a.definitionId) && !a.isActive) {
				a.isActive = true;
				a.isWaiting = false;
				a.currentTool = 'Agent';
				a.currentToolStatus = specialistToolStatus.get(a.definitionId) ?? 'Working';
			}
		}

		// Dedup by display name
		const nameMap = new Map<string, number>();
		for (let i = 0; i < agents.length; i++) {
			const a = agents[i];
			const prev = nameMap.get(a.name);
			if (prev !== undefined) {
				const kept = agents[prev];
				const keptAgent = this.agents.get(kept.localId);
				const curAgent = this.agents.get(a.localId);
				const curBetter = (!keptAgent?.terminalRef && !!curAgent?.terminalRef)
					|| (a.isActive && !kept.isActive);
				if (curBetter) {
					agents.splice(prev, 1);
					i--;
					nameMap.set(a.name, i);
				} else {
					agents.splice(i, 1);
					i--;
				}
			} else {
				nameMap.set(a.name, i);
			}
		}

		const state: SyncWindowState = {
			windowId: this.windowId,
			workspaceName: this.getProjectName(),
			workspaceFolder: folder.path,
			pid: process.pid,
			agents,
			updatedAt: Date.now(),
			personalities: this.personalityEngine?.getSnapshot(),
		};
		// Debug: log specialist activations
		if (activeSpecialists.size > 0) {
			this.log(`[Sync] Active specialists: ${[...activeSpecialists].join(', ')}`);
		}
		this.syncManager.writeState(state);
		this.relayClient?.pushState(state);
	}

	// ── Dev logging ──────────────────────────────────────────────

	private emitDevLog(msg: Record<string, unknown>): void {
		const now = new Date();
		const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
		const id = msg.id as number | undefined;
		const defId = msg.definitionId as string | undefined;

		let event = '';
		let detail = '';
		switch (msg.type) {
			case 'agentBound': event = 'BIND'; detail = `${defId ?? '?'} → agent #${id}`; break;
			case 'agentUnbound': event = 'UNBIND'; detail = `${defId ?? '?'} ← agent #${id}`; break;
			case 'agentCreated': event = 'CREATE'; detail = `agent #${id}`; break;
			case 'agentClosed': event = 'CLOSE'; detail = `agent #${id}`; break;
			case 'agentStatus': event = 'STATUS'; detail = `agent #${id} → ${msg.status as string}`; break;
		}

		if (!event) return;
		this.log(`[${ts}] ${event.padEnd(6)} ${detail}`);
	}

	// ── Cleanup ──────────────────────────────────────────────────

	dispose(): void {
		this.personalityEngine?.flush();
		this.relayClient?.dispose();
		this.relayClient = null;
		this.syncManager?.dispose();
		this.syncManager = null;
		if (this.syncWriteTimer) {
			clearTimeout(this.syncWriteTimer);
			this.syncWriteTimer = null;
		}
		if (this.stateTickInterval) {
			clearInterval(this.stateTickInterval);
			this.stateTickInterval = null;
		}
		this.layoutWatcher?.dispose();
		this.layoutWatcher = null;
		this.agentDefinitionWatcher?.dispose();
		this.agentDefinitionWatcher = null;
		for (const id of [...this.agents.keys()]) {
			removeAgent(
				id, this.agents,
				this.fileWatchers, this.pollingTimers, this.permissionTimers,
				this.jsonlPollTimers, this.persistAgents,
			);
		}
		for (const timer of this.projectScanTimers.values()) {
			clearInterval(timer);
		}
		this.projectScanTimers.clear();
	}
}
