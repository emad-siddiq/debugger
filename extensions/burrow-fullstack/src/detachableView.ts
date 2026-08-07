/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { detachable } from './toolSurface';

// Pop out / dock for a sidebar/panel WebviewView (patches/0016).
//
// The workbench can move an EDITOR into a floating window. It cannot move a
// view: there is no auxiliary views part in 1.128, no `moveViewToNewWindow`,
// nothing under `browser/parts/views/` that knows about auxiliary windows at
// all. Building one is a workbench feature, not a patch.
//
// So a view that wants a second monitor has to become an editor first. That is
// all this file does: it re-hosts the same HTML and the same message protocol
// in a WebviewPanel, which the workbench will then happily float. The provider
// does not learn anything about windows — it keeps rendering into a `ViewHost`
// and cannot tell which kind it got.
//
// Copied per extension, like toolSurface.ts, for the same reason: built-in
// extensions have no shared bundle.

/**
 * The slice of `WebviewView` Burrow's view providers actually use. `WebviewView`
 * satisfies it structurally; `panelHost()` makes a `WebviewPanel` satisfy it too.
 */
export interface ViewHost {
	readonly webview: vscode.Webview;
	readonly visible: boolean;
	readonly onDidChangeVisibility: vscode.Event<void>;
	readonly onDidDispose: vscode.Event<void>;
	title?: string;
	description?: string;
	show(preserveFocus?: boolean): void;
}

export interface DetachableViewSpec {
	/** The container view's id, e.g. `burrowVizPane`. Used for `<viewId>.focus` on dock. */
	readonly viewId: string;
	/** The hosted panel's viewType. Must be distinct from `viewId` and stable across releases. */
	readonly viewType: string;
	/** The floating window's tab title. */
	readonly title: string;
	/** The provider's existing `resolveWebviewView` body, taking a `ViewHost`. */
	attach(host: ViewHost): void;
	/** One line for the placeholder left behind in the rail. Defaults to the title. */
	readonly placeholderLabel?: string;
}

/** Adapt a `WebviewPanel` to `ViewHost`. */
function panelHost(panel: vscode.WebviewPanel): ViewHost {
	return {
		webview: panel.webview,
		get visible() { return panel.visible; },
		// A panel reports view state (visible + active); a view reports visibility
		// alone. Providers only ever ask "am I on screen", so the extra bit is dropped.
		onDidChangeVisibility: (listener, thisArgs, disposables) =>
			panel.onDidChangeViewState(() => listener.call(thisArgs), undefined, disposables),
		onDidDispose: panel.onDidDispose,
		get title() { return panel.title; },
		set title(value: string | undefined) { if (value) { panel.title = value; } },
		// A panel has no description line. Folding it into the title would make the
		// tab jitter as the description changes, so it is dropped — the pane's own
		// header (every Burrow view draws one) still says what it is showing.
		description: undefined,
		show: (preserveFocus?: boolean) => panel.reveal(undefined, preserveFocus),
	};
}

/**
 * Owns one view's pop-out lifecycle. Construct once, delegate the provider's
 * `resolveWebviewView` to `resolve()`, and wire `popOut`/`dock` to commands.
 */
export class DetachableView implements vscode.Disposable {

	private view: vscode.WebviewView | undefined;
	private panel: vscode.WebviewPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly spec: DetachableViewSpec,
		private readonly memento: vscode.Memento,
	) {
		// The panel, once it exists, is an ordinary Burrow surface: it gets the
		// same Pop Out / Dock title buttons every other one gets. Pop Out on an
		// already-floating panel is a no-op the workbench handles; Dock returns it
		// to the main editor area, from where `dock()` puts it back in the rail.
		this.disposables.push(detachable(spec.viewType));
	}

	/** `true` while the content lives in a panel rather than in the rail. */
	get detached(): boolean {
		return this.panel !== undefined || this.memento.get<boolean>(this.stateKey) === true;
	}

	private get stateKey(): string {
		return `burrow.window.detached:${this.spec.viewId}`;
	}

	/**
	 * Call this from `resolveWebviewView`. While detached the rail slot shows a
	 * placeholder instead of live content — the provider keeps ONE host, and
	 * letting the container re-attach would silently steal it back from the
	 * floating window on the next rail switch.
	 */
	resolve(view: vscode.WebviewView): void {
		this.view = view;
		view.onDidDispose(() => { if (this.view === view) { this.view = undefined; } }, undefined, this.disposables);
		if (this.detached) {
			this.showPlaceholder(view);
			return;
		}
		this.spec.attach(view);
	}

	/** Move the content into a panel and push that panel into a floating window. */
	async popOut(): Promise<void> {
		if (!this.panel) {
			const panel = vscode.window.createWebviewPanel(
				this.spec.viewType,
				this.spec.title,
				vscode.ViewColumn.Active,
				{ enableScripts: true, retainContextWhenHidden: true },
			);
			this.adoptPanel(panel);
		}
		this.panel?.reveal(undefined, false);
		await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
		// Only now is the rail slot definitely not the live host.
		if (this.view) {
			this.showPlaceholder(this.view);
		}
	}

	/** Dispose the panel and put the content back in the rail. */
	async dock(): Promise<void> {
		this.panel?.dispose(); // onDidDispose re-attaches the rail slot
		await vscode.commands.executeCommand(`${this.spec.viewId}.focus`);
	}

	/** Survive a reload: a floating hosted view comes back floating. */
	register(): vscode.Disposable {
		return vscode.window.registerWebviewPanelSerializer(this.spec.viewType, {
			deserializeWebviewPanel: async (panel: vscode.WebviewPanel): Promise<void> => {
				this.panel?.dispose();
				this.adoptPanel(panel);
			},
		});
	}

	private adoptPanel(panel: vscode.WebviewPanel): void {
		this.panel = panel;
		void this.memento.update(this.stateKey, true);
		panel.onDidDispose(() => {
			this.panel = undefined;
			void this.memento.update(this.stateKey, undefined);
			// Re-attach the rail slot if it is mounted. If it is not, the next
			// `resolve()` sees `detached === false` and attaches for real.
			if (this.view) {
				this.spec.attach(this.view);
			}
		}, undefined, this.disposables);
		this.spec.attach(panelHost(panel));
	}

	private showPlaceholder(view: vscode.WebviewView): void {
		view.webview.options = { enableScripts: true };
		// No shared nonce helper in this extension; one is cheap.
		const n = Array.from({ length: 24 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');
		const label = this.spec.placeholderLabel ?? this.spec.title;
		// Everything inline and nonced: a style-src of `nonce-…` alone drops every
		// inline style="…" attribute silently, so there are none here.
		view.webview.html = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
	<style nonce="${n}">
		body { margin: 0; padding: 16px 12px; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-descriptionForeground); text-align: center; }
		p { margin: 0 0 10px; line-height: 1.5; }
		button { font: inherit; padding: 3px 12px; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 2px; }
		button:hover { background: var(--vscode-button-hoverBackground); }
	</style>
</head>
<body>
	<p>${label} is showing in a separate window.</p>
	<button id="dock">Dock it back here</button>
	<script nonce="${n}">
		const vscode = acquireVsCodeApi();
		document.getElementById('dock').addEventListener('click', () => vscode.postMessage({ type: 'dock' }));
	</script>
</body>
</html>`;
		this.disposables.push(view.webview.onDidReceiveMessage((m: { type?: string }) => {
			if (m?.type === 'dock') {
				void this.dock();
			}
		}));
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.disposables.length = 0;
		this.panel?.dispose();
	}
}
