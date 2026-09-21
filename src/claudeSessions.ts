/**
 * Discover running Claude Code sessions on this machine.
 *
 * Primary source: Claude Code's own process registry at ~/.claude/sessions/<pid>.json
 * (written by every `claude` process; contains pid, sessionId, cwd, name, status).
 * A registry entry is only trusted when the pid is alive AND its kernel start time
 * matches the recorded `procStart` - this guards against pid reuse after reboots
 * or crashes, where a stale registry file could point at an unrelated process.
 *
 * Fallback (older Claude Code without the registry): walk /proc for `claude`
 * processes, take their cwd, and pick the newest non-ended JSONL under the
 * matching project dir whose records carry that cwd.
 *
 * Pure Node - no VS Code, no side effects beyond reads.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CLAUDE_DIR, CLAUDE_PROJECTS_DIR, CLAUDE_SESSIONS_DIR, SESSION_MATCH_TAIL_BYTES } from './constants.js';
import { getProjectDirPath } from './agentManager.js';
import { isSessionEnded } from './fileWatcher.js';

export interface LiveClaudeSession {
	pid: number;
	sessionId: string;
	/** Absolute project folder the session runs in */
	cwd: string;
	/** Absolute path of the session transcript (may not exist yet for a brand-new session) */
	jsonlFile: string;
	/** Display name from the registry (user-set or derived) */
	name: string | null;
	nameSource: 'user' | 'derived' | null;
	/** Registry status hint ('busy' / 'idle') - informational only */
	status: string | null;
	startedAt: number;
	/** 'registry' when found via ~/.claude/sessions, 'proc' when inferred from /proc */
	source: 'registry' | 'proc';
}

interface RegistryEntry {
	pid?: number;
	sessionId?: string;
	cwd?: string;
	procStart?: string | number;
	name?: string;
	nameSource?: string;
	status?: string;
	startedAt?: number;
	kind?: string;
}

function claudeHome(): string {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), CLAUDE_DIR);
}

export function sessionsRegistryDir(): string {
	return path.join(claudeHome(), CLAUDE_SESSIONS_DIR);
}

// ── Process liveness ─────────────────────────────────────────

/** Kernel start time of a process (clock ticks since boot), Linux only. */
function procStartTime(pid: number): string | null {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
		// comm may contain spaces/parens - fields start after the last ')'
		const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		// rest[0] = state (field 3) → starttime is field 22 → index 19
		return rest[19] ?? null;
	} catch {
		return null;
	}
}

/**
 * True if `pid` is alive and - when both sides are known - was started at the
 * recorded time. On non-Linux only the signal-0 check is available.
 */
export function isProcessAlive(pid: number, expectedStart?: string | number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch (err) {
		// EPERM = exists but owned by someone else; treat as alive
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
	if (expectedStart === undefined || expectedStart === null || expectedStart === '') return true;
	const actual = procStartTime(pid);
	if (actual === null) return true; // not Linux - can't verify, trust the signal check
	return actual === String(expectedStart);
}

// ── Registry scan ────────────────────────────────────────────

function readRegistryEntry(file: string): RegistryEntry | null {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf-8')) as RegistryEntry;
	} catch {
		return null; // mid-write or corrupt - skip this tick
	}
}

/**
 * Read ~/.claude/sessions and return one entry per live session.
 * Multiple processes on the same sessionId (e.g. `claude --continue` twice)
 * collapse into one, keeping the earliest-started process.
 */
export function scanSessionRegistry(): LiveClaudeSession[] | null {
	const dir = sessionsRegistryDir();
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
	} catch {
		return null; // registry not present → caller falls back to /proc
	}

	const bySession = new Map<string, LiveClaudeSession>();
	for (const f of files) {
		const entry = readRegistryEntry(path.join(dir, f));
		if (!entry) continue;
		const pid = entry.pid ?? parseInt(f, 10);
		if (!entry.sessionId || !entry.cwd) continue;
		if (!isProcessAlive(pid, entry.procStart)) continue;

		const projectDir = getProjectDirPath(entry.cwd);
		if (!projectDir) continue;
		const session: LiveClaudeSession = {
			pid,
			sessionId: entry.sessionId,
			cwd: path.resolve(entry.cwd),
			jsonlFile: path.join(projectDir, `${entry.sessionId}.jsonl`),
			name: entry.name ?? null,
			nameSource: entry.nameSource === 'user' ? 'user' : entry.nameSource === 'derived' ? 'derived' : null,
			status: entry.status ?? null,
			startedAt: entry.startedAt ?? 0,
			source: 'registry',
		};
		const existing = bySession.get(session.sessionId);
		if (!existing || session.startedAt < existing.startedAt) {
			bySession.set(session.sessionId, session);
		}
	}
	return [...bySession.values()];
}

