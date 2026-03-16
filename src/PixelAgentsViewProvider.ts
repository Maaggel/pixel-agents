import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createAgentState } from './types.js';
import type { AgentState, DetectedAgentDefinition, SyncAgentState, SyncWindowState } from './types.js';
import { createSyncManager } from './syncManager.js';
import type { SyncManager } from './syncManager.js';
import {
	launchNewTerminal,
	removeAgent,
	unbindAgent,
	restoreAgents,
	persistAgents,
	sendExistingAgents,
	sendLayout,
	getProjectDirPath,
} from './agentManager.js';
import { ensureProjectScan, autoAdoptActiveConversations, startFileWatching, readNewLines } from './fileWatcher.js';
import { loadFurnitureAssets, sendAssetsToWebview, loadFloorTiles, sendFloorTilesToWebview, loadWallTiles, sendWallTilesToWebview, loadCharacterSprites, sendCharacterSpritesToWebview, loadDefaultLayout } from './assetLoader.js';
import { WORKSPACE_KEY_AGENT_SEATS, GLOBAL_KEY_SOUND_ENABLED, GLOBAL_KEY_SHOW_NAMETAGS, JSONL_POLL_INTERVAL_MS, REMOTE_ID_BASE, SYNC_WRITE_DEBOUNCE_MS, BUILD_NUMBER } from './constants.js';
import { writeLayoutToFile, readLayoutFromFile, watchLayoutFile } from './layoutPersistence.js';
import type { LayoutWatcher } from './layoutPersistence.js';
import { detectAgents, ensurePixelAgentsConfig, watchAgentDefinitions, updateAgentConfig, readPixelAgentsConfig, readSessionMarker } from './agentDetector.js';
import type { AgentDefinitionWatcher } from './agentDetector.js';
import { computeAgentDisplayState, registerDisplayStateCallback, tickAllAgents } from './agentDisplayState.js';
import { createRelayClient } from './relayClient.js';
import type { RelayClient } from './relayClient.js';

export class PixelAgentsViewProvider implements vscode.WebviewViewProvider {
	nextAgentId = { current: 1 };
	nextTerminalIndex = { current: 1 };
	agents = new Map<number, AgentState>();
	webviewView: vscode.WebviewView | undefined;

	// Per-agent timers
	fileWatchers = new Map<number, fs.FSWatcher>();
	pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
	jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();
	permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

	// /clear detection: project-level scan for new JSONL files
	activeAgentId = { current: null as number | null };
	knownJsonlFiles = new Set<string>();
	projectScanTimer = { current: null as ReturnType<typeof setInterval> | null };

	// Bundled default layout (loaded from assets/default-layout.json)
	defaultLayout: Record<string, unknown> | null = null;

	// Cross-window layout sync
	layoutWatcher: LayoutWatcher | null = null;

	// Agent detection
	detectedDefinitions: DetectedAgentDefinition[] = [];
	agentDefinitionWatcher: AgentDefinitionWatcher | null = null;

	// Cross-window sync
	private syncManager: SyncManager | null = null;
	private relayClient: RelayClient | null = null;
	// Deterministic sync file ID based on workspace folder — ensures the same
	// workspace always writes to the same sync file, even across window reloads.
	private readonly windowId = PixelAgentsViewProvider.workspaceSyncId();
	private syncWriteTimer: ReturnType<typeof setTimeout> | null = null;
	private lastSyncSentIds: Set<number> = new Set();
	private lastSyncStateKeys: Map<number, string> = new Map();
	private stateTickInterval: ReturnType<typeof setInterval> | null = null;
	private remoteIdMap = new Map<string, number>();
	private nextRemoteId = REMOTE_ID_BASE;
	private characterVisuals = new Map<number, import('./types.js').SyncCharacterVisual>();
	// WebviewPanel support (editor tab)
	private panels = new Set<vscode.WebviewPanel>();
	// Dev Console ring buffer (last 200 entries)
	private devLogs: string[] = [];
	// Output channel — always visible in VS Code Output tab regardless of webview state
	private readonly outputChannel = vscode.window.createOutputChannel('Pixel Agents');

	/**
	 * Stable proxy that always delegates postMessage to the current broadcaster.
	 * Pass this instead of `this.webview` to functions that capture the webview
	 * reference in closures (file watchers, timers, etc.) — it always resolves
	 * to the live webview(s) at call time, even if they didn't exist when the
	 * closure was created.
	 */
	private readonly webviewProxy: vscode.Webview = {
		postMessage: (msg: unknown) => {
			// Trigger sync write when agent display state changes so the
			// standalone browser (which polls sync files) sees activity.
			const m = msg as { type?: string; id?: number; definitionId?: string; projectName?: string };
			if (m.type === 'agentStateUpdate') {
				this.scheduleSyncWrite();
			}
			// Dev Console: intercept binding/lifecycle/status events to emit log entries
			if (m.type === 'agentBound' || m.type === 'agentUnbound' || m.type === 'agentCreated' || m.type === 'agentClosed' || m.type === 'agentStatus') {
				this.emitDevLog(m as Record<string, unknown>);
			}
			return this.broadcaster?.postMessage(msg) ?? Promise.resolve(false);
		},
	} as unknown as vscode.Webview;

	constructor(private readonly context: vscode.ExtensionContext) {}

