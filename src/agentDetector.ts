import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { DetectedAgentDefinition, PixelAgentsConfigFile, PixelAgentConfig } from './types.js';
import { PIXEL_AGENTS_CONFIG_DIR, PIXEL_AGENTS_LEGACY_CONFIG_FILE, LAYOUT_FILE_DIR, AGENTS_DIR, AGENT_DIR_POLL_INTERVAL_MS } from './constants.js';

// ── Detection ──────────────────────────────────────────────────

/**
 * Scan a workspace folder for Claude Code agent definitions.
 * - CLAUDE.md in root → 'main' agent
 * - .claude/agents/*.md → one agent per file
 */
export function detectAgents(workspaceFolder: string): DetectedAgentDefinition[] {
	const agents: DetectedAgentDefinition[] = [];
	let hasClaudeMd = false;

	// Check for root CLAUDE.md → main agent (name decided after sub-agent scan)
	const claudeMdPath = path.join(workspaceFolder, 'CLAUDE.md');
	try {
		if (fs.existsSync(claudeMdPath)) {
			hasClaudeMd = true;
		}
	} catch { /* ignore */ }

	// Check for .claude/agents/*.md → sub-agents
	const agentsDir = path.join(workspaceFolder, AGENTS_DIR);
	let hasSubAgents = false;
	try {
		if (fs.existsSync(agentsDir) && fs.statSync(agentsDir).isDirectory()) {
			const files = fs.readdirSync(agentsDir);
			for (const file of files) {
				if (!file.endsWith('.md')) continue;
				const stem = file.slice(0, -3); // remove .md
				if (!stem) continue;
				hasSubAgents = true;
				agents.push({
					definitionId: stem.toLowerCase(),
					name: titleCase(stem),
					source: 'agent-file',
					filePath: path.join(agentsDir, file),
					workspaceFolder,
				});
			}
		}
	} catch { /* ignore */ }

	// Add main agent: always emitted so every workspace folder has a lead avatar.
	// Uses 'claude-md' source when CLAUDE.md exists, 'default' otherwise.
	agents.unshift({
		definitionId: 'main',
		name: hasSubAgents ? 'Orchestrator' : 'Lead',
		source: hasClaudeMd ? 'claude-md' : 'default',
		filePath: hasClaudeMd ? claudeMdPath : undefined,
		workspaceFolder,
	});

	return agents;
}

