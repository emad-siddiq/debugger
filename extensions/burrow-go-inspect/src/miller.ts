/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// miller.ts — the Miller-column inspector (IX, architecture task 05.4 "Inspector —
// Miller UI" + 05.5 "Value pane"), the LAYER-4 WEBVIEW PROTOTYPE of the fork task 05
// flags ("Prototype both [webview vs. core view], pick one, record in the patch
// ledger"). It renders, in a webview, the anti-tree Xcode layout: a breadcrumb, at
// most two live columns (the current level + a preview of the selected composite),
// and a value pane below (full value, copy-as-Go-literal, Watch / Break-on-write
// mounts). Depth on screen is always ≤ breadcrumb + two columns — no recursive
// indentation, ever. It reuses the WO-3 model (paths, summaries, change-diff) and
// owns no DAP connection. WO-6 made this the sole Burrow inspector (the WO-4 native
// tree was retired); it registers as the "Inspector (Preview)" view.

import {
	CancellationToken,
	Disposable,
	WebviewView,
	WebviewViewProvider,
	WebviewViewResolveContext,
	debug,
	env,
	window,
} from 'vscode';
import { InspectorModel, InspectorNode, PAGE_SIZE } from './model';
import { toGoLiteral } from './literal';

/** One committed hop in the drill path (a scope or a composite we descended into). */
interface Level {
	readonly label: string;
	readonly variablesReference: number;
	readonly path: readonly string[];
}

/** A resolved row in a column — a scope root or a value, unified for the webview. */
interface Item {
	readonly name: string;
	readonly summary: string;
	readonly kind: string;
	readonly changed: boolean;
	readonly drillable: boolean;
	readonly variablesReference: number;
	readonly path: readonly string[];
	/** Present for value rows (not scopes) — feeds the value pane + copy-as-literal. */
	readonly variable?: InspectorNode['variable'];
}

// ---- wire protocol (host → webview) ----------------------------------------

interface WireRow {
	readonly name: string;
	readonly summary: string;
	readonly kind: string;
	readonly changed: boolean;
	readonly drillable: boolean;
}
interface WireColumn {
	readonly title: string;
	readonly rows: WireRow[];
	readonly selectedIndex: number;
}
interface WireValue {
	readonly name: string;
	readonly type: string;
	readonly value: string;
	readonly kind: string;
	readonly changed: boolean;
}
type WireState =
	| { readonly type: 'empty'; readonly reason: string }
	| { readonly type: 'state'; readonly breadcrumb: string[]; readonly columns: WireColumn[]; readonly value?: WireValue };

// ---- wire protocol (webview → host) ----------------------------------------

type Inbound =
	| { readonly type: 'ready' }
	| { readonly type: 'select'; readonly index: number }
	| { readonly type: 'drill'; readonly index: number }
	| { readonly type: 'up' }
	| { readonly type: 'jump'; readonly depth: number }
	| { readonly type: 'copyLiteral' }
	| { readonly type: 'watch' }
	| { readonly type: 'breakOnWrite' };

export class MillerInspectorProvider implements WebviewViewProvider, Disposable {

	public static readonly viewId = 'burrowInspectorMiller';

	private view: WebviewView | undefined;
	private readonly disposables: Disposable[] = [];

	/** The committed drill path; the deepest level supplies column 1's rows (empty = scopes). */
	private stack: Level[] = [];
	/** Selection within column 1; column 2 previews this row's children. */
	private selectedIndex = 0;
	/** Column-1 items for the current render, so message handlers resolve by index. */
	private currentItems: Item[] = [];

	constructor(private readonly models: Map<string, InspectorModel>) { }