	/** Deterministic sync ID from workspace folder path. Same workspace = same file. */
	private static workspaceSyncId(): string {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'unknown';
		// Simple hash to create a short, filesystem-safe identifier
		let hash = 0;
		for (let i = 0; i < folder.length; i++) {
			hash = ((hash << 5) - hash + folder.charCodeAt(i)) | 0;
		}
		// Convert to unsigned hex + include folder basename for readability
		const hex = (hash >>> 0).toString(16).padStart(8, '0');
		const base = folder.replace(/[\\/]/g, '-').replace(/[^a-zA-Z0-9-]/g, '').slice(-30);
		return `${base}-${hex}`;
	}

	private get extensionUri(): vscode.Uri {
		return this.context.extensionUri;
	}

	/** Lazy broadcaster that sends to all active webviews (sidebar + panels). */
	private get broadcaster(): vscode.Webview | undefined {
		const sidebarWv = this.webviewView?.webview;
		if (this.panels.size === 0) return sidebarWv;
		const self = this;
		return {
			postMessage(msg: unknown) {
				sidebarWv?.postMessage(msg);
				for (const p of self.panels) p.webview.postMessage(msg);
				return Promise.resolve(true);
			},
		} as unknown as vscode.Webview;
	}

	private get webview(): vscode.Webview | undefined {
		return this.broadcaster;
	}

	private persistAgents = (): void => {
		persistAgents(this.agents, this.context);
		this.scheduleSyncWrite();
	};

