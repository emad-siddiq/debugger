/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// viewer.ts — the fullscreen Go doc viewer (architecture task 07.3 "Viewer
// webview"): a single reusable webview editor tab that renders `go doc` output,
// maximizes its editor group on open ("fullscreen"), and exits on Esc or the ✕
// icon — restoring focus to the exact editor + cursor the user came from (the
// explicit exit contract). It also carries the slice's real navigation: a ⌘K-style
// search box and back button that re-run `go doc` for another symbol, keeping one
// tab and a history stack. Rendering/parsing lives in godoc.ts; the toolchain call
// lives in runner.ts — this file only owns the webview and its lifecycle.

import {
	Disposable,
	Selection,
	Uri,
	ViewColumn,
	WebviewPanel,
	commands,
	window,
	workspace,
} from 'vscode';
import { dirname } from 'path';
import { DocTarget, buildGoDocArgs, parseDocTarget, renderDocHtml } from './godoc';
import { runGoDoc } from './runner';

/** The editor position to return the user to when the viewer closes. */
interface SavedEditor {
	readonly uri: Uri;
	readonly selection: Selection;
	readonly viewColumn: ViewColumn | undefined;
}

/** Messages the webview sends back to the host. */
type Inbound =
	| { readonly type: 'ready' }
	| { readonly type: 'navigate'; readonly input: string }
	| { readonly type: 'back' }
	| { readonly type: 'close' }
	| { readonly type: 'retry' }
	| { readonly type: 'focus' };

/** The command that maximizes / restores the active editor group ("fullscreen"). */
const MAXIMIZE_COMMAND = 'workbench.action.toggleMaximizeEditorGroup';

export const DOCS_VIEW_TYPE = 'burrowGoDocs';

/** How many hops of back-history are persisted. A `DocTarget` is ~60 bytes, so
 *  fifty of them is ~3 KB — comfortably inside the per-panel budget, and deeper
 *  than anyone reads back through in one sitting. */
const HISTORY_CAP = 50;

/** The viewer's state (WO-60): where you had navigated to, not what it showed.
 *  `go doc` re-renders a package in milliseconds from the module cache, so the
 *  rendered text would be a cache of a cache — and a large one. */
interface DocViewerState {
	readonly history?: readonly DocTarget[];
	readonly cursor?: number;
}

export class DocViewer implements Disposable {

	private panel: WebviewPanel | undefined;
	private readonly disposables: Disposable[] = [];

	/** Visited targets; navigation truncates the forward tail then appends. */
	private history: DocTarget[] = [];
	private cursor = -1;

	/**
	 * True until the first render after a revive. That render runs the toolchain
	 * OFFLINE: reviving a tab is not a request to download a module.
	 */
	private restoring = false;

	/** Where to return focus on close; captured only when a real editor is active. */
	private savedEditor: SavedEditor | undefined;

	/** True once we maximized the group, so close restores exactly once. */
	private didMaximize = false;

	/**
	 * Open (or re-focus) the viewer on a target, pushing it onto history.
	 * @param target The package/symbol to document.
	 */
	async open(target: DocTarget): Promise<void> {
		const editor = window.activeTextEditor;
		if (editor) {
			// Capture only when an editor is truly focused — navigating inside the
			// webview leaves activeTextEditor undefined, which must not clobber the
			// return position the user launched from.
			this.savedEditor = {
				uri: editor.document.uri,
				selection: editor.selection,
				viewColumn: editor.viewColumn,
			};
		}
		this.push(target);
		this.ensurePanel();
		await this.render();
	}

	dispose(): void {
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
		this.disposables.length = 0;
	}

	/**
	 * Come back with the rail, a reload and a relaunch (WO-60), at the symbol you
	 * had navigated to and with the back stack you built getting there.
	 *
	 * Two things a revive deliberately does NOT do: it does not maximize the
	 * editor group (the viewer maximizes when YOU open it; doing that during a
	 * window restore would rearrange a layout nobody touched), and it does not
	 * let the toolchain reach the network.
	 */
	register(): Disposable {
		return window.registerWebviewPanelSerializer(DOCS_VIEW_TYPE, {
			deserializeWebviewPanel: async (panel: WebviewPanel, state: unknown): Promise<void> => {
				const saved = (state ?? {}) as DocViewerState;
				const history = (saved.history ?? []).filter((t): t is DocTarget => !!t && typeof t.label === 'string');
				this.panel?.dispose();
				this.history = [...history];
				this.cursor = typeof saved.cursor === 'number' && saved.cursor >= 0 && saved.cursor < history.length
					? saved.cursor
					: history.length - 1;
				this.restoring = this.cursor >= 0;
				this.panel = panel;
				panel.webview.options = { enableScripts: true };
				panel.webview.html = this.html();
				panel.webview.onDidReceiveMessage((m: Inbound) => this.onMessage(m), undefined, this.disposables);
				panel.onDidDispose(() => this.onDisposed(), undefined, this.disposables);
				await this.render();
			},
		});
	}

