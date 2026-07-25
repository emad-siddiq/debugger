/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { onSidecarPhase, sidecarPhase } from './sidecar';

// Component gallery (Framer-mode T5): a NATIVE sidebar tree of the target's
// React components. Clicking a component isolates it in the T3 Framer surface
// (source | live preview). A component with a colocated `<Component>.samples.*`
// (T4) is marked so you can spot picker-ready ones.
//
// Shaped by the view contract (docs/plans/02 §3.7): exactly TWO levels — a
// folder group (its path relative to `src/`) and the components in it, never a
// deep nest to click through — and a first row that says what the dev server is
// doing, because rule 6 of the contract forbids background work the view does
// not admit to. That row is also the stop button.
//
// All fs-side (no sidecar route): the tree lists files; the isolate command
// (which the click fires with the component's Uri) starts the sidecar on demand.

const COMPONENT_EXT = new Set(['.tsx', '.jsx']);
const SAMPLE_EXTS = ['ts', 'tsx', 'js', 'jsx'];
const SKIP_DIRS = new Set(['node_modules', '__tests__', '__snapshots__', 'test', 'tests', '__mocks__']);

/** A `.tsx/.jsx` file whose basename is a Component (PascalCase), excluding the
 *  test/story/sample siblings that share a component's stem. */
function isComponentFile(name: string): boolean {
	const ext = path.extname(name);
	if (!COMPONENT_EXT.has(ext)) {
		return false;
	}
	const stem = name.slice(0, -ext.length);
	if (/\.(test|spec|stories|samples)$/.test(stem)) {
		return false;
	}
	return /^[A-Z]/.test(stem);
}

/** Whether `<stem>.samples.{ts,tsx,js,jsx}` sits beside a component (T4).
 *  Shared with isolation.ts (the auto-skeleton yields to a samples file). */
export function hasSamples(dir: string, componentFile: string): boolean {
	const stem = componentFile.slice(0, -path.extname(componentFile).length);
	return SAMPLE_EXTS.some((ext) => fs.existsSync(path.join(dir, `${stem}.samples.${ext}`)));
}

type Node =
	| { readonly kind: 'status' }
	| { readonly kind: 'folder'; readonly abs: string; readonly label: string }
	| { readonly kind: 'component'; readonly abs: string; readonly label: string; readonly samples: boolean };

/** Every directory under `src/` that holds at least one component, as a path
 *  relative to it — the group labels, and the only branch level there is. */
function componentDirs(root: string, out: string[] = [], rel = ''): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
	} catch {
		return out;
	}
	if (entries.some((e) => !e.isDirectory() && isComponentFile(e.name))) {
		out.push(rel);
	}
	for (const e of entries) {
		if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
			componentDirs(root, out, rel ? `${rel}/${e.name}` : e.name);
		}
	}
	return out;
}

export class ComponentsProvider implements vscode.TreeDataProvider<Node> {
	private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this._onDidChange.event;

	/** `srcRoot()` resolves the CURRENT target `src/` (it follows config changes),
	 *  or undefined when no target is detected. */
	constructor(private readonly srcRoot: () => string | undefined) {
		// The status row is only honest if it keeps up with the thing it reports.
		onSidecarPhase(() => this.refresh());
	}

	refresh(): void {
		this._onDidChange.fire(undefined);
	}

	getTreeItem(node: Node): vscode.TreeItem {
		if (node.kind === 'status') {
			// One muted row, no icon noise: the dev server's state in plain words,
			// and clicking it does the obvious thing for that state.
			const { phase, uiPort } = sidecarPhase();
			const item = new vscode.TreeItem(
				phase === 'running' ? `dev server: :${uiPort} live` : phase === 'starting' ? 'dev server: starting…' : 'dev server: stopped',
				vscode.TreeItemCollapsibleState.None,
			);
			item.contextValue = 'burrowComponentsStatus';
			item.tooltip = phase === 'running'
				? 'The frontend debugger sidecar is running — click to stop it'
				: phase === 'starting'
					? 'Starting the sidecar so the first isolate lands on a running dev server'
					: 'No dev server — click to start one and open the app';
			item.command = phase === 'running'
				? { command: 'burrow.frontendDebugger.stop', title: 'Stop the dev server' }
				: { command: 'burrow.frontendDebugger.open', title: 'Start the dev server' };
			return item;
		}
		if (node.kind === 'folder') {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
			item.iconPath = vscode.ThemeIcon.Folder;
			item.contextValue = 'burrowComponentFolder';
			item.resourceUri = vscode.Uri.file(node.abs);
			return item;
		}
		const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon('symbol-method');
		item.contextValue = 'burrowComponent';
		item.resourceUri = vscode.Uri.file(node.abs);
		item.tooltip = node.abs;
		if (node.samples) {
			// TreeItem.description is plain text (no codicon rendering) — a bare
			// word reads cleanest as the "picker-ready" marker.
			item.description = 'samples';
		}
		// Single click isolates — the T3 isolate command accepts the file Uri.
		item.command = {
			command: 'burrow.frontendDebugger.isolate',
			title: 'Isolate Component',
			arguments: [vscode.Uri.file(node.abs)],
		};
		return item;
	}

	getChildren(node?: Node): Node[] {
		const root = this.srcRoot();
		if (!root || !fs.existsSync(root)) {
			return [];
		}
		if (!node) {
			// Level one: the status row, then one group per directory that holds
			// components — labelled by its path, so `primitives/tabs` reads as
			// itself instead of as three collapsed levels to open.
			const groups: Node[] = componentDirs(root)
				.sort((a, b) => a.localeCompare(b))
				.map((rel) => ({ kind: 'folder', abs: path.join(root, rel), label: rel || 'src' }));
			return [{ kind: 'status' }, ...groups];
		}
		if (node.kind !== 'folder') {
			return [];
		}
		// Level two: the components in that directory, and nothing else.
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(node.abs, { withFileTypes: true });
		} catch {
			return [];
		}
		return entries
			.filter((e) => !e.isDirectory() && isComponentFile(e.name))
			.map((e) => ({
				kind: 'component' as const,
				abs: path.join(node.abs, e.name),
				label: e.name.slice(0, -path.extname(e.name).length),
				samples: hasSamples(node.abs, e.name),
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
	}
}