	/**
	 * Headless init: restore agents + start sync without a webview.
	 * Called from activate() so sync files are written even when the panel isn't visible.
	 */
	initHeadless(): void {
		// Register terminal lifecycle events so agent tracking works
		// even when the webview panel is not visible.
		this.registerTerminalEvents();

		restoreAgents(
			this.context,
			this.nextAgentId, this.nextTerminalIndex,
			this.agents, this.knownJsonlFiles,
			this.fileWatchers, this.pollingTimers, this.permissionTimers,
			this.jsonlPollTimers, this.projectScanTimer, this.activeAgentId,
			this.webviewProxy, this.persistAgents,
		);

		// Detect agent definitions FIRST so config agents exist before auto-adoption.
		// This ensures adoptFileWithoutTerminal can bind JSONL files to config agents
		// instead of creating duplicate entries.
		this.detectAndSendAgents();

		// Scan all workspace folders for active JSONL files (multi-root support)
		const scannedDirs = new Set<string>();
		const folders = vscode.workspace.workspaceFolders ?? [];
		for (const folder of folders) {
			const projectDir = getProjectDirPath(folder.uri.fsPath);
			if (!projectDir || scannedDirs.has(projectDir)) continue;
			scannedDirs.add(projectDir);
			ensureProjectScan(
				projectDir, this.knownJsonlFiles, this.projectScanTimer, this.activeAgentId,
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

		this.startSyncManager();
	}

	/** Register terminal lifecycle events. Safe to call multiple times. */
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
					this.webview?.postMessage({ type: 'agentSelected', id });
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

	resolveWebviewView(webviewView: vscode.WebviewView) {
		this.webviewView = webviewView;
		webviewView.webview.options = { enableScripts: true };
		// Keep webview alive when switching to terminal panel — prevents avatar respawn
		(webviewView as unknown as { options: { retainContextWhenHidden: boolean } }).options = { retainContextWhenHidden: true };
		webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);

		webviewView.webview.onDidReceiveMessage(async (message) => {
			await this.handleWebviewMessage(message, webviewView.webview);
		});

		// Terminal events are registered in initHeadless() which runs
		// from activate() — no need to register them here again.
	}

	/** Shared message handler for sidebar and panel webviews. */
	private async handleWebviewMessage(message: Record<string, unknown>, senderWebview: vscode.Webview): Promise<void> {
		if (message.type === 'openClaude') {
			await launchNewTerminal(
				this.nextAgentId, this.nextTerminalIndex,
				this.agents, this.activeAgentId, this.knownJsonlFiles,
				this.fileWatchers, this.pollingTimers, this.permissionTimers,
				this.jsonlPollTimers, this.projectScanTimer,
				this.webviewProxy, this.persistAgents,
				message.folderPath as string | undefined,
			);
		} else if (message.type === 'openClaudeExtension') {
			await this.launchClaudeExtension(message.folderPath as string | undefined);
		} else if (message.type === 'focusAgent') {
			const agent = this.agents.get(message.id as number);
			if (agent) {
				if (agent.terminalRef) {
					agent.terminalRef.show();
				} else {
					vscode.commands.executeCommand('claude-vscode.focus');
				}
			}
		} else if (message.type === 'closeAgent') {
			const agent = this.agents.get(message.id as number);
			if (agent) {
				if (agent.terminalRef) {
					agent.terminalRef.dispose();
				} else {
					removeAgent(
						message.id as number, this.agents,
						this.fileWatchers, this.pollingTimers, this.permissionTimers,
						this.jsonlPollTimers, this.persistAgents,
					);
					this.webviewProxy.postMessage({ type: 'agentClosed', id: message.id });
				}
			}
		} else if (message.type === 'saveAgentSeats') {
			console.log(`[Pixel Agents] saveAgentSeats:`, JSON.stringify(message.seats));
			this.context.workspaceState.update(WORKSPACE_KEY_AGENT_SEATS, message.seats);
			this.scheduleSyncWrite();
		} else if (message.type === 'saveLayout') {
			this.layoutWatcher?.markOwnWrite();
			writeLayoutToFile(message.layout as Record<string, unknown>);
			this.relayClient?.pushLayout(message.layout as Record<string, unknown>);
		} else if (message.type === 'useDefaultLayout') {
			if (this.defaultLayout) {
				this.layoutWatcher?.markOwnWrite();
				writeLayoutToFile(this.defaultLayout);
				this.webview?.postMessage({ type: 'layoutLoaded', layout: this.defaultLayout });
			}
		} else if (message.type === 'characterVisualStates') {
			const states = message.states as Record<string, import('./types.js').SyncCharacterVisual>;
			this.characterVisuals.clear();
			for (const [idStr, visual] of Object.entries(states)) {
				this.characterVisuals.set(Number(idStr), visual);
			}
			this.scheduleSyncWrite();
		} else if (message.type === 'setSoundEnabled') {
			this.context.globalState.update(GLOBAL_KEY_SOUND_ENABLED, message.enabled);
		} else if (message.type === 'setShowNametags') {
			this.context.globalState.update(GLOBAL_KEY_SHOW_NAMETAGS, message.enabled);
		} else if (message.type === 'webviewReady') {
			// For the first webview (sidebar), do full initialization
			// For subsequent webviews (panels), just send current state
			const isSidebar = senderWebview === this.webviewView?.webview;

			if (isSidebar) {
				restoreAgents(
					this.context,
					this.nextAgentId, this.nextTerminalIndex,
					this.agents, this.knownJsonlFiles,
					this.fileWatchers, this.pollingTimers, this.permissionTimers,
					this.jsonlPollTimers, this.projectScanTimer, this.activeAgentId,
					this.webviewProxy, this.persistAgents,
				);
			}

			// Send settings to the specific webview that asked
			const soundEnabled = this.context.globalState.get<boolean>(GLOBAL_KEY_SOUND_ENABLED, true);
			const showNametags = this.context.globalState.get<boolean>(GLOBAL_KEY_SHOW_NAMETAGS, false);
			const claudeExtAvailable = vscode.extensions.getExtension('anthropic.claude-code') !== undefined;
			senderWebview.postMessage({ type: 'settingsLoaded', soundEnabled, showNametags, claudeExtAvailable });

			// Heartbeat: always emit a CONN entry and send full history
			{
				const now = new Date();
				const hh = String(now.getHours()).padStart(2, '0');
				const mm = String(now.getMinutes()).padStart(2, '0');
				const ss = String(now.getSeconds()).padStart(2, '0');
				const connEntry = `[${hh}:${mm}:${ss}] CONN   v1.4.3 build ${BUILD_NUMBER} — webview ${isSidebar ? 'sidebar' : 'panel'} connected — ${this.agents.size} agent(s) tracked`;
				this.devLogs.push(connEntry);
				this.outputChannel.appendLine(connEntry);
				for (const [aid, ag] of this.agents) {
					const jsonl = ag.jsonlFile ? ag.jsonlFile.split(/[\\/]/).pop() : 'none';
					const hasTerm = ag.terminalRef ? 'terminal' : 'no-terminal';
					const defId = ag.agentDefinitionId ?? 'ad-hoc';
					const agEntry = `[${hh}:${mm}:${ss}] CONN     agent #${aid} def=${defId} ${hasTerm} jsonl=${jsonl}`;
					this.devLogs.push(agEntry);
					this.outputChannel.appendLine(agEntry);
				}
			}
			senderWebview.postMessage({ type: 'devConsoleHistory', entries: this.devLogs });

			const wsFolders = vscode.workspace.workspaceFolders;
			if (wsFolders && wsFolders.length > 1) {
				senderWebview.postMessage({
					type: 'workspaceFolders',
					folders: wsFolders.map(f => ({ name: f.name, path: f.uri.fsPath })),
				});
			}

			const projectDir = getProjectDirPath();
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

			if (projectDir) {
				if (isSidebar) {
					ensureProjectScan(
						projectDir, this.knownJsonlFiles, this.projectScanTimer, this.activeAgentId,
						this.nextAgentId, this.agents,
						this.fileWatchers, this.pollingTimers, this.permissionTimers,
						this.webviewProxy, this.persistAgents,
					);
				}

				// Load and send assets to this specific webview
				await this.loadAndSendAssets(senderWebview, workspaceRoot, projectDir, isSidebar);
			} else {
				await this.loadAndSendAssetsMinimal(senderWebview);
			}

			sendExistingAgents(this.agents, this.context, senderWebview);

			// Force kick: re-read all agents with JSONL files to catch up on missed data
			for (const [agentId, agent] of this.agents) {
				if (agent.jsonlFile) {
					console.log(`[Pixel Agents] Kick: re-reading agent ${agentId} (file=${agent.jsonlFile.split(/[\\/]/).pop()}, offset=${agent.fileOffset}, hasWatcher=${this.fileWatchers.has(agentId)})`);
					if (!this.fileWatchers.has(agentId) && !this.pollingTimers.has(agentId)) {
						// Watcher lost — restart it
						console.log(`[Pixel Agents] Kick: restarting file watcher for agent ${agentId}`);
						startFileWatching(agentId, agent.jsonlFile, this.agents, this.fileWatchers, this.pollingTimers, this.permissionTimers, this.webviewProxy);
					}
					readNewLines(agentId, this.agents, this.permissionTimers, this.webviewProxy);
				} else {
					console.log(`[Pixel Agents] Agent ${agentId} has no JSONL file (defId=${agent.agentDefinitionId})`);
				}
			}

			// Start sync manager (once, on first webviewReady)
			this.startSyncManager();
		} else if (message.type === 'openSessionsFolder') {
			const projectDir = getProjectDirPath();
			if (projectDir && fs.existsSync(projectDir)) {
				vscode.env.openExternal(vscode.Uri.file(projectDir));
			}
		} else if (message.type === 'exportLayout') {
			const layout = readLayoutFromFile();
			if (!layout) {
				vscode.window.showWarningMessage('Pixel Agents: No saved layout to export.');
				return;
			}
			const uri = await vscode.window.showSaveDialog({
				filters: { 'JSON Files': ['json'] },
				defaultUri: vscode.Uri.file(path.join(os.homedir(), 'pixel-agents-layout.json')),
			});
			if (uri) {
				fs.writeFileSync(uri.fsPath, JSON.stringify(layout, null, 2), 'utf-8');
				vscode.window.showInformationMessage('Pixel Agents: Layout exported successfully.');
			}
		} else if (message.type === 'importLayout') {
			const uris = await vscode.window.showOpenDialog({
				filters: { 'JSON Files': ['json'] },
				canSelectMany: false,
			});
			if (!uris || uris.length === 0) return;
			try {
				const raw = fs.readFileSync(uris[0].fsPath, 'utf-8');
				const imported = JSON.parse(raw) as Record<string, unknown>;
				if (imported.version !== 1 || !Array.isArray(imported.tiles)) {
					vscode.window.showErrorMessage('Pixel Agents: Invalid layout file.');
					return;
				}
				this.layoutWatcher?.markOwnWrite();
				writeLayoutToFile(imported);
				this.webview?.postMessage({ type: 'layoutLoaded', layout: imported });
				vscode.window.showInformationMessage('Pixel Agents: Layout imported successfully.');
			} catch {
				vscode.window.showErrorMessage('Pixel Agents: Failed to read or parse layout file.');
			}
		}
	}

	/** Load all assets and send to a specific webview, with full init for sidebar. */
	private async loadAndSendAssets(targetWebview: vscode.Webview, workspaceRoot: string | undefined, projectDir: string, isSidebar: boolean): Promise<void> {
		try {
			const extensionPath = this.extensionUri.fsPath;
			const bundledAssetsDir = path.join(extensionPath, 'dist', 'assets');
			let assetsRoot: string | null = null;
			if (fs.existsSync(bundledAssetsDir)) {
				assetsRoot = path.join(extensionPath, 'dist');
			} else if (workspaceRoot) {
				assetsRoot = workspaceRoot;
			}

			if (!assetsRoot) {
				sendLayout(this.context, targetWebview, this.defaultLayout);
				this.startLayoutWatcher();
				return;
			}

			this.defaultLayout = loadDefaultLayout(assetsRoot);

			const charSprites = await loadCharacterSprites(assetsRoot);
			if (charSprites) sendCharacterSpritesToWebview(targetWebview, charSprites);

			const floorTiles = await loadFloorTiles(assetsRoot);
			if (floorTiles) sendFloorTilesToWebview(targetWebview, floorTiles);

			const wallTiles = await loadWallTiles(assetsRoot);
			if (wallTiles) sendWallTilesToWebview(targetWebview, wallTiles);

			const assets = await loadFurnitureAssets(assetsRoot);
			if (assets) sendAssetsToWebview(targetWebview, assets);
		} catch (err) {
			console.error('[Extension] Error loading assets:', err);
		}

		sendLayout(this.context, targetWebview, this.defaultLayout);
		this.startLayoutWatcher();

		if (isSidebar) {
			this.detectAndSendAgents();
			this.bindActiveAgentsToDefinitions();

			const projectDir2 = getProjectDirPath();
			if (projectDir2) {
				autoAdoptActiveConversations(
					projectDir2, this.knownJsonlFiles,
					this.nextAgentId, this.agents, this.activeAgentId,
					this.fileWatchers, this.pollingTimers, this.permissionTimers,
					this.webviewProxy, this.persistAgents,
				);
				// Re-run binding after adoption — newly adopted agents may match definitions
				this.bindActiveAgentsToDefinitions();
			}
		} else {
			// Panel: send detected agents + existing agents
			this.detectAndSendAgents();
		}
	}

	/** Minimal asset loading when there's no project dir. */
	private async loadAndSendAssetsMinimal(targetWebview: vscode.Webview): Promise<void> {
		try {
			const ep = this.extensionUri.fsPath;
			const bundled = path.join(ep, 'dist', 'assets');
			if (fs.existsSync(bundled)) {
				const distRoot = path.join(ep, 'dist');
				this.defaultLayout = loadDefaultLayout(distRoot);
				const cs = await loadCharacterSprites(distRoot);
				if (cs) sendCharacterSpritesToWebview(targetWebview, cs);
				const ft = await loadFloorTiles(distRoot);
				if (ft) sendFloorTilesToWebview(targetWebview, ft);
				const wt = await loadWallTiles(distRoot);
				if (wt) sendWallTilesToWebview(targetWebview, wt);
			}
		} catch { /* ignore */ }
		sendLayout(this.context, targetWebview, this.defaultLayout);
		this.startLayoutWatcher();
	}

	/** Launch a new conversation in the Claude Code VS Code extension and track it */
	private async launchClaudeExtension(_folderPath?: string): Promise<void> {
		const projectDir = getProjectDirPath();
		if (!projectDir) {
			console.log('[Pixel Agents] No project dir, cannot track Claude extension agent');
			return;
		}

		// Snapshot existing JSONL files before launching
		const beforeFiles = new Set<string>();
		try {
			for (const f of fs.readdirSync(projectDir)) {
				if (f.endsWith('.jsonl')) beforeFiles.add(path.join(projectDir, f));
			}
		} catch { /* dir may not exist */ }

		// Open new conversation in Claude Code extension
		try {
			await vscode.commands.executeCommand('claude-vscode.newConversation');
		} catch (err) {
			console.log(`[Pixel Agents] Failed to open Claude Code extension: ${err}`);
			vscode.window.showWarningMessage('Pixel Agents: Claude Code extension not found. Install it or use the terminal mode.');
			return;
		}

		const id = this.nextAgentId.current++;
		const agent = createAgentState({ id, projectDir, jsonlFile: '' });

		this.agents.set(id, agent);
		this.activeAgentId.current = id;
		this.persistAgents();
		const projectName = this.getProjectName();
		console.log(`[Pixel Agents] Agent ${id}: created for Claude extension conversation`);
		this.webviewProxy.postMessage({ type: 'agentCreated', id, projectName });

		// Poll for new JSONL file that wasn't in the snapshot
		const pollTimer = setInterval(() => {
			try {
				const currentFiles = fs.readdirSync(projectDir)
					.filter(f => f.endsWith('.jsonl'))
					.map(f => path.join(projectDir, f));
				for (const file of currentFiles) {
					if (!beforeFiles.has(file) && !this.knownJsonlFiles.has(file)) {
						// Found the new conversation's JSONL file
						console.log(`[Pixel Agents] Agent ${id}: found extension JSONL ${path.basename(file)}`);
						agent.jsonlFile = file;
						this.knownJsonlFiles.add(file);
						clearInterval(pollTimer);
						this.jsonlPollTimers.delete(id);
						this.persistAgents();
						startFileWatching(id, file, this.agents, this.fileWatchers, this.pollingTimers, this.permissionTimers, this.webviewProxy);
						readNewLines(id, this.agents, this.permissionTimers, this.webviewProxy);
						return;
					}
				}
			} catch { /* dir may not exist yet */ }
		}, JSONL_POLL_INTERVAL_MS);
		this.jsonlPollTimers.set(id, pollTimer);
	}

	/** Export current saved layout to webview-ui/public/assets/default-layout.json (dev utility) */
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

	/** Detect agents from project structure and send to webview */
	private detectAndSendAgents(): void {
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

		// Ensure .pixel_agents config exists for each workspace folder
		let paletteCounter = 0;
		const pickPalette = (): number => paletteCounter++ % 6;

		const agentMessages: Array<{
			definitionId: string;
			name: string;
			source: string;
			workspaceFolder: string;
			id: number;
			palette: number;
			hueShift: number;
			seatId: string | null;
		}> = [];

		for (const folder of folders) {
			const folderDefs = allDefinitions.filter(d => d.workspaceFolder === folder.uri.fsPath);
			if (folderDefs.length === 0) continue;

			const config = ensurePixelAgentsConfig(folder.uri.fsPath, folderDefs, pickPalette);

			for (const def of folderDefs) {
				const agentConfig = config.agents[def.definitionId];
				if (!agentConfig) continue;
				agentMessages.push({
					definitionId: def.definitionId,
					name: agentConfig.name,
					source: def.source,
					workspaceFolder: def.workspaceFolder,
					id: agentConfig.id,
					palette: agentConfig.palette,
					hueShift: agentConfig.hueShift,
					seatId: agentConfig.seatId,
				});
			}
		}

		// Create backend AgentState entries for detected agents that aren't already tracked.
		// This ensures they have agentDefinitionId set, so terminal close triggers unbind (not remove).
		// Skip if another agent already has this definitionId bound (e.g. adopted with a different ID).
		for (const msg of agentMessages) {
			const agentProjectDir = getProjectDirPath(msg.workspaceFolder);
			// Check if ANY agent already covers this definition (may have a different ID from adoption)
			let alreadyCovered = this.agents.has(msg.id);
			if (!alreadyCovered) {
				for (const existingAgent of this.agents.values()) {
					if (existingAgent.agentDefinitionId === msg.definitionId) {
						alreadyCovered = true;
						break;
					}
				}
			}
			if (!alreadyCovered && agentProjectDir) {
				const agent = createAgentState({
					id: msg.id,
					projectDir: agentProjectDir,
					jsonlFile: '',
					agentDefinitionId: msg.definitionId,
					folderName: undefined,
				});
				this.agents.set(msg.id, agent);
				console.log(`[Pixel Agents] Created backend entry for detected agent ${msg.id} ("${msg.definitionId}") projectDir=${agentProjectDir}`);
			}
			// Advance nextAgentId past config IDs to prevent collisions
			if (msg.id >= this.nextAgentId.current) {
				this.nextAgentId.current = msg.id + 1;
			}
		}

		console.log(`[Pixel Agents] Sending ${agentMessages.length} detected agents to webview`);
		this.webview?.postMessage({
			type: 'detectedAgents',
			agents: agentMessages,
		});

		// Update sync so other windows see detected agents
		this.scheduleSyncWrite();

		// Start watching for changes to agent definitions
		this.startAgentDefinitionWatchers();
	}

	/**
	 * After detected agents are sent and restored agents are loaded,
	 * try to bind any active (restored) agents that don't have a definitionId
	 * to the detected definitions. Also handles binding when VS Code reopens
	 * with existing Claude terminals still running.
	 */
	private bindActiveAgentsToDefinitions(): void {
		// Collect detected agent IDs that are not yet bound to any active agent
		const unboundDefinitions = new Map<string, { configId: number; projectDir: string }>(); // definitionId → info
		for (const def of this.detectedDefinitions) {
			const folders = vscode.workspace.workspaceFolders;
			if (!folders) continue;
			for (const folder of folders) {
				if (def.workspaceFolder !== folder.uri.fsPath) continue;
					const config = readPixelAgentsConfig(folder.uri.fsPath);
				if (config?.agents[def.definitionId]) {
					const configId = config.agents[def.definitionId].id;
					// Check if any agent already has this definition bound
					let alreadyBound = false;
					for (const agent of this.agents.values()) {
						if (agent.agentDefinitionId === def.definitionId && (agent.jsonlFile || agent.terminalRef)) {
							alreadyBound = true;
							break;
						}
					}
					if (!alreadyBound) {
						const defProjectDir = getProjectDirPath(def.workspaceFolder);
						if (defProjectDir) unboundDefinitions.set(def.definitionId, { configId, projectDir: defProjectDir });
					}
				}
			}
		}

		if (unboundDefinitions.size === 0) return;

		// Helper: when an adopted agent gets bound to a definition, remove the
		// placeholder entry (from detectAndSendAgents) that has no session.
		const removePlaceholder = (definitionId: string, adoptedAgentId: number): void => {
			for (const [existingId, existingAgent] of this.agents) {
				if (existingId !== adoptedAgentId
					&& existingAgent.agentDefinitionId === definitionId
					&& !existingAgent.jsonlFile && !existingAgent.terminalRef) {
					this.agents.delete(existingId);
					console.log(`[Pixel Agents] Removed placeholder agent ${existingId} for definition "${definitionId}"`);
					break;
				}
			}
		};

		// Try to bind restored agents (which have active terminals/JSONL files but no definitionId) to definitions
		for (const [_id, agent] of this.agents) {
			if (agent.agentDefinitionId) continue; // already bound
			if (!agent.jsonlFile) continue; // no active session

			// Check session marker
			const sessionId = path.basename(agent.jsonlFile, '.jsonl');
			const marker = readSessionMarker(sessionId);
			if (marker && unboundDefinitions.has(marker.definitionId)) {
				agent.agentDefinitionId = marker.definitionId;
				unboundDefinitions.delete(marker.definitionId);
				removePlaceholder(marker.definitionId, agent.id);
				console.log(`[Pixel Agents] Agent ${agent.id}: bound restored agent to definition "${marker.definitionId}"`);
				this.webviewProxy.postMessage({ type: 'agentBound', id: agent.id, definitionId: marker.definitionId });
				this.persistAgents();
			}
		}

		// Auto-bind: for each unbound definition, if there's exactly one unmatched
		// active agent in the SAME project directory, bind them together.
		// This scopes per-project so multi-root workspaces don't interfere.
		for (const [definitionId, { projectDir }] of unboundDefinitions) {
			const unmatchedInProject = [...this.agents.values()].filter(a =>
				!a.agentDefinitionId && a.jsonlFile && a.projectDir === projectDir
			);
			if (unmatchedInProject.length === 1) {
				const agent = unmatchedInProject[0];
				agent.agentDefinitionId = definitionId;
				unboundDefinitions.delete(definitionId);
				removePlaceholder(definitionId, agent.id);
				console.log(`[Pixel Agents] Agent ${agent.id}: auto-bound to definition "${definitionId}" (only match in ${projectDir})`);
				this.webviewProxy.postMessage({ type: 'agentBound', id: agent.id, definitionId });
				this.persistAgents();
			}
		}
	}

	private startAgentDefinitionWatchers(): void {
		// Dispose existing watcher
		this.agentDefinitionWatcher?.dispose();

		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) return;

		// For simplicity, watch the first folder (multi-root support can be expanded)
		const folder = folders[0];
		this.agentDefinitionWatcher = watchAgentDefinitions(folder.uri.fsPath, (_newDefs) => {
			// Re-detect all agents and re-send to webview
			this.detectAndSendAgents();
		});
	}