	/** Truncate any forward history and append the new target. */
	private push(target: DocTarget): void {
		this.history = this.history.slice(0, this.cursor + 1);
		this.history.push(target);
		this.cursor = this.history.length - 1;
	}

	private current(): DocTarget | undefined {
		return this.cursor >= 0 ? this.history[this.cursor] : undefined;
	}

	/** Create the panel once, or reveal the existing one; then maximize the group. */
	private ensurePanel(): void {
		if (this.panel) {
			this.panel.reveal(this.panel.viewColumn ?? ViewColumn.Active, false);
			return;
		}
		const panel = window.createWebviewPanel(
			DOCS_VIEW_TYPE,
			'Go Docs',
			ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		panel.webview.html = this.html();
		panel.webview.onDidReceiveMessage((m: Inbound) => this.onMessage(m), undefined, this.disposables);
		panel.onDidDispose(() => this.onDisposed(), undefined, this.disposables);
		this.panel = panel;
		this.maximize();
	}

	/** Maximize the editor group so the doc viewer fills the workbench ("fullscreen"). */
	private maximize(): void {
		// Best-effort: never let a missing/renamed workbench command break the viewer.
		void Promise.resolve(commands.executeCommand(MAXIMIZE_COMMAND)).then(
			() => { this.didMaximize = true; },
			() => { /* command unavailable; viewer still works, just not maximized */ },
		);
	}

	private async onMessage(message: Inbound): Promise<void> {
		switch (message.type) {
			case 'ready':
				// The first open()'s render can race the webview load; re-render on ready.
				await this.render();
				return;
			case 'navigate': {
				const target = parseDocTarget(message.input);
				if (target) {
					this.push(target);
					await this.render();
				}
				return;
			}
			case 'back':
				if (this.cursor > 0) {
					this.cursor--;
					await this.render();
				}
				return;
			case 'retry':
				// The button an offline restore offers. Clicking it IS the user
				// asking, so this render may reach the module proxy.
				this.restoring = false;
				await this.render();
				return;
			case 'close':
				this.panel?.dispose();
				return;
			case 'focus':
				// The shared Focus Mode, not a viewer-local one (docs/plans/01 §5).
				void commands.executeCommand('burrow.focus.toggle');
				return;
		}
	}

	/** Run `go doc` for the current target and push the result to the webview. */
	private async render(): Promise<void> {
		const target = this.current();
		const panel = this.panel;
		if (!target || !panel) {
			return;
		}
		const cfg = workspace.getConfiguration('burrow.goDocs');
		const goBin = cfg.get<string>('goPath', 'go') || 'go';
		const showAll = cfg.get<boolean>('showAll', false);
		panel.title = `Go Docs — ${target.label}`;
		void panel.webview.postMessage({ type: 'loading', label: target.label });
		const offline = this.restoring;
		this.restoring = false;
		const result = await runGoDoc(goBin, buildGoDocArgs(target, showAll), this.cwd(), undefined, offline);
		if (this.panel !== panel) {
			// Disposed (or replaced) while awaiting the toolchain — drop the stale result.
			return;
		}
		const canBack = this.cursor > 0;
		// Persist the navigation, not the page — the webview owns the blob the
		// serializer above reads back (WO-60). Only the tail: a long reading
		// session is unbounded, and a panel's state is not a place to keep an
		// unbounded list. Back stops working past HISTORY_CAP hops, which is the
		// smaller of the two costs.
		const from = Math.max(0, this.history.length - HISTORY_CAP);
		void panel.webview.postMessage({ type: 'state', history: this.history.slice(from), cursor: this.cursor - from });
		if (result.ok) {
			void panel.webview.postMessage({ type: 'render', label: target.label, html: renderDocHtml(result.text), canBack });
		} else if (offline) {
			void panel.webview.postMessage({
				type: 'error',
				label: target.label,
				message: `${result.error ?? 'go doc failed'}\n\nThis tab was restored, so Burrow ran the toolchain offline rather than letting it fetch a module you did not ask for.`,
				canBack,
				offline: true,
			});
		} else {
			void panel.webview.postMessage({ type: 'error', label: target.label, message: result.error ?? 'go doc failed', canBack });
		}
	}

	/** The module directory to run `go doc` in, so dependency docs match go.sum. */
	private cwd(): string | undefined {
		const uri = this.savedEditor?.uri;
		if (uri && uri.scheme === 'file') {
			return dirname(uri.fsPath);
		}
		return workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	/** On close: restore the maximize state and return focus to the launching editor. */
	private onDisposed(): void {
		this.panel = undefined;
		this.history = [];
		this.cursor = -1;
		if (this.didMaximize) {
			this.didMaximize = false;
			void Promise.resolve(commands.executeCommand(MAXIMIZE_COMMAND)).then(undefined, () => { /* ignore */ });
		}
		void this.restoreFocus();
	}

	/** Reopen the saved editor at its saved selection (the Esc/✕ exit contract). */
	private async restoreFocus(): Promise<void> {
		const saved = this.savedEditor;
		if (!saved) {
			return;
		}
		try {
			const doc = await workspace.openTextDocument(saved.uri);
			await window.showTextDocument(doc, { viewColumn: saved.viewColumn, selection: saved.selection, preserveFocus: false });
		} catch {
			// The editor may have been closed; nothing to restore to.
		}
	}

	/** The static webview shell; content arrives via postMessage. */
	private html(): string {
		const n = nonce();
		const csp = `default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';`;
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style nonce="${n}">
		:root { color-scheme: light dark; }
		body { margin: 0; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
		#bar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
		#bar button { font: inherit; padding: 2px 8px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-radius: 2px; cursor: pointer; }
		#bar button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
		#bar button:disabled { opacity: .4; cursor: default; }
		#label { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; }
		#search { flex: 1 1 auto; min-width: 80px; font: inherit; padding: 3px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
		#close { flex: 0 0 auto; }
		#content { padding: 14px 20px 40px; max-width: 900px; }
		.pkg { font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; opacity: .8; margin-bottom: 12px; }
		h2.section { font-size: 13px; letter-spacing: .06em; opacity: .75; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; margin: 24px 0 10px; }
		pre.decl { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 4px; overflow-x: auto; white-space: pre; margin: 10px 0 4px; }
		p.doc { margin: 4px 0 12px; line-height: 1.55; }
		.status { opacity: .7; padding: 10px 0; }
		.status.error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
		[hidden] { display: none !important; }
	</style>
</head>
<body>
	<div id="bar">
		<button id="back" title="Back (previously viewed symbol)" disabled>&#8592;</button>
		<span id="label">Go Docs</span>
		<input id="search" type="text" placeholder="Search a package or symbol — e.g. net/http.Request.ParseForm — then Enter" />
		<button id="focus" title="Focus Mode (⌘⇧↩)">&#9974;</button>
		<button id="close" title="Close (Esc)">&#10005;</button>
	</div>
	<div id="content"><div class="status">Loading…</div></div>
	<script nonce="${n}">
		const vscode = acquireVsCodeApi();
		const content = document.getElementById('content');
		const label = document.getElementById('label');
		const search = document.getElementById('search');
		const back = document.getElementById('back');
		document.getElementById('close').addEventListener('click', () => vscode.postMessage({ type: 'close' }));
		// One maximize gesture across every Burrow tool (docs/plans/01 §5): this
		// button drives the shared burrow.focus.toggle, it does not invent a
		// viewer-local fullscreen.
		document.getElementById('focus').addEventListener('click', () => vscode.postMessage({ type: 'focus' }));
		back.addEventListener('click', () => vscode.postMessage({ type: 'back' }));
		search.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				const value = search.value.trim();
				if (value) {
					vscode.postMessage({ type: 'navigate', input: value });
					search.value = '';
				}
			} else if (e.key === 'Escape') {
				// Let Escape close the viewer even from inside the search box.
				e.preventDefault();
				vscode.postMessage({ type: 'close' });
			}
		});
		window.addEventListener('keydown', e => {
			if (e.key === 'Escape') {
				vscode.postMessage({ type: 'close' });
			}
		});
		window.addEventListener('message', e => {
			const m = e.data;
			if (m.type === 'loading') {
				label.textContent = m.label;
				content.innerHTML = '<div class="status">Loading…</div>';
			} else if (m.type === 'render') {
				label.textContent = m.label;
				back.disabled = !m.canBack;
				content.innerHTML = m.html || '<div class="status">No documentation found.</div>';
			} else if (m.type === 'error') {
				label.textContent = m.label;
				back.disabled = !m.canBack;
				const div = document.createElement('div');
				div.className = 'status error';
				div.textContent = m.message;
				content.replaceChildren(div);
				if (m.offline) {
					const retry = document.createElement('button');
					retry.textContent = 'Run go doc anyway';
					retry.style.marginTop = '10px';
					retry.addEventListener('click', () => vscode.postMessage({ type: 'retry' }));
					content.appendChild(retry);
				}
			} else if (m.type === 'state') {
				// WO-60: where you had navigated to, handed back to the serializer on
				// a rail switch, a reload and a relaunch.
				vscode.setState({ history: m.history, cursor: m.cursor });
			}
		});
		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}

/** A 32-char random nonce for the strict inline-script/style CSP. */
function nonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}
