/**
 * Pixel Agents headless daemon.
 *
 * Runs on the machine where Claude Code runs (no VS Code needed). Every
 * REGISTRY_POLL_MS it reads Claude Code's own process registry
 * (~/.claude/sessions/<pid>.json — see claudeSessions.ts), so the set of
 * tracked agents is exactly the set of live `claude` processes: no guessing
 * from file timestamps, no configured folder list required.
 *
 *   node dist/pixel-agents-daemon.cjs --relay-url wss://host/pixelagents/ws --relay-token SECRET
 *
 * One PixelAgentsBackend runs per project folder (the cwd of the claude
 * process), each publishing under its own windowId. Backends are created when
 * a folder's first session appears and disposed DAEMON_PROJECT_LINGER_MS after
 * its last one exits. `--folder` pins a folder so it is always shown (idle
 * characters when nothing runs); `--include` restricts discovery to a prefix.
 *
 * Configuration precedence: CLI flags > environment variables > ~/.pixel-agents/daemon.json.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PixelAgentsBackend } from './PixelAgentsViewProvider.js';
import { MemoryKeyValueStore, setHost } from './host.js';
import type { Host, KeyValueStore, WorkspaceFolder } from './host.js';
import {
	DAEMON_CONFIG_FILE,
	DAEMON_PROJECT_LINGER_MS,
	DAEMON_REGISTRY_POLL_MS,
	DAEMON_STATE_DIR,
	DAEMON_STATE_WRITE_DEBOUNCE_MS,
	LAYOUT_FILE_DIR,
} from './constants.js';
import { discoverLiveSessions, sessionsRegistryDir } from './claudeSessions.js';
import type { LiveClaudeSession } from './claudeSessions.js';

// ── Configuration ────────────────────────────────────────────

interface DaemonConfig {
	/** Pinned folders: always tracked, even with no live session */
	folders: string[];
	/** Only discover sessions whose cwd starts with one of these prefixes (empty = everything) */
	include: string[];
	/** Never track sessions whose cwd starts with one of these prefixes */
	exclude: string[];
	relayUrl: string;
	relayToken: string;
	projectName: string;
}

interface ConfigFile {
	folders?: string[];
	include?: string[];
	exclude?: string[];
	relayUrl?: string;
	relayToken?: string;
	projectName?: string;
}

function usage(): never {
	console.log(`Pixel Agents daemon — headless publisher for the relay server

Usage: pixel-agents-daemon [options]

Sessions are discovered automatically from Claude Code's process registry
(~/.claude/sessions). Nothing needs to be listed for the daemon to find them.

Options:
  --folder <path>        Pin a project folder: always shown, even when no claude runs there (repeatable)
  --include <prefix>     Only track sessions whose cwd starts with <prefix> (repeatable)
  --exclude <prefix>     Ignore sessions whose cwd starts with <prefix> (repeatable)
  --relay-url <url>      Relay WebSocket URL, e.g. wss://host/pixelagents/ws
  --relay-token <token>  Relay auth token
  --project-name <name>  Nametag prefix override (single-folder setups)
  --config <file>        Config file (default ~/${LAYOUT_FILE_DIR}/${DAEMON_CONFIG_FILE})
  -h, --help             Show this help

Environment: PIXEL_AGENTS_FOLDERS / PIXEL_AGENTS_INCLUDE / PIXEL_AGENTS_EXCLUDE (":"-separated),
             PIXEL_AGENTS_RELAY_URL, PIXEL_AGENTS_RELAY_TOKEN, PIXEL_AGENTS_PROJECT_NAME

Config file keys: folders[], include[], exclude[], relayUrl, relayToken, projectName`);
	process.exit(0);
}

function parseArgs(argv: string[]): { flags: Record<string, string>; lists: Record<string, string[]> } {
	const flags: Record<string, string> = {};
	const lists: Record<string, string[]> = { folder: [], include: [], exclude: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '-h' || arg === '--help') usage();
		if (!arg.startsWith('--')) {
			console.error(`Unexpected argument: ${arg}`);
			process.exit(2);
		}
		const key = arg.slice(2);
		const value = argv[++i];
		if (value === undefined) {
			console.error(`Missing value for --${key}`);
			process.exit(2);
		}
		if (key in lists) lists[key].push(value);
		else flags[key] = value;
	}
	return { flags, lists };
}

function readConfigFile(file: string): ConfigFile {
	try {
		if (!fs.existsSync(file)) return {};
		return JSON.parse(fs.readFileSync(file, 'utf-8')) as ConfigFile;
	} catch (err) {
		console.error(`[Daemon] Could not read config ${file}: ${err}`);
		return {};
	}
}