	private startLayoutWatcher(): void {
		if (this.layoutWatcher) return;
		this.layoutWatcher = watchLayoutFile((layout) => {
			console.log('[Pixel Agents] External layout change — pushing to webview');
			this.webview?.postMessage({ type: 'layoutLoaded', layout });
		});
	}

	// ── Cross-window sync ──────────────────────────────────────

	startSyncManager(): void {
		if (this.syncManager) return;
		this.syncManager = createSyncManager(this.windowId, (windows) => {
			this.handleRemoteWindowChange(windows);
		});
		// Initialize remote relay if configured
		const relayUrl = vscode.workspace.getConfiguration('pixel-agents').get<string>('relayUrl', '');
		const relayToken = vscode.workspace.getConfiguration('pixel-agents').get<string>('relayToken', '');
		if (relayUrl && relayToken) {
			this.relayClient = createRelayClient(relayUrl, relayToken, (layout) => {
				// Incoming layout from remote viewer — write to disk and push to webview
				this.layoutWatcher?.markOwnWrite();
				writeLayoutToFile(layout);
				this.webview?.postMessage({ type: 'layoutLoaded', layout });
			}, (msg) => this.outputChannel.appendLine(msg));
		}
		// Sync file writes whenever any agent's display state changes
		// (timer fires, tool starts/ends, permission detected, etc.)
		registerDisplayStateCallback(() => this.scheduleSyncWrite());
		// Periodic tick: re-evaluate all agents for timestamp-based state transitions
		// (idle/grace/thinking) and send updates to webview + sync file.
		this.stateTickInterval = setInterval(() => {
			tickAllAgents(this.agents, this.webview);
			this.scheduleSyncWrite();
		}, 1000);
		// Write initial state
		this.scheduleSyncWrite();
	}

