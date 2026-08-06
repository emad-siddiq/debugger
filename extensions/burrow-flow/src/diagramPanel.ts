/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// diagramPanel.ts — hosts the wire diagram in a singleton editor-area
// WebviewPanel and bridges clicks back into the native editor: open a hop's
// source, arm the handler breakpoint, hand a SQL statement or table to the
// burrow-db explorer (with graceful fallbacks when it is not installed).

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { armSymbolBreakpoint } from './breakpoints';
import { defaultExpanded, escapeHtml, LEGEND, REL_LEGEND, renderFlow } from './diagram';
import { Flow, handlerOf } from './model';

interface PanelMessage {
	readonly type: 'open' | 'query' | 'table' | 'breakpoint' | 'exitFocus' | 'refresh' | 'toggle';
	readonly file?: string;
	readonly line?: number;
	readonly col?: number;
	readonly sql?: string;
	readonly table?: string;
	readonly node?: number;
}

/** Everything a REVIVED diagram needs that the panel itself cannot remember: the
 *  project it is drawn against, and the route index to look its flow up in. */
export interface DiagramDeps {
	readonly backendDir: string;
	readonly migrationFor: (table: string) => string | undefined;
	readonly find: (method: string, path: string) => Flow | undefined;
	/** How many leading middlewares every route here shares — the root router's
	 *  stack, which folds behind a count. A project-wide fact, so the panel is
	 *  told it rather than guessing from the one flow it holds. */
	readonly sharedMiddleware: number;
}

/** The panel's own state (WO-60): the ROUTE, never the drawing. The diagram is
 *  derived from `flows.json` in a few milliseconds, so persisting the render
 *  would be storing a cache of a cache. */
interface DiagramPanelState {
	readonly method?: string;
	readonly path?: string;
	readonly help?: boolean;
}

export const DIAGRAM_VIEW_TYPE = 'burrowFlowDiagram';

