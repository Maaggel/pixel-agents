import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SyncWindowState } from './types.js';
import { LAYOUT_FILE_DIR, SYNC_DIR, SYNC_POLL_INTERVAL_MS, SYNC_STALE_TIMEOUT_MS } from './constants.js';

function getSyncDir(): string {
	return path.join(os.homedir(), LAYOUT_FILE_DIR, SYNC_DIR);
}

export interface SyncManager {
	/** Write this window's agent states to the sync file. */
	writeState(state: SyncWindowState): void;
	/** Force a read of other windows' states. */
	readOtherWindows(): SyncWindowState[];
	/** Dispose watchers and remove own sync file. */
	dispose(): void;
}

export function createSyncManager(
	windowId: string,
	onRemoteChange: (windows: SyncWindowState[]) => void,
): SyncManager {
	const syncDir = getSyncDir();
	const ownFile = path.join(syncDir, `${windowId}.json`);
	let disposed = false;
	let fsWatcher: fs.FSWatcher | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let lastSnapshot = '';

	// Ensure sync directory exists
	try {
		if (!fs.existsSync(syncDir)) {
			fs.mkdirSync(syncDir, { recursive: true });
		}
	} catch { /* ignore */ }

	function readOtherWindows(): SyncWindowState[] {
		const windows: SyncWindowState[] = [];
		try {
			const files = fs.readdirSync(syncDir);
			const now = Date.now();
			for (const f of files) {
				if (!f.endsWith('.json')) continue;
				if (f === `${windowId}.json`) continue;
				const filePath = path.join(syncDir, f);
				try {
					const raw = fs.readFileSync(filePath, 'utf-8');
					const state = JSON.parse(raw) as SyncWindowState;
					// Check staleness
					if (now - state.updatedAt > SYNC_STALE_TIMEOUT_MS) {
						// Check if process is still alive
						try {
							process.kill(state.pid, 0);
						} catch {
							try { fs.unlinkSync(filePath); } catch { /* ignore */ }
							continue;
						}
					}
					windows.push(state);
				} catch { /* skip bad files */ }
			}
		} catch { /* dir may not exist */ }
		return windows;
	}

	function check(): void {
		if (disposed) return;
		const windows = readOtherWindows();
		const snapshot = JSON.stringify(windows);
		if (snapshot !== lastSnapshot) {
			lastSnapshot = snapshot;
			onRemoteChange(windows);
		}
	}

	// Start watching sync directory
	try {
		if (fs.existsSync(syncDir)) {
			fsWatcher = fs.watch(syncDir, () => check());
			fsWatcher.on('error', () => {
				fsWatcher?.close();
				fsWatcher = null;
			});
		}
	} catch { /* ignore */ }

	// Polling backup
	pollTimer = setInterval(() => {
		if (disposed) return;
		if (!fsWatcher) {
			try {
				if (fs.existsSync(syncDir)) {
					fsWatcher = fs.watch(syncDir, () => check());
					fsWatcher.on('error', () => {
						fsWatcher?.close();
						fsWatcher = null;
					});
				}
			} catch { /* ignore */ }
		}
		check();
	}, SYNC_POLL_INTERVAL_MS);

	// Initial check
	check();

	return {
		writeState(state: SyncWindowState): void {
			if (disposed) return;
			try {
				if (!fs.existsSync(syncDir)) {
					fs.mkdirSync(syncDir, { recursive: true });
				}
				const tmpPath = ownFile + '.tmp';
				fs.writeFileSync(tmpPath, JSON.stringify(state), 'utf-8');
				fs.renameSync(tmpPath, ownFile);
			} catch { /* ignore */ }
		},

		readOtherWindows,

		dispose(): void {
			disposed = true;
			fsWatcher?.close();
			fsWatcher = null;
			if (pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
			// Remove own sync file
			try {
				if (fs.existsSync(ownFile)) {
					fs.unlinkSync(ownFile);
				}
			} catch { /* ignore */ }
		},
	};
}