	/** Schedule a debounced write of this window's agent states to the sync file. */
	scheduleSyncWrite(): void {
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
		// Track which definitionIds are covered by active agents
		const coveredDefinitions = new Set<string>();

		// Dedup by jsonlFile: if multiple agents track the same file, prefer the active one
		const seenJsonlFiles = new Map<string, AgentState>();

		// Count unnamed agents per project folder for Lead/#N naming
		const unnamedCounts = new Map<string, number>();

		const now = Date.now();
		for (const agent of this.agents.values()) {
			// Skip ad-hoc agents with no session (no terminal AND no JSONL file).
			// Config agents (agentDefinitionId set) stay visible as idle characters
			// even when unbound — prevents despawn/respawn flicker on conversation switch.
			if (!agent.terminalRef && !agent.jsonlFile && !agent.agentDefinitionId) continue;
			// Dedup by jsonlFile: keep the more recently active agent
			if (agent.jsonlFile) {
				const existing = seenJsonlFiles.get(agent.jsonlFile);
				if (existing) {
					// Prefer the one with more recent activity, or has a terminal
					const keepExisting = existing.lastDataAt >= agent.lastDataAt || (existing.terminalRef && !agent.terminalRef);
					if (keepExisting) continue;
					// Remove previously added entry for the duplicate
					const idx = agents.findIndex(a => a.localId === existing.id);
					if (idx !== -1) agents.splice(idx, 1);
				}
				seenJsonlFiles.set(agent.jsonlFile, agent);
			}
			// Use workspace folder name for naming (folderName is set for multi-root workspaces)
			const agentProjectName = agent.folderName || this.getProjectName();
			// Get appearance from .pixel_agents config or workspaceState
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
			});
		}

		// Dedup by display name: if two agents share the same name, keep the one
		// that has a terminal (real session) and drop the other (stale restore).
		const nameMap = new Map<string, number>();
		for (let i = 0; i < agents.length; i++) {
			const a = agents[i];
			const prev = nameMap.get(a.name);
			if (prev !== undefined) {
				const kept = agents[prev];
				const keptAgent = this.agents.get(kept.localId);
				const curAgent = this.agents.get(a.localId);
				// Prefer the agent with a terminal; if tied, prefer active > idle
				const curBetter = (!keptAgent?.terminalRef && !!curAgent?.terminalRef)
					|| (a.isActive && !kept.isActive);
				if (curBetter) {
					// Replace kept with current
					agents.splice(prev, 1);
					i--;
					nameMap.set(a.name, i);
				} else {
					// Drop current
					agents.splice(i, 1);
					i--;
				}
			} else {
				nameMap.set(a.name, i);
			}
		}

		// Only include detected definitions that have an active terminal/JSONL in the
		// sync file — they show as idle characters in the webview when open, but
		// shouldn't appear in the standalone browser without an active session.
		// (Covered definitions with active agents are already included above.)

		const state: SyncWindowState = {
			windowId: this.windowId,
			workspaceName: this.getProjectName(),
			workspaceFolder: folder.uri.fsPath,
			pid: process.pid,
			agents,
			updatedAt: Date.now(),
		};
		this.syncManager.writeState(state);
		this.relayClient?.pushState(state);

		// ── Sync-based webview reconciliation (same logic as standalone bridge) ──
		// Compare current agent list to what we last sent. Send standard messages
		// (existingAgents, agentClosed, agentStateUpdate) so the webview works
		// identically to the standalone browser — single source of truth.
		const currentIds = new Set(agents.map(a => a.localId));
		const newAgentIds: number[] = [];
		const newAgentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string }> = {};
		const newFolderNames: Record<number, string> = {};

		for (const a of agents) {
			if (!this.lastSyncSentIds.has(a.localId)) {
				newAgentIds.push(a.localId);
				newAgentMeta[a.localId] = { palette: a.palette, hueShift: a.hueShift, seatId: a.seatId ?? undefined };
				newFolderNames[a.localId] = a.name;
			}
		}
		if (newAgentIds.length > 0) {
			this.webview?.postMessage({
				type: 'existingAgents',
				agents: newAgentIds,
				agentMeta: newAgentMeta,
				folderNames: newFolderNames,
				projectName: this.getProjectName(),
			});
		}

		// Remove agents that disappeared
		for (const prevId of this.lastSyncSentIds) {
			if (!currentIds.has(prevId)) {
				this.webviewProxy.postMessage({ type: 'agentClosed', id: prevId });
			}
		}

		// Update state for agents whose state actually changed (avoids hammering the webview every tick)
		for (const a of agents) {
			const stateKey = `${a.isActive}|${a.currentTool}|${a.currentToolStatus}|${a.bubbleType}|${a.idleHint}`;
			if (this.lastSyncStateKeys.get(a.localId) !== stateKey) {
				this.lastSyncStateKeys.set(a.localId, stateKey);
				this.webview?.postMessage({
					type: 'agentStateUpdate',
					id: a.localId,
					isActive: a.isActive,
					currentTool: a.currentTool,
					toolStatus: a.currentToolStatus,
					bubbleType: a.bubbleType,
					idleHint: a.idleHint,
				});
			}
		}
		// Clean up state keys for removed agents
		for (const prevId of this.lastSyncSentIds) {
			if (!currentIds.has(prevId)) this.lastSyncStateKeys.delete(prevId);
		}

		this.lastSyncSentIds = currentIds;
	}

	/** Format and emit a Dev Console log entry, buffering it for late-joining webviews. */
	private emitDevLog(msg: Record<string, unknown>): void {
		const now = new Date();
		const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
		const id = msg.id as number | undefined;
		const defId = msg.definitionId as string | undefined;
		const agent = id !== undefined ? this.agents.get(id) : undefined;
		const folder = vscode.workspace.workspaceFolders?.find(f => agent?.projectDir?.startsWith(f.uri.fsPath))?.name ?? 'unknown';

		let event = '';
		let detail = '';
		switch (msg.type) {
			case 'agentBound':
				event = 'BIND';
				detail = `${folder}/${defId ?? '?'} → agent #${id} (session adopted)`;
				break;
			case 'agentUnbound':
				event = 'UNBIND';
				detail = `${folder}/${defId ?? '?'} ← agent #${id} terminal closed → idle`;
				break;
			case 'agentCreated':
				event = 'CREATE';
				detail = `agent #${id} created (${(msg.projectName as string) ?? folder})`;
				break;
			case 'agentClosed':
				event = 'CLOSE';
				detail = `agent #${id} removed`;
				break;
			case 'agentStatus':
				event = 'STATUS';
				detail = `agent #${id} → ${msg.status as string}`;
				break;
		}

		if (!event) return;
		const entry = `[${ts}] ${event.padEnd(6)} ${detail}`;
		this.devLogs.push(entry);
		if (this.devLogs.length > 200) this.devLogs.shift();
		this.outputChannel.appendLine(entry);
		this.broadcaster?.postMessage({ type: 'devConsoleLog', entry });
	}

	private getRemoteId(windowId: string, localId: number): number {
		const key = `${windowId}:${localId}`;
		let id = this.remoteIdMap.get(key);
		if (id === undefined) {
			id = this.nextRemoteId++;
			this.remoteIdMap.set(key, id);
		}
		return id;
	}

	private handleRemoteWindowChange(windows: SyncWindowState[]): void {
		const remoteAgents: Array<{
			id: number;
			name: string;
			palette: number;
			hueShift: number;
			seatId: string | null;
			isActive: boolean;
			currentTool: string | null;
			currentToolStatus: string | null;
			isWaiting: boolean;
			bubbleType: 'permission' | 'waiting' | null;
			idleHint: 'thinking' | 'between-turns' | null;
			workspaceName: string;
			workspaceFolder: string;
			visual?: import('./types.js').SyncCharacterVisual;
		}> = [];

		for (const win of windows) {
			for (const agent of win.agents) {
				remoteAgents.push({
					id: this.getRemoteId(win.windowId, agent.localId),
					name: agent.name,
					palette: agent.palette,
					hueShift: agent.hueShift,
					seatId: agent.seatId,
					isActive: agent.isActive,
					currentTool: agent.currentTool,
					currentToolStatus: agent.currentToolStatus,
					isWaiting: agent.isWaiting,
					bubbleType: agent.bubbleType,
					idleHint: agent.idleHint,
					workspaceName: win.workspaceName,
					workspaceFolder: win.workspaceFolder,
					visual: agent.visual,
				});
			}
		}

		this.webview?.postMessage({ type: 'remoteAgents', agents: remoteAgents });
	}

	// ── WebviewPanel (editor tab) ──────────────────────────────

	openInTab(): void {
		const panel = vscode.window.createWebviewPanel(
			'pixel-agents.tab',
			'Pixel Agents',
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true },
		);

		panel.webview.html = getWebviewContent(panel.webview, this.extensionUri);
		this.panels.add(panel);

		panel.onDidDispose(() => {
			this.panels.delete(panel);
		});

		// Handle messages from the panel webview (same as sidebar)
		panel.webview.onDidReceiveMessage(async (message) => {
			await this.handleWebviewMessage(message, panel.webview);
		});
	}

	dispose() {
		this.relayClient?.dispose();
		this.relayClient = null;
		this.syncManager?.dispose();
		this.syncManager = null;
		if (this.syncWriteTimer) {
			clearTimeout(this.syncWriteTimer);
			this.syncWriteTimer = null;
		}
		this.layoutWatcher?.dispose();
		this.layoutWatcher = null;
		this.agentDefinitionWatcher?.dispose();
		this.agentDefinitionWatcher = null;
		for (const panel of this.panels) panel.dispose();
		this.panels.clear();
		for (const id of [...this.agents.keys()]) {
			removeAgent(
				id, this.agents,
				this.fileWatchers, this.pollingTimers, this.permissionTimers,
				this.jsonlPollTimers, this.persistAgents,
			);
		}
		if (this.projectScanTimer.current) {
			clearInterval(this.projectScanTimer.current);
			this.projectScanTimer.current = null;
		}
		this.outputChannel.dispose();
	}
}

export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const distPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
	const indexPath = vscode.Uri.joinPath(distPath, 'index.html').fsPath;

	let html = fs.readFileSync(indexPath, 'utf-8');

	// Strip crossorigin attributes — they interfere with VS Code's internal
	// service worker that serves webview resources, causing registration failures.
	html = html.replace(/\s+crossorigin/g, '');

	html = html.replace(/(href|src)="\.\/([^"]+)"/g, (_match, attr, filePath) => {
		const fileUri = vscode.Uri.joinPath(distPath, filePath);
		const webviewUri = webview.asWebviewUri(fileUri);
		return `${attr}="${webviewUri}"`;
	});

	return html;
}
