/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { resolveConfig } from './config';
import { openPanel, refreshPanel, postToApp, setIsolationHandler, setRouteChoicesHandler } from './panel';
import { openIsolation, IsolateArgs, reloadPreview, saveSample, currentIsolation, currentIsolationFile } from './isolation';
import { ComponentsProvider } from './gallery';
import { Sidecar, sidecarPhase } from './sidecar';
import { announceOnVisible, claimSurface } from './toolSurface';
import { ModeStatus } from './status';
import { RevealBridge, RevealPayload } from './bridge';
import { runOpenInBrowser, maybeSeedRunCommand } from './launch';

// burrow-frontend-debugger (task 15): hosts the tools/frontend-debugger
// sidecar in an editor WebviewPanel and bridges its reveals into the editor.
// Design: docs/architecture/15-frontend-debugger.md.

let sidecar: Sidecar | undefined;

/** What this extension lets OTHER extensions read (burrow-agent's context
 *  envelope, docs/plans/03 §3). Read-only and additive: a caller that is not
 *  running, or a Burrow build without the agent, notices nothing. */
export interface FrontendDebuggerApi {
	/** The component on the isolation canvas right now, if any. */
	readonly isolation: () => { file: string; label: string; props?: Record<string, unknown> } | undefined;
	/** Whether the dev sidecar is up, and on which port — the Run view's
	 *  Frontend tier reads this instead of probing a port it does not own. */
	readonly sidecar: () => { phase: 'stopped' | 'starting' | 'running'; uiPort: number; targetUrl?: string };
}

