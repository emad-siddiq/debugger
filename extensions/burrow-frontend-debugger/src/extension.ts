/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { resolveConfig } from './config';
import { openPanel, refreshPanel, setIsolationHandler } from './panel';
import { openIsolation, IsolateArgs } from './isolation';
import { Sidecar } from './sidecar';
import { ModeStatus } from './status';

// burrow-frontend-debugger (task 15): hosts the tools/frontend-debugger
// sidecar in an editor WebviewPanel and bridges its reveals into the editor.
// Design: docs/architecture/15-frontend-debugger.md.

let sidecar: Sidecar | undefined;

export function activate(context: vscode.ExtensionContext): void {
	sidecar = new Sidecar();
	const status = new ModeStatus();
	context.subscriptions.push(sidecar, status);

	const open = async (): Promise<void> => {
		const cfg = resolveConfig(context);
		try {
			const uiPort = await sidecar!.start(cfg);
			openPanel(context, uiPort, cfg.targetDir);
			status.show(uiPort);
		} catch (err) {
			sidecar!.out.show(true);
			void vscode.window.showErrorMessage(`Frontend Debugger: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	// Open the component-isolation workbench: the component's real source on the
	// left, its isolated live preview beside it. Ensures the sidecar (and thus
	// the target Vite that serves the isolation harness) is running first.
	// Triggered by the command (isolates the active editor's file) or by the
	// inspector's "Isolate" button (a host envelope carrying file/export/props).
	const isolate = async (hostArgs?: IsolateArgs): Promise<void> => {
		const cfg = resolveConfig(context);
		try {
			await sidecar!.start(cfg);
		} catch (err) {
			sidecar!.out.show(true);
			void vscode.window.showErrorMessage(`Frontend Debugger: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		let args = hostArgs;
		if (!args) {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				void vscode.window.showWarningMessage('Frontend Debugger: open a component file to isolate it.');
				return;
			}
			args = { file: editor.document.uri.fsPath };
		}
		const targetOrigin = `http://127.0.0.1:${sidecar!.targetPort || cfg.targetPort}`;
		await openIsolation(context, { targetOrigin, targetBase: cfg.targetBase, targetDir: cfg.targetDir }, args);
	};
	setIsolationHandler((a) => void isolate(a));

	const restart = async (): Promise<void> => {
		const cfg = resolveConfig(context);
		await sidecar!.stop();
		status.hide();
		try {
			const uiPort = await sidecar!.start(cfg);
			refreshPanel(uiPort, cfg.targetDir);
			openPanel(context, uiPort, cfg.targetDir);
			status.show(uiPort);
		} catch (err) {
			sidecar!.out.show(true);
			void vscode.window.showErrorMessage(`Frontend Debugger: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('burrow.frontendDebugger.open', open),
		vscode.commands.registerCommand('burrow.frontendDebugger.isolate', () => isolate()),
		vscode.commands.registerCommand('burrow.frontendDebugger.restart', restart),
		vscode.commands.registerCommand('burrow.frontendDebugger.toggleMode', () => status.toggle()),
		vscode.commands.registerCommand('burrow.frontendDebugger.stop', () => {
			void sidecar!.stop();
			status.hide();
		}),
		vscode.commands.registerCommand('burrow.frontendDebugger.showLogs', () => sidecar!.out.show(true)),
	);
}

export function deactivate(): void {
	void sidecar?.stop();
}
