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
// tree was retired). WO-15 closed the value-pane parity gap — set-value on scalar
// l-values (DAP setVariable) and copy-JSON — so it registers as "Inspector", no
// longer "(Preview)".

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
import { DapVariable, summarize } from './summary';
import { toGoLiteral } from './literal';
import { nonce, valuePaneCss } from './webview';
import { ViewHost } from './detachableView';

/** How long a render request waits for its duplicates before it runs. */
const COALESCE_MS = 8;

/** One committed hop in the drill path (a scope or a composite we descended into). */
interface Level {
	readonly label: string;
	/** Not readonly: a set-value re-anchors this to a fresh ref (dlv staleness, see setSelectedValue). */
	variablesReference: number;
	readonly path: readonly string[];
	/** Total indexed children (slice/array/map length); paged when it exceeds a page. */
	readonly indexed?: number;
	/** First index shown for a paged level — the pager's window into the collection. */
	pageStart: number;
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
	/** Total indexed children, carried so drilling knows to page (slices/maps). */
	readonly indexed?: number;
	/** Present for value rows (not scopes) — feeds the value pane + copy-as-literal. */
	readonly variable?: InspectorNode['variable'];
}

/** The window a paged column is showing, for the pager strip. */
interface WirePage {
	readonly start: number;
	readonly shown: number;
	readonly total: number;
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
	/** Set only for a paged level — drives the "101–200 of 50,000" strip. */
	readonly page?: WirePage;
	/** The active filter text + how many rows it hid, for the filter box + count. */
	readonly filter?: { readonly text: string; readonly matched: number; readonly total: number; readonly paged: boolean };
}
interface WireValue {
	readonly name: string;
	readonly type: string;
	readonly value: string;
	readonly kind: string;
	readonly changed: boolean;
	/** Whether "Set value…" applies — a value inside a scope, not a scope root. */
	readonly settable: boolean;
}
type WireState =
	| { readonly type: 'empty'; readonly reason: string }
	| { readonly type: 'state'; readonly breadcrumb: string[]; readonly columns: WireColumn[]; readonly value?: WireValue; readonly trace?: string };

// ---- wire protocol (webview → host) ----------------------------------------

type Inbound =
	| { readonly type: 'ready' }
	| { readonly type: 'select'; readonly index: number }
	| { readonly type: 'drill'; readonly index: number }
	| { readonly type: 'up' }
	| { readonly type: 'jump'; readonly depth: number }
	| { readonly type: 'copyLiteral' }
	| { readonly type: 'copyJson' }
	| { readonly type: 'setValue' }
	| { readonly type: 'watch' }
	| { readonly type: 'breakOnWrite' }
	| { readonly type: 'pageBy'; readonly pages: number }
	| { readonly type: 'pageTo'; readonly index: number }
	| { readonly type: 'filter'; readonly text: string; readonly open?: boolean }
	| { readonly type: 'painted'; readonly trace: string; readonly ms: number; readonly how: 'paint' | 'timeout' };

export class MillerInspectorProvider implements WebviewViewProvider, Disposable {

	public static readonly viewId = 'burrowInspectorMiller';

	private view: ViewHost | undefined;
	/** Set by extension.ts once the pop-out wrapper exists (patches/0016). */
	public detachable: { resolve(view: WebviewView): void } | undefined;
	private readonly disposables: Disposable[] = [];

	/** The committed drill path; the deepest level supplies column 1's rows (empty = scopes). */
	private stack: Level[] = [];
	/** Selection within column 1; column 2 previews this row's children. */
	private selectedIndex = 0;
	/** Column-1 items for the current render, so message handlers resolve by index. */
	private currentItems: Item[] = [];
	/** The active per-column type-ahead filter (task 05.4); '' = matches everything. */
	private filterText = '';
	/** Whether the filter box is open (it shows even while empty, once '/' opens it). */
	private filterActive = false;

