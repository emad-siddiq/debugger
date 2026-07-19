/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// watch.ts — the Burrow Watch view (IX, architecture task 05.6): a flat list of
// user expressions rendered with the **same summary renderer** as the inspector and
// the **same value pane** on select (copy-as-Go-literal). Expressions persist per
// workspace; invalid-in-this-frame watches **gray out** instead of erroring. It
// evaluates through `InspectorModel.evaluate` (DAP `evaluate`, `context: 'watch'`)
// and owns no DAP connection. This is the layer-4 replacement for the stock Watch
// view retired by core patch 0007.

import {
	CancellationToken,
	Disposable,
	Memento,
	WebviewView,
	WebviewViewProvider,
	WebviewViewResolveContext,
	debug,
	env,
	window,
} from 'vscode';
import { InspectorModel } from './model';
import { summarize, DapVariable } from './summary';
import { toGoLiteral } from './literal';
import { nonce, valuePaneCss } from './webview';

const STORE_KEY = 'burrow.watch.expressions';

interface WireRow {
	readonly expr: string;
	readonly summary: string;
	readonly kind: string;
	readonly valid: boolean;
}
interface WireValue {
	readonly name: string;
	readonly type: string;
	readonly value: string;
}
type WireState =
	| { readonly type: 'empty'; readonly reason: string; readonly rows: WireRow[] }
	| { readonly type: 'state'; readonly rows: WireRow[]; readonly value?: WireValue };

type Inbound =
	| { readonly type: 'ready' }
	| { readonly type: 'add'; readonly expr: string }
	| { readonly type: 'remove'; readonly index: number }
	| { readonly type: 'select'; readonly index: number }
	| { readonly type: 'copyLiteral' }
	| { readonly type: 'clear' };

/** One evaluated watch row kept host-side so message handlers resolve by index. */
interface Resolved {
	readonly expr: string;
	readonly variable?: DapVariable;
	readonly valid: boolean;
}

export class WatchProvider implements WebviewViewProvider, Disposable {

	public static readonly viewId = 'burrowWatch';

	private view: WebviewView | undefined;
	private readonly disposables: Disposable[] = [];
	private expressions: string[];
	private resolved: Resolved[] = [];
	private selectedIndex = 0;

	constructor(private readonly models: Map<string, InspectorModel>, private readonly store: Memento) {
		this.expressions = store.get<string[]>(STORE_KEY, []);
	}

	resolveWebviewView(view: WebviewView, _ctx: WebviewViewResolveContext, _token: CancellationToken): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = this.html();
		this.disposables.push(view.webview.onDidReceiveMessage((m: Inbound) => this.onMessage(m)));
		view.onDidDispose(() => (this.view = undefined), undefined, this.disposables);
	}

	/** New stop / frame change: re-evaluate everything against the current frame. */
	refresh(): void {
		void this.render();
	}

	/** Add a watch from elsewhere (the inspector's value-pane "Watch" button). */
	addExpression(expr: string): void {
		const trimmed = expr.trim();
		if (!trimmed || this.expressions.includes(trimmed)) {
			return;
		}
		this.expressions.push(trimmed);
		void this.persist();
		void this.render();
	}

	private activeModel(): InspectorModel | undefined {
		const session = debug.activeDebugSession;
		return session ? this.models.get(session.id) : undefined;
	}

	private async persist(): Promise<void> {
		await this.store.update(STORE_KEY, this.expressions);
	}

	private async onMessage(message: Inbound): Promise<void> {
		switch (message.type) {
			case 'ready':
				await this.render();
				return;
			case 'add':
				this.addExpression(message.expr);
				return;
			case 'remove':
				this.expressions.splice(message.index, 1);
				await this.persist();
				await this.render();
				return;
			case 'select':
				this.selectedIndex = message.index;
				await this.render();
				return;
			case 'clear':
				this.expressions = [];
				await this.persist();
				await this.render();
				return;
			case 'copyLiteral': {
				const row = this.resolved[this.selectedIndex];
				if (row?.variable) {
					await env.clipboard.writeText(toGoLiteral(row.variable));
					window.showInformationMessage(`Copied ${row.expr} as a Go literal.`);
				}
				return;
			}
		}
	}

	private async render(): Promise<void> {
		if (!this.view) {
			return;
		}
		void this.view.webview.postMessage(await this.buildState());
	}

	private async buildState(): Promise<WireState> {
		const model = this.activeModel();
		const frameId = model ? await model.activeFrameId() : undefined;

		// Evaluate every expression against the current frame (undefined = invalid).
		this.resolved = [];
		for (const expr of this.expressions) {
			const variable = model && frameId !== undefined ? await model.evaluate(expr, frameId) : undefined;
			this.resolved.push({ expr, variable, valid: !!variable });
		}
		const rows: WireRow[] = this.resolved.map(r => ({
			expr: r.expr,
			summary: r.variable ? summarize(r.variable).text : '',
			kind: r.variable ? summarize(r.variable).kind : 'other',
			valid: r.valid,
		}));

		if (!model || frameId === undefined) {
			const reason = !model ? 'No active Go debug session.' : 'Session running — stop at a breakpoint to evaluate watches.';
			return { type: 'empty', reason, rows };
		}

		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, rows.length - 1));
		const sel = this.resolved[this.selectedIndex];
		const value = sel?.variable
			? { name: sel.expr, type: sel.variable.type ?? '', value: sel.variable.value }
			: undefined;
		return { type: 'state', rows, value };
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.disposables.length = 0;
	}

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
		body { margin: 0; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }
		#add { display: flex; gap: 4px; padding: 4px 6px; border-bottom: 1px solid var(--vscode-panel-border); }
		#add input { flex: 1 1 auto; min-width: 0; font: inherit; padding: 2px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
		.rows { list-style: none; margin: 0; padding: 0; }
		.row { display: flex; gap: 6px; padding: 2px 8px; cursor: pointer; white-space: nowrap; overflow: hidden; align-items: baseline; }
		.row:hover { background: var(--vscode-list-hoverBackground); }
		.row.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
		.row.invalid { opacity: .45; font-style: italic; }
		.row .expr { flex: 0 0 auto; font-weight: 600; }
		.row .summary { flex: 1 1 auto; opacity: .85; overflow: hidden; text-overflow: ellipsis; }
		.row .rm { flex: 0 0 auto; opacity: .5; cursor: pointer; }
		.row .rm:hover { opacity: 1; }
		#hint { padding: 8px; opacity: .6; }
		${valuePaneCss()}
	</style>