function loadConfig(): DaemonConfig {
	const { flags, lists } = parseArgs(process.argv.slice(2));
	const env = process.env;
	const configPath = flags.config ?? path.join(os.homedir(), LAYOUT_FILE_DIR, DAEMON_CONFIG_FILE);
	const file = readConfigFile(configPath);

	const pathList = (cli: string[], envVar: string | undefined, fromFile: string[] | undefined): string[] => {
		const raw = cli.length > 0 ? cli
			: envVar ? envVar.split(path.delimiter).filter(Boolean)
			: fromFile ?? [];
		return [...new Set(raw.map(f => path.resolve(f)))];
	};

	return {
		folders: pathList(lists.folder, env.PIXEL_AGENTS_FOLDERS, file.folders),
		include: pathList(lists.include, env.PIXEL_AGENTS_INCLUDE, file.include),
		exclude: pathList(lists.exclude, env.PIXEL_AGENTS_EXCLUDE, file.exclude),
		relayUrl: flags['relay-url'] ?? env.PIXEL_AGENTS_RELAY_URL ?? file.relayUrl ?? '',
		relayToken: flags['relay-token'] ?? env.PIXEL_AGENTS_RELAY_TOKEN ?? file.relayToken ?? '',
		projectName: flags['project-name'] ?? env.PIXEL_AGENTS_PROJECT_NAME ?? file.projectName ?? '',
	};
}

// ── Persistence (replaces VS Code workspaceState) ────────────

