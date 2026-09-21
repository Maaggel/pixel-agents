/**
 * Host abstraction - everything the backend needs from its environment.
 *
 * Two implementations exist:
 *   - vscodeHost.ts  → VS Code extension (workspace folders, terminals, workspaceState)
 *   - daemon.ts      → headless Linux service (config file / CLI, no terminals, JSON state file)
 *
 * Backend modules must never import 'vscode' directly - go through getHost().
 */

/** Anything that accepts backend messages (formerly vscode.Webview). */
export interface MessageSink {
	postMessage(msg: unknown): unknown;
}

/** Minimal shape of a terminal. vscode.Terminal satisfies this structurally. */
export interface TerminalHandle {
	readonly name: string;
}

export interface WorkspaceFolder {
	/** Absolute filesystem path */
	path: string;
	/** Display name (folder basename in VS Code) */
	name: string;
}

/** Persistent key/value store (formerly vscode.ExtensionContext.workspaceState). */
export interface KeyValueStore {
	get<T>(key: string, defaultValue: T): T;
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): void;
}

export interface RelaySettings {
	url: string;
	token: string;
}

/**
 * How the backend finds Claude Code sessions.
 *  - 'terminals': VS Code - infer from terminals + JSONL mtime heuristics (fileWatcher.ts)
 *  - 'registry':  headless - exact list from ~/.claude/sessions (claudeSessions.ts),
 *                 pushed in via PixelAgentsBackend.applyLiveSessions()
 */
export type DiscoveryMode = 'terminals' | 'registry';

export interface Host {
	discovery(): DiscoveryMode;
	/** Project folders whose Claude Code sessions should be tracked. */
	workspaceFolders(): WorkspaceFolder[];
	/** User-configured project name override ('' → use folder name). */
	customProjectName(): string;
	relaySettings(): RelaySettings;
	/** Live terminals (empty when headless). */
	terminals(): readonly TerminalHandle[];
	/** Focused terminal (null when headless). */
	activeTerminal(): TerminalHandle | null;
	/**
	 * Max ad-hoc sessions to adopt per project at startup when no terminals exist.
	 * Return null to use the default (1).
	 */
	headlessAdoptLimit(): number | null;
	workspaceState: KeyValueStore;
	log(msg: string): void;
}

let currentHost: Host | null = null;

export function setHost(host: Host): void {
	currentHost = host;
}

export function getHost(): Host {
	if (!currentHost) {
		throw new Error('[Pixel Agents] Host not initialised - call setHost() before using the backend');
	}
	return currentHost;
}

/** In-memory KeyValueStore - handy for tests and as a base for file-backed stores. */
export class MemoryKeyValueStore implements KeyValueStore {
	protected data: Record<string, unknown> = {};

	get<T>(key: string, defaultValue: T): T;
	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue?: T): T | undefined {
		const v = this.data[key];
		return v === undefined ? defaultValue : (v as T);
	}

	update(key: string, value: unknown): void {
		if (value === undefined) {
			delete this.data[key];
		} else {
			this.data[key] = value;
		}
	}
}
