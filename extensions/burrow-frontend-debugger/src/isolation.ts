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
	readonly detail?: string;
}

let preview: vscode.WebviewPanel | undefined;

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

	// Right: the isolated preview webview.
	const props = sanitizeProps(args.props);
	const url = buildIsolateUrl(target, rel, args.export, props);
	const label = args.export || defaultLabel(rel);

	if (!preview) {
		preview = vscode.window.createWebviewPanel(
			'burrow.frontendIsolation',
			`Preview — ${label}`,
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		preview.onDidDispose(() => { preview = undefined; }, undefined, context.subscriptions);
		preview.webview.onDidReceiveMessage((msg: IsolateEnvelope) => handleEnvelope(msg, label), undefined, context.subscriptions);
	} else {
		preview.title = `Preview — ${label}`;
		preview.reveal(vscode.ViewColumn.Beside, true);
		preview.webview.onDidReceiveMessage((msg: IsolateEnvelope) => handleEnvelope(msg, label), undefined, context.subscriptions);
	}
	preview.webview.html = buildPreviewHtml(target.targetOrigin, url, label, rel, props);
}

function handleEnvelope(msg: IsolateEnvelope, label: string): void {
	if (!msg || msg.__burrowIso !== 1) {
		return;
	}
	if (msg.type === 'renderError' && msg.detail) {
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
 * The preview shim: a slim toolbar (component name, Reload, editable props)
 * above an iframe pointed at the isolation harness. The iframe is the target
 * origin (a separate document), so the shim relays the harness's `__burrowIso`
 * envelopes to the extension and pushes prop edits down with `__burrowIsoCmd`.
 */
function buildPreviewHtml(origin: string, isoUrl: string, label: string, rel: string, props: Record<string, unknown>): string {
	const nonce = getNonce();
	const propsJson = JSON.stringify(props, null, 2).replace(/</g, '\\u003c');
	const safeUrl = isoUrl.replace(/"/g, '&quot;');
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'">
	<style>
		html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-foreground, #ccc); font: 12px var(--vscode-font-family, sans-serif); }
		.bar { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, #333); }
		.bar .name { font-weight: 600; }
		.bar .file { opacity: .6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
		.bar button { font: inherit; color: inherit; background: var(--vscode-button-secondaryBackground, #3a3d41); border: 0; border-radius: 4px; padding: 2px 8px; cursor: pointer; }
		.bar button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
		.props { display: none; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, #333); }
		.props.open { display: block; }
		.props textarea { width: 100%; box-sizing: border-box; height: 96px; resize: vertical; font: 11px var(--vscode-editor-font-family, monospace); color: var(--vscode-input-foreground, #ccc); background: var(--vscode-input-background, #1e1e1e); border: 1px solid var(--vscode-input-border, #333); border-radius: 4px; }
		.props .row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
		.props .err { color: var(--vscode-errorForeground, #f48771); }
		iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
		.wrap { position: absolute; inset: 0; display: flex; flex-direction: column; }
		.stage { flex: 1; min-height: 0; }
	</style>
</head>
<body>
	<div class="wrap">
		<div class="bar">
			<span class="name">${label}</span>
			<span class="file">${rel}</span>
			<button id="propsBtn" title="Edit the props passed to the isolated component">Props</button>
			<button id="reloadBtn" title="Reload the preview">Reload</button>
		</div>
		<div class="props" id="propsPanel">
			<textarea id="propsText" spellcheck="false">${propsJson}</textarea>
			<div class="row"><button id="applyBtn">Apply</button><span class="err" id="propsErr"></span></div>
		</div>
		<div class="stage"><iframe id="frame" src="${safeUrl}" allow="clipboard-read; clipboard-write"></iframe></div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const frame = document.getElementById('frame');
		const origin = '${origin}';
		document.getElementById('propsBtn').addEventListener('click', () => document.getElementById('propsPanel').classList.toggle('open'));
		document.getElementById('reloadBtn').addEventListener('click', () => {
			if (frame.contentWindow) { frame.contentWindow.postMessage({ __burrowIsoCmd: 1, type: 'reload' }, '*'); }
		});
		document.getElementById('applyBtn').addEventListener('click', () => {
			const err = document.getElementById('propsErr');
			let parsed;
			try { parsed = JSON.parse(document.getElementById('propsText').value || '{}'); }
			catch (e) { err.textContent = 'Invalid JSON: ' + e.message; return; }
			err.textContent = '';
			if (frame.contentWindow) { frame.contentWindow.postMessage({ __burrowIsoCmd: 1, type: 'props', props: parsed }, '*'); }
		});
		// Relay the harness's ready/renderError envelopes up to the extension.
		window.addEventListener('message', (e) => {
			if (e.origin !== origin) { return; }
			const d = e.data;
			if (d && d.__burrowIso === 1) { vscode.postMessage(d); }
		});
	</script>
</body>
</html>`;
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