</head>
<body>
	<div id="add"><input id="expr" type="text" placeholder="Add expression to watch…" aria-label="Add watch expression"></div>
	<ul class="rows" id="rows"></ul>
	<div id="hint" hidden></div>
	<div id="value" hidden></div>
	<script nonce="${n}">
		const vscode = acquireVsCodeApi();
		const $rows = document.getElementById('rows');
		const $hint = document.getElementById('hint');
		const $value = document.getElementById('value');
		const $expr = document.getElementById('expr');
		let selected = 0, count = 0;
		function post(m) { vscode.postMessage(m); }

		$expr.addEventListener('keydown', e => {
			if (e.key === 'Enter' && $expr.value.trim()) { post({ type: 'add', expr: $expr.value.trim() }); $expr.value = ''; }
		});

		function renderRow(row, i) {
			const li = document.createElement('li');
			li.className = 'row' + (i === selected ? ' sel' : '') + (row.valid ? '' : ' invalid');
			const expr = document.createElement('span'); expr.className = 'expr'; expr.textContent = row.expr; li.appendChild(expr);
			const sum = document.createElement('span'); sum.className = 'summary'; sum.textContent = row.valid ? row.summary : 'not available in this frame'; li.appendChild(sum);
			const rm = document.createElement('span'); rm.className = 'rm'; rm.textContent = '✕'; rm.title = 'Remove';
			rm.onclick = e => { e.stopPropagation(); post({ type: 'remove', index: i }); };
			li.appendChild(rm);
			li.onclick = () => post({ type: 'select', index: i });
			return li;
		}

		function renderValue(value) {
			if (!value) { $value.hidden = true; return; }
			$value.hidden = false; $value.textContent = '';
			const head = document.createElement('div'); head.className = 'head';
			const nm = document.createElement('strong'); nm.textContent = value.name; head.appendChild(nm);
			const ty = document.createElement('span'); ty.className = 'type'; ty.textContent = '  ' + value.type; head.appendChild(ty);
			$value.appendChild(head);
			const pre = document.createElement('pre'); pre.textContent = value.value; $value.appendChild(pre);
			const actions = document.createElement('div'); actions.className = 'actions';
			const b = document.createElement('button'); b.textContent = 'Copy as Go literal'; b.onclick = () => post({ type: 'copyLiteral' });
			actions.appendChild(b); $value.appendChild(actions);
		}

		function apply(state) {
			const rows = state.rows || [];
			selected = Math.max(0, Math.min(selected, rows.length - 1));
			count = rows.length;
			$rows.textContent = '';
			rows.forEach((r, i) => $rows.appendChild(renderRow(r, i)));
			if (state.type === 'empty') { $hint.hidden = false; $hint.textContent = state.reason; $value.hidden = true; }
			else { $hint.hidden = true; renderValue(state.value); }
		}

		window.addEventListener('message', e => { const s = e.data; selected = s.rows ? Math.min(selected, s.rows.length - 1) : 0; apply(s); });
		window.addEventListener('keydown', e => {
			if (document.activeElement === $expr) { return; }
			if (e.key === 'ArrowDown' && selected < count - 1) { selected++; post({ type: 'select', index: selected }); e.preventDefault(); }
			else if (e.key === 'ArrowUp' && selected > 0) { selected--; post({ type: 'select', index: selected }); e.preventDefault(); }
		});
		post({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}
