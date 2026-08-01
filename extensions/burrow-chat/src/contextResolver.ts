/*---------------------------------------------------------------------------------------------
 *  Burrow: ViewContextResolver — the focused Burrow surface, resolved to the
 *  PRIMARY artifacts it is about (plan chat/02). Primaries only; the one-hop
 *  neighborhood expansion is the pack builder's job (phase 3).
 *
 *  Every lookup degrades silently (invariant 8): a rail that is not installed,
 *  not active, or has no selection resolves to the next fallback or nothing.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { activeExports, FocusTracker, Surface } from './focusTracker';
import { styleImportsOf } from './styleImports';

export interface PrimaryArtifact {
	uri: vscode.Uri;
	role: 'component' | 'stylesheet' | 'route' | 'handler' | 'editor' | 'frame';
	range?: vscode.Range;          // only when a real selection exists
	note?: string;                 // e.g. 'imported at line 3' — ≤6 words
}

export interface ViewContext {
	surface: Surface;
	primaries: PrimaryArtifact[];  // ordered: main artifact first
	// seed for phase-3 expansion:
	seed: { kind: 'component' | 'route' | 'symbol' | 'file'; id: string };
}

interface ComponentsApi {
	readonly selectedComponent?: () => { file: string; label: string } | undefined;
	readonly isolation?: () => { file: string; label: string } | undefined;
}
/** Structural mirror of burrow-flow's Flow (tools/flowscan/model.go field names). */
export interface FlowLite {
	readonly method: string;
	readonly path: string;
	readonly file: string;   // backend-relative
	readonly line: number;
}
interface FlowApi {
	readonly selectedRoute?: () => FlowLite | undefined;
	readonly backendDir?: () => string | undefined;
}

export async function resolveViewContext(tracker: FocusTracker): Promise<ViewContext | undefined> {
	tracker.ensureSubscriptions();
	const surface = tracker.current() ?? (tracker.editingPath() ? 'editor' : undefined);
	switch (surface) {
		case 'components': return (await componentsContext()) ?? editorContext(tracker);
		case 'routes': return (await routesContext()) ?? editorContext(tracker);
		case 'debug': return (await debugContext()) ?? editorContext(tracker);
		case 'editor': return editorContext(tracker);
		default: return undefined;
	}
}

// --- surfaces ----------------------------------------------------------------------------------

async function componentsContext(): Promise<ViewContext | undefined> {
	const api = activeExports<ComponentsApi>('burrow.burrow-frontend-debugger');
	const comp = api?.selectedComponent?.() ?? api?.isolation?.();
	if (!comp?.file) { return undefined; }
	const uri = vscode.Uri.file(comp.file);
	const primaries: PrimaryArtifact[] = [{ uri, role: 'component' }];
	primaries.push(...await stylesheetsOf(uri));
	return { surface: 'components', primaries, seed: { kind: 'component', id: comp.file } };
}

async function routesContext(): Promise<ViewContext | undefined> {
	const api = activeExports<FlowApi>('burrow.burrow-flow');
	const route = api?.selectedRoute?.();
	if (!route?.file) { return undefined; }
	const backend = api?.backendDir?.();
	const abs = backend ? path.join(backend, route.file) : undefined;
	if (!abs || !await exists(vscode.Uri.file(abs))) { return undefined; }
	const line = Math.max(0, (route.line ?? 1) - 1);
	return {
		surface: 'routes',
		primaries: [{ uri: vscode.Uri.file(abs), role: 'handler', range: new vscode.Range(line, 0, line, 0) }],
		seed: { kind: 'route', id: `${route.method} ${route.path}` },
	};
}

async function debugContext(): Promise<ViewContext | undefined> {
	const item = vscode.debug.activeStackItem;
	const session = vscode.debug.activeDebugSession;
	if (!session || !item || !('frameId' in item)) { return undefined; }
	try {
		const resp = await Promise.race([
			session.customRequest('stackTrace', { threadId: (item as { threadId: number }).threadId, startFrame: 0, levels: 1 }),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stackTrace timeout')), 300)),
		]) as { stackFrames?: { name?: string; line?: number; source?: { path?: string } }[] };
		const frame = resp?.stackFrames?.[0];
		if (!frame?.source?.path) { return undefined; }
		const line = Math.max(0, (frame.line ?? 1) - 1);
		return {
			surface: 'debug',
			primaries: [{ uri: vscode.Uri.file(frame.source.path), role: 'frame', range: new vscode.Range(line, 0, line, 0) }],
			seed: { kind: 'symbol', id: frame.name ?? '' },
		};
	} catch {
		return undefined;
	}
}

function editorContext(tracker: FocusTracker): ViewContext | undefined {
	const p = tracker.editingPath();
	if (!p) { return undefined; }
	const editor = vscode.window.activeTextEditor?.document.uri.path === p
		? vscode.window.activeTextEditor
		: vscode.window.visibleTextEditors.find(e => e.document.uri.path === p);
	const selection = editor && !editor.selection.isEmpty ? new vscode.Range(editor.selection.start, editor.selection.end) : undefined;
	return {
		surface: 'editor',
		primaries: [{ uri: vscode.Uri.file(p), role: 'editor', range: selection }],
		seed: { kind: 'file', id: vscode.workspace.asRelativePath(p).replace(/\\/g, '/') },
	};
}

// --- stylesheet discovery (plan chat/02 step 4, exact algorithm) -------------------------------

/** One-slot cache of the last component source read — the pack builder reuses
 *  it instead of re-reading (plan chat/03 step 1.3: "reuse, do not re-read"). */
export let lastComponentRead: { path: string; text: string } | undefined;

export async function stylesheetsOf(component: vscode.Uri): Promise<PrimaryArtifact[]> {
	const deadline = Date.now() + 100;
	const found: PrimaryArtifact[] = [];
	let text: string;
	try {
		text = new TextDecoder().decode(await vscode.workspace.fs.readFile(component));
		lastComponentRead = { path: component.fsPath, text };
	} catch {
		return found;
	}
	const dir = path.dirname(component.fsPath);
	for (const { spec, line } of styleImportsOf(text)) {
		if (found.length >= 3 || Date.now() > deadline) { return found; }
		if (!spec.startsWith('.')) { continue; }  // package-style imports are ignored
		const resolved = vscode.Uri.file(path.resolve(dir, spec));
		if (await exists(resolved)) {
			found.push({ uri: resolved, role: 'stylesheet', note: `imported at line ${line}` });
		}
	}
	if (!found.length) {
		const base = path.basename(component.fsPath).replace(/\.[^.]+$/, '');
		for (const name of [`${base}.module.css`, `${base}.css`, 'styles.css']) {
			if (found.length >= 3 || Date.now() > deadline) { break; }
			const probe = vscode.Uri.file(path.join(dir, name));
			if (await exists(probe)) {
				found.push({ uri: probe, role: 'stylesheet' });
			}
		}
	}
	return found;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}