	/** Set by the extension to route the value pane's "Watch" button to the Watch view. */
	onWatch: ((expression: string) => void) | undefined;

	// Perf tracing (task 05.8: "stop → painted inspector < 150 ms"). The host stamps
	// a start time and a label onto each render; the webview reports back the moment
	// the DOM it produced has actually been painted. Timing from here — rather than
	// from a CDP driver — is the only way to measure what the user waits for: it
	// spans the DAP round-trips, the postMessage hop AND layout.
	private traces = new Map<string, { readonly label: string; readonly t0: number }>();
	private traceSeq = 0;
	private pendingRender: { readonly label: string; readonly t0: number } | undefined;

	private readonly perf = window.createOutputChannel('Burrow Inspector Perf');

	constructor(private readonly models: Map<string, InspectorModel>) {
		this.disposables.push(this.perf);
	}

	/**
	 * The rail slot. Delegated to `DetachableView` (patches/0016) when a pop-out
	 * wrapper is wired, so the same content can live here or in a floating
	 * window; `attach` below is the body this used to be.
	 */
	resolveWebviewView(view: WebviewView, _ctx: WebviewViewResolveContext, _token: CancellationToken): void {
		if (this.detachable) {
			this.detachable.resolve(view);
			return;
		}
		this.attach(view);
	}

	/** Wire a host — a rail slot or a popped-out panel; this cannot tell which. */
	attach(view: ViewHost): void {
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
		this.scheduleRender('stop');
	}