export class DiagramPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private flow: Flow | undefined;
	private backendDir = '';
	private migrationFor: (table: string) => string | undefined = () => undefined;
	/** Node indexes whose children are drawn. Belongs to the flow on screen, so
	 *  drawing a different route replaces it rather than carrying it over. */
	private expanded = new Set<number>();
	/** Leading middlewares common to every route — folded behind a count. */
	private sharedMw = 0;

	show(flow: Flow, backendDir: string, migrationFor: (table: string) => string | undefined, sharedMw: number): void {
		this.flow = flow;
		this.expanded = defaultExpanded(flow);
		this.backendDir = backendDir;
		this.migrationFor = migrationFor;
		this.sharedMw = sharedMw;
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(
				DIAGRAM_VIEW_TYPE,
				'Wire Diagram',
				{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
				{ enableScripts: true },
			);
			this.adopt(this.panel);
		}
		this.panel.title = `${flow.method} ${flow.path}`;
		this.panel.webview.html = this.html(flow);
		this.panel.reveal(vscode.ViewColumn.Beside, false);
	}

	/**
	 * Come back with the rail, a reload and a relaunch (WO-60).
	 *
	 * The route is re-resolved out of the cached `flows.json` — a local file
	 * read, the same one activation already does, and no request to anything.
	 * When the index is missing (a fresh clone, a workspace that was never
	 * traced) the panel says which route it was for and offers Refresh, rather
	 * than coming back blank or quietly redrawing the wrong thing.
	 */
	register(deps: () => DiagramDeps | undefined): vscode.Disposable {
		return vscode.window.registerWebviewPanelSerializer(DIAGRAM_VIEW_TYPE, {
			deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: unknown): Promise<void> => {
				const saved = (state ?? {}) as DiagramPanelState;
				this.panel?.dispose();
				this.panel = panel;
				this.adopt(panel);
				const wiring = deps();
				const flow = saved.method && saved.path ? wiring?.find(saved.method, saved.path) : undefined;
				if (wiring && flow) {
					this.flow = flow;
					this.expanded = defaultExpanded(flow);
					this.backendDir = wiring.backendDir;
					this.migrationFor = wiring.migrationFor;
					this.sharedMw = wiring.sharedMiddleware;
					panel.title = `${flow.method} ${flow.path}`;
					panel.webview.html = this.html(flow);
					return;
				}
				panel.title = saved.method && saved.path ? `${saved.method} ${saved.path}` : 'Wire Diagram';
				panel.webview.html = unresolvedHtml(saved.method, saved.path, wiring ? 'stale' : 'noproject');
			},
		});
	}

	/** Listener wiring shared by a fresh open and a revive. */
	private adopt(panel: vscode.WebviewPanel): void {
		panel.onDidDispose(() => { this.panel = undefined; });
		panel.webview.onDidReceiveMessage((message: PanelMessage) => this.onMessage(message));
	}

	dispose(): void {
		this.panel?.dispose();
	}

	private async onMessage(message: PanelMessage): Promise<void> {
		switch (message.type) {
			case 'toggle': {
				// Layout stays a pure host function with a node test behind it, so
				// the chevron re-renders rather than re-laying out in the webview.
				// The page is small; the webview restores its own scroll position.
				if (this.flow && this.panel && typeof message.node === 'number') {
					if (!this.expanded.delete(message.node)) {
						this.expanded.add(message.node);
					}
					this.panel.webview.html = this.html(this.flow);
				}
				return;
			}
			case 'refresh': {
				// The button a diagram restored without an index offers. Tracing is
				// explicit work, so it happens because this was clicked.
				await vscode.commands.executeCommand('burrow.flow.refresh');
				return;
			}
			case 'exitFocus': {
				try {
					await vscode.commands.executeCommand('burrow.focus.exit');
				} catch { /* focus mode is another extension's; Esc simply does nothing without it */ }
				return;
			}
			case 'open': {
				if (!message.file) {
					return;
				}
				const uri = vscode.Uri.file(path.join(this.backendDir, message.file));
				try {
					const doc = await vscode.workspace.openTextDocument(uri);
					const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
					const line = Math.max(0, (message.line ?? 1) - 1);
					const pos = new vscode.Position(line, Math.max(0, (message.col ?? 1) - 1));
					editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
					editor.selection = new vscode.Selection(pos, pos);
				} catch {
					void vscode.window.showWarningMessage(`File not found: ${message.file} — refresh the flows?`);
				}
				return;
			}
			case 'breakpoint': {
				const handler = this.flow ? handlerOf(this.flow) : undefined;
				if (handler?.file) {
					await armSymbolBreakpoint(this.backendDir, handler.file, handler.label);
				}
				return;
			}
			case 'query': {
				if (!message.sql) {
					return;
				}
				try {
					await vscode.commands.executeCommand('burrow.db.runQuery', message.sql);
				} catch {
					await vscode.env.clipboard.writeText(message.sql);
					void vscode.window.showInformationMessage('SQL copied to the clipboard (burrow-db not available).');
				}
				return;
			}
			case 'table': {
				if (!message.table) {
					return;
				}
				try {
					await vscode.commands.executeCommand('burrow.db.openTable', message.table);
				} catch {
					const migration = this.migrationFor(message.table);
					if (migration) {
						const uri = vscode.Uri.file(path.join(this.backendDir, 'migrations', migration));
						try {
							await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
						} catch { /* migration file absent — nothing better to show */ }
					}
				}
				return;
			}
		}
	}

	private html(flow: Flow): string {
		const nonce = crypto.randomBytes(16).toString('base64');
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<!-- style-src-attr is load-bearing, not boilerplate. The diagram positions every
	     node with an inline style attribute, and a nonce whitelists <style> ELEMENTS
	     only — never style ATTRIBUTES. Without this the browser silently drops all of
	     them: the SVG edges (plain attributes) still draw in the right places while
	     every node collapses to the canvas origin with a zero-height canvas, which is
	     to say "squiggly lines that don't connect anything". Reported by the user;
	     the nonce still gates the stylesheet and all script. -->
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<style nonce="${nonce}">
		body { font: 13px var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 10px 14px; }
		.head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
		.method { font-weight: 700; padding: 1px 7px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
		.method.get { background: #2d6a4f; color: #fff; } .method.post { background: #1d4e89; color: #fff; }
		.method.put, .method.patch { background: #8a5a00; color: #fff; } .method.delete { background: #7a1e1e; color: #fff; }
		.path { font-size: 15px; font-weight: 600; }
		.reg { opacity: .55; cursor: pointer; } .reg:hover { text-decoration: underline; }
		.badge { font-size: 10px; padding: 0 5px; border-radius: 7px; margin-left: 4px; vertical-align: middle; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
		.badge.write { background: #7a1e1e; color: #fff; } .badge.read { background: #2d6a4f; color: #fff; }
		.badge.partial, .badge.unknown { background: #8a5a00; color: #fff; } .badge.traced { background: #2d6a4f; color: #fff; }
		/* The standing explanation is the same on all 235 routes, so it earns an
		   icon rather than four lines above every diagram. CSS-only reveal:
		   the panel's script budget is for messages back to the host. */
		.info { position: relative; cursor: help; opacity: .55; font-size: 14px; margin-left: 2px; }
		.info:hover, .info:focus { opacity: 1; outline: none; }
		.infopop { display: none; position: absolute; top: 20px; left: 0; z-index: 15; width: 62ch; max-width: 70vw;
			padding: 10px 12px; border-radius: 6px; font-size: 12px; line-height: 1.5; opacity: 1; cursor: default;
			background: var(--vscode-editorWidget-background); color: var(--vscode-foreground);
			border: 1px solid var(--vscode-widget-border, var(--vscode-editorLineNumber-foreground));
			box-shadow: 0 4px 16px rgba(0,0,0,.35); }
		.info:hover .infopop, .info:focus .infopop, .info:focus-within .infopop { display: block; }
		.chiprow { display: flex; align-items: baseline; gap: 8px; margin: 2px 0 8px; flex-wrap: wrap; }
		.chiplabel { font-size: 11px; opacity: .55; white-space: nowrap; }
		.legend { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 12px; font-size: 11px; opacity: .8; }
		.key { padding-left: 8px; border-left: 3px solid var(--vscode-editorLineNumber-foreground); }
		.key.handler { border-left-color: var(--vscode-charts-blue, #3794ff); }
		.key.store { border-left-color: var(--vscode-charts-purple, #b180d7); }
		.key.query { border-left-color: var(--vscode-charts-green, #89d185); }
		.key.table { border-left-color: var(--vscode-charts-orange, #d18616); }
		.key.unknown { border-left-color: var(--vscode-charts-yellow, #cca700); border-left-style: dashed; }
		/* The verbs, keyed the way they are drawn on the curves. */
		.relkey { font-size: 10px; line-height: 15px; padding: 0 6px; border-radius: 8px; opacity: .92;
			background: var(--vscode-editorWidget-background);
			border: 1px solid var(--vscode-widget-border, var(--vscode-editorLineNumber-foreground)); }
		.relkey.reads { background: #2d6a4f; border-color: #2d6a4f; color: #fff; }
		.relkey.writes { background: #7a1e1e; border-color: #7a1e1e; color: #fff; }
		.relkey.unresolved { background: #8a5a00; border-color: #8a5a00; color: #fff; }
		.helpbtn { margin-left: auto; width: 20px; height: 20px; border-radius: 50%; cursor: pointer;
			background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; font-weight: 700; }
		.helpbtn:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		#help { display: none; position: fixed; top: 8px; right: 8px; width: 420px; max-height: 88vh; overflow-y: auto; z-index: 20;
			background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, var(--vscode-editorLineNumber-foreground));
			border-radius: 8px; padding: 12px 14px; box-shadow: 0 6px 24px rgba(0,0,0,.4); }
		#help.on { display: block; }
		.hh { font-weight: 700; margin: 10px 0 4px; } .hh:first-child { margin-top: 0; }
		.hlede { opacity: .8; line-height: 1.5; margin-bottom: 6px; }
		.hrow { display: grid; grid-template-columns: 120px 1fr; gap: 4px 10px; margin: 3px 0; align-items: baseline; }
		.hk { opacity: .95; font-weight: 600; } .hv { opacity: .75; line-height: 1.45; }
		.stale { margin: 0 0 8px; padding: 5px 9px; border-radius: 5px; max-width: 70ch; line-height: 1.45;
			background: var(--vscode-inputValidation-warningBackground, var(--vscode-editorWidget-background));
			border: 1px solid var(--vscode-inputValidation-warningBorder, transparent); }
		.chips { display: flex; flex-wrap: wrap; gap: 4px; }
		/* The root router's stack is true on every route and so tells you nothing
		   about the one you opened. <details> folds it with no script at all. */
		.mwrow { margin: 2px 0 8px; }
		.mwrow summary { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; cursor: pointer; list-style: none; }
		.mwrow summary::-webkit-details-marker { display: none; }
		.mwrow summary::before { content: '▸'; opacity: .55; font-size: 10px; }
		.mwrow[open] summary::before { content: '▾'; }
		.mwcount { font-size: 11px; padding: 1px 8px; border-radius: 9px; opacity: .7;
			background: var(--vscode-editorWidget-background);
			border: 1px dashed var(--vscode-widget-border, var(--vscode-editorLineNumber-foreground)); }
		.mwrow summary:hover .mwcount { opacity: 1; }
		.chips.shared { margin: 5px 0 0 14px; opacity: .8; }
		/* An arm of an if/else is a CHOICE, not a link in the chain. */
		.chip.cond { border-style: dashed; border-color: var(--vscode-charts-yellow, #cca700); }
		.chip { font-size: 11px; padding: 1px 8px; border-radius: 9px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); cursor: pointer; opacity: .85; }
		.chip:hover { opacity: 1; text-decoration: underline; }
		.canvas { position: relative; }
		.edges { position: absolute; inset: 0; }
		.edges path.edge { fill: none; stroke: var(--vscode-editorLineNumber-foreground); stroke-width: 1.4; opacity: .6; }
		/* A 1.4px curve is not a click target. This one is invisible and fat, and
		   it sits UNDER the drawn curve so the hover it reports is the right one. */
		.edges path.edgehit { fill: none; stroke: transparent; stroke-width: 14; cursor: pointer; }
		.edges .arrow path { fill: var(--vscode-editorLineNumber-foreground); stroke: none; opacity: .75; }
		/* The verb on the curve. Colours are the ones already in this panel:
		   read/write reuse the SQL badge pair, unresolved the unknown-node amber. */
		.rel { position: absolute; transform: translate(-50%, -50%); font-size: 10px; line-height: 15px;
			padding: 0 6px; border-radius: 8px; white-space: nowrap; cursor: pointer; letter-spacing: .2px;
			background: var(--vscode-editorWidget-background); color: var(--vscode-foreground); opacity: .92;
			border: 1px solid var(--vscode-widget-border, var(--vscode-editorLineNumber-foreground)); }
		.rel:hover { opacity: 1; border-color: var(--vscode-focusBorder); }
		.rel.reads { background: #2d6a4f; border-color: #2d6a4f; color: #fff; }
		.rel.writes { background: #7a1e1e; border-color: #7a1e1e; color: #fff; }
		.rel.unresolved { background: #8a5a00; border-color: #8a5a00; color: #fff; }
		.edge.reads { stroke: var(--vscode-charts-green, #89d185); }
		.edge.writes { stroke: var(--vscode-charts-red, #f14c4c); }
		.edge.unresolved { stroke: var(--vscode-charts-yellow, #cca700); stroke-dasharray: 4 3; }
		.arrow.reads path { fill: var(--vscode-charts-green, #89d185); }
		.arrow.writes path { fill: var(--vscode-charts-red, #f14c4c); }
		.arrow.unresolved path { fill: var(--vscode-charts-yellow, #cca700); }
		.node { position: absolute; box-sizing: border-box; height: 54px; padding: 6px 8px; border-radius: 6px; cursor: pointer; overflow: hidden;
			background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, var(--vscode-editorLineNumber-foreground)); }
		.node:hover { border-color: var(--vscode-focusBorder); }
		.node.handler { border-left: 3px solid var(--vscode-charts-blue, #3794ff); }
		.node.store { border-left: 3px solid var(--vscode-charts-purple, #b180d7); }
		.node.query { border-left: 3px solid var(--vscode-charts-green, #89d185); }
		.node.table { border-left: 3px solid var(--vscode-charts-orange, #d18616); }
		.node.unknown { border-left: 3px solid var(--vscode-charts-yellow, #cca700); border-style: dashed; }
		/* A node with nowhere to go should not pretend to be a link. */
		.node.dead { cursor: default; opacity: .72; }
		.title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.sub { opacity: .6; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.sub.sql { font-family: var(--vscode-editor-font-family); }
		.act { position: absolute; top: 4px; right: 4px; font-size: 10px; padding: 0 5px; cursor: pointer;
			background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; }
		.act:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		/* Bottom-right: the title owns the top-left of a box and .act the top-right.
		   Its own target, so the box body still opens the source. */
		.chev { position: absolute; bottom: 3px; right: 4px; font-size: 10px; padding: 0 5px; cursor: pointer;
			background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
			border: none; border-radius: 8px; font-variant-numeric: tabular-nums; }
		.chev:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	</style>
</head>
<body>
${renderFlow(flow, this.expanded, this.sharedMw)}
<div id="help">
	<div class="hh">The wire diagram</div>
	<div class="hlede">One route, and everything the backend runs to serve it — read left to right.
		Burrow builds this by reading the Go source, not by watching traffic, so it is here before you
		send a single request.</div>
	<div class="hh">The boxes</div>
	${LEGEND.map(item => `<div class="hrow"><span class="hk">${escapeHtml(item.label)}</span><span class="hv">${escapeHtml(item.what)}</span></div>`).join('')}
	<div class="hh">The curves</div>
	<div class="hlede">Each one is labelled with what the left box does to the right one, and the arrow says
		which way it runs. A box with two curves out of it does two things; a table with two curves in is
		touched twice.</div>
	${REL_LEGEND.map(item => `<div class="hrow"><span class="hk"><span class="relkey ${item.rel}">${escapeHtml(item.rel)}</span></span><span class="hv">${escapeHtml(item.what)}</span></div>`).join('')}
	<div class="hh">Clicking</div>
	<div class="hrow"><span class="hk">a box</span><span class="hv">opens its source at the exact line. A <b>table</b> has no source — it opens in the Data view instead. A faded box is one flowscan could not place, and there is nothing to open.</span></div>
	<div class="hrow"><span class="hk">a curve</span><span class="hv">opens the line where that relation happens — the call itself, not either box's declaration. For a store hop those are different files: the handler calls an <i>interface</i> method and the box names the concrete type that implements it, so the call site is the one place both are visible.</span></div>
	<div class="hrow"><span class="hk">▸&#8202;3</span><span class="hv">reveals the next level under that box. A route is drawn one hop deep to start with, because a busy one runs to dozens of boxes and a picture of all of them at once is not one anybody reads. The chevron counts what is still hidden.</span></div>
	<div class="hrow"><span class="hk">break here</span><span class="hv">sets a breakpoint on the handler. Start the backend and the next request to this route stops in Go, on this line.</span></div>
	<div class="hrow"><span class="hk">run in Data</span><span class="hv">sends that exact SQL to the Data view and runs it. Read-only unless you have turned writes on there.</span></div>
	<div class="hrow"><span class="hk">open in Data</span><span class="hv">opens the table's rows in the Data view.</span></div>
	<div class="hrow"><span class="hk">a chip</span><span class="hv">the middleware that runs before the handler, in the order it runs. Opens where it is mounted.</span></div>
	<div class="hrow"><span class="hk">the file:line</span><span class="hv">top right of the header — where the route is registered, usually the router.</span></div>
	<div class="hh">traced · partial · unknown</div>
	<div class="hrow"><span class="hk">traced</span><span class="hv">followed all the way to the tables.</span></div>
	<div class="hrow"><span class="hk">partial</span><span class="hv">some hops are missing or the SQL was only partly constant — the dashed boxes say why.</span></div>
	<div class="hrow"><span class="hk">unknown</span><span class="hv">the route is registered but nothing past it could be followed.</span></div>
	<div class="hh">One panel, not one per route</div>
	<div class="hlede">Clicking another route redraws <i>this</i> tab rather than opening a second one.
		The editor beside it follows too: the handler's source opens as a preview tab, so the code you
		are looking at is always the route you last clicked.</div>
	<div class="hh">Keys</div>
	<div class="hrow"><span class="hk">?</span><span class="hv">this sheet</span></div>
	<div class="hrow"><span class="hk">Esc</span><span class="hv">closes it, then leaves Focus Mode</span></div>
</div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	// WO-60: the route this tab is for, plus whether the help sheet was open.
	// That is the whole of the diagram's view state — there is no zoom or pan to
	// remember, and the nodes are laid out by the host on every render.
	const ROUTE = { method: ${JSON.stringify(flow.method)}, path: ${JSON.stringify(flow.path)} };
	let saved = Object.assign({ help: false }, vscode.getState() || {}, ROUTE);
	vscode.setState(saved);
	const remember = (patch) => { saved = Object.assign({}, saved, patch); vscode.setState(saved); };
	const help = document.getElementById('help');
	const setHelp = (on) => { help.classList.toggle('on', on); remember({ help: on }); };
	if (saved.help) { help.classList.add('on'); }
	document.getElementById('helpbtn').addEventListener('click', e => { e.stopPropagation(); setHelp(!help.classList.contains('on')); });
	document.addEventListener('keydown', e => {
		if (e.key === '?') { setHelp(true); return; }
		if (e.key !== 'Escape') { return; }
		if (help.classList.contains('on')) { setHelp(false); return; }
		vscode.postMessage({ type: 'exitFocus' });
	});
	// The chevron re-renders on the host, so the page reloads under the user. Put
	// them back where they were looking — otherwise revealing a hop at the far
	// right of a wide route throws them to the top-left of the canvas.
	window.addEventListener('scroll', () => remember({ sx: window.scrollX, sy: window.scrollY }));
	if (saved.sx || saved.sy) { window.scrollTo(saved.sx || 0, saved.sy || 0); }
	document.addEventListener('click', e => {
		if (help.contains(e.target)) { return; }
		if (e.target.id === 'refresh') { vscode.postMessage({ type: 'refresh' }); return; }
		const chev = e.target.closest('.chev');
		if (chev) {
			vscode.postMessage({ type: 'toggle', node: Number(chev.dataset.node) });
			e.stopPropagation();
			return;
		}
		const act = e.target.closest('.act');
		if (act) {
			const node = act.closest('.node');
			if (act.dataset.act === 'query') {
				vscode.postMessage({ type: 'query', sql: node?.dataset.sql || '' });
			} else if (act.dataset.act === 'table') {
				vscode.postMessage({ type: 'table', table: node?.dataset.table || '', file: node?.dataset.file || '' });
			} else if (act.dataset.act === 'breakpoint') {
				vscode.postMessage({ type: 'breakpoint' });
			}
			e.stopPropagation();
			return;
		}
		// .rel and .edgehit are the two halves of a curve — the verb you can see
		// and the fat invisible path under it. Both carry the call site, so a
		// click on either opens the line that joins the two boxes.
		const el = e.target.closest('.node, .chip, .reg, .rel, .edgehit');
		if (el && el.dataset.file) {
			vscode.postMessage({ type: 'open', file: el.dataset.file, line: Number(el.dataset.line || 0), col: Number(el.dataset.col || 0) });
		}
	});
</script>
</body>
</html>`;
	}
}

/**
 * The diagram came back but its route did not (WO-60, "grey with a reason").
 * Two causes, and they need different sentences: no Go backend is open in this
 * window at all, or there is one and the route index has not been built for it.
 */
function unresolvedHtml(method: string | undefined, routePath: string | undefined, why: 'stale' | 'noproject'): string {
	const nonce = crypto.randomBytes(16).toString('base64');
	const route = method && routePath ? `${method} ${routePath}` : 'a route';
	const reason = why === 'noproject'
		? 'No Go backend is open in this window, so there is nothing to trace it against.'
		: 'The route index has not been built in this workspace yet — tracing reads the Go source, and Burrow does not start it because a tab was restored.';
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<style nonce="${nonce}">
		body { font: 13px var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 14px 18px; }
		h3 { font-size: 13px; margin: 0 0 8px; }
		p { max-width: 62ch; line-height: 1.55; opacity: .8; }
		code { font-family: var(--vscode-editor-font-family); }
		button { font: inherit; font-size: 12px; padding: 2px 10px; border: 0; border-radius: 4px; cursor: pointer;
			color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
	</style>
</head>
<body>
	<h3>${escapeHtml(route)}</h3>
	<p>${escapeHtml(reason)}</p>
	${why === 'stale' ? '<button id="refresh">Refresh flows</button>' : ''}
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	vscode.setState({ method: ${JSON.stringify(method ?? null)}, path: ${JSON.stringify(routePath ?? null)} });
	const btn = document.getElementById('refresh');
	if (btn) { btn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' })); }
	document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { vscode.postMessage({ type: 'exitFocus' }); } });
</script>
</body>
</html>`;
}
