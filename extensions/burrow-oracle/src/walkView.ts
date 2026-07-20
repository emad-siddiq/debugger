/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// walkView.ts — the Oracle "package walk" webview (architecture task 08, task 1 + the
// task's own "package walk rendered in a webview"). It renders the import-path tree that
// golist.ts builds into a collapsible list, and lets a click reveal a package's directory
// in the editor. The go/child_process invocation and tree-building live in extension.ts;
// this provider is presentation only — it holds the latest tree and (re)renders the HTML.

import {
	CancellationToken,
	Uri,
	WebviewView,
	WebviewViewProvider,
	WebviewViewResolveContext,
	commands,
} from 'vscode';
import { GoPackage, PackageTreeNode } from './golist';

/** A random nonce for the strict inline-script CSP (same idiom as the inspector). */
function nonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}

/** Escape text for safe interpolation into HTML. */
function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, ch => (
		ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
	));
}

/** Message the webview posts when a package row is clicked. */
interface RevealMessage {
	readonly type: 'reveal';
	readonly dir: string;
}

/** The Oracle package-walk webview view. */
export class OracleWalkProvider implements WebviewViewProvider {
	static readonly viewId = 'burrowOracleWalk';

	private view?: WebviewView;
	private tree?: PackageTreeNode;
	private status = 'Run “Oracle: Walk Go Packages” to map this codebase.';

	/** Wire the webview: strict CSP, and a click → reveal-in-explorer bridge. */
	resolveWebviewView(view: WebviewView, _context: WebviewViewResolveContext, _token: CancellationToken): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.onDidReceiveMessage((message: RevealMessage) => {
			if (message.type === 'reveal' && message.dir) {
				void commands.executeCommand('revealInExplorer', Uri.file(message.dir));
			}
		});
		this.render();
	}

	/** Replace the walk with a freshly-parsed tree and re-render. */
	update(tree: PackageTreeNode, packageCount: number): void {
		this.tree = tree;
		this.status = `${packageCount} package${packageCount === 1 ? '' : 's'} walked.`;
		this.render();
	}

	/** Show a transient status line (e.g. "Walking…", or an error) without a tree. */
	setStatus(status: string): void {
		this.status = status;
		this.render();
	}

	/** Rebuild the HTML from the current tree + status. No-op until the view resolves. */
	private render(): void {
		if (!this.view) {
			return;
		}
		const n = nonce();
		const body = this.tree ? renderNode(this.tree, true) : '';
		this.view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
	<style nonce="${n}">
		body { font: 13px var(--vscode-font-family); color: var(--vscode-foreground); padding: 4px 0; }
		.status { opacity: .7; padding: 2px 10px 8px; }
		ul { list-style: none; margin: 0; padding-left: 14px; }
		li { padding: 1px 0; }
		.pkg { cursor: pointer; }
		.pkg:hover { text-decoration: underline; }
		.name { color: var(--vscode-symbolIcon-packageForeground, var(--vscode-foreground)); }
		.doc { opacity: .6; margin-left: 6px; }
		.dir { opacity: .45; }
	</style>
</head>
<body>
	<div class="status">${escapeHtml(this.status)}</div>
	${body}
	<script nonce="${n}">
		const vscode = acquireVsCodeApi();
		document.addEventListener('click', e => {
			const el = e.target.closest('.pkg');
			if (el && el.dataset.dir) {
				vscode.postMessage({ type: 'reveal', dir: el.dataset.dir });
			}
		});
	</script>
</body>
</html>`;
	}
}

/** Render a tree node (and its subtree) as a nested `<ul>`. `isRoot` unwraps the root li. */
function renderNode(node: PackageTreeNode, isRoot: boolean): string {
	const children = node.children.map(child => `<li>${renderNode(child, false)}</li>`).join('');
	const childList = children ? `<ul>${children}</ul>` : '';
	if (isRoot) {
		return `${node.pkg ? rowFor(node) : `<div class="name">${escapeHtml(node.name)}</div>`}${childList}`;
	}
	return `${node.pkg ? rowFor(node) : `<span class="name">${escapeHtml(node.name)}</span>`}${childList}`;
}

/** The clickable row for a node that carries an actual package. */
function rowFor(node: PackageTreeNode): string {
	const pkg = node.pkg as GoPackage;
	const doc = pkg.Doc ? `<span class="doc">${escapeHtml(firstSentence(pkg.Doc))}</span>` : '';
	const dir = pkg.Dir ? ` data-dir="${escapeHtml(pkg.Dir)}"` : '';
	return `<span class="pkg name"${dir} title="${escapeHtml(pkg.ImportPath)}">${escapeHtml(node.name)}</span>${doc}`;
}

/** First sentence of a doc comment, capped, for the compact walk row. */
function firstSentence(doc: string): string {
	const flat = doc.replace(/\s+/g, ' ').trim();
	const stop = flat.indexOf('. ');
	const text = stop > 0 ? flat.slice(0, stop + 1) : flat;
	return text.length > 100 ? text.slice(0, 99) + '…' : text;
}
