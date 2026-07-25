/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { parseHttpFile } from './httpFile';

// The API view's **Requests** section (docs/plans/02 §3.5): the `.http` files
// this workspace ships, the requests inside them, and what the last few sends
// answered. Two levels, never three — a file (or "Recent") and its rows.
//
// The tree is an index, not a surface: clicking a request opens it in the
// editor at its line, where the codelens and the HTTP workbench already live.
// Nothing here sends anything; that stays an explicit gesture.

/** One finished send, as the tree shows it. Kept in memory only — a request
 *  history that survived restarts would be a log, and this is a scratchpad. */
export interface ResponseRecord {
	readonly method: string;
	readonly url: string;
	readonly status: number;
	readonly ms: number;
	readonly file?: vscode.Uri;
	readonly line?: number;
}

const HISTORY_MAX = 10;
const history: ResponseRecord[] = [];
const historyChanged = new vscode.EventEmitter<void>();

/** Record a send. Called by the send path so the section shows what happened
 *  without the tree having to poll anything. */
export function rememberResponse(record: ResponseRecord): void {
	history.unshift(record);
	while (history.length > HISTORY_MAX) {
		history.pop();
	}
	historyChanged.fire();
}

type Node =
	| { readonly kind: 'file'; readonly uri: vscode.Uri }
	| { readonly kind: 'request'; readonly uri: vscode.Uri; readonly label: string; readonly line: number }
	| { readonly kind: 'recent' }
	| { readonly kind: 'response'; readonly record: ResponseRecord };

export class RequestsProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {

	public static readonly viewId = 'burrowHttpRequests';

	private readonly changed = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	private readonly subscription = historyChanged.event(() => this.refresh());

	dispose(): void {
		this.subscription.dispose();
		this.changed.dispose();
	}

	refresh(): void {
		this.changed.fire(undefined);
	}

	getTreeItem(node: Node): vscode.TreeItem {
		switch (node.kind) {
			case 'file': {
				const item = new vscode.TreeItem(path.basename(node.uri.fsPath), vscode.TreeItemCollapsibleState.Expanded);
				item.resourceUri = node.uri;
				item.description = relative(path.dirname(node.uri.fsPath));
				item.contextValue = 'burrowHttpFile';
				item.iconPath = new vscode.ThemeIcon('file-code');
				return item;
			}
			case 'request': {
				const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
				item.contextValue = 'burrowHttpRequest';
				item.iconPath = new vscode.ThemeIcon('arrow-right');
				item.command = {
					command: 'vscode.open',
					title: 'Open request',
					arguments: [node.uri, { selection: new vscode.Range(node.line, 0, node.line, 0) }],
				};
				return item;
			}
			case 'recent': {
				const item = new vscode.TreeItem('Recent', vscode.TreeItemCollapsibleState.Expanded);
				item.description = String(history.length);
				item.iconPath = new vscode.ThemeIcon('history');
				return item;
			}
			case 'response': {
				const { method, url, status, ms } = node.record;
				const item = new vscode.TreeItem(`${method} ${short(url)}`, vscode.TreeItemCollapsibleState.None);
				item.description = `${status} · ${ms} ms`;
				// Status carries information here, so it gets the only colour in
				// the row (contract rule 5: icons only where they mean something).
				item.iconPath = new vscode.ThemeIcon(status >= 400 ? 'error' : 'pass', new vscode.ThemeColor(
					status >= 500 ? 'testing.iconFailed' : status >= 400 ? 'testing.iconQueued' : 'testing.iconPassed',
				));
				if (node.record.file) {
					item.command = {
						command: 'vscode.open',
						title: 'Open the request that produced this',
						arguments: [node.record.file, { selection: new vscode.Range(node.record.line ?? 0, 0, node.record.line ?? 0, 0) }],
					};
				}
				return item;
			}
		}
	}

	async getChildren(node?: Node): Promise<Node[]> {
		if (!node) {
			const files = await httpFiles();
			const roots: Node[] = files.map((uri) => ({ kind: 'file', uri }));
			return history.length ? [{ kind: 'recent' }, ...roots] : roots;
		}
		if (node.kind === 'recent') {
			return history.map((record) => ({ kind: 'response', record }));
		}
		if (node.kind !== 'file') {
			return [];
		}
		try {
			const text = (await vscode.workspace.openTextDocument(node.uri)).getText();
			return parseHttpFile(text).requests.map((request) => ({
				kind: 'request',
				uri: node.uri,
				label: request.name || `${request.method} ${short(request.url)}`,
				line: request.line,
			}));
		} catch {
			return [];
		}
	}
}

/** Every `.http` file in the workspace, the one under `infra/test` first — it
 *  is merkle's own request collection and the one a developer means. */
async function httpFiles(): Promise<vscode.Uri[]> {
	const found = await vscode.workspace.findFiles('**/*.http', '**/node_modules/**', 50);
	return found.sort((a, b) => rank(a) - rank(b) || a.fsPath.localeCompare(b.fsPath));
}

function rank(uri: vscode.Uri): number {
	return /infra[\\/]test[\\/]/.test(uri.fsPath) ? 0 : 1;
}

function relative(dir: string): string {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return root && dir.startsWith(root) ? path.relative(root, dir).split(path.sep).join('/') : dir;
}

function short(url: string): string {
	return url.replace(/^https?:\/\/[^/]+/, '').slice(0, 60) || url.slice(0, 60);
}