/** JSON-file-backed store, one file per project folder under ~/.pixel-agents/daemon-state/. */
class FileKeyValueStore extends MemoryKeyValueStore implements KeyValueStore {
	private writeTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly file: string) {
		super();
		try {
			if (fs.existsSync(file)) {
				this.data = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
			}
		} catch (err) {
			console.error(`[Daemon] Could not read state ${file}: ${err}`);
		}
	}

	override update(key: string, value: unknown): void {
		super.update(key, value);
		if (this.writeTimer) clearTimeout(this.writeTimer);
		this.writeTimer = setTimeout(() => {
			this.writeTimer = null;
			this.flush();
		}, DAEMON_STATE_WRITE_DEBOUNCE_MS);
	}

	flush(): void {
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			const tmp = `${this.file}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
			fs.renameSync(tmp, this.file);
		} catch (err) {
			console.error(`[Daemon] Could not write state ${this.file}: ${err}`);
		}
	}
}

function stateFileFor(folder: string): string {
	const slug = folder.replace(/[\\/]/g, '-').replace(/[^a-zA-Z0-9-]/g, '').replace(/^-+/, '').slice(-40);
	return path.join(os.homedir(), LAYOUT_FILE_DIR, DAEMON_STATE_DIR, `${slug}.json`);
}

// ── Host ─────────────────────────────────────────────────────

function timestamp(): string {
	return new Date().toISOString().slice(11, 19);
}

function createDaemonHost(config: DaemonConfig, folder: WorkspaceFolder, store: FileKeyValueStore): Host {
	const tag = `[${folder.name}] `;
	return {
		discovery: () => 'registry' as const,
		workspaceFolders: () => [folder],
		customProjectName: () => config.projectName,
		relaySettings: () => ({ url: config.relayUrl, token: config.relayToken }),
		terminals: () => [],
		activeTerminal: () => null,
		headlessAdoptLimit: () => null,
		workspaceState: store,
		log: (msg: string) => console.log(`${timestamp()} ${tag}${msg}`),
	};
}

// ── Project manager ──────────────────────────────────────────

interface ProjectEntry {
	folder: WorkspaceFolder;
	backend: PixelAgentsBackend;
	store: FileKeyValueStore;
	pinned: boolean;
	/** When the last live session for this folder disappeared (null while sessions exist) */
	idleSince: number | null;
}

function isUnderPrefix(p: string, prefix: string): boolean {
	return p === prefix || p.startsWith(prefix.endsWith(path.sep) ? prefix : prefix + path.sep);
}

class ProjectManager {
	private readonly projects = new Map<string, ProjectEntry>();
	private lastSource: 'registry' | 'proc' | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private registryWatcher: fs.FSWatcher | null = null;
	private polling = false;

	constructor(private readonly config: DaemonConfig) {}

	start(): void {
		for (const p of this.config.folders) {
			if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
				console.error(`[Daemon] Pinned folder does not exist, skipping: ${p}`);
				continue;
			}
			this.ensureProject(p, true);
		}
		this.poll();
		this.pollTimer = setInterval(() => this.poll(), DAEMON_REGISTRY_POLL_MS);
		// React quickly to sessions starting/stopping; the poll remains the safety net.
		try {
			this.registryWatcher = fs.watch(sessionsRegistryDir(), () => this.poll());
		} catch { /* registry dir absent (old Claude Code) — /proc fallback via poll */ }
	}

	private accepts(cwd: string): boolean {
		if (this.config.exclude.some(x => isUnderPrefix(cwd, x))) return false;
		if (this.config.include.length === 0) return true;
		return this.config.include.some(x => isUnderPrefix(cwd, x));
	}

	private ensureProject(folderPath: string, pinned: boolean): ProjectEntry {
		let entry = this.projects.get(folderPath);
		if (entry) {
			if (pinned) entry.pinned = true;
			return entry;
		}
		const folder: WorkspaceFolder = { path: folderPath, name: path.basename(folderPath) };
		const store = new FileKeyValueStore(stateFileFor(folderPath));
		const backend = new PixelAgentsBackend(createDaemonHost(this.config, folder, store));
		console.log(`${timestamp()} [Daemon] Project ${pinned ? 'pinned' : 'discovered'}: ${folderPath}`);
		backend.init();
		entry = { folder, backend, store, pinned, idleSince: null };
		this.projects.set(folderPath, entry);
		return entry;
	}

	private disposeProject(entry: ProjectEntry): void {
		console.log(`${timestamp()} [Daemon] Project idle for ${DAEMON_PROJECT_LINGER_MS / 60000} min, removing: ${entry.folder.path}`);
		try { entry.backend.dispose(); } catch (err) { console.error(`[Daemon] dispose error: ${err}`); }
		entry.store.flush();
		this.projects.delete(entry.folder.path);
	}

	poll(): void {
		if (this.polling) return; // fs.watch bursts
		this.polling = true;
		try {
			const { sessions, source } = discoverLiveSessions();
			if (source !== this.lastSource) {
				console.log(`${timestamp()} [Daemon] Session discovery via ${source === 'registry' ? '~/.claude/sessions registry' : '/proc scan (registry not found — older Claude Code?)'}`);
				this.lastSource = source;
			}

			const byFolder = new Map<string, LiveClaudeSession[]>();
			for (const s of sessions) {
				if (!this.accepts(s.cwd)) continue;
				const list = byFolder.get(s.cwd) ?? [];
				list.push(s);
				byFolder.set(s.cwd, list);
			}

			for (const [cwd, list] of byFolder) {
				const entry = this.ensureProject(cwd, false);
				entry.idleSince = null;
				entry.backend.applyLiveSessions(list);
			}

			const now = Date.now();
			for (const entry of [...this.projects.values()]) {
				if (byFolder.has(entry.folder.path)) continue;
				entry.backend.applyLiveSessions([]);
				if (entry.pinned) continue;
				if (entry.idleSince === null) entry.idleSince = now;
				else if (now - entry.idleSince > DAEMON_PROJECT_LINGER_MS) this.disposeProject(entry);
			}
		} catch (err) {
			console.error(`${timestamp()} [Daemon] Discovery error: ${err instanceof Error ? err.stack ?? err.message : err}`);
		} finally {
			this.polling = false;
		}
	}

	summary(): string {
		const parts: string[] = [];
		for (const e of this.projects.values()) {
			const live = [...e.backend.agents.values()].filter(a => a.pid !== null).length;
			parts.push(`${e.folder.name}:${live}${e.pinned ? '*' : ''}`);
		}
		return parts.join(' ') || '(no projects)';
	}

	dispose(): void {
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.registryWatcher?.close();
		for (const entry of this.projects.values()) {
			try { entry.backend.dispose(); } catch (err) { console.error(`[Daemon] dispose error: ${err}`); }
			entry.store.flush();
		}
		this.projects.clear();
	}
}

// ── Main ─────────────────────────────────────────────────────

function main(): void {
	const config = loadConfig();

	if (!config.relayUrl || !config.relayToken) {
		console.log('[Daemon] No relay configured (relayUrl/relayToken) — running local-only (sync files for the standalone viewer).');
	}

	console.log(`[Daemon] Starting (pid ${process.pid}) — relay: ${config.relayUrl || '(none)'}`
		+ (config.folders.length ? `, pinned: ${config.folders.join(', ')}` : '')
		+ (config.include.length ? `, include: ${config.include.join(', ')}` : '')
		+ (config.exclude.length ? `, exclude: ${config.exclude.join(', ')}` : ''));

	// Module-level host for folder-independent lookups in shared modules
	// (terminals, adopt limit). Each backend gets its own single-folder host.
	const sharedStore = new FileKeyValueStore(stateFileFor('shared'));
	setHost(createDaemonHost(config, { path: process.cwd(), name: 'daemon' }, sharedStore));

	const manager = new ProjectManager(config);
	manager.start();
	console.log(`${timestamp()} [Daemon] Tracking: ${manager.summary()}`);

	let shuttingDown = false;
	const shutdown = (signal: string): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`[Daemon] ${signal} received — shutting down`);
		manager.dispose();
		process.exit(0);
	};
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGUSR1', () => console.log(`${timestamp()} [Daemon] Tracking: ${manager.summary()}`));
	process.on('uncaughtException', (err) => {
		console.error(`[Daemon] Uncaught exception: ${err.stack ?? err}`);
	});
	process.on('unhandledRejection', (reason) => {
		console.error(`[Daemon] Unhandled rejection: ${reason}`);
	});
}

main();