// ── /proc fallback ───────────────────────────────────────────

function isClaudeCommand(cmdline: string): boolean {
	const argv = cmdline.split('\0').filter(Boolean);
	if (argv.length === 0) return false;
	// Direct binary (.../bin/claude) or `node .../claude` wrappers; exclude shells that merely mention it
	const exe = path.basename(argv[0]);
	if (exe === 'claude') return true;
	if ((exe === 'node' || exe.startsWith('node')) && argv[1] && path.basename(argv[1]) === 'claude') return true;
	return false;
}

function jsonlTailMentionsCwd(file: string, cwd: string): boolean {
	try {
		const fd = fs.openSync(file, 'r');
		try {
			const size = fs.fstatSync(fd).size;
			const len = Math.min(SESSION_MATCH_TAIL_BYTES, size);
			const buf = Buffer.alloc(len);
			fs.readSync(fd, buf, 0, len, size - len);
			return buf.toString('utf-8').includes(`"cwd":${JSON.stringify(cwd)}`);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return false;
	}
}

/**
 * Infer sessions from /proc when the registry is unavailable.
 * For N claude processes in one cwd, the N most recently modified non-ended
 * transcripts mentioning that cwd are assumed to belong to them.
 */
export function scanProcForSessions(): LiveClaudeSession[] {
	const procsByCwd = new Map<string, number[]>();
	let pids: string[];
	try {
		pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n));
	} catch {
		return [];
	}
	for (const p of pids) {
		let cmdline: string;
		let cwd: string;
		try {
			cmdline = fs.readFileSync(`/proc/${p}/cmdline`, 'utf-8');
			if (!isClaudeCommand(cmdline)) continue;
			cwd = fs.readlinkSync(`/proc/${p}/cwd`);
		} catch {
			continue; // exited or not ours
		}
		const list = procsByCwd.get(cwd) ?? [];
		list.push(parseInt(p, 10));
		procsByCwd.set(cwd, list);
	}

	const sessions: LiveClaudeSession[] = [];
	for (const [cwd, procPids] of procsByCwd) {
		const projectDir = getProjectDirPath(cwd);
		if (!projectDir) continue;
		let candidates: Array<{ file: string; mtime: number }> = [];
		try {
			candidates = fs.readdirSync(projectDir)
				.filter(f => f.endsWith('.jsonl'))
				.map(f => path.join(projectDir, f))
				.filter(f => !isSessionEnded(f) && jsonlTailMentionsCwd(f, cwd))
				.map(f => ({ file: f, mtime: fs.statSync(f).mtimeMs }))
				.sort((a, b) => b.mtime - a.mtime);
		} catch { /* project dir missing → no sessions yet */ }
		procPids.sort((a, b) => a - b);
		for (let i = 0; i < procPids.length && i < candidates.length; i++) {
			sessions.push({
				pid: procPids[i],
				sessionId: path.basename(candidates[i].file, '.jsonl'),
				cwd,
				jsonlFile: candidates[i].file,
				name: null,
				nameSource: null,
				status: null,
				startedAt: 0,
				source: 'proc',
			});
		}
	}
	return sessions;
}

/** Registry first, /proc fallback. Never throws. */
export function discoverLiveSessions(): { sessions: LiveClaudeSession[]; source: 'registry' | 'proc' } {
	const fromRegistry = scanSessionRegistry();
	if (fromRegistry !== null) return { sessions: fromRegistry, source: 'registry' };
	return { sessions: scanProcForSessions(), source: 'proc' };
}

export function projectsDir(): string {
	return path.join(claudeHome(), CLAUDE_PROJECTS_DIR);
}