function titleCase(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ── Agent Config I/O (centralized at ~/.pixel-agents/projects/) ──

/** Hash workspace path to a short filename-safe string. */
function hashWorkspacePath(workspaceFolder: string): string {
	return crypto.createHash('sha256').update(workspaceFolder).digest('hex').slice(0, 16);
}

function getConfigDir(): string {
	return path.join(os.homedir(), LAYOUT_FILE_DIR, PIXEL_AGENTS_CONFIG_DIR);
}

function getConfigPath(workspaceFolder: string): string {
	return path.join(getConfigDir(), `${hashWorkspacePath(workspaceFolder)}.json`);
}

function getLegacyConfigPath(workspaceFolder: string): string {
	return path.join(workspaceFolder, PIXEL_AGENTS_LEGACY_CONFIG_FILE);
}

/**
 * Migrate legacy .pixel_agents from project root to ~/.pixel-agents/projects/.
 * Moves the data and deletes the old file.
 */
function migrateLegacyConfig(workspaceFolder: string): void {
	const legacyPath = getLegacyConfigPath(workspaceFolder);
	try {
		if (!fs.existsSync(legacyPath)) return;
		const raw = fs.readFileSync(legacyPath, 'utf-8');
		const parsed = JSON.parse(raw) as PixelAgentsConfigFile;
		if (parsed.version !== 1 || typeof parsed.agents !== 'object') {
			// Invalid legacy file — just remove it
			fs.unlinkSync(legacyPath);
			return;
		}
		// Write to new centralized location
		const newPath = getConfigPath(workspaceFolder);
		const dir = getConfigDir();
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		// Only migrate if new file doesn't already exist
		if (!fs.existsSync(newPath)) {
			fs.writeFileSync(newPath, raw, 'utf-8');
			console.log(`[Pixel Agents] Migrated .pixel_agents to ${newPath}`);
		}
		// Remove legacy file from project root
		fs.unlinkSync(legacyPath);
		console.log('[Pixel Agents] Removed legacy .pixel_agents from project root');
	} catch (err) {
		console.error('[Pixel Agents] Failed to migrate legacy .pixel_agents:', err);
	}
}

export function readPixelAgentsConfig(workspaceFolder: string): PixelAgentsConfigFile | null {
	// Migrate legacy file if it exists
	migrateLegacyConfig(workspaceFolder);

	const filePath = getConfigPath(workspaceFolder);
	try {
		if (!fs.existsSync(filePath)) return null;
		const raw = fs.readFileSync(filePath, 'utf-8');
		const parsed = JSON.parse(raw) as PixelAgentsConfigFile;
		if (parsed.version !== 1 || typeof parsed.agents !== 'object') return null;
		return parsed;
	} catch (err) {
		console.error('[Pixel Agents] Failed to read agent config:', err);
		return null;
	}
}

export function writePixelAgentsConfig(workspaceFolder: string, config: PixelAgentsConfigFile): void {
	const filePath = getConfigPath(workspaceFolder);
	try {
		const dir = getConfigDir();
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const json = JSON.stringify(config, null, 2);
		const tmpPath = filePath + '.tmp';
		fs.writeFileSync(tmpPath, json, 'utf-8');
		fs.renameSync(tmpPath, filePath);
	} catch (err) {
		console.error('[Pixel Agents] Failed to write agent config:', err);
	}
}

/**
 * Ensure agent config exists and is in sync with detected agents.
 * - Migrates legacy .pixel_agents from project root if present
 * - Creates config with defaults if missing
 * - Adds entries for new definitions (preserves existing customizations)
 * - Removes entries for definitions that no longer exist
 * Returns the merged config.
 */
export function ensurePixelAgentsConfig(
	workspaceFolder: string,
	definitions: DetectedAgentDefinition[],
	pickPalette: () => number,
): PixelAgentsConfigFile {
	const existing = readPixelAgentsConfig(workspaceFolder);
	const definitionIds = new Set(definitions.map(d => d.definitionId));

	if (existing) {
		let changed = false;

		// Add missing definitions + sync names from definitions
		for (const def of definitions) {
			if (!existing.agents[def.definitionId]) {
				existing.agents[def.definitionId] = {
					id: existing.nextId++,
					name: def.name,
					palette: pickPalette(),
					hueShift: 0,
					seatId: null,
				};
				changed = true;
			} else if (existing.agents[def.definitionId].name !== def.name) {
				// Sync name from definition (e.g. "Main" → "Lead")
				existing.agents[def.definitionId].name = def.name;
				changed = true;
			}
		}

		// Remove stale definitions
		for (const key of Object.keys(existing.agents)) {
			if (!definitionIds.has(key)) {
				delete existing.agents[key];
				changed = true;
			}
		}

		if (changed) {
			writePixelAgentsConfig(workspaceFolder, existing);
		}

		return existing;
	}

	// Create new config
	let nextId = 1;
	const agents: Record<string, PixelAgentConfig> = {};
	for (const def of definitions) {
		agents[def.definitionId] = {
			id: nextId++,
			name: def.name,
			palette: pickPalette(),
			hueShift: 0,
			seatId: null,
		};
	}

	const config: PixelAgentsConfigFile = {
		version: 1,
		nextId,
		agents,
	};

	writePixelAgentsConfig(workspaceFolder, config);
	return config;
}

/**
 * Update a single agent's appearance in the agent config.
 */
export function updateAgentConfig(
	workspaceFolder: string,
	definitionId: string,
	updates: Partial<Pick<PixelAgentConfig, 'palette' | 'hueShift' | 'seatId' | 'name'>>,
): void {
	const config = readPixelAgentsConfig(workspaceFolder);
	if (!config || !config.agents[definitionId]) return;

	const agent = config.agents[definitionId];
	if (updates.palette !== undefined) agent.palette = updates.palette;
	if (updates.hueShift !== undefined) agent.hueShift = updates.hueShift;
	if (updates.seatId !== undefined) agent.seatId = updates.seatId;
	if (updates.name !== undefined) agent.name = updates.name;

	writePixelAgentsConfig(workspaceFolder, config);
}

// ── Directory Watching ──────────────────────────────────────────

export interface AgentDefinitionWatcher {
	dispose(): void;
}

/**
 * Watch for changes to agent definitions:
 * - CLAUDE.md creation/deletion in workspace root
 * - .claude/agents/ directory additions/removals
 * Uses hybrid fs.watch + polling (same pattern as layout file watcher).
 */
export function watchAgentDefinitions(
	workspaceFolder: string,
	onChange: (agents: DetectedAgentDefinition[]) => void,
): AgentDefinitionWatcher {
	let disposed = false;
	let fsWatcher: fs.FSWatcher | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let lastSnapshot = serializeDefinitions(detectAgents(workspaceFolder));

	function check(): void {
		if (disposed) return;
		const current = detectAgents(workspaceFolder);
		const snapshot = serializeDefinitions(current);
		if (snapshot !== lastSnapshot) {
			lastSnapshot = snapshot;
			console.log('[Pixel Agents] Agent definitions changed');
			onChange(current);
		}
	}

	// Watch .claude/agents/ directory if it exists
	const agentsDir = path.join(workspaceFolder, AGENTS_DIR);
	try {
		if (fs.existsSync(agentsDir)) {
			fsWatcher = fs.watch(agentsDir, () => check());
			fsWatcher.on('error', () => {
				fsWatcher?.close();
				fsWatcher = null;
			});
		}
	} catch { /* ignore */ }

	// Polling backup
	pollTimer = setInterval(() => {
		if (disposed) return;
		// Try to start fs.watch if not running and dir now exists
		if (!fsWatcher) {
			try {
				if (fs.existsSync(agentsDir)) {
					fsWatcher = fs.watch(agentsDir, () => check());
					fsWatcher.on('error', () => {
						fsWatcher?.close();
						fsWatcher = null;
					});
				}
			} catch { /* ignore */ }
		}
		check();
	}, AGENT_DIR_POLL_INTERVAL_MS);

	return {
		dispose(): void {
			disposed = true;
			fsWatcher?.close();
			fsWatcher = null;
			if (pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
		},
	};
}

function serializeDefinitions(defs: DetectedAgentDefinition[]): string {
	return defs.map(d => `${d.definitionId}:${d.source}:${d.filePath ?? ''}`).sort().join('|');
}

// ── Session Marker Files ────────────────────────────────────────

function getSessionMarkerDir(): string {
	return path.join(os.homedir(), LAYOUT_FILE_DIR, 'sessions');
}

/**
 * Write a marker file that associates a session UUID with an agent definition.
 * Used when the extension launches a terminal for a specific detected agent.
 */
export function writeSessionMarker(sessionId: string, definitionId: string, workspaceFolder: string): void {
	const dir = getSessionMarkerDir();
	try {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const markerPath = path.join(dir, `${sessionId}.agent`);
		const data = JSON.stringify({ definitionId, workspaceFolder });
		fs.writeFileSync(markerPath, data, 'utf-8');
	} catch (err) {
		console.error('[Pixel Agents] Failed to write session marker:', err);
	}
}

/**
 * Read a session marker file to determine which agent definition a session belongs to.
 * Returns null if no marker exists.
 */
export function readSessionMarker(sessionId: string): { definitionId: string; workspaceFolder: string } | null {
	const markerPath = path.join(getSessionMarkerDir(), `${sessionId}.agent`);
	try {
		if (!fs.existsSync(markerPath)) return null;
		const raw = fs.readFileSync(markerPath, 'utf-8');
		return JSON.parse(raw) as { definitionId: string; workspaceFolder: string };
	} catch {
		return null;
	}
}

/**
 * Clean up a session marker file when a session ends.
 */
export function removeSessionMarker(sessionId: string): void {
	const markerPath = path.join(getSessionMarkerDir(), `${sessionId}.agent`);
	try {
		if (fs.existsSync(markerPath)) {
			fs.unlinkSync(markerPath);
		}
	} catch { /* ignore */ }
}
