/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import {
	CancellationToken,
	Disposable,
	WebviewView,
	WebviewViewProvider,
	WebviewViewResolveContext,
} from 'vscode';
import { ViewHost } from './detachableView';
import { asciiText, detectView, hexDump, toBase64, tryPrettyJson, HexRow } from './hexdump';
import { BytePayload } from './model';
import { nonce } from './webview';

// vizview.ts — the webview mount for the []byte / string hex-ASCII visualizer
// (architecture task 06.1's "webview component in the value pane" + 06.3's byte
// viewer). The host computes every view (hex rows, ASCII text, pretty JSON,
// base64) from the SINGLE source of truth in hexdump.ts and ships them to the
// webview, which only swaps between the precomputed strings — so the formatting
// logic stays pure and unit-tested, never re-implemented in the DOM.

/** The message the webview posts once its script has booted and can accept a render. */
interface ReadyMessage {
	readonly type: 'ready';
}

/** What the host sends the webview to paint; all views are precomputed host-side. */
interface RenderState {
	readonly type: 'render';
	readonly label: string;
	readonly goType: string;
	readonly total: number;
	readonly complete: boolean;
	readonly view: string;
	readonly hex: HexRow[];
	readonly text: string;
	readonly json: string | undefined;
	readonly base64: string;
}

/** Shown before any value is visualized, or when a value has no bytes. */
interface EmptyState {
	readonly type: 'empty';
	readonly message: string;
}

export class VizViewProvider implements WebviewViewProvider, Disposable {

	public static readonly viewId = 'burrowVizPane';

	private view: ViewHost | undefined;
	/** Set by extension.ts once the pop-out wrapper exists. */
	public detachable: { resolve(view: WebviewView): void } | undefined;
	private ready = false;
	private pending: RenderState | EmptyState = { type: 'empty', message: 'Select a []byte value and run “Burrow: Visualize Value as Hex / ASCII”.' };
	private readonly disposables: Disposable[] = [];

	/**
	 * The rail slot. Delegated to `DetachableView` (patches/0016) so the same
	 * content can live here or in a floating window; `attach` below is the body
	 * this used to be, and it cannot tell which host it got.
	 */
	resolveWebviewView(view: WebviewView, _ctx: WebviewViewResolveContext, _token: CancellationToken): void {
		if (this.detachable) {
			this.detachable.resolve(view);
			return;
		}
		this.attach(view);
	}

	/** Wire a host: strict CSP, script boot handshake, dispose tracking. */
	attach(view: ViewHost): void {
		this.view = view;
		this.ready = false;
		view.webview.options = { enableScripts: true };
		view.webview.html = this.html();
		this.disposables.push(view.webview.onDidReceiveMessage((m: ReadyMessage) => {
			if (m.type === 'ready') {
				this.ready = true;
				this.flush();
			}
		}));
		view.onDidDispose(() => {
			this.view = undefined;
			this.ready = false;
		}, undefined, this.disposables);
	}

	/**
	 * Visualize a resolved byte payload: derive every view from hexdump.ts, stash the
	 * render state, and paint it (now if the webview is live, else on its next `ready`).
	 * `label` is the source expression so the pane titles what it is showing.
	 */
	show(label: string, payload: BytePayload): void {
		if (payload.bytes.length === 0) {
			this.pending = { type: 'empty', message: `${label} (${payload.type}) has no bytes to show.` };
		} else {
			this.pending = {
				type: 'render',
				label,
				goType: payload.type,
				total: payload.total,
				complete: payload.complete,
				view: detectView(payload.bytes),
				hex: hexDump(payload.bytes),
				text: asciiText(payload.bytes),
				json: tryPrettyJson(payload.bytes),
				base64: toBase64(payload.bytes),
			};
		}
		this.flush();
	}

	private flush(): void {
		if (this.view && this.ready) {
			void this.view.webview.postMessage(this.pending);
		}
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.disposables.length = 0;
	}

	private html(): string {
		const n = nonce();
		const csp = `default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';`;
		// Self-contained: inline CSS/JS themed via the workbench's webview CSS variables.
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style nonce="${n}">
		:root { color-scheme: light dark; }
		body { margin: 0; padding: 0; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }
		#head { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
		#head .label { font-weight: 600; }
		#head .type { opacity: .7; }
		#head .note { opacity: .6; margin-left: auto; }
		#tabs { display: flex; gap: 4px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
		#tabs button { font: inherit; padding: 1px 8px; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-radius: 2px; }
		#tabs button:hover { background: var(--vscode-button-secondaryHoverBackground); }
		#tabs button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		#tabs button[hidden] { display: none; }
		#body { padding: 6px 8px; overflow: auto; }
		pre { margin: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 12px); white-space: pre; }
		.hex .off { color: var(--vscode-descriptionForeground); }
		.hex .asc { color: var(--vscode-charts-blue); }
		.hex .gut { opacity: .5; }
		#empty { padding: 12px; opacity: .7; }
		[hidden] { display: none !important; }
	</style>
</head>
<body>
	<div id="head" hidden><span class="label"></span><span class="type"></span><span class="note"></span></div>
	<div id="tabs" hidden>
		<button data-view="hex">Hex</button>
		<button data-view="text">Text</button>
		<button data-view="json">JSON</button>
		<button data-view="base64">Base64</button>
	</div>
	<div id="body"></div>
	<div id="empty"></div>
	<script nonce="${n}">
		const vscode = acquireVsCodeApi();
		const $head = document.getElementById('head');
		const $label = $head.querySelector('.label');
		const $type = $head.querySelector('.type');
		const $note = $head.querySelector('.note');
		const $tabs = document.getElementById('tabs');
		const $body = document.getElementById('body');
		const $empty = document.getElementById('empty');
		let state = null;
		let view = 'hex';

		function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

		function renderHex() {
			const lines = state.hex.map(r =>
				'<span class="off">' + r.offset + '</span>  ' +
				esc(r.hex.padEnd(49, ' ')) +
				'  <span class="gut">|</span><span class="asc">' + esc(r.ascii) + '</span><span class="gut">|</span>'
			);
			return '<pre class="hex">' + lines.join('\\n') + '</pre>';
		}

		function renderText(s) { return '<pre>' + esc(s) + '</pre>'; }

		function paint() {
			if (!state || state.type === 'empty') {
				$head.hidden = true;
				$tabs.hidden = true;
				$body.textContent = '';
				$empty.hidden = false;
				$empty.textContent = state ? state.message : '';
				return;
			}
			$empty.hidden = true;
			$head.hidden = false;
			$tabs.hidden = false;
			$label.textContent = state.label;
			$type.textContent = state.goType;
			$note.textContent = state.complete ? (state.total + ' bytes') : ('first ' + state.hex.reduce((n, r) => n + r.ascii.length, 0) + ' of ' + state.total + ' bytes');
			for (const btn of $tabs.querySelectorAll('button')) {
				const v = btn.getAttribute('data-view');
				btn.hidden = (v === 'json' && state.json == null);
				btn.classList.toggle('active', v === view);
			}
			if (view === 'hex') { $body.innerHTML = renderHex(); }
			else if (view === 'text') { $body.innerHTML = renderText(state.text); }
			else if (view === 'json') { $body.innerHTML = renderText(state.json != null ? state.json : state.text); }
			else { $body.innerHTML = renderText(state.base64); }
		}

		$tabs.addEventListener('click', e => {
			const btn = e.target.closest('button');
			if (btn) { view = btn.getAttribute('data-view'); paint(); }
		});

		window.addEventListener('message', e => {
			state = e.data;
			if (state && state.type === 'render') { view = state.view; }
			paint();
		});

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}
