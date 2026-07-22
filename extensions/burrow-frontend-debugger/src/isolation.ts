/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';

// Component-isolation workbench (the Framer-like view). Opens the component's
// REAL source in an editor column (left) and an isolated live preview in a
// webview beside it (right). The preview iframes the target Vite's `__isolate`
// harness (see tools/frontend-debugger/server/inspectorPlugin.js), which mounts
// ONE component alone with a minimal provider shell. Editing the real file →
// save → Vite Fast Refresh → the preview re-renders. Props are editable in the
// preview toolbar and pushed to the harness over postMessage.

/** Where the running sidecar's target dev server lives + the fs allowlist anchor. */
export interface IsolateTarget {
	readonly targetOrigin: string;   // http://127.0.0.1:<targetPort>
	readonly targetBase: string;     // e.g. /watch/app/
	readonly targetDir: string;      // target frontend root (allowlist anchor)
}

/** A request to isolate a component: a file (abs or target-relative), an
 *  optional preferred export, and optional seed props (from a live capture). */
export interface IsolateArgs {
	readonly file: string;
	readonly export?: string;
	readonly props?: unknown;
}

interface IsolateEnvelope {
	readonly __burrowIso?: number;
	readonly type?: string;
	readonly detail?: string | string[];
}

let preview: vscode.WebviewPanel | undefined;

// Sample prop-set names for the CURRENTLY-isolated component, reported by the
// harness (`<Component>.samples`). Reset on each isolation; the native picker
// (pickSample) reads them and applies a choice over postMessage.
let sampleNames: string[] = [];

/**
 * Reveal the component's source on the left and an isolated preview on the
 * right. Reuses the single preview panel across calls (re-pointing it at the
 * new component). No-ops with a warning if the file is not under the target's
 * `src/` (the isolation harness only serves modules from there).
 */
