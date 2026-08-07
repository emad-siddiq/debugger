/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// frames.ts — the Frames view (IX, architecture task 05.2): the compact call
// stack + the goroutine header/switcher, at the top of the Burrow debug bar. A
// webview, like the inspector and Watch, because it needs the same keyboard model
// and the same themed density — and it reuses the model's DAP plumbing wholesale.
//
// It reads (threads, stackTrace) over DAP directly; the one thing DAP+the
// extension API cannot give it is ACTING on a click — `debug.activeStackItem` is
// read-only — so focusing a frame or a goroutine goes through the core command
// `burrow.debug.focusFrame` (patch 0008).

import {
	CancellationToken,
	Disposable,
	WebviewView,
	WebviewViewProvider,
	WebviewViewResolveContext,
	commands,
	debug,
	workspace,
} from 'vscode';
import { InspectorModel } from './model';
import { Goroutine, countByKind, goroutineLabel, matchesGoroutine, orderGoroutines } from './goroutines';
import { FrameRow, buildRows } from './framerows';
import { nonce } from './webview';
import { ViewHost } from './detachableView';

// ---- wire protocol (host → webview) ----------------------------------------

interface WireHeader {
	readonly current: string;
	readonly user: number;
	readonly system: number;
}
type WireState =
	| { readonly type: 'empty'; readonly reason: string }
	| { readonly type: 'state'; readonly header: WireHeader; readonly rows: FrameRow[]; readonly focusedFrameId: number | undefined; readonly goroutines: WireGoroutine[] };

interface WireGoroutine {
	readonly id: number;
	readonly label: string;
	readonly kind: string;
	readonly current: boolean;
}

// ---- wire protocol (webview → host) ----------------------------------------

type Inbound =
	| { readonly type: 'ready' }
	| { readonly type: 'focusFrame'; readonly frameId: number }
	| { readonly type: 'toggleFold'; readonly foldKey: number }
	| { readonly type: 'switchGoroutine'; readonly id: number };

export class FramesProvider implements WebviewViewProvider, Disposable {

	public static readonly viewId = 'burrowFrames';

	private view: ViewHost | undefined;
	/** Set by extension.ts once the pop-out wrapper exists (patches/0016). */
	public detachable: { resolve(view: WebviewView): void } | undefined;
	private readonly disposables: Disposable[] = [];

	/** Fold runs the user has expanded, keyed by the run's stack index (see framerows). */
	private expanded = new Set<number>();

