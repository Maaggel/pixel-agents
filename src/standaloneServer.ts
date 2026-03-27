import * as vscode from 'vscode';
import { type ChildProcess, spawn } from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { STANDALONE_DEFAULT_PORT, STANDALONE_READY_TIMEOUT_MS, STANDALONE_READY_POLL_MS } from './constants.js';

let serverProcess: ChildProcess | null = null;
let activePort: number | null = null;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let extensionPathCache: string | null = null;
let outputChannelRef: vscode.OutputChannel | null = null;

/**
 * Check if a server is already listening on a port by hitting /api/init.
 */
function isPortReady(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const req = http.get(`http://localhost:${port}/api/init`, (res) => {
			res.resume();
			resolve(res.statusCode === 200);
		});
		req.on('error', () => resolve(false));
		req.setTimeout(1000, () => { req.destroy(); resolve(false); });
	});
}

/**
 * Wait for the standalone server to be ready (responding to HTTP requests).
 */
function waitForReady(port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const start = Date.now();
		const check = () => {
			if (Date.now() - start > timeoutMs) {
				resolve(false);
				return;
			}
			isPortReady(port).then((ready) => {
				if (ready) resolve(true);
				else setTimeout(check, STANDALONE_READY_POLL_MS);
			});
		};
		check();
	});
}

/**
 * Spawn the server process. Returns the ChildProcess on success, null on failure.
 */
async function spawnServer(extensionPath: string, port: number, outputChannel: vscode.OutputChannel): Promise<ChildProcess | null> {
	const serverScript = path.join(extensionPath, 'dist', 'standalone-server.cjs');
	outputChannel.appendLine(`[Standalone] Starting server: node ${serverScript} --port ${port}`);

	const proc = spawn(process.execPath, [serverScript, '--port', String(port)], {
		cwd: extensionPath,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: false,
	});

	proc.stdout?.on('data', (data: Buffer) => {
		const text = data.toString().trim();
		if (text) outputChannel.appendLine(`[Standalone] ${text}`);
	});
	proc.stderr?.on('data', (data: Buffer) => {
		const text = data.toString().trim();
		if (text) outputChannel.appendLine(`[Standalone:err] ${text}`);
	});

	proc.on('exit', (code) => {
		outputChannel.appendLine(`[Standalone] Server exited (code=${code})`);
		if (serverProcess === proc) {
			serverProcess = null;
			// Don't clear activePort — the health check will try to restart
		}
	});

	const ready = await waitForReady(port, STANDALONE_READY_TIMEOUT_MS);
	if (!ready) {
		outputChannel.appendLine(`[Standalone] Server did not become ready within ${STANDALONE_READY_TIMEOUT_MS}ms`);
		proc.kill();
		return null;
	}

	outputChannel.appendLine(`[Standalone] Server ready on port ${port}`);
	return proc;
}

/**
 * Start the standalone server as a child process.
 * If the port is already in use (e.g., another VS Code window started it),
 * we reuse that server instead of starting a new one.
 * A periodic health check ensures the server stays available — if another
 * window that originally started the server shuts down, this window will
 * automatically restart it.
 *
 * Returns the port number the server is available on.
 */
export async function startStandaloneServer(
	extensionPath: string,
	outputChannel: vscode.OutputChannel,
	port?: number,
): Promise<number> {
	const targetPort = port ?? STANDALONE_DEFAULT_PORT;
	extensionPathCache = extensionPath;
	outputChannelRef = outputChannel;

	// Check if a server is already running on this port
	const alreadyRunning = await isPortReady(targetPort);
	if (alreadyRunning) {
		outputChannel.appendLine(`[Standalone] Server already running on port ${targetPort} — reusing`);
	} else {
		const proc = await spawnServer(extensionPath, targetPort, outputChannel);
		if (!proc) throw new Error('Standalone server failed to start');
		serverProcess = proc;
	}

	activePort = targetPort;

	// Start periodic health check — restart if the server dies
	// (e.g., another VS Code window that started it was closed)
	if (healthCheckTimer) clearInterval(healthCheckTimer);
	healthCheckTimer = setInterval(async () => {
		if (!activePort || !extensionPathCache || !outputChannelRef) return;
		const alive = await isPortReady(activePort);
		if (!alive) {
			outputChannelRef.appendLine(`[Standalone] Server on port ${activePort} is down — restarting`);
			const proc = await spawnServer(extensionPathCache, activePort, outputChannelRef);
			if (proc) {
				serverProcess = proc;
			} else {
				outputChannelRef.appendLine(`[Standalone] Failed to restart server`);
			}
		}
	}, 5000);

	return targetPort;
}

/**
 * Stop the standalone server if we started it, and stop health checking.
 */
export function stopStandaloneServer(): void {
	if (healthCheckTimer) {
		clearInterval(healthCheckTimer);
		healthCheckTimer = null;
	}
	if (serverProcess) {
		serverProcess.kill();
		serverProcess = null;
	}
	activePort = null;
	extensionPathCache = null;
	outputChannelRef = null;
}

/**
 * Restart the standalone server (kill + respawn).
 * Preserves the existing port and health check.
 */
export async function restartStandaloneServer(): Promise<void> {
	if (!extensionPathCache || !outputChannelRef || !activePort) {
		throw new Error('Standalone server was never started');
	}
	outputChannelRef.appendLine(`[Standalone] Restarting server...`);
	if (serverProcess) {
		serverProcess.kill();
		serverProcess = null;
	}
	const proc = await spawnServer(extensionPathCache, activePort, outputChannelRef);
	if (!proc) throw new Error('Standalone server failed to restart');
	serverProcess = proc;
	outputChannelRef.appendLine(`[Standalone] Server restarted on port ${activePort}`);
}

/**
 * Get the port the standalone server is running on (or null if not started).
 */
export function getStandalonePort(): number | null {
	return activePort;
}
