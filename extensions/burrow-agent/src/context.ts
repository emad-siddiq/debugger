/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { bundleFor, bundleRole, DENY_GLOBS, isDenied, Layer } from './contextModel';
import { memoryLayer } from './memory';

// What the agent knows without being told (docs/plans/03 §3): the layers, read
// off the workbench at the moment the question is asked. The rules about what
// may be sent and what fits in the budget live in contextModel.ts; this file is
// only the collecting.
//
// Everything here is cheap and synchronous except the enclosing symbol, which
// asks the language server. A layer that cannot be collected is simply absent —
// no half-truths in the envelope, and never a thrown error in the composer.

const MAX_SELECTION_LINES = 200;

/** The built-in never-touch list plus whatever the workspace added. The
 *  built-ins always apply: the setting can only make the list longer. */
export function denyGlobs(): string[] {
	const extra = vscode.workspace.getConfiguration('burrow.agent').get<string[]>('denyGlobs', []);
	return [...DENY_GLOBS, ...(Array.isArray(extra) ? extra.filter((g) => typeof g === 'string' && g) : [])];
}

const denied = (file: string) => isDenied(file.split(path.sep).join('/'), denyGlobs());

export async function collect(dropped: ReadonlySet<string>): Promise<Layer[]> {
	const layers: Layer[] = [];
	const add = (id: string, label: string, body: string | undefined) => {
		if (body && body.trim() && !dropped.has(id)) {
			layers.push({ id, label, body });
		}
	};
	const editor = vscode.window.activeTextEditor;
	const activePath = editor?.document.uri.fsPath;

	add('workspace', 'Workspace', workspace());
	add('pages', 'Open pages', openPages());
	if (activePath && !denied(activePath)) {
		add('bundle', `Page bundle — ${path.basename(activePath)}`, pageBundle(activePath));
		add('selection', 'Selection', await selection(editor!));
	}
	add('surface', 'Live surface', liveSurface());
	add('debug', 'Debug', debugState());
	add('data', 'Data', dataState());
	add('memory', 'Repo memory', memoryLayer(activePath));
	return layers;
}

function workspace(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return undefined;
	}
	const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty).length;
	const parts = [`${folder.name} at \`${folder.uri.fsPath}\``];
	const branch = gitBranch(folder.uri.fsPath);
	if (branch) {
		parts.push(`branch \`${branch}\``);
	}
	if (dirty) {
		parts.push(`${dirty} file${dirty === 1 ? '' : 's'} with unsaved changes`);
	}
	return parts.join(' · ');
}

/** The branch, read straight from .git/HEAD — cheaper than waking the git
 *  extension for one string, and it works before that extension activates. */
function gitBranch(root: string): string | undefined {
	try {
		const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
		return head.startsWith('ref: ') ? head.slice(head.lastIndexOf('/') + 1) : head.slice(0, 7);
	} catch {
		return undefined;
	}
}

/** Which pages are open, in which column — "what I have on screen", which is
 *  what a developer means by "this file" and "the other one". */
function openPages(): string | undefined {
	const rows: string[] = [];
	for (const [index, group] of vscode.window.tabGroups.all.entries()) {
		for (const tab of group.tabs) {
			if (!(tab.input instanceof vscode.TabInputText)) {
				continue;
			}
			const file = tab.input.uri.fsPath;
			if (denied(file)) {
				continue;
			}
			const marks = [`group ${index + 1}`];
			if (tab.isActive) {
				marks.push('active');
			}
			if (tab.isDirty) {
				marks.push('unsaved');
			}
			rows.push(`- \`${relative(file)}\` (${marks.join(', ')})`);
		}
	}
	return rows.length ? rows.join('\n') : undefined;
}

/** The colocated family of the active file — the CSS+component pair the brief
 *  calls out, plus samples and tests when they exist. */
function pageBundle(activeFile: string): string | undefined {
	const dir = path.dirname(activeFile);
	let siblings: string[];
	try {
		siblings = fs.readdirSync(dir);
	} catch {
		return undefined;
	}
	const members = bundleFor(activeFile.split(path.sep).join('/'), siblings);
	if (!members.length) {
		return undefined;
	}
	const rows = [`- \`${relative(activeFile)}\` (source, open)`];
	for (const member of members) {
		rows.push(`- \`${relative(member)}\` (${bundleRole(member)})`);
	}
	return rows.join('\n');
}