	/**
	 * Collapse a burst of refresh requests into one render (task 05.8).
	 *
	 * One stop reaches us twice — the adapter tracker sees the `stopped` event and
	 * `onDidChangeActiveStackItem` fires for the frame the debugger focuses — and
	 * each render is a full DAP pass (scopes, the selected scope's children, a
	 * `variables` round-trip per pointer summary). Rendering both doubled the work
	 * a user waits through for a result the second render throws away.
	 *
	 * The trace clock starts with the FIRST request in the burst, not with the
	 * render, so coalescing can't flatter the measurement by hiding its own delay.
	 */
	private scheduleRender(label: string): void {
		if (!this.pendingRender) {
			this.pendingRender = { label, t0: Date.now() };
			setTimeout(() => {
				const pending = this.pendingRender;
				this.pendingRender = undefined;
				if (pending) {
					void this.render(pending.label, pending.t0);
				}
			}, COALESCE_MS);
		}
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
					this.stack.push({ label: item.name, variablesReference: item.variablesReference, path: item.path, indexed: item.indexed, pageStart: 0 });
					this.selectedIndex = 0;
					this.filterText = ''; this.filterActive = false; // a new level starts unfiltered
				}
				await this.render('drill');
				return;
			}
			case 'up':
				this.stack.pop();
				this.selectedIndex = 0;
				this.filterText = '';
				this.filterActive = false;
				await this.render();
				return;
			case 'jump':
				this.stack = this.stack.slice(0, message.depth);
				this.selectedIndex = 0;
				this.filterText = '';
				this.filterActive = false;
				await this.render();
				return;
			case 'copyLiteral':
				await this.copySelectedLiteral();
				return;
			case 'copyJson':
				await this.copySelectedJson();
				return;
			case 'setValue':
				await this.setSelectedValue();
				return;
			case 'watch': {
				// Route the selected value's re-evaluable expression to the Watch view.
				const item = this.currentItems[this.selectedIndex];
				const expr = item?.variable?.evaluateName ?? item?.name;
				if (expr && this.onWatch) {
					this.onWatch(expr);
					window.showInformationMessage(`Watching ${expr}.`);
				}
				return;
			}
			case 'breakOnWrite':
				// dlv watchpoints are task 04; the value pane mounts the button now so
				// the surface is complete.
				window.showInformationMessage('Break on write: wiring lands with dlv watchpoints (task 04).');
				return;
			case 'pageBy':
				this.movePage(message.pages * PAGE_SIZE);
				await this.render('page');
				return;
			case 'pageTo':
				// Land on the page CONTAINING the index, so "jump to 12345" shows it in
				// context rather than making it row 0 of an arbitrary window.
				this.seekPage(Math.floor(message.index / PAGE_SIZE) * PAGE_SIZE);
				await this.render('page');
				return;
			case 'filter':
				this.filterText = message.text;
				this.filterActive = message.text !== '' || message.open === true;
				this.selectedIndex = 0;
				await this.render('filter');
				return;
			case 'painted': {
				const trace = this.traces.get(message.trace);
				this.traces.delete(message.trace);
				if (trace) {
					const total = Math.round(Date.now() - trace.t0);
					this.perf.appendLine(`${trace.label}\t${total} ms host→${message.how === 'paint' ? 'painted' : 'DOM (window not compositing — upper bound)'} (webview ${Math.round(message.ms)} ms)`);
					// Echo it back so the last sample is readable from the DOM. The perf
					// DoD ("stop → painted < 150 ms") is checked by an out-of-process
					// driver, which can see the webview but not the output channel.
					void this.view?.webview.postMessage({ type: 'perf', label: trace.label, ms: total, how: message.how });
				}
				return;
			}
		}
	}

	/** The paged level currently supplying column 1, if any. */
	private pagedLevel(): Level | undefined {
		const top = this.stack[this.stack.length - 1];
		return top && isPaged(top) ? top : undefined;
	}

	private movePage(delta: number): void {
		const level = this.pagedLevel();
		if (level) {
			this.seekPage(level.pageStart + delta);
		}
	}

	private seekPage(start: number): void {
		const level = this.pagedLevel();
		if (!level) {
			return;
		}
		const last = Math.max(0, Math.floor(((level.indexed ?? 0) - 1) / PAGE_SIZE) * PAGE_SIZE);
		level.pageStart = clamp(start, 0, last);
		this.selectedIndex = 0;
	}

	private async copySelectedLiteral(): Promise<void> {
		const item = this.currentItems[this.selectedIndex];
		if (!item?.variable) {
			return;
		}
		await env.clipboard.writeText(toGoLiteral(item.variable));
		window.showInformationMessage(`Copied ${item.name} as a Go literal.`);
	}

	private async copySelectedJson(): Promise<void> {
		const item = this.currentItems[this.selectedIndex];
		const model = this.activeModel();
		if (!item?.variable || !model) {
			return;
		}
		try {
			const value = await toJsonValue(model, item.variable, item.path, 0);
			await env.clipboard.writeText(JSON.stringify(value, null, 2));
			window.showInformationMessage(`Copied ${item.name} as JSON.`);
		} catch (err) {
			window.showErrorMessage(`Copy JSON failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Set the selected value in place (task 05.5). The parent for DAP `setVariable`
	 * is the deepest committed level; a value at the scopes root (a scope itself) is
	 * not an l-value, which the `settable` flag already gates in the UI.
	 */
	private async setSelectedValue(): Promise<void> {
		const item = this.currentItems[this.selectedIndex];
		const parent = this.stack[this.stack.length - 1];
		const model = this.activeModel();
		if (!item?.variable || !parent || !model) {
			window.showWarningMessage('Select a value inside a scope to edit it.');
			return;
		}
		const input = await window.showInputBox({
			title: `Set ${item.name}`,
			value: item.variable.value,
			prompt: 'dlv accepts a Go literal; strings may also use a call expression.',
		});
		if (input === undefined) {
			return; // cancelled
		}
		try {
			const now = await model.setVariable(parent.variablesReference, item.name, input);
			// dlv's cached handles are stale after a set (the old ref returns the old
			// value), so re-anchor the current level to a fresh ref before rendering —
			// otherwise the column would redraw the pre-set value and look like a no-op.
			const fresh = await model.resolveRef(parent.path);
			if (fresh !== undefined) {
				parent.variablesReference = fresh;
			}
			window.showInformationMessage(`${item.name} = ${now}`);
			await this.render('setValue');
		} catch (err) {
			window.showErrorMessage(`Set failed: ${err instanceof Error ? err.message : String(err)}`);
		}
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
		return (await this.readLevel(model, top, top.pageStart)).map(itemFromNode);
	}

	/** A level's rows: one page for a large collection, everything otherwise. */
	private async readLevel(model: InspectorModel, level: { variablesReference: number; path: readonly string[]; indexed?: number }, start: number): Promise<InspectorNode[]> {
		if (!isPaged(level)) {
			return model.children(level.variablesReference, level.path);
		}
		return model.page(level.variablesReference, level.path, start, PAGE_SIZE);
	}

	private async render(label = 'render', t0 = Date.now()): Promise<void> {
		if (!this.view) {
			return;
		}
		// The clock starts BEFORE building: the DAP round-trips buildState makes are
		// part of what the user waits for, so they have to be inside the measurement.
		const trace = `t${this.traceSeq++}`;
		this.traces.set(trace, { label, t0 });
		const state = await this.buildState();
		void this.view.webview.postMessage(state.type === 'state' ? { ...state, trace } : state);
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
			const allItems = await this.rowsFor(model);
			// Type-ahead filter (task 05.4). Applied here so `currentItems` — the index
			// space every message handler (select/drill/copy) resolves against — matches
			// exactly what the column shows. On a paged level the filter narrows the
			// LOADED PAGE only, not all 50k; the box labels itself so that is not a lie
			// (whole-collection content filtering needs a dlv-side predicate — deferred,
			// same boundary as WO-10's jump-to-index).
			const items = this.filterText ? allItems.filter(it => matchesItem(it, this.filterText)) : allItems;
			this.currentItems = items;
			if (items.length === 0) {
				const paged = this.pagedLevel();
				const empty: WireColumn = {
					title: this.columnTitle(),
					rows: [],
					selectedIndex: -1,
					filter: this.filterActive ? { text: this.filterText, matched: 0, total: allItems.length, paged: !!paged } : undefined,
				};
				return { type: 'state', breadcrumb: this.breadcrumb(), columns: [empty] };
			}
			this.selectedIndex = clamp(this.selectedIndex, 0, items.length - 1);
			const selected = items[this.selectedIndex];

			const paged = this.pagedLevel();
			const column1: WireColumn = {
				title: this.columnTitle(),
				rows: items.map(toWireRow),
				selectedIndex: this.selectedIndex,
				page: paged ? { start: paged.pageStart, shown: allItems.length, total: paged.indexed ?? allItems.length } : undefined,
				filter: this.filterActive ? { text: this.filterText, matched: items.length, total: allItems.length, paged: !!paged } : undefined,
			};
			const columns: WireColumn[] = [column1];

			// Column 2 previews the selected composite's children (read-only peek) —
			// first page only; you page it once you drill in.
			if (selected.drillable) {
				const childNodes = await this.readLevel(model, selected, 0);
				columns.push({ title: selected.name, rows: childNodes.map(itemFromNode).map(toWireRow), selectedIndex: -1 });
			}

			// The value pane reflects the selected leaf (scopes have no variable). It is
			// settable only inside a scope (stack non-empty) and when it is a scalar —
			// dlv's setVariable rejects composites, so offering it there would only
			// produce an error dialog.
			const value = selected.variable
				? {
					name: selected.name,
					type: selected.variable.type ?? '',
					value: selected.variable.value,
					kind: selected.kind,
					changed: selected.changed,
					settable: this.stack.length > 0 && isScalarKind(selected.kind),
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
		const n = nonce();
		const csp = `default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';`;
		// Self-contained: inline CSS/JS (no bundler in this extension). Colors come
		// from the workbench's webview CSS variables so it themes automatically.
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style nonce="${n}">
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
		.pager { display: flex; align-items: center; gap: 6px; padding: 2px 8px; font-size: 11px; border-bottom: 1px solid var(--vscode-panel-border); opacity: .85; }
		.pager button { font: inherit; padding: 0 5px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 2px; }
		.pager button:disabled { opacity: .4; cursor: default; }
		.pager .range { flex: 1 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.pager input { width: 7ch; font: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
		.filter { display: flex; align-items: center; gap: 6px; padding: 2px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
		.filter input { flex: 1 1 auto; font: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 1px 5px; }
		.filter .count { flex: 0 0 auto; font-size: 11px; opacity: .7; white-space: nowrap; }
		.filter .count.none { color: var(--vscode-errorForeground); opacity: .9; }
		#empty { padding: 12px; opacity: .7; }
		${valuePaneCss()}
	</style>
</head>
<body>
	<div id="breadcrumb"></div>
	<div id="columns"></div>
	<div id="value" hidden></div>
	<div id="empty" hidden></div>
	<script nonce="${n}">
		const vscode = acquireVsCodeApi();
		const $breadcrumb = document.getElementById('breadcrumb');
		const $columns = document.getElementById('columns');
		const $value = document.getElementById('value');
		const $empty = document.getElementById('empty');
		let selected = 0;      // selected index in column 1
		let colCount = 1;      // rows in column 1 (for keyboard clamping)
		let paged = false;     // column 1 is a window over a large collection
		let $jump = null;      // the pager's jump-to-index input, when present
		let $filter = null;    // the type-ahead filter input, when present
		let filtering = false; // whether column 1 currently has a filter box

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

		// A paged column gets a strip: where you are, prev/next, and jump-to-index.
		// Without it a 100-row window over 50,000 elements looks exactly like a
		// 100-element collection — the UI would be lying about the data.
		function renderPager(page) {
			const bar = document.createElement('div');
			bar.className = 'pager';
			const last = page.start + page.shown;
			const range = document.createElement('span');
			range.className = 'range';
			range.textContent = (page.start + 1).toLocaleString() + '–' + last.toLocaleString() + ' of ' + page.total.toLocaleString();
			const prev = button('‹', () => post({ type: 'pageBy', pages: -1 }));
			prev.disabled = page.start === 0;
			const next = button('›', () => post({ type: 'pageBy', pages: 1 }));
			next.disabled = last >= page.total;
			const jump = document.createElement('input');
			jump.type = 'number';
			jump.min = '0';
			jump.max = String(page.total - 1);
			jump.placeholder = 'index';
			jump.title = 'Jump to index (Enter)';
			jump.onkeydown = e => {
				if (e.key === 'Enter' && jump.value !== '') { post({ type: 'pageTo', index: Number(jump.value) }); }
				if (e.key === 'Escape') { jump.blur(); }
				e.stopPropagation();
			};
			$jump = jump;
			bar.append(prev, range, next, jump);
			return bar;
		}

		// The type-ahead filter box for column 1. Shown once the user starts filtering
		// (via '/'); its count says how many rows matched, and — on a paged level —
		// that the filter only sees the loaded page.
		function renderFilter(filter) {
			const bar = document.createElement('div');
			bar.className = 'filter';
			const input = document.createElement('input');
			input.type = 'text';
			input.placeholder = filter.paged ? 'Filter this page…' : 'Filter…';
			input.value = filter.text;
			input.oninput = () => post({ type: 'filter', text: input.value });
			input.onkeydown = e => {
				if (e.key === 'Escape') { post({ type: 'filter', text: '' }); }
				if (e.key === 'Enter' || e.key === 'ArrowDown') { input.blur(); }
				e.stopPropagation();
			};
			const count = document.createElement('span');
			count.className = 'count' + (filter.matched === 0 ? ' none' : '');
			count.textContent = filter.matched + ' of ' + filter.total + (filter.paged ? ' on page' : '');
			$filter = input;
			bar.append(input, count);
			return bar;
		}

		function renderColumn(col, isPrimary) {
			const wrap = document.createElement('div');
			wrap.className = 'col' + (isPrimary ? '' : ' preview');
			const title = document.createElement('div');
			title.className = 'col-title';
			title.textContent = col.title;
			wrap.appendChild(title);
			if (isPrimary && col.page) { wrap.appendChild(renderPager(col.page)); }
			if (isPrimary && col.filter) { wrap.appendChild(renderFilter(col.filter)); }
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
			if (value.settable) { actions.appendChild(button('Set value…', () => post({ type: 'setValue' }))); }
			actions.appendChild(button('Copy as Go literal', () => post({ type: 'copyLiteral' })));
			actions.appendChild(button('Copy JSON', () => post({ type: 'copyJson' })));
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
			$jump = null;
			$filter = null;
			const primary = state.columns[0];
			selected = primary ? primary.selectedIndex : 0;
			colCount = primary ? primary.rows.length : 0;
			paged = !!(primary && primary.page);
			filtering = !!(primary && primary.filter);
			state.columns.forEach((col, i) => $columns.appendChild(renderColumn(col, i === 0)));
			renderValue(state.value);
			// Keep focus in the filter box across the re-render each keystroke triggers,
			// so typing is uninterrupted; the caret goes to the end.
			if ($filter && document.activeElement !== $filter && filtering) {
				const v = $filter.value; $filter.focus(); $filter.setSelectionRange(v.length, v.length);
			}
		}

		window.addEventListener('message', e => {
			if (e.data && e.data.type === 'perf') {
				document.body.dataset.perf = e.data.label + ':' + e.data.ms + ':' + e.data.how;
				return;
			}
			const t0 = performance.now();
			apply(e.data);
			// Two frames: the first fires after layout is scheduled, the second after
			// the browser has actually painted it. Reporting on the first would time
			// our DOM writes, not what the user sees.
			//
			// The timeout is not belt-and-braces: an unfocused or occluded window is
			// not compositing, so rAF never fires there and the sample would silently
			// vanish. We report anyway and label the clock 'timeout', because a
			// measurement whose provenance is unknown is worse than no measurement.
			if (e.data && e.data.trace) {
				const trace = e.data.trace;
				let done = false;
				const report = how => {
					if (!done) { done = true; post({ type: 'painted', trace: trace, ms: performance.now() - t0, how: how }); }
				};
				requestAnimationFrame(() => requestAnimationFrame(() => report('paint')));
				setTimeout(() => report('timeout'), 300);
			}
		});

		// Keyboard (task 05.8 — the whole inspector without the mouse):
		//   ↑↓ move · →/Enter drill · ← up a level · Home/End first/last row
		//   PageDown/PageUp next/prev page of a large collection (jump 10 rows if not paged)
		//   / filter · g jump-to-index · c copy literal · e set value · w watch
		// Escape in a focused input closes the filter (handled on the input); Escape
		// with focus outside also closes it, so the filter never traps the keyboard.
		const select = index => { if (index !== selected && index >= 0 && index < colCount) { post({ type: 'select', index: index }); } };
		window.addEventListener('keydown', e => {
			if (e.target && e.target.tagName === 'INPUT') { return; }
			const key = e.key;
			if (key === 'ArrowDown') { select(selected + 1); }
			else if (key === 'ArrowUp') { select(selected - 1); }
			else if (key === 'ArrowRight' || key === 'Enter') { post({ type: 'drill', index: selected }); }
			else if (key === 'ArrowLeft') { post({ type: 'up' }); }
			else if (key === 'Home') { select(0); }
			else if (key === 'End') { select(colCount - 1); }
			else if (key === 'PageDown') { paged ? post({ type: 'pageBy', pages: 1 }) : select(Math.min(colCount - 1, selected + 10)); }
			else if (key === 'PageUp') { paged ? post({ type: 'pageBy', pages: -1 }) : select(Math.max(0, selected - 10)); }
			else if (key === '/') { $filter ? $filter.focus() : post({ type: 'filter', text: '', open: true }); }
			else if (key === 'Escape' && filtering) { post({ type: 'filter', text: '' }); }
			else if (key === 'g') { if ($jump) { $jump.focus(); $jump.select(); } }
			else if (key === 'c') { post({ type: 'copyLiteral' }); }
			else if (key === 'e') { post({ type: 'setValue' }); }
			else if (key === 'w') { post({ type: 'watch' }); }
			else { return; }
			e.preventDefault();
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
		indexed: node.variable.indexedVariables,
		variable: node.variable,
	};
}

/** A level pages when it has more indexed children than fit on one page. */
function isPaged(level: { indexed?: number }): boolean {
	return (level.indexed ?? 0) > PAGE_SIZE;
}

/** Case-insensitive substring match over a row's name and its summary. */
function matchesItem(item: Item, query: string): boolean {
	const q = query.trim().toLowerCase();
	return q === '' || item.name.toLowerCase().includes(q) || item.summary.toLowerCase().includes(q);
}

/** The kinds dlv's setVariable accepts (scalars) — composites it rejects. */
function isScalarKind(kind: string): boolean {
	return kind === 'number' || kind === 'bool' || kind === 'string';
}

/** Depth/breadth caps for copy-JSON, so exporting a deep or huge value terminates. */
const JSON_MAX_DEPTH = 8;
const JSON_MAX_CHILDREN = 200;

/**
 * A JSON value for the inspector's "Copy JSON" (task 05.5 value pane). Recurses
 * through the DAP child model — scalars map to JS primitives, structs/maps to
 * objects, slices/arrays to arrays — with caps so a 50k slice or a cyclic pointer
 * graph can't run away. Truncation and depth limits are marked in-band ("…") so the
 * output never silently claims to be complete.
 */
async function toJsonValue(model: InspectorModel, variable: DapVariable, path: readonly string[], depth: number): Promise<unknown> {
	const kind = summarize(variable).kind;
	const value = variable.value ?? '';
	if (kind === 'nil') {
		return null;
	}
	if (kind === 'number') {
		const n = Number(value);
		return Number.isFinite(n) ? n : value;
	}
	if (kind === 'bool') {
		return value === 'true';
	}
	if (kind === 'string') {
		return unquote(value);
	}
	// Composite. Without a child ref (or past the depth cap) fall back to dlv's
	// rendered summary string — still valid JSON, just not structured.
	if (variable.variablesReference <= 0 || depth >= JSON_MAX_DEPTH) {
		return value || summarize(variable).text;
	}
	const nodes = await model.children(variable.variablesReference, path);
	const capped = nodes.slice(0, JSON_MAX_CHILDREN);
	const isArray = kind === 'slice' || kind === 'array' || kind === 'bytes';
	if (isArray) {
		const out: unknown[] = [];
		for (const node of capped) {
			out.push(await toJsonValue(model, node.variable, node.path, depth + 1));
		}
		if (nodes.length > capped.length) {
			out.push(`… ${nodes.length - capped.length} more`);
		}
		return out;
	}
	// struct / map / pointer / other composite → object keyed by child name.
	const obj: Record<string, unknown> = {};
	for (const node of capped) {
		obj[unquote(node.variable.name)] = await toJsonValue(model, node.variable, node.path, depth + 1);
	}
	if (nodes.length > capped.length) {
		obj['…'] = `${nodes.length - capped.length} more`;
	}
	return obj;
}

/** Strip dlv's surrounding double quotes from a string, if present. */
function unquote(s: string): string {
	return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

function toWireRow(item: Item): WireRow {
	return { name: item.name, summary: item.summary, kind: item.kind, changed: item.changed, drillable: item.drillable };
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}
