/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// Component gallery (Framer-mode T5): a NATIVE sidebar tree of the target's
// React components, grouped by folder. Clicking a component isolates it in the
// T3 Framer surface (source | live preview). A component with a colocated
// `<Component>.samples.*` (T4) is marked so you can spot picker-ready ones.
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

/** Whether `<stem>.samples.{ts,tsx,js,jsx}` sits beside a component (T4). */
function hasSamples(dir: string, componentFile: string): boolean {
	const stem = componentFile.slice(0, -path.extname(componentFile).length);
	return SAMPLE_EXTS.some((ext) => fs.existsSync(path.join(dir, `${stem}.samples.${ext}`)));
}

/** Does this directory (recursively) hold at least one component? Used to prune
 *  folders that would otherwise render as empty branches. */
function dirHasComponents(dir: string): boolean {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const e of entries) {
		if (e.isDirectory()) {
			if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && dirHasComponents(path.join(dir, e.name))) {
				return true;
			}
		} else if (isComponentFile(e.name)) {
			return true;
		}
	}
	return false;
}

type Node =
	| { readonly kind: 'folder'; readonly abs: string; readonly label: string }
	| { readonly kind: 'component'; readonly abs: string; readonly label: string; readonly samples: boolean };

export class ComponentsProvider implements vscode.TreeDataProvider<Node> {
	private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this._onDidChange.event;

	/** `srcRoot()` resolves the CURRENT target `src/` (it follows config changes),
	 *  or undefined when no target is detected. */
	constructor(private readonly srcRoot: () => string | undefined) { }

	refresh(): void {
		this._onDidChange.fire(undefined);
	}

	getTreeItem(node: Node): vscode.TreeItem {
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
		const dir = node ? node.abs : this.srcRoot();
		if (!dir || !fs.existsSync(dir)) {
			return [];
		}
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return [];
		}
		const folders: Node[] = [];
		const components: Node[] = [];
		for (const e of entries) {
			const abs = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && dirHasComponents(abs)) {
					folders.push({ kind: 'folder', abs, label: e.name });
				}
			} else if (isComponentFile(e.name)) {
				components.push({
					kind: 'component',
					abs,
					label: e.name.slice(0, -path.extname(e.name).length),
					samples: hasSamples(dir, e.name),
				});
			}
		}
		const byLabel = (a: Node, b: Node) => a.label.localeCompare(b.label);
		// Folders first, then components — both alphabetical.
		return [...folders.sort(byLabel), ...components.sort(byLabel)];
	}
}
