/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { hasSamples } from './gallery';
import { parsePropsSchema, parsePropsSkeleton, preferredExport, PropSpec } from './propsSkeleton';
import { makeTypeResolver } from './typeResolver';

// Component-isolation workbench (the Framer-like view). Opens the component's
// REAL source in an editor column (left) and an isolated live preview in a
// webview beside it (right). The preview iframes the target Vite's `__isolate`
// harness (see tools/frontend-debugger/server/inspectorPlugin.js), which mounts
// ONE component alone with a minimal provider shell. Editing the real file →
// save → Vite Fast Refresh → the preview re-renders. Props flow natively: a
// required-props SKELETON (parsed from the component's props type) seeds the
// first render, the harness mirrors its live props up after every render, and
// the Edit Props command (editProps) pushes changes back over postMessage.

/** Where the running sidecar's target dev server lives + the fs allowlist anchor. */
export interface IsolateTarget {
	readonly targetOrigin: string;   // http://127.0.0.1:<targetPort>
	readonly targetBase: string;     // e.g. /watch/app/
	readonly targetDir: string;      // target frontend root (allowlist anchor)
	readonly uiPort: number;         // sidecar UI/API port (samples write-back)
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
	readonly detail?: string | string[] | Record<string, unknown>;
}

let preview: vscode.WebviewPanel | undefined;

