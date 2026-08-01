/*---------------------------------------------------------------------------------------------
 *  Burrow: what the workbench is showing, as chat context.
 *
 *  A question asked while a component sits on the isolation canvas is almost
 *  always about that component — and a component alone tells the model less
 *  than the component plus its stylesheet, samples and children. This module
 *  reads the other Burrow rails' read-only APIs and renders one compact block
 *  of PATHS and one-line facts. Never file bodies: the CLI reads files itself,
 *  so ten lines here replace thousands of inlined tokens.
 *
 *  Every source is optional and wrapped: a rail that is not running, or an API
 *  that is not there, contributes nothing rather than an error.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface IsolationState { file: string; label: string; props?: Record<string, unknown> }
interface FlowNodeLite { file?: string; line?: number; sql?: string }
interface FlowLite { method: string; path: string; file: string; line: number; nodes?: FlowNodeLite[] }
interface FlowsDocLite { flows?: FlowLite[] | null }

export function collectWorkbenchContext(): string | undefined {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) { return undefined; }
	const rel = (p: string) => path.isAbsolute(p) ? path.relative(root, p).split(path.sep).join('/') : p;

	const lines: string[] = [];

	// --- Components rail: the isolated component and its bundle -------------------------------
	const iso = isolation();
	if (iso?.file) {
		lines.push(`- Components rail: isolated component \`${iso.label || path.basename(iso.file)}\` — ${rel(iso.file)}`);
		for (const companion of companionsOf(iso.file)) {
			lines.push(`  - ${rel(companion.file)} (${companion.role})`);
		}
		const props = iso.props && Object.keys(iso.props).length ? JSON.stringify(iso.props) : '';
		if (props) {
			lines.push(`  - live props: ${props.length > 300 ? props.slice(0, 300) + '…' : props}`);
		}
	}

	// --- Data rail: the live connection --------------------------------------------------------
	const db = dbConnection();
	if (db) {
		lines.push(`- Data rail: connected to ${db.label}${db.writes ? ' (writes enabled)' : ''}`);
	}

	// --- API rail: routes that flow through the active file -----------------------------------
	const editor = vscode.window.activeTextEditor;
	const active = editor?.document.uri.fsPath;
	if (active && /\.go$/.test(active)) {
		const routes = routesThroughFile(active, rel);
		if (routes.length) {
			lines.push(`- API rail: routes through ${rel(active)}: ${routes.join(' · ')}`);
		}
	}

	// --- Debug ---------------------------------------------------------------------------------
	const session = vscode.debug.activeDebugSession;
	if (session) {
		const stopped = vscode.debug.activeStackItem && 'frameId' in vscode.debug.activeStackItem;
		lines.push(`- Debug: session \`${session.name}\` (${session.type})${stopped ? ', stopped at a breakpoint' : ''}`);
	}

	if (!lines.length) { return undefined; }
	return [
		'Burrow workbench state (paths are workspace-relative; read the files with your tools):',
		...lines,
	].join('\n');
}

// --- sources -----------------------------------------------------------------------------------

function isolation(): IsolationState | undefined {
	try {
		const api = vscode.extensions.getExtension('burrow.burrow-frontend-debugger')?.exports as
			{ readonly isolation?: () => IsolationState | undefined } | undefined;
		return api?.isolation?.();
	} catch {
		return undefined;
	}
}

function dbConnection(): { label: string; writes: boolean } | undefined {
	try {
		const api = vscode.extensions.getExtension('burrow.burrow-db')?.exports as
			{ readonly connection?: () => { label: string; writes: boolean } | undefined } | undefined;
		return api?.connection?.();
	} catch {
		return undefined;
	}
}

function flowsDoc(): FlowsDocLite | undefined {
	try {
		const api = vscode.extensions.getExtension('burrow.burrow-flow')?.exports as
			{ readonly doc?: () => FlowsDocLite | undefined } | undefined;
		return api?.doc?.();
	} catch {
		return undefined;
	}
}

/**
 * The component's bundle: same-stem siblings (stylesheet, samples, tests —
 * burrow-agent's `bundleFor` convention) UNION whatever stylesheets the
 * component actually imports, because a stylesheet does not have to share the
 * component's name to be its stylesheet.
 */
