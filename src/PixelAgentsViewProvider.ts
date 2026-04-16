import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
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
import { WORKSPACE_KEY_AGENT_SEATS, JSONL_POLL_INTERVAL_MS, REMOTE_ID_BASE, SYNC_WRITE_DEBOUNCE_MS } from './constants.js';
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
 * writes sync files for the standalone viewer to read.
 * No longer a WebviewViewProvider — the standalone server is the sole UI.
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
	private readonly windowId = PixelAgentsBackend.workspaceSyncId();
	private syncWriteTimer: ReturnType<typeof setTimeout> | null = null;
	private stateTickInterval: ReturnType<typeof setInterval> | null = null;
	private characterVisuals = new Map<number, import('./types.js').SyncCharacterVisual>();

	// Personality engine
	private personalityEngine: PersonalityEngine | null = null;

	// Output channel — always visible in VS Code Output tab
	private readonly outputChannel = vscode.window.createOutputChannel('Pixel Agents');

	/**
	 * No-op webview proxy. Functions that take a webview parameter call
	 * postMessage on it — this stub intercepts those calls to trigger
	 * sync file writes (so the standalone viewer sees the update) and
	 * emit dev logs. No actual webview receives these messages.
	 */
	private readonly webviewProxy: vscode.Webview = {
		postMessage: (msg: unknown) => {
			const m = msg as { type?: string };
			if (m.type === 'agentStateUpdate') {
				this.scheduleSyncWrite();
			}
			if (m.type === 'agentBound' || m.type === 'agentUnbound' || m.type === 'agentCreated' || m.type === 'agentClosed' || m.type === 'agentStatus') {
				this.emitDevLog(msg as Record<string, unknown>);
			}
			return Promise.resolve(false);
		},
	} as unknown as vscode.Webview;

	constructor(private readonly context: vscode.ExtensionContext) {}

	/** Deterministic sync ID from workspace folder path. Same workspace = same file. */
	private static workspaceSyncId(): string {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'unknown';
		let hash = 0;
		for (let i = 0; i < folder.length; i++) {
			hash = ((hash << 5) - hash + folder.charCodeAt(i)) | 0;
		}
		const hex = (hash >>> 0).toString(16).padStart(8, '0');
		const base = folder.replace(/[\\/]/g, '-').replace(/[^a-zA-Z0-9-]/g, '').slice(-30);
		return `${base}-${hex}`;
	}

	private persistAgents = (): void => {
		persistAgents(this.agents, this.context);
		this.scheduleSyncWrite();
	};

	// ── Initialization ───────────────────────────────────────────

	/**
	 * Initialize agent tracking, file watching, and sync writing.
	 * Called from activate(). No webview needed.
	 */
	init(): void {
		const log = (msg: string) => this.outputChannel.appendLine(msg);
		log(`[Init] Window ID: ${this.windowId}`);
		log(`[Init] Workspace folders: ${(vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath).join(', ') || '(none)'}`);

		// Initialize personality engine (uses workspace sync ID as project hash)
		this.personalityEngine = new PersonalityEngine(this.windowId);
		setPersonalityEngine(this.personalityEngine);
		log(`[Init] Personality engine initialized`);

		this.registerTerminalEvents();

		restoreAgents(
			this.context,
			this.nextAgentId, this.nextTerminalIndex,
			this.agents, this.knownJsonlFiles,
			this.fileWatchers, this.pollingTimers, this.permissionTimers,
			this.jsonlPollTimers, this.projectScanTimers, this.activeAgentId,
			this.webviewProxy, this.persistAgents,
		);
		log(`[Init] Restored ${this.agents.size} agents, ${this.knownJsonlFiles.size} known JSONL files`);

		this.detectAgents();

		// Scan all workspace folders for active JSONL files (multi-root support)
		const scannedDirs = new Set<string>();
		const folders = vscode.workspace.workspaceFolders ?? [];
		for (const folder of folders) {
			const projectDir = getProjectDirPath(folder.uri.fsPath);
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

	// ── Terminal lifecycle ────────────────────────────────────────

	private terminalEventsRegistered = false;
	private registerTerminalEvents(): void {
		if (this.terminalEventsRegistered) return;
		this.terminalEventsRegistered = true;

		vscode.window.onDidChangeActiveTerminal((terminal) => {
			this.activeAgentId.current = null;
			if (!terminal) return;
			for (const [id, agent] of this.agents) {
				if (agent.terminalRef && agent.terminalRef === terminal) {
					this.activeAgentId.current = id;
					break;
				}
			}
		});

		vscode.window.onDidCloseTerminal((closed) => {
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
		});
	}

	// ── Agent detection ──────────────────────────────────────────

	private detectAgents(): void {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders) return;

		const allDefinitions: DetectedAgentDefinition[] = [];
		for (const folder of folders) {
			const defs = detectAgents(folder.uri.fsPath);
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
			const folderDefs = allDefinitions.filter(d => d.workspaceFolder === folder.uri.fsPath);
			if (folderDefs.length === 0) continue;

			const config = ensurePixelAgentsConfig(folder.uri.fsPath, folderDefs, pickPalette);

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
		for (const def of this.detectedDefinitions) {
			const folders = vscode.workspace.workspaceFolders;
			if (!folders) continue;
			for (const folder of folders) {
				if (def.workspaceFolder !== folder.uri.fsPath) continue;
					const config = readPixelAgentsConfig(folder.uri.fsPath);
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
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) return;
		const folder = folders[0];
		this.agentDefinitionWatcher = watchAgentDefinitions(folder.uri.fsPath, () => {
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

	exportDefaultLayout(): void {
		const layout = readLayoutFromFile();
		if (!layout) {
			vscode.window.showWarningMessage('Pixel Agents: No saved layout found.');
			return;
		}
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			vscode.window.showErrorMessage('Pixel Agents: No workspace folder found.');
			return;
		}
		const targetPath = path.join(workspaceRoot, 'webview-ui', 'public', 'assets', 'default-layout.json');
		const json = JSON.stringify(layout, null, 2);
		fs.writeFileSync(targetPath, json, 'utf-8');
		vscode.window.showInformationMessage(`Pixel Agents: Default layout exported to ${targetPath}`);
	}

	// ── Cross-window sync ────────────────────────────────────────

	private startSyncManager(): void {
		if (this.syncManager) return;
		this.syncManager = createSyncManager(this.windowId, (_windows) => {
			// Remote window changes — standalone viewer reads sync files directly
		});
		// Initialize remote relay if configured
		const relayUrl = vscode.workspace.getConfiguration('pixel-agents').get<string>('relayUrl', '');
		const relayToken = vscode.workspace.getConfiguration('pixel-agents').get<string>('relayToken', '');
		if (relayUrl && relayToken) {
			this.relayClient = createRelayClient(relayUrl, relayToken, (layout) => {
				this.layoutWatcher?.markOwnWrite();
				writeLayoutToFile(layout);
			}, (msg) => this.outputChannel.appendLine(msg), (msg) => {
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
		const custom = vscode.workspace.getConfiguration('pixel-agents').get<string>('projectName', '');
		if (custom) return custom;
		return vscode.workspace.workspaceFolders?.[0]?.name ?? 'Project';
	}

	private writeSyncState(): void {
		if (!this.syncManager) return;
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) return;

		const agentSeats = this.context.workspaceState.get<Record<string, { palette?: number; hueShift?: number; seatId?: string }>>(WORKSPACE_KEY_AGENT_SEATS, {});
		const config = readPixelAgentsConfig(folder.uri.fsPath);

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
			const unnamedIdx = unnamedCounts.get(agentProjectName) ?? 0;
			let name = unnamedIdx === 0 ? `${agentProjectName} Lead` : `${agentProjectName} #${unnamedIdx + 1}`;

			if (agent.agentDefinitionId && config?.agents[agent.agentDefinitionId]) {
				const ac = config.agents[agent.agentDefinitionId];
				palette = ac.palette;
				hueShift = ac.hueShift;
				seatId = ac.seatId;
				name = `${agentProjectName} ${ac.name}`;
				coveredDefinitions.add(agent.agentDefinitionId);
			} else {
				unnamedCounts.set(agentProjectName, unnamedIdx + 1);
				const meta = agentSeats[String(agent.id)];
				if (meta) {
					palette = meta.palette ?? 0;
					hueShift = meta.hueShift ?? 0;
					seatId = meta.seatId ?? null;
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
			workspaceFolder: folder.uri.fsPath,
			pid: process.pid,
			agents,
			updatedAt: Date.now(),
			personalities: this.personalityEngine?.getSnapshot(),
		};
		// Debug: log specialist activations
		if (activeSpecialists.size > 0) {
			this.outputChannel.appendLine(`[Sync] Active specialists: ${[...activeSpecialists].join(', ')}`);
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
		const entry = `[${ts}] ${event.padEnd(6)} ${detail}`;
		this.outputChannel.appendLine(entry);
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
		this.outputChannel.dispose();
	}
}
