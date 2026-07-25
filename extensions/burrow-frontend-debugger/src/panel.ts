/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';

// The panel iframes the sidecar SPA by its full loopback origin (never
// asExternalUri — a code-server-era rewrite that targets the wrong host). The
// SPA detects the embed via ?embed=burrow (ui/src/host.ts) and posts
// __fedbgHost envelopes to window.parent; the nonce'd shim below relays them
// to the extension. Two message types: openSource (reveal file:line:col in
// the editor) and setFullScreen (maximize/restore the editor group).

interface HostMessage {
	readonly type?: string;
	readonly file?: string;
	readonly line?: number;
	readonly col?: number;
	readonly on?: boolean;
	readonly export?: string;
	readonly props?: unknown;
	readonly name?: string | null;
	readonly choices?: readonly RouteChoice[];
}

/** One candidate route for a Show-in-App disambiguation QuickPick. */
export interface RouteChoice {
	readonly path: string;
	readonly label: string;
	readonly name: string | null;
}

/** Set by the extension so the inspector's "Isolate" button (an openIsolation
 *  host envelope) can open the component-isolation workbench. */
type IsolationHandler = (args: { file: string; export?: string; props?: unknown }) => void;
let isolationHandler: IsolationHandler | undefined;
export function setIsolationHandler(fn: IsolationHandler): void { isolationHandler = fn; }

/** Set by the extension: the SPA found SEVERAL routes rendering a Show-in-App
 *  component and asks for a native QuickPick (a `routeChoices` host envelope);
 *  the handler answers by re-posting `showInApp` with the chosen route. */
type RouteChoicesHandler = (args: { file: string; name: string | null; choices: readonly RouteChoice[] }) => void;
let routeChoicesHandler: RouteChoicesHandler | undefined;
export function setRouteChoicesHandler(fn: RouteChoicesHandler): void { routeChoicesHandler = fn; }

let current: vscode.WebviewPanel | undefined;
let targetDir = '';
let maximized = false;

export function openPanel(context: vscode.ExtensionContext, uiPort: number, dir: string): vscode.WebviewPanel {
	targetDir = dir;
	if (current) {
		current.reveal();
		return current;
	}
	const panel = vscode.window.createWebviewPanel(
		'burrow.frontendDebugger',
		'Frontend Debugger',
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	panel.webview.html = buildHtml(uiPort);
	// Option A (recon §8): the whole-app panel reads as "just another tab" at
	// default size — fill the window on open unless the user opts out.
	if (vscode.workspace.getConfiguration('burrow.frontendDebugger').get<boolean>('openMaximized', true)) {
		void setEditorFullScreen(true);
	}
	panel.webview.onDidReceiveMessage((msg: HostMessage) => void handleHostMessage(msg), undefined, context.subscriptions);
	panel.onDidDispose(() => {
		current = undefined;
		if (maximized) {
			void setEditorFullScreen(false); // don't leave the group maximized around a dead panel
		}
	}, undefined, context.subscriptions);
	current = panel;
	return panel;
}

/** Re-point the iframe after a sidecar restart (the port may have changed). */
export function refreshPanel(uiPort: number, dir: string): void {
	targetDir = dir;
	if (current) {
		current.webview.html = buildHtml(uiPort);
	}
}

function buildHtml(uiPort: number): string {
	const origin = `http://127.0.0.1:${uiPort}`;
	const nonce = getNonce();
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'">
	<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#1e1e1e}iframe{display:block;width:100%;height:100%;border:0}</style>
</head>
<body>
	<iframe src="${origin}/?embed=burrow" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const frame = document.querySelector('iframe');
		window.addEventListener('message', (e) => {
			const d = e.data;
			if (!d) { return; }
			// Extension → SPA commands (Show in App): messages from the extension
			// carry the __fedbgCmd envelope and do NOT come from the SPA origin —
			// relay them into the iframe. Never reflected back out (the SPA origin
			// check below only forwards __fedbgHost envelopes upward).
			if (d.__fedbgCmd === 1 && e.origin !== '${origin}') {
				if (frame.contentWindow) { frame.contentWindow.postMessage(d, '${origin}'); }
				return;
			}
			if (e.origin !== '${origin}') { return; }
			if (d.__fedbgHost !== 1 || typeof d.type !== 'string') { return; }
			vscode.postMessage(d);
		});
	</script>
</body>
</html>`;
}

async function handleHostMessage(msg: HostMessage): Promise<void> {
	if (!msg || typeof msg !== 'object') {
		return;
	}
	if (msg.type === 'exitFocus') {
		// Esc bridge (docs/plans/01 §4): the SPA iframe owns the focused document,
		// so the keystroke reaches the workbench only by this route.
		await vscode.commands.executeCommand('burrow.focus.exit');
	} else if (msg.type === 'openSource') {
		await openSource(msg);
	} else if (msg.type === 'setFullScreen') {
		await setEditorFullScreen(!!msg.on);
	} else if (msg.type === 'openIsolation' && typeof msg.file === 'string' && msg.file) {
		isolationHandler?.({ file: msg.file, export: msg.export, props: msg.props });
	} else if (msg.type === 'routeChoices' && typeof msg.file === 'string' && Array.isArray(msg.choices) && msg.choices.length) {
		routeChoicesHandler?.({ file: msg.file, name: typeof msg.name === 'string' ? msg.name : null, choices: msg.choices });
	}
}

/** Forward a command envelope to the embedded SPA (extension → app direction).
 *  The panel shim relays `__fedbgCmd` messages into the SPA iframe; the SPA's
 *  host.ts dispatches them. Returns false when no panel is open. */
export function postToApp(msg: Record<string, unknown>): boolean {
	if (!current) {
		return false;
	}
	void current.webview.postMessage({ __fedbgCmd: 1, ...msg });
	return true;
}

async function openSource(msg: HostMessage): Promise<void> {
	// Mirror the sidecar's own path allowlist (server/api.js safe()): the file
	// must resolve inside the target frontend, no absolutes, no escapes.
	if (typeof msg.file !== 'string' || !msg.file || path.isAbsolute(msg.file) || !targetDir) {
		return;
	}
	const abs = path.resolve(targetDir, msg.file);
	if (abs !== targetDir && !abs.startsWith(targetDir + path.sep)) {
		return;
	}
	try {
		const doc = await vscode.workspace.openTextDocument(abs);
		const line = Math.min(Math.max(0, Math.floor(Number(msg.line) || 1) - 1), doc.lineCount - 1);
		const col = Math.max(0, Math.floor(Number(msg.col) || 1) - 1);
		const pos = new vscode.Position(line, col);
		await vscode.window.showTextDocument(doc, {
			viewColumn: vscode.ViewColumn.Beside,
			selection: new vscode.Range(pos, pos),
		});
	} catch (err) {
		void vscode.window.showWarningMessage(`Frontend Debugger: cannot open ${msg.file} — ${err instanceof Error ? err.message : String(err)}`);
	}
}

export async function setEditorFullScreen(on: boolean): Promise<void> {
	if (on === maximized) {
		return;
	}
	maximized = on;
	if (on) {
		// Hides the side bar + auxiliary bar and maximizes the group when
		// several exist; the panel is closed separately.
		await vscode.commands.executeCommand('workbench.action.maximizeEditorHideSidebar');
		await vscode.commands.executeCommand('workbench.action.closePanel');
	} else if (vscode.window.tabGroups.all.length > 1) {
		// Only unmaximize when a maximize could have happened (toggle is not
		// precondition-guarded through executeCommand). The side bars stay
		// hidden — the workbench exposes no visibility query to restore them.
		await vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup');
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