export async function openIsolation(context: vscode.ExtensionContext, target: IsolateTarget, args: IsolateArgs): Promise<void> {
	const rel = resolveSrcRel(target.targetDir, args.file);
	if (!rel) {
		void vscode.window.showWarningMessage('Frontend Debugger: can only isolate components under the target\'s src/ folder.');
		return;
	}

	// Left: the real editor. Keeps focus so you can start editing immediately.
	try {
		const doc = await vscode.workspace.openTextDocument(path.join(target.targetDir, rel));
		await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
	} catch (err) {
		void vscode.window.showWarningMessage(`Frontend Debugger: cannot open ${rel} — ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	// Framer-mode "design" layout: source slim on the left, the live canvas wider
	// on the right (no manual dragging, no leftover groups). Best-effort — a
	// projects that can't set the layout still gets the two columns above.
	try {
		await vscode.commands.executeCommand('vscode.setEditorLayout', {
			orientation: 0,
			groups: [{ size: 0.42 }, { size: 0.58 }],
		});
	} catch {
		// layout is a nicety, not a requirement
	}

	// Right: the isolated preview webview.
	const props = sanitizeProps(args.props);
	const url = buildIsolateUrl(target, rel, args.export, props);
	const label = args.export || defaultLabel(rel);

	// New component → the previous component's sample names no longer apply. The
	// harness re-reports `samples` for this one as it loads.
	sampleNames = [];

	if (!preview) {
		preview = vscode.window.createWebviewPanel(
			'burrow.frontendIsolation',
			`Preview — ${label}`,
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		preview.onDidDispose(() => { preview = undefined; sampleNames = []; }, undefined, context.subscriptions);
		preview.webview.onDidReceiveMessage((msg: IsolateEnvelope) => handleEnvelope(msg, label), undefined, context.subscriptions);
	} else {
		preview.title = `Preview — ${label}`;
		preview.reveal(vscode.ViewColumn.Beside, true);
		preview.webview.onDidReceiveMessage((msg: IsolateEnvelope) => handleEnvelope(msg, label), undefined, context.subscriptions);
	}
	preview.webview.html = buildPreviewHtml(target.targetOrigin, url);
}

/**
 * Native sample-props picker (Framer-mode T4). Shows the sample names the
 * harness reported for the isolated component and applies the chosen one live
 * (`{__burrowIsoCmd:1,type:'sample',name}` → harness re-renders with those
 * props). No-ops with a hint when nothing is isolated or the component has no
 * colocated `<Component>.samples.*` file.
 */
export async function pickSample(): Promise<void> {
	if (!preview) {
		void vscode.window.showInformationMessage('Frontend Debugger: isolate a component first (its preview must be open).');
		return;
	}
	if (!sampleNames.length) {
		void vscode.window.showInformationMessage('Frontend Debugger: this component has no colocated <Component>.samples.* file.');
		return;
	}
	const name = await vscode.window.showQuickPick(sampleNames, { placeHolder: 'Apply a sample prop-set to the preview' });
	if (!name) {
		return;
	}
	void preview.webview.postMessage({ __burrowIsoCmd: 1, type: 'sample', name });
}

function handleEnvelope(msg: IsolateEnvelope, label: string): void {
	if (!msg || msg.__burrowIso !== 1) {
		return;
	}
	if (msg.type === 'samples' && Array.isArray(msg.detail)) {
		// The harness found a colocated <Component>.samples.* — cache the names for
		// the native picker (pickSample).
		sampleNames = msg.detail.filter((n): n is string => typeof n === 'string');
		return;
	}
	if (msg.type === 'renderError' && typeof msg.detail === 'string') {
		// Surface once — the preview already shows the stack inline; this makes a
		// silently-broken component obvious without staring at the canvas.
		void vscode.window.setStatusBarMessage(`Isolation: ${label} render error`, 4000);
	}
}

/** Resolve a caller path to a target-relative `src/…` path, or undefined if it
 *  escapes the target's src/ (mirrors the sidecar's api.js safe()). */
function resolveSrcRel(targetDir: string, file: string): string | undefined {
	if (!file || !targetDir) {
		return undefined;
	}
	const abs = path.isAbsolute(file) ? file : path.resolve(targetDir, file);
	const srcRoot = path.join(targetDir, 'src');
	if (abs !== srcRoot && !abs.startsWith(srcRoot + path.sep)) {
		return undefined;
	}
	return path.relative(targetDir, abs).split(path.sep).join('/');
}

/** Drop the in-page agent's opaque prop placeholders (functions → "ƒ name",
 *  React elements/containers → "«…»") so a seeded props object is JSON-safe. */
function sanitizeProps(raw: unknown): Record<string, unknown> {
	if (!raw || typeof raw !== 'object') {
		return {};
	}
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === 'string' && (value.startsWith('ƒ ') || value.startsWith('«'))) {
			continue;
		}
		out[key] = value;
	}
	return out;
}

function buildIsolateUrl(target: IsolateTarget, rel: string, exportName: string | undefined, props: Record<string, unknown>): string {
	const base = target.targetBase.endsWith('/') ? target.targetBase : `${target.targetBase}/`;
	const q = new URLSearchParams();
	q.set('module', rel);
	if (exportName) {
		q.set('export', exportName);
	}
	if (Object.keys(props).length) {
		q.set('props', JSON.stringify(props));
	}
	return `${target.targetOrigin}${base}__isolate?${q.toString()}`;
}

function defaultLabel(rel: string): string {
	const base = rel.split('/').pop() || rel;
	return base.replace(/\.[jt]sx?$/, '');
}

/**
 * The preview canvas (Framer-mode T3): a clean, full-bleed iframe pointed at the
 * isolation harness — NO in-webview toolbar clone. Controls (reload, props,
 * samples) live in the native workbench (editor-title command / T4 sample
 * picker), so the surface reads as an editor pane, not a webview widget.
 *
 * The iframe is the target origin (a separate document), so this shim (a) relays
 * the harness's `__burrowIso` ready/renderError envelopes up to the extension
 * and (b) relays native commands (reload/props) FROM the extension DOWN to the
 * harness as `__burrowIsoCmd`.
 */
function buildPreviewHtml(origin: string, isoUrl: string): string {
	const nonce = getNonce();
	const safeUrl = isoUrl.replace(/"/g, '&quot;');
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'">
	<style>
		html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: var(--vscode-editor-background, #1e1e1e); }
		iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
	</style>
</head>
<body>
	<iframe id="frame" src="${safeUrl}" allow="clipboard-read; clipboard-write"></iframe>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const frame = document.getElementById('frame');
		const origin = '${origin}';
		// Native commands (reload/props) arrive from the extension and are relayed
		// down to the harness in the iframe.
		window.addEventListener('message', (e) => {
			const d = e.data;
			if (!d) { return; }
			if (d.__burrowIsoCmd === 1) {
				if (frame.contentWindow) { frame.contentWindow.postMessage(d, '*'); }
				return;
			}
			// The harness's ready/renderError envelopes bubble up to the extension.
			if (e.origin === origin && d.__burrowIso === 1) { vscode.postMessage(d); }
		});
	</script>
</body>
</html>`;
}

/** Relay a native "reload the preview" command down to the harness. No-op if no
 *  preview is open. Used by the `burrow.frontendDebugger.reloadPreview` command. */
export function reloadPreview(): void {
	void preview?.webview.postMessage({ __burrowIsoCmd: 1, type: 'reload' });
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