	resolveWebviewView(view: WebviewView, _ctx: WebviewViewResolveContext, _token: CancellationToken): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = this.html();
		this.disposables.push(view.webview.onDidReceiveMessage((m: Inbound) => this.onMessage(m)));
		view.onDidDispose(() => (this.view = undefined), undefined, this.disposables);
		// The webview posts `ready` once its script boots; we render then.
	}

	/** New stop / frame change: refs and paths no longer apply — return to the scopes. */
	reset(): void {
		this.stack = [];
		this.selectedIndex = 0;
		void this.render();
	}

	private activeModel(): InspectorModel | undefined {
		const session = debug.activeDebugSession;
		return session ? this.models.get(session.id) : undefined;
	}

	private async onMessage(message: Inbound): Promise<void> {
		switch (message.type) {
			case 'ready':
				await this.render();
				return;
			case 'select':
				this.selectedIndex = message.index;
				await this.render();
				return;
			case 'drill': {
				const item = this.currentItems[message.index];
				if (item?.drillable) {
					this.stack.push({ label: item.name, variablesReference: item.variablesReference, path: item.path });
					this.selectedIndex = 0;
				}
				await this.render();
				return;
			}
			case 'up':
				this.stack.pop();
				this.selectedIndex = 0;
				await this.render();
				return;
			case 'jump':
				this.stack = this.stack.slice(0, message.depth);
				this.selectedIndex = 0;
				await this.render();
				return;
			case 'copyLiteral':
				await this.copySelectedLiteral();
				return;
			case 'watch':
			case 'breakOnWrite':
				// Watchpoints / watch expressions are task 04 + a later IX slice; the
				// value pane mounts the buttons now so the surface is complete.
				window.showInformationMessage(
					message.type === 'watch'
						? 'Watch: wiring lands with the Watch view (task 05.6).'
						: 'Break on write: wiring lands with dlv watchpoints (task 04).');
				return;
		}
	}

	private async copySelectedLiteral(): Promise<void> {
		const item = this.currentItems[this.selectedIndex];
		if (!item?.variable) {
			return;
		}
		await env.clipboard.writeText(toGoLiteral(item.variable));
		window.showInformationMessage(`Copied ${item.name} as a Go literal.`);
	}

	/** Resolve the current level's rows (scopes at the root, else the deepest level's children). */
	private async rowsFor(model: InspectorModel): Promise<Item[]> {
		if (this.stack.length === 0) {
			const frameId = await model.activeFrameId();
			if (frameId === undefined) {
				return [];
			}
			const scopes = await model.scopes(frameId);
			return scopes
				.filter(scope => !scope.expensive)
				.map(scope => ({
					name: scope.name,
					summary: '',
					kind: 'scope',
					changed: false,
					drillable: true,
					variablesReference: scope.variablesReference,
					path: [scope.name],
				}));
		}
		const top = this.stack[this.stack.length - 1];
		const nodes = await model.children(top.variablesReference, top.path, 0, PAGE_SIZE);
		return nodes.map(itemFromNode);
	}

	private async render(): Promise<void> {
		if (!this.view) {
			return;
		}
		const state = await this.buildState();
		void this.view.webview.postMessage(state);
	}

	private async buildState(): Promise<WireState> {
		const model = this.activeModel();
		if (!model) {
			this.currentItems = [];
			return { type: 'empty', reason: 'No active Go debug session.' };
		}
		try {
			if (this.stack.length === 0 && (await model.activeFrameId()) === undefined) {
				this.currentItems = [];
				return { type: 'empty', reason: 'Session running — stop at a breakpoint to inspect.' };
			}
			const items = await this.rowsFor(model);
			this.currentItems = items;
			if (items.length === 0) {
				return { type: 'state', breadcrumb: this.breadcrumb(), columns: [{ title: this.columnTitle(), rows: [], selectedIndex: -1 }] };
			}
			this.selectedIndex = clamp(this.selectedIndex, 0, items.length - 1);
			const selected = items[this.selectedIndex];

			const column1: WireColumn = { title: this.columnTitle(), rows: items.map(toWireRow), selectedIndex: this.selectedIndex };
			const columns: WireColumn[] = [column1];

			// Column 2 previews the selected composite's children (read-only peek).
			if (selected.drillable) {
				const childNodes = await model.children(selected.variablesReference, selected.path, 0, PAGE_SIZE);
				columns.push({ title: selected.name, rows: childNodes.map(itemFromNode).map(toWireRow), selectedIndex: -1 });
			}

			// The value pane reflects the selected leaf (scopes have no variable).
			const value = selected.variable
				? {
					name: selected.name,
					type: selected.variable.type ?? '',
					value: selected.variable.value,
					kind: selected.kind,
					changed: selected.changed,
				}
				: undefined;

			return { type: 'state', breadcrumb: this.breadcrumb(), columns, value };
		} catch (err) {
			this.currentItems = [];
			return { type: 'empty', reason: `Could not read this level: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	private breadcrumb(): string[] {
		return this.stack.map(level => level.label);
	}

	private columnTitle(): string {
		return this.stack.length ? this.stack[this.stack.length - 1].label : 'Scopes';
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.disposables.length = 0;
	}

	private html(): string {
		const nonce = makeNonce();
		const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
		// Self-contained: inline CSS/JS (no bundler in this extension). Colors come
		// from the workbench's webview CSS variables so it themes automatically.
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style nonce="${nonce}">
		:root { color-scheme: light dark; }
		body { margin: 0; padding: 0; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }
		#breadcrumb { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; overflow-x: auto; font-size: 12px; }
		#breadcrumb .seg { cursor: pointer; color: var(--vscode-textLink-foreground); }
		#breadcrumb .seg:hover { text-decoration: underline; }
		#breadcrumb .sep { opacity: .5; padding: 0 4px; }
		#columns { display: flex; align-items: stretch; }
		.col { flex: 1 1 0; min-width: 0; border-right: 1px solid var(--vscode-panel-border); }
		.col:last-child { border-right: none; }
		.col-title { padding: 3px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; position: sticky; top: 0; background: var(--vscode-sideBar-background); }
		.rows { list-style: none; margin: 0; padding: 0; }
		.row { display: flex; gap: 6px; padding: 2px 8px; cursor: pointer; white-space: nowrap; overflow: hidden; }
		.row:hover { background: var(--vscode-list-hoverBackground); }
		.row.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
		.row .name { flex: 0 0 auto; }
		.row .summary { flex: 1 1 auto; opacity: .8; overflow: hidden; text-overflow: ellipsis; }
		.row .chev { flex: 0 0 auto; opacity: .6; }
		.row .dot { color: var(--vscode-charts-yellow); flex: 0 0 auto; }
		.preview .row { cursor: default; }
		#value { border-top: 1px solid var(--vscode-panel-border); padding: 6px 8px; }
		#value .head { font-size: 12px; margin-bottom: 4px; }
		#value .type { opacity: .7; }
		#value pre { margin: 0 0 6px; padding: 4px 6px; background: var(--vscode-textCodeBlock-background); border-radius: 3px; white-space: pre-wrap; word-break: break-all; max-height: 8em; overflow: auto; }
		#value .actions { display: flex; gap: 6px; flex-wrap: wrap; }
		#value button { font: inherit; padding: 2px 8px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-radius: 2px; cursor: pointer; }
		#value button:hover { background: var(--vscode-button-secondaryHoverBackground); }
		#empty { padding: 12px; opacity: .7; }
		[hidden] { display: none !important; }
	</style>
</head>
<body>
	<div id="breadcrumb"></div>
	<div id="columns"></div>
	<div id="value" hidden></div>
	<div id="empty" hidden></div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const $breadcrumb = document.getElementById('breadcrumb');
		const $columns = document.getElementById('columns');
		const $value = document.getElementById('value');
		const $empty = document.getElementById('empty');
		let selected = 0;      // selected index in column 1
		let colCount = 1;      // rows in column 1 (for keyboard clamping)

		function post(msg) { vscode.postMessage(msg); }

		function renderBreadcrumb(segs) {
			$breadcrumb.textContent = '';
			const root = document.createElement('span');
			root.className = 'seg';
			root.textContent = 'Scopes';
			root.onclick = () => post({ type: 'jump', depth: 0 });
			$breadcrumb.appendChild(root);
			segs.forEach((label, i) => {
				const sep = document.createElement('span');
				sep.className = 'sep';
				sep.textContent = '›';
				$breadcrumb.appendChild(sep);
				const seg = document.createElement('span');
				seg.className = 'seg';
				seg.textContent = label;
				seg.onclick = () => post({ type: 'jump', depth: i + 1 });
				$breadcrumb.appendChild(seg);
			});
		}

		function renderRow(row, index, isPrimary) {
			const li = document.createElement('li');
			li.className = 'row' + (isPrimary && index === selected ? ' sel' : '');
			li.dataset.index = String(index);
			if (row.changed) {
				const dot = document.createElement('span');
				dot.className = 'dot';
				dot.textContent = '●';
				li.appendChild(dot);
			}
			const name = document.createElement('span');
			name.className = 'name';
			name.textContent = row.name;
			li.appendChild(name);
			const summary = document.createElement('span');
			summary.className = 'summary';
			summary.textContent = row.summary;
			li.appendChild(summary);
			if (row.drillable) {
				const chev = document.createElement('span');
				chev.className = 'chev';
				chev.textContent = '›';
				li.appendChild(chev);
			}
			if (isPrimary) {
				li.onclick = () => post({ type: 'select', index });
				li.ondblclick = () => post({ type: 'drill', index });
			}
			return li;
		}

		function renderColumn(col, isPrimary) {
			const wrap = document.createElement('div');
			wrap.className = 'col' + (isPrimary ? '' : ' preview');
			const title = document.createElement('div');
			title.className = 'col-title';
			title.textContent = col.title;
			wrap.appendChild(title);
			const ul = document.createElement('ul');
			ul.className = 'rows';
			col.rows.forEach((row, i) => ul.appendChild(renderRow(row, i, isPrimary)));
			if (col.rows.length === 0) {
				const li = document.createElement('li');
				li.className = 'row';
				li.style.opacity = '.6';
				li.textContent = '(empty)';
				ul.appendChild(li);
			}
			wrap.appendChild(ul);
			return wrap;
		}

		function renderValue(value) {
			if (!value) { $value.hidden = true; return; }
			$value.hidden = false;
			$value.textContent = '';
			const head = document.createElement('div');
			head.className = 'head';
			head.innerHTML = '';
			const nm = document.createElement('strong');
			nm.textContent = value.name;
			head.appendChild(nm);
			const ty = document.createElement('span');
			ty.className = 'type';
			ty.textContent = '  ' + value.type;
			head.appendChild(ty);
			$value.appendChild(head);
			const pre = document.createElement('pre');
			pre.textContent = value.value;
			$value.appendChild(pre);
			const actions = document.createElement('div');
			actions.className = 'actions';
			actions.appendChild(button('Copy as Go literal', () => post({ type: 'copyLiteral' })));
			actions.appendChild(button('Watch', () => post({ type: 'watch' })));
			actions.appendChild(button('Break on write', () => post({ type: 'breakOnWrite' })));
			$value.appendChild(actions);
		}

		function button(label, onClick) {
			const b = document.createElement('button');
			b.textContent = label;
			b.onclick = onClick;
			return b;
		}

		function apply(state) {
			if (state.type === 'empty') {
				$columns.textContent = '';
				$breadcrumb.textContent = '';
				$value.hidden = true;
				$empty.hidden = false;
				$empty.textContent = state.reason;
				return;
			}
			$empty.hidden = true;
			renderBreadcrumb(state.breadcrumb);
			$columns.textContent = '';
			const primary = state.columns[0];
			selected = primary ? primary.selectedIndex : 0;
			colCount = primary ? primary.rows.length : 0;
			state.columns.forEach((col, i) => $columns.appendChild(renderColumn(col, i === 0)));
			renderValue(state.value);
		}

		window.addEventListener('message', e => apply(e.data));

		// Keyboard: ↑↓ move within column 1, → / Enter drill, ← up a level.
		window.addEventListener('keydown', e => {
			if (e.key === 'ArrowDown') { if (selected < colCount - 1) post({ type: 'select', index: selected + 1 }); e.preventDefault(); }
			else if (e.key === 'ArrowUp') { if (selected > 0) post({ type: 'select', index: selected - 1 }); e.preventDefault(); }
			else if (e.key === 'ArrowRight' || e.key === 'Enter') { post({ type: 'drill', index: selected }); e.preventDefault(); }
			else if (e.key === 'ArrowLeft') { post({ type: 'up' }); e.preventDefault(); }
		});

		post({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}

// ---- pure helpers ----------------------------------------------------------

function itemFromNode(node: InspectorNode): Item {
	const drillable = node.summary.expandable && node.variable.variablesReference > 0;
	return {
		name: node.variable.name,
		summary: node.summary.text,
		kind: node.summary.kind,
		changed: node.changed,
		drillable,
		variablesReference: node.variable.variablesReference,
		path: node.path,
		variable: node.variable,
	};
}

function toWireRow(item: Item): WireRow {
	return { name: item.name, summary: item.summary, kind: item.kind, changed: item.changed, drillable: item.drillable };
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

function makeNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}
