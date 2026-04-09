import * as vscode from 'vscode';
import { PixelAgentsBackend } from './PixelAgentsViewProvider.js';
import { startStandaloneServer, stopStandaloneServer, restartStandaloneServer, getStandalonePort } from './standaloneServer.js';
import { COMMAND_EXPORT_DEFAULT_LAYOUT, COMMAND_OPEN_IN_TAB, COMMAND_SET_PROJECT_NAME, COMMAND_SHOW_MISSING_SPRITES, COMMAND_RESTART_STANDALONE, STANDALONE_DEFAULT_PORT } from './constants.js';
import { getMissingBubbleSpriteTools, clearMissingBubbleSpriteTools } from './transcriptParser.js';

let backend: PixelAgentsBackend | undefined;

export async function activate(context: vscode.ExtensionContext) {
	// Start backend (agent tracking, file watching, sync file writing)
	backend = new PixelAgentsBackend(context);
	backend.init();

	const outputChannel = vscode.window.createOutputChannel('Pixel Agents — Standalone');
	context.subscriptions.push(outputChannel);

	// Auto-start the standalone server
	const port = vscode.workspace.getConfiguration('pixel-agents').get<number>('standalonePort', STANDALONE_DEFAULT_PORT);
	try {
		await startStandaloneServer(context.extensionUri.fsPath, outputChannel, port);
	} catch (err) {
		outputChannel.appendLine(`[Extension] Failed to start standalone server: ${err}`);
		vscode.window.showWarningMessage(`Pixel Agents: Could not start standalone server — ${err}`);
	}

	// Command: Open standalone viewer in a VS Code editor tab
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMAND_OPEN_IN_TAB, () => {
			const serverPort = getStandalonePort() ?? port;
			const url = `http://localhost:${serverPort}`;
			vscode.commands.executeCommand('simpleBrowser.show', url);
		})
	);

	// Command: Set project name via input box
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMAND_SET_PROJECT_NAME, async () => {
			const config = vscode.workspace.getConfiguration('pixel-agents');
			const current = config.get<string>('projectName', '');
			const folderName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';
			const value = await vscode.window.showInputBox({
				title: 'Set Project Name',
				prompt: 'Custom name displayed on agent nametags. Leave empty to use the workspace folder name.',
				value: current || folderName,
				placeHolder: folderName,
			});
			if (value === undefined) return; // cancelled
			await config.update('projectName', value || undefined, vscode.ConfigurationTarget.Workspace);
			backend?.refreshProjectName();
		})
	);

	// Command: Export layout as default (dev utility)
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMAND_EXPORT_DEFAULT_LAYOUT, () => {
			backend?.exportDefaultLayout();
		})
	);

	// Command: Restart standalone server (picks up new builds)
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMAND_RESTART_STANDALONE, async () => {
			try {
				await restartStandaloneServer();
				vscode.window.showInformationMessage('Pixel Agents: Standalone server restarted. Refresh your browser.');
			} catch (err) {
				vscode.window.showErrorMessage(`Pixel Agents: Failed to restart standalone server — ${err}`);
			}
		})
	);

	// Command: Show tools missing bubble sprites
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMAND_SHOW_MISSING_SPRITES, async () => {
			const missing = getMissingBubbleSpriteTools();
			if (missing.length === 0) {
				vscode.window.showInformationMessage('Pixel Agents: No missing bubble sprites detected yet.');
				return;
			}
			const lines = missing.map(({ tool, firstSeen }) =>
				`${tool}  (first seen: ${firstSeen.toLocaleDateString()} ${firstSeen.toLocaleTimeString()})`
			);
			const panel = vscode.window.createOutputChannel('Pixel Agents — Missing Sprites');
			panel.clear();
			panel.appendLine(`Missing bubble sprites (${missing.length} tools):`);
			panel.appendLine('─'.repeat(40));
			for (const line of lines) panel.appendLine(`  • ${line}`);
			panel.appendLine('');
			panel.appendLine('Add sprites for these tools in webview-ui/src/office/sprites/spriteData.ts');
			panel.appendLine('→ TOOL_BUBBLE_SPRITES record');
			panel.show();

			const choice = await vscode.window.showInformationMessage(
				`${missing.length} tools missing bubble sprites.`,
				'Clear List',
			);
			if (choice === 'Clear List') {
				clearMissingBubbleSpriteTools();
				panel.appendLine('');
				panel.appendLine('(List cleared)');
				vscode.window.showInformationMessage('Pixel Agents: Missing sprites list cleared.');
			}
		})
	);

}

export function deactivate() {
	backend?.dispose();
	stopStandaloneServer();
}
