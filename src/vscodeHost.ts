import * as vscode from 'vscode';
import type { Host, KeyValueStore, RelaySettings, TerminalHandle, WorkspaceFolder } from './host.js';
import type { PixelAgentsBackend } from './PixelAgentsViewProvider.js';

/** Host implementation backed by the VS Code extension API. */
export function createVsCodeHost(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel): Host {
	const workspaceState: KeyValueStore = {
		get<T>(key: string, defaultValue?: T): T | undefined {
			return context.workspaceState.get<T>(key, defaultValue as T);
		},
		update(key: string, value: unknown): void {
			context.workspaceState.update(key, value);
		},
	};

	return {
		discovery: () => 'terminals' as const,
		workspaceFolders(): WorkspaceFolder[] {
			return (vscode.workspace.workspaceFolders ?? []).map(f => ({ path: f.uri.fsPath, name: f.name }));
		},
		customProjectName(): string {
			return vscode.workspace.getConfiguration('pixel-agents').get<string>('projectName', '');
		},
		relaySettings(): RelaySettings {
			const config = vscode.workspace.getConfiguration('pixel-agents');
			return {
				url: config.get<string>('relayUrl', ''),
				token: config.get<string>('relayToken', ''),
			};
		},
		terminals(): readonly TerminalHandle[] {
			return vscode.window.terminals;
		},
		activeTerminal(): TerminalHandle | null {
			return vscode.window.activeTerminal ?? null;
		},
		headlessAdoptLimit(): number | null {
			return null;
		},
		workspaceState,
		log(msg: string): void {
			outputChannel.appendLine(msg);
		},
	};
}

/** Forward VS Code terminal events to the backend. Returns disposables for context.subscriptions. */
export function wireTerminalEvents(backend: PixelAgentsBackend): vscode.Disposable[] {
	return [
		vscode.window.onDidChangeActiveTerminal((terminal) => backend.onActiveTerminalChanged(terminal ?? null)),
		vscode.window.onDidCloseTerminal((terminal) => backend.onTerminalClosed(terminal)),
	];
}