// State for the CURRENTLY-isolated component, reset on each isolation:
// sample prop-set names reported by the harness (the pickSample picker),
// the live props the harness mirrors up after every render (the editProps
// seed), the absolute source path (skeleton re-parses), and the label the
// envelope handler uses (module-level so the ONE panel listener — registered
// at creation only — always names the current component, not a stale one).
let sampleNames: string[] = [];
let currentProps: Record<string, unknown> | undefined;
let currentFile: string | undefined;
let currentTargetDir: string | undefined;
let currentUiPort = 0;
let currentLabel = '';

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

	const abs = path.join(target.targetDir, rel);

	// Left: the real editor. Keeps focus so you can start editing immediately.
	try {
		const doc = await vscode.workspace.openTextDocument(abs);
		await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
	} catch (err) {
		void vscode.window.showWarningMessage(`Frontend Debugger: cannot open ${rel} — ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	// Framer-mode "design" layout: source slim on the left, the live canvas wider
	// on the right. When the component has a colocated stylesheet, the left
	// column splits into source (top) | CSS (bottom) so markup, styles, and the
	// live component are all on one screen. Best-effort — a project that can't
	// set the layout still gets the plain columns.
	const cssAbs = findColocatedCss(abs);
	try {
		await vscode.commands.executeCommand('vscode.setEditorLayout', cssAbs
			? { orientation: 0, groups: [{ groups: [{ size: 0.62 }, { size: 0.38 }], size: 0.42 }, { size: 0.58 }] }
			: { orientation: 0, groups: [{ size: 0.42 }, { size: 0.58 }] });
	} catch {
		// layout is a nicety, not a requirement
	}
	if (cssAbs) {
		try {
			const cssDoc = await vscode.workspace.openTextDocument(cssAbs);
			await vscode.window.showTextDocument(cssDoc, { viewColumn: vscode.ViewColumn.Two, preview: false, preserveFocus: true });
		} catch {
			// the stylesheet row is optional
		}
	}

	// Option B (recon §8): a dedicated design mode — hide the side bars and the
	// bottom panel so source | canvas fill the window, Framer-style. Both
	// columns stay visible (no group maximize). Best-effort and setting-gated;
	// Cmd+B / Cmd+J bring the chrome back (the workbench exposes no visibility
	// query to restore it automatically on close).
	if (vscode.workspace.getConfiguration('burrow.frontendDebugger').get<boolean>('designLayout', true)) {
		for (const command of ['workbench.action.closeSidebar', 'workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel']) {
			try {
				await vscode.commands.executeCommand(command);
			} catch {
				// chrome-hiding is cosmetic — never block the isolation itself
			}
		}
	}

	// Right: the isolated preview webview.
	const stem = defaultLabel(rel);
	let source: string | undefined;
	try {
		source = fs.readFileSync(abs, 'utf8');
	} catch {
		source = undefined;
	}
	// A gallery click carries no export. When the file has a basename-matching
	// named export and no default, name it explicitly — the harness's fallback
	// (first PascalCase export) can pick the wrong one in a multi-export file.
	let exportName = args.export;
	if (!exportName && source) {
		exportName = preferredExport(source, stem);
	}
	// The typed props schema drives the harness's live props panel; its
	// skeleton (required members, imported types resolved one hop) is the
	// auto-applied seed when there is no capture and no samples file — the
	// first click renders the component instead of a missing-props stack.
	const schema = source ? parsePropsSchema(source, stem, makeTypeResolver(abs, target.targetDir)) : undefined;
	let props = sanitizeProps(args.props);
	if (!Object.keys(props).length && schema && schema.required.length && !hasSamples(path.dirname(abs), path.basename(abs))) {
		props = schema.skeleton;
		vscode.window.setStatusBarMessage(`Isolation: ${exportName || stem} — applied a props skeleton (edit live in the preview's props panel)`, 5000);
	}
	const url = buildIsolateUrl(target, rel, exportName, props, schema?.specs);
	const label = exportName || stem;

	// New component → the previous component's state no longer applies. The
	// harness re-reports `samples`/`props` for this one as it loads.
	sampleNames = [];
	currentProps = undefined;
	currentFile = abs;
	currentTargetDir = target.targetDir;
	currentUiPort = target.uiPort;
	currentLabel = label;

	const previewColumn = cssAbs ? vscode.ViewColumn.Three : vscode.ViewColumn.Beside;
	if (!preview) {
		preview = vscode.window.createWebviewPanel(
			'burrow.frontendIsolation',
			`Preview — ${label}`,
			{ viewColumn: previewColumn, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		preview.onDidDispose(() => { preview = undefined; sampleNames = []; currentProps = undefined; currentFile = undefined; }, undefined, context.subscriptions);
		// ONE listener for the panel's life. It reads module state (currentLabel),
		// so re-isolations must NOT register another — that used to multiply every
		// envelope by the number of isolations.
		preview.webview.onDidReceiveMessage((msg: IsolateEnvelope) => handleEnvelope(msg), undefined, context.subscriptions);
	} else {
		preview.title = `Preview — ${label}`;
		preview.reveal(previewColumn, true);
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

/**
 * Native props editor: a JSON input seeded with the component's LIVE props
 * (mirrored up by the harness) over its required-props skeleton, applied to
 * the preview via `{__burrowIsoCmd:1,type:'props',props}`. String value "ƒ"
 * marks a function prop — the harness renders it as a no-op stub.
 */
export async function editProps(): Promise<void> {
	if (!preview || !currentFile) {
		void vscode.window.showInformationMessage('Frontend Debugger: isolate a component first (its preview must be open).');
		return;
	}
	let skeleton: Record<string, unknown> = {};
	try {
		const stem = path.basename(currentFile).replace(/\.[jt]sx?$/, '');
		skeleton = parsePropsSkeleton(fs.readFileSync(currentFile, 'utf8'), stem)?.props ?? {};
	} catch {
		// no source, no skeleton — live props alone still seed the editor
	}
	const seed = { ...skeleton, ...(currentProps ?? {}) };
	const raw = await vscode.window.showInputBox({
		title: `Props — ${currentLabel}`,
		value: JSON.stringify(seed),
		prompt: 'JSON object. Use "ƒ" as a value for a function prop (rendered as a no-op stub).',
		validateInput: (text) => {
			try {
				const parsed = JSON.parse(text);
				return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? undefined : 'Must be a JSON object.';
			} catch {
				return 'Not valid JSON.';
			}
		},
	});
	if (raw === undefined) {
		return;
	}
	void preview.webview.postMessage({ __burrowIsoCmd: 1, type: 'props', props: JSON.parse(raw) });
}

/**
 * Persist the preview's live props as a named sample in the component's
 * colocated `<Component>.samples.ts` (created if absent, merged if present),
 * written through the sidecar's allowlisted POST /api/source. The next
 * isolation then renders the first sample by default — a tuned prop set
 * becomes durable, the Framer "set sample props once" workflow.
 */
export async function saveSample(): Promise<void> {
	if (!preview || !currentFile || !currentTargetDir || !currentProps || !Object.keys(currentProps).length) {
		void vscode.window.showInformationMessage('Frontend Debugger: isolate a component (with props applied) first.');
		return;
	}
	const uiPort = currentUiPort;
	if (!uiPort) {
		void vscode.window.showInformationMessage('Frontend Debugger: the sidecar is not running.');
		return;
	}
	const name = await vscode.window.showInputBox({
		title: `Save Props as Sample — ${currentLabel}`,
		value: 'Default',
		prompt: 'Sample name (a key in the samples map).',
		validateInput: (text) => (/^[^'\\]+$/.test(text.trim()) && text.trim() ? undefined : 'Name must be non-empty, without quotes or backslashes.'),
	});
	if (name === undefined) {
		return;
	}
	const stemAbs = currentFile.replace(/\.[jt]sx?$/, '');
	const existingAbs = ['ts', 'tsx', 'js', 'jsx'].map((ext) => `${stemAbs}.samples.${ext}`).find((p) => fs.existsSync(p));
	const targetAbs = existingAbs ?? `${stemAbs}.samples.ts`;
	const rel = path.relative(currentTargetDir, targetAbs).split(path.sep).join('/');
	const entry = `'${name.trim()}': ${JSON.stringify(currentProps, null, 2).replace(/\n/g, '\n  ')},`;

	let content: string;
	if (existingAbs) {
		const current = fs.readFileSync(existingAbs, 'utf8');
		// Insert after the samples map's opening brace (samples named export or a
		// default-exported object) — conservative merge; anything unrecognized is
		// opened for a manual edit instead of a risky rewrite.
		const open = /(export\s+const\s+samples[^=]*=\s*\{|export\s+default\s*\{)/.exec(current);
		if (!open) {
			void vscode.window.showWarningMessage(`Frontend Debugger: couldn't find the samples map in ${path.basename(existingAbs)} — opening it instead.`);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(existingAbs));
			return;
		}
		const at = open.index + open[0].length;
		content = `${current.slice(0, at)}\n  ${entry}${current.slice(at)}`;
	} else {
		content = [
			`// DEV-ONLY: sample prop-sets for ${currentLabel} — the Burrow isolation`,
			`// workbench lists these in its Pick Sample Props picker and renders the`,
			`// first one by default. String value 'ƒ' marks a function prop (stubbed).`,
			`export const samples = {`,
			`  ${entry}`,
			`};`,
			``,
		].join('\n');
	}

	try {
		const res = await fetch(`http://127.0.0.1:${uiPort}/api/source`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ file: rel, content }),
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({})) as { error?: string };
			throw new Error(body.error || `HTTP ${res.status}`);
		}
	} catch (err) {
		void vscode.window.showErrorMessage(`Frontend Debugger: saving the sample failed — ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	vscode.window.setStatusBarMessage(`Isolation: saved sample '${name.trim()}' beside ${currentLabel}`, 4000);
	// The gallery badge and the harness's sample list both key off the file.
	void vscode.commands.executeCommand('burrow.frontendDebugger.refreshComponents');
	void preview.webview.postMessage({ __burrowIsoCmd: 1, type: 'reload' });
}

function handleEnvelope(msg: IsolateEnvelope): void {
	if (!msg || msg.__burrowIso !== 1) {
		return;
	}
	if (msg.type === 'samples' && Array.isArray(msg.detail)) {
		// The harness found a colocated <Component>.samples.* — cache the names for
		// the native picker (pickSample).
		sampleNames = msg.detail.filter((n): n is string => typeof n === 'string');
		return;
	}
	if (msg.type === 'props' && msg.detail && typeof msg.detail === 'object' && !Array.isArray(msg.detail)) {
		// The harness mirrors its live props (JSON-safe, 'ƒ' markers intact) after
		// every render — the seed for editProps.
		currentProps = msg.detail;
		return;
	}
	if (msg.type === 'saveSample') {
		// The panel's 💾 button — persist through the native flow (name prompt +
		// allowlisted write-back). The posted props ARE the latest props mirror,
		// but take them anyway in case the render report is still in flight.
		if (msg.detail && typeof msg.detail === 'object' && !Array.isArray(msg.detail)) {
			currentProps = msg.detail;
		}
		void saveSample();
		return;
	}
	if (msg.type === 'renderError' && typeof msg.detail === 'string') {
		// Surface once — the preview already shows the stack inline; this makes a
		// silently-broken component obvious without staring at the canvas.
		vscode.window.setStatusBarMessage(`Isolation: ${currentLabel} render error`, 4000);
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

/** Drop the in-page agent's element/container placeholders ("«…»") so a seeded
 *  props object is JSON-safe. Function placeholders ("ƒ name") are KEPT — the
 *  harness renders them as no-op stubs, so a captured callback prop still
 *  satisfies the component instead of going missing. */
function sanitizeProps(raw: unknown): Record<string, unknown> {
	if (!raw || typeof raw !== 'object') {
		return {};
	}
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === 'string' && value.startsWith('«')) {
			continue;
		}
		out[key] = value;
	}
	return out;
}

function buildIsolateUrl(target: IsolateTarget, rel: string, exportName: string | undefined, props: Record<string, unknown>, specs?: PropSpec[]): string {
	const base = target.targetBase.endsWith('/') ? target.targetBase : `${target.targetBase}/`;
	const q = new URLSearchParams();
	q.set('module', rel);
	if (exportName) {
		q.set('export', exportName);
	}
	if (Object.keys(props).length) {
		q.set('props', JSON.stringify(props));
	}
	if (specs?.length) {
		q.set('schema', JSON.stringify(specs));
	}
	return `${target.targetOrigin}${base}__isolate?${q.toString()}`;
}

/** The component's colocated stylesheet: `<Stem>.css` beside it, else the
 *  directory's single `.css` file (merkle's one-component-per-dir layout). */
function findColocatedCss(componentAbs: string): string | undefined {
	const dir = path.dirname(componentAbs);
	const stemCss = path.join(dir, path.basename(componentAbs).replace(/\.[jt]sx?$/, '.css'));
	if (fs.existsSync(stemCss)) {
		return stemCss;
	}
	try {
		const css = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));
		return css.length === 1 ? path.join(dir, css[0]) : undefined;
	} catch {
		return undefined;
	}
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