function companionsOf(componentFile: string): { file: string; role: string }[] {
	const out = new Map<string, string>();
	const dir = path.dirname(componentFile);
	const stem = path.basename(componentFile).replace(/\.[jt]sx?$/, '');

	try {
		let stylesheets = 0;
		for (const name of fs.readdirSync(dir)) {
			if (name === path.basename(componentFile)) { continue; }
			// A component folder's stylesheet belongs to the component whatever it
			// is called — merkle names it after the folder (alerts-panel.css beside
			// AlertsPanel.tsx), other stacks use the stem or *.module.css.
			if (/\.(css|scss)$/.test(name)) {
				if (stylesheets++ < 3) { out.set(path.join(dir, name), 'stylesheet'); }
				continue;
			}
			const wanted =
				/^.*\.samples\.[jt]sx?$/.test(name) && name.startsWith(`${stem}.samples.`) ? 'sample props' :
					name.startsWith(`${stem}.test.`) || name === `${stem}_test.go` ? 'tests' : undefined;
			if (wanted) { out.set(path.join(dir, name), wanted); }
		}
	} catch { /* unreadable dir: siblings stay unlisted */ }

	try {
		const source = fs.readFileSync(componentFile, 'utf8');
		const resolveImport = (spec: string): string | undefined => {
			if (spec.startsWith('.')) { return path.resolve(dir, spec); }
			// The `@/` alias — Vite/tsconfig convention for the package's src root,
			// which is the nearest `src` ancestor of the component itself.
			if (spec.startsWith('@/')) {
				let cursor = dir;
				while (path.basename(cursor) !== 'src' && path.dirname(cursor) !== cursor) { cursor = path.dirname(cursor); }
				return path.basename(cursor) === 'src' ? path.join(cursor, spec.slice(2)) : undefined;
			}
			return undefined;
		};
		for (const m of source.matchAll(/import\s+(?:[^'"]*\s+from\s+)?['"]([^'"]+\.(?:css|scss))['"]/g)) {
			const resolved = resolveImport(m[1]);
			if (resolved && !out.has(resolved) && fs.existsSync(resolved)) { out.set(resolved, 'stylesheet (imported)'); }
		}
		// Child components: the subtree this component renders.
		const children: string[] = [];
		for (const m of source.matchAll(/import\s+[^'"]*\s+from\s+['"]((?:\.|@\/)[^'"]+)['"]/g)) {
			if (/\.(css|scss|json|svg|png)$/.test(m[1])) { continue; }
			const base = resolveImport(m[1]);
			if (!base) { continue; }
			for (const ext of ['.tsx', '.jsx', '/index.tsx', '', '.ts']) {
				const resolved = base + ext;
				if (fs.existsSync(resolved) && /\.[jt]sx$/.test(resolved)) { children.push(resolved); break; }
			}
		}
		for (const child of children.slice(0, 5)) {
			if (!out.has(child)) { out.set(child, 'child component'); }
		}
	} catch { /* unreadable source: imports stay unlisted */ }

	return [...out].map(([file, role]) => ({ file, role }));
}

/** Up to four traced routes whose flow passes through the given file. */
function routesThroughFile(file: string, rel: (p: string) => string): string[] {
	const doc = flowsDoc();
	const flows = doc?.flows ?? [];
	const target = rel(file);
	const hits: string[] = [];
	for (const flow of flows) {
		const touches = rel(flow.file) === target || (flow.nodes ?? []).some(n => n.file && rel(n.file) === target);
		if (touches) {
			hits.push(`${flow.method} ${flow.path}`);
			if (hits.length >= 4) { break; }
		}
	}
	return hits;
}