	constructor(private readonly models: Map<string, InspectorModel>) { }

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
	}

	/** New stop / frame change: fold state no longer maps to the new stack — re-render. */
	refresh(): void {
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
			case 'focusFrame':
				await this.focus(message.frameId);
				return;
			case 'toggleFold':
				if (this.expanded.has(message.foldKey)) {
					this.expanded.delete(message.foldKey);
				} else {
					this.expanded.add(message.foldKey);
				}
				await this.render();
				return;
			case 'switchGoroutine':
				// Focus the goroutine at its top frame. The stop→inspector refresh then
				// follows from the core's own onDidChangeActiveStackItem.
				await this.focusGoroutine(message.id);
				return;
		}
	}

	private async focus(frameId: number): Promise<void> {
		const session = debug.activeDebugSession;
		const model = this.activeModel();
		const threadId = model?.activeThreadId();
		if (session && threadId !== undefined) {
			await commands.executeCommand('burrow.debug.focusFrame', { sessionId: session.id, threadId, frameId });
		}
	}

	private async focusGoroutine(threadId: number): Promise<void> {
		const session = debug.activeDebugSession;
		if (session) {
			await commands.executeCommand('burrow.debug.focusFrame', { sessionId: session.id, threadId });
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
		if (!model) {
			return { type: 'empty', reason: 'No active Go debug session.' };
		}
		try {
			const threads = await model.threads();
			if (threads.length === 0) {
				return { type: 'empty', reason: 'Session running — stop at a breakpoint to see the stack.' };
			}
			const goroutines = orderGoroutines(threads);
			const focusThread = model.activeThreadId() ?? goroutines.find(g => g.current)?.id ?? goroutines[0].id;
			const frames = await model.stackTrace(focusThread);
			const rows = buildRows(frames, this.roots(), this.expanded);
			const focusedFrameId = await model.activeFrameId();
			const counts = countByKind(goroutines);
			return {
				type: 'state',
				header: { current: this.headerLabel(goroutines, focusThread), user: counts.user, system: counts.system },
				rows,
				focusedFrameId,
				goroutines: goroutines.map(toWireGoroutine),
			};
		} catch (err) {
			return { type: 'empty', reason: `Could not read the stack: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	private headerLabel(goroutines: readonly Goroutine[], focusThread: number): string {
		const g = goroutines.find(x => x.id === focusThread) ?? goroutines.find(x => x.current);
		return g ? goroutineLabel(g) : 'goroutine';
	}

	/** Workspace folder paths, for classifying project vs. foreign frames. */
	private roots(): string[] {
		return (workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
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
		body { margin: 0; padding: 0; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }
		#goroutine { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; cursor: pointer; }
		#goroutine:hover { background: var(--vscode-list-hoverBackground); }
		#goroutine .gname { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		#goroutine .badge { flex: 0 0 auto; opacity: .7; font-size: 11px; }
		#goroutine .chev { flex: 0 0 auto; opacity: .6; }
		#picker { display: none; border-bottom: 1px solid var(--vscode-panel-border); }
		#picker.open { display: block; }
		#picker input { width: 100%; box-sizing: border-box; font: inherit; padding: 3px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: none; border-bottom: 1px solid var(--vscode-input-border, transparent); }
		#glist { list-style: none; margin: 0; padding: 0; max-height: 14em; overflow-y: auto; }
		#glist li { padding: 2px 8px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
		#glist li:hover, #glist li.active { background: var(--vscode-list-hoverBackground); }
		#glist li.sys { opacity: .6; }
		#frames { list-style: none; margin: 0; padding: 0; }
		.frame { display: flex; gap: 8px; padding: 2px 8px; cursor: pointer; white-space: nowrap; overflow: hidden; }
		.frame:hover { background: var(--vscode-list-hoverBackground); }
		.frame.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
		.frame .func { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
		.frame.foreign .func { opacity: .65; }
		.frame .loc { flex: 1 1 auto; text-align: right; opacity: .6; overflow: hidden; text-overflow: ellipsis; }
		.fold { padding: 2px 8px; cursor: pointer; opacity: .6; font-size: 12px; }
		.fold:hover { opacity: .9; background: var(--vscode-list-hoverBackground); }
		#empty { padding: 12px; opacity: .7; }
		[hidden] { display: none !important; }
	</style>
</head>
<body>
	<div id="goroutine" hidden></div>
	<div id="picker"><input id="gsearch" type="text" placeholder="Filter goroutines…" /><ul id="glist"></ul></div>
	<ul id="frames"></ul>
	<div id="empty" hidden></div>
	<script nonce="${n}">
		const vscode = acquireVsCodeApi();
		const $goroutine = document.getElementById('goroutine');
		const $picker = document.getElementById('picker');
		const $search = document.getElementById('gsearch');
		const $glist = document.getElementById('glist');
		const $frames = document.getElementById('frames');
		const $empty = document.getElementById('empty');
		let goroutines = [];
		let frames = [];         // frame rows for keyboard nav (frame + fold)
		let selected = 0;        // selected index among focusable frame rows

		function post(msg) { vscode.postMessage(msg); }

		function renderHeader(header) {
			$goroutine.hidden = false;
			$goroutine.textContent = '';
			const name = document.createElement('span');
			name.className = 'gname';
			name.textContent = header.current;
			const badge = document.createElement('span');
			badge.className = 'badge';
			badge.textContent = header.user + ' user · ' + header.system + ' sys';
			const chev = document.createElement('span');
			chev.className = 'chev';
			chev.textContent = '▾';
			$goroutine.append(name, badge, chev);
		}

		function renderPicker() {
			$glist.textContent = '';
			const q = $search.value;
			goroutines.forEach(g => {
				if (!matches(g, q)) { return; }
				const li = document.createElement('li');
				li.className = (g.kind === 'system' ? 'sys' : '') + (g.current ? ' active' : '');
				li.textContent = (g.current ? '● ' : '') + g.label;
				li.onclick = () => { closePicker(); post({ type: 'switchGoroutine', id: g.id }); };
				$glist.appendChild(li);
			});
		}

		// The host already filters nothing; we filter client-side so typing is instant.
		function matches(g, q) {
			const s = (q || '').trim().toLowerCase();
			return s === '' || g.label.toLowerCase().includes(s);
		}

		function openPicker() { $picker.classList.add('open'); $search.value = ''; renderPicker(); $search.focus(); }
		function closePicker() { $picker.classList.remove('open'); }
		function togglePicker() { $picker.classList.contains('open') ? closePicker() : openPicker(); }

		function renderFrames(rows, focusedFrameId) {
			$frames.textContent = '';
			frames = rows;
			rows.forEach((row, i) => {
				if (row.type === 'fold') {
					const li = document.createElement('li');
					li.className = 'fold';
					li.dataset.index = String(i);
					li.textContent = row.label + ' ⋯ (' + row.count + ')';
					li.onclick = () => post({ type: 'toggleFold', foldKey: row.foldKey });
					$frames.appendChild(li);
				} else {
					const li = document.createElement('li');
					li.className = 'frame' + (row.foreign ? ' foreign' : '') + (row.frameId === focusedFrameId ? ' sel' : '');
					li.dataset.index = String(i);
					const fn = document.createElement('span');
					fn.className = 'func';
					fn.textContent = row.func;
					const loc = document.createElement('span');
					loc.className = 'loc';
					loc.textContent = row.location;
					li.append(fn, loc);
					li.onclick = () => post({ type: 'focusFrame', frameId: row.frameId });
					if (row.frameId === focusedFrameId) { selected = i; }
					$frames.appendChild(li);
				}
			});
		}

		function apply(state) {
			if (state.type === 'empty') {
				$goroutine.hidden = true;
				$picker.classList.remove('open');
				$frames.textContent = '';
				$empty.hidden = false;
				$empty.textContent = state.reason;
				return;
			}
			$empty.hidden = true;
			goroutines = state.goroutines;
			renderHeader(state.header);
			if ($picker.classList.contains('open')) { renderPicker(); }
			renderFrames(state.rows, state.focusedFrameId);
		}

		$goroutine.onclick = togglePicker;
		$search.oninput = renderPicker;
		$search.onkeydown = e => { if (e.key === 'Escape') { closePicker(); } e.stopPropagation(); };
		window.addEventListener('message', e => apply(e.data));

		// Keyboard: ↑↓ move among frame rows, Enter focus, g open the goroutine picker.
		function act(i) {
			const row = frames[i];
			if (!row) { return; }
			if (row.type === 'fold') { post({ type: 'toggleFold', foldKey: row.foldKey }); }
			else { post({ type: 'focusFrame', frameId: row.frameId }); }
		}
		window.addEventListener('keydown', e => {
			if (e.target && e.target.tagName === 'INPUT') { return; }
			if (e.key === 'ArrowDown') { selected = Math.min(frames.length - 1, selected + 1); highlight(); }
			else if (e.key === 'ArrowUp') { selected = Math.max(0, selected - 1); highlight(); }
			else if (e.key === 'Enter') { act(selected); }
			else if (e.key === 'g') { togglePicker(); }
			else { return; }
			e.preventDefault();
		});
		function highlight() {
			Array.from($frames.children).forEach(li => li.classList.toggle('sel', Number(li.dataset.index) === selected));
			const el = $frames.querySelector('.sel');
			if (el) { el.scrollIntoView({ block: 'nearest' }); }
		}

		post({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}

function toWireGoroutine(g: Goroutine): WireGoroutine {
	return { id: g.id, label: goroutineLabel(g), kind: g.kind, current: g.current };
}

// Re-exported so the webview's client-side filter and the host stay in sync on
// what "matches" means (the host does not filter, but tests exercise the rule).
export { matchesGoroutine };