/** The selection, its line range, and the symbol it sits in. The symbol is what
 *  turns "why is this misaligned" into a question about a named component. */
async function selection(editor: vscode.TextEditor): Promise<string | undefined> {
	if (editor.selection.isEmpty) {
		return undefined;
	}
	const doc = editor.document;
	const start = editor.selection.start.line;
	const end = Math.min(editor.selection.end.line, start + MAX_SELECTION_LINES);
	const range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
	const text = doc.getText(range);
	const truncated = end < editor.selection.end.line;
	const symbol = await enclosingSymbol(doc.uri, editor.selection.start);
	const where = `\`${relative(doc.uri.fsPath)}:${start + 1}-${end + 1}\`${symbol ? ` in \`${symbol}\`` : ''}`;
	return [where, '', '```' + doc.languageId, text, '```', truncated ? `(truncated at ${MAX_SELECTION_LINES} lines)` : ''].join('\n');
}

async function enclosingSymbol(uri: vscode.Uri, at: vscode.Position): Promise<string | undefined> {
	try {
		const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri);
		let found: string | undefined;
		const walk = (nodes: readonly vscode.DocumentSymbol[] | undefined, trail: string) => {
			for (const node of nodes ?? []) {
				if (node.range.contains(at)) {
					const name = trail ? `${trail}.${node.name}` : node.name;
					found = name;
					walk(node.children, name);
				}
			}
		};
		walk(symbols, '');
		return found;
	} catch {
		return undefined;
	}
}

/** What the Frontend Debugger has isolated right now, through its read-only
 *  export. Absent (not guessed) when the extension is not running. */
function liveSurface(): string | undefined {
	try {
		const api = vscode.extensions.getExtension('burrow.burrow-frontend-debugger')?.exports as
			{ readonly isolation?: () => { file?: string; label?: string; props?: unknown; mode?: string; targetUrl?: string } | undefined } | undefined;
		const live = api?.isolation?.();
		if (!live?.file) {
			return undefined;
		}
		const rows = [`isolated component \`${live.label ?? path.basename(live.file)}\` (\`${relative(live.file)}\`)`];
		if (live.mode) {
			rows.push(`data mode: ${live.mode}`);
		}
		const props = live.props && typeof live.props === 'object' ? JSON.stringify(live.props) : '';
		if (props && props !== '{}') {
			rows.push(`props: \`${props.length > 600 ? `${props.slice(0, 600)}…` : props}\``);
		}
		return rows.join('\n');
	} catch {
		return undefined;
	}
}

/** Where the debugger is stopped, and what is in scope there. A question asked
 *  at a breakpoint is nearly always about this frame. */
function debugState(): string | undefined {
	const session = vscode.debug.activeDebugSession;
	if (!session) {
		return undefined;
	}
	const rows = [`session \`${session.name}\` (${session.type})`];
	const frame = vscode.debug.activeStackItem;
	if (frame && 'frameId' in frame) {
		rows.push('stopped — the frame and its locals are in the debugger views');
	}
	return rows.join('\n');
}

/** The data tools' current subject: which table is open, which request came
 *  back last. Both extensions are optional and read-only here. */
function dataState(): string | undefined {
	const rows: string[] = [];
	for (const [id, key] of [['burrow.burrow-db', 'db'], ['burrow.burrow-http', 'http']] as const) {
		try {
			const api = vscode.extensions.getExtension(id)?.exports as { readonly context?: () => string | undefined } | undefined;
			const line = api?.context?.();
			if (line) {
				rows.push(`${key}: ${line}`);
			}
		} catch {
			// an optional tool that does not export context simply says nothing
		}
	}
	return rows.length ? rows.join('\n') : undefined;
}

function relative(file: string): string {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return root && file.startsWith(root) ? path.relative(root, file).split(path.sep).join('/') : file;
}
