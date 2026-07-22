/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { resolveConfig } from './config';
import { openPanel, refreshPanel, setIsolationHandler } from './panel';
import { openIsolation, IsolateArgs, reloadPreview, pickSample } from './isolation';
import { ComponentsProvider } from './gallery';
import { Sidecar } from './sidecar';
import { ModeStatus } from './status';
import { RevealBridge, RevealPayload } from './bridge';
import { runOpenInBrowser, maybeSeedRunCommand } from './launch';

// burrow-frontend-debugger (task 15): hosts the tools/frontend-debugger
// sidecar in an editor WebviewPanel and bridges its reveals into the editor.
// Design: docs/architecture/15-frontend-debugger.md.

let sidecar: Sidecar | undefined;

export function activate(context: vscode.ExtensionContext): void {
	sidecar = new Sidecar();
	const status = new ModeStatus();
	context.subscriptions.push(sidecar, status);

	// Component gallery (T5): a native sidebar tree of the target's components,
	// grouped by folder; clicking one isolates it. srcRoot follows config, so it
	// tracks the selected target without a restart.
	const components = new ComponentsProvider(() => {
		const cfg = resolveConfig(context);
		return cfg.targetDir ? path.join(cfg.targetDir, 'src') : undefined;
	});
	context.subscriptions.push(vscode.window.createTreeView('burrowComponents', { treeDataProvider: components }));

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
	// Framer-mode T2 — the browser surface. A local reveal bridge receives
	// ⌥-click picks from the instrumented app running in the REAL browser and
	// opens the authored source in the editor (plain reveal until T3's Framer
	// editor exists). Started lazily on first "Open in Browser".
	const bridge = new RevealBridge();
	context.subscriptions.push(bridge);
	let bridgeStarted = false;

	const revealSource = async (p: RevealPayload): Promise<void> => {
		const cfg = resolveConfig(context);
		const abs = path.isAbsolute(p.file) ? p.file : path.join(cfg.targetDir, p.file);
		try {
			const doc = await vscode.workspace.openTextDocument(abs);
			const pos = new vscode.Position(Math.max(0, p.line - 1), Math.max(0, p.col - 1));
			await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: false });
		} catch {
			void vscode.window.showWarningMessage(`Frontend Debugger: couldn't reveal ${p.file}`);
		}
	};

	const openInBrowser = async (): Promise<void> => {
		if (!bridgeStarted) {
			try {
				await bridge.start(revealSource);
				bridgeStarted = true;
			} catch {
				void vscode.window.showWarningMessage(
					`Frontend Debugger: reveal bridge port ${bridge.port} is busy — ⌥-click reveal is off this session.`,
				);
			}
		}
		await maybeSeedRunCommand(context);
		try {
			await runOpenInBrowser(context, sidecar!);
		} catch (err) {
			sidecar!.out.show(true);
			void vscode.window.showErrorMessage(`Frontend Debugger: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	// `source` is one of: an inspector host envelope (IsolateArgs), the
	// editor-title button's editor Uri, or undefined (command palette). The
	// button passes its editor's Uri so it isolates THAT file regardless of where
	// keyboard focus sits — `activeTextEditor` is undefined whenever focus is in a
	// terminal, the sidebar, another group, or the window isn't the OS key window.
	// Only the palette (no arg) falls back to the active editor.
	const isolate = async (source?: IsolateArgs | vscode.Uri): Promise<void> => {
		const cfg = resolveConfig(context);
		try {
			await sidecar!.start(cfg);
		} catch (err) {
			sidecar!.out.show(true);
			void vscode.window.showErrorMessage(`Frontend Debugger: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		let args = source instanceof vscode.Uri ? { file: source.fsPath } : source;
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
		vscode.commands.registerCommand('burrow.frontendDebugger.openInBrowser', openInBrowser),
		vscode.commands.registerCommand('burrow.frontendDebugger.isolate', (uri?: vscode.Uri) => isolate(uri)),
		vscode.commands.registerCommand('burrow.frontendDebugger.reloadPreview', () => reloadPreview()),
		vscode.commands.registerCommand('burrow.frontendDebugger.pickSample', () => pickSample()),
		vscode.commands.registerCommand('burrow.frontendDebugger.refreshComponents', () => components.refresh()),
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