export function activate(context: vscode.ExtensionContext): FrontendDebuggerApi {
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
	const componentsView = vscode.window.createTreeView('burrowComponents', { treeDataProvider: components });
	context.subscriptions.push(
		componentsView,
		// Tool-surface isolation (docs/plans/02 §6): the Components tool owns the
		// app panel and the isolation preview, and neither should outlive it.
		announceOnVisible('components', componentsView),
		claimSurface('components', { viewType: 'burrow.frontendDebugger' }),
		claimSurface('components', { viewType: 'burrow.frontendIsolation' }),
	);

	// Revealing the Components view warm-starts the sidecar in the background so
	// the first isolate/open click lands on a running dev server. Best-effort:
	// failures log to the output channel (a modal would punish a passive sidebar
	// click), and one attempt per window — the explicit commands are the retry.
	let warmTried = false;
	componentsView.onDidChangeVisibility((e) => {
		if (!e.visible || warmTried || sidecar!.running) {
			return;
		}
		if (!vscode.workspace.getConfiguration('burrow.frontendDebugger').get<boolean>('autoStartOnComponentsView', true)) {
			return;
		}
		warmTried = true;
		const cfg = resolveConfig(context);
		sidecar!.start(cfg).then(
			(uiPort) => status.show(uiPort),
			(err) => sidecar!.out.appendLine(`[fedbg] warm start failed: ${err instanceof Error ? err.message : String(err)}`),
		);
	}, undefined, context.subscriptions);

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
		// targetBase comes from the sidecar, not settings — an attached sidecar may
		// serve the target under a different base than this window's config.
		await openIsolation(context, { targetOrigin, targetBase: sidecar!.targetBase, targetDir: cfg.targetDir, uiPort: sidecar!.uiPort }, args);
	};
	setIsolationHandler((a) => void isolate(a));

	// "Show in App": reveal a component in the LIVE app — from the Components
	// tree (inline eye, passes the tree node), the isolation preview's title bar
	// (no argument → the currently-isolated file), or the palette (active
	// editor). Ensures the panel is open, then hands the frontendDir-relative
	// path to the SPA, which locates the instance (navigating first when the
	// component's route isn't the current one — see ui/src/showInApp.ts).
	const lastRouteKey = (rel: string) => `fedbg.lastRoute:${rel}`;
	const showInApp = async (source?: vscode.Uri | { kind?: string; abs?: string }): Promise<void> => {
		const cfg = resolveConfig(context);
		let abs: string | undefined;
		if (source instanceof vscode.Uri) {
			abs = source.fsPath;
		} else if (source && typeof source.abs === 'string') {
			abs = source.abs; // a Components-tree node
		} else {
			abs = currentIsolationFile() || vscode.window.activeTextEditor?.document.uri.fsPath;
		}
		if (!abs) {
			void vscode.window.showWarningMessage('Frontend Debugger: open or isolate a component to show it in the app.');
			return;
		}
		const rel = path.relative(cfg.targetDir, abs).split(path.sep).join('/');
		if (rel.startsWith('..') || path.isAbsolute(rel)) {
			void vscode.window.showWarningMessage('Frontend Debugger: the component must live under the target frontend.');
			return;
		}
		const stem = path.basename(abs).replace(/\.[^.]+$/, '');
		try {
			const uiPort = await sidecar!.start(cfg);
			openPanel(context, uiPort, cfg.targetDir);
			status.show(uiPort);
		} catch (err) {
			sidecar!.out.show(true);
			void vscode.window.showErrorMessage(`Frontend Debugger: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		postToApp({
			type: 'showInApp',
			file: rel,
			name: /^[A-Z]/.test(stem) ? stem : null,
			route: context.workspaceState.get<string>(lastRouteKey(rel)) ?? null,
		});
	};

	// The SPA found several routes rendering the component: QuickPick natively,
	// remember the choice per component, and answer with a routed showInApp.
	setRouteChoicesHandler(async ({ file, name, choices }) => {
		const pick = await vscode.window.showQuickPick(
			choices.map((c) => ({ label: c.label || c.path, description: c.path, detail: c.name ? `renders ${c.name}` : undefined, path: c.path })),
			{ placeHolder: `Which route should show ${name || file}?` },
		);
		if (!pick) {
			return;
		}
		await context.workspaceState.update(lastRouteKey(file), pick.path);
		postToApp({ type: 'showInApp', file, name, route: pick.path });
	});

	const restart = async (): Promise<void> => {
		const cfg = resolveConfig(context);
		await sidecar!.stop();
		status.hide();
		try {
			// Restart is the escape hatch from a stale sidecar: never attach, always
			// spawn fresh so the current server code is what actually runs.
			const uiPort = await sidecar!.start(cfg, { forceSpawn: true });
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
		vscode.commands.registerCommand('burrow.frontendDebugger.showInApp', (source?: vscode.Uri | { kind?: string; abs?: string }) => showInApp(source)),
		vscode.commands.registerCommand('burrow.frontendDebugger.reloadPreview', () => reloadPreview()),
		vscode.commands.registerCommand('burrow.frontendDebugger.saveSample', () => saveSample()),
		vscode.commands.registerCommand('burrow.frontendDebugger.refreshComponents', () => components.refresh()),
		vscode.commands.registerCommand('burrow.frontendDebugger.restart', restart),
		vscode.commands.registerCommand('burrow.frontendDebugger.toggleMode', () => status.toggle()),
		vscode.commands.registerCommand('burrow.frontendDebugger.stop', () => {
			void sidecar!.stop();
			status.hide();
		}),
		vscode.commands.registerCommand('burrow.frontendDebugger.showLogs', () => sidecar!.out.show(true)),
	);

	return {
		isolation: () => currentIsolation(),
		sidecar: () => {
			const phase = sidecarPhase();
			// The URL the target app is actually served at — the Full Stack
			// compound points Chrome here instead of guessing a port.
			const base = sidecar!.targetBase.endsWith('/') ? sidecar!.targetBase : `${sidecar!.targetBase}/`;
			return sidecar!.targetPort
				? { ...phase, targetUrl: `http://localhost:${sidecar!.targetPort}${base}` }
				: phase;
		},
	};
}

export function deactivate(): void {
	void sidecar?.stop();
}
