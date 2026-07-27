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
import { escapeHtml, LEGEND, renderFlow } from './diagram';
import { Flow, handlerOf } from './model';

interface PanelMessage {
	readonly type: 'open' | 'query' | 'table' | 'breakpoint' | 'exitFocus';
	readonly file?: string;
	readonly line?: number;
	readonly col?: number;
	readonly sql?: string;
	readonly table?: string;
}

export class DiagramPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private flow: Flow | undefined;
	private backendDir = '';
	private migrationFor: (table: string) => string | undefined = () => undefined;

	show(flow: Flow, backendDir: string, migrationFor: (table: string) => string | undefined): void {
		this.flow = flow;
		this.backendDir = backendDir;
		this.migrationFor = migrationFor;
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(
				'burrowFlowDiagram',
				'Wire Diagram',
				{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
				{ enableScripts: true },
			);
			this.panel.onDidDispose(() => { this.panel = undefined; });
			this.panel.webview.onDidReceiveMessage((message: PanelMessage) => this.onMessage(message));
		}
		this.panel.title = `${flow.method} ${flow.path}`;
		this.panel.webview.html = this.html(flow);
		this.panel.reveal(vscode.ViewColumn.Beside, false);
	}

	dispose(): void {
		this.panel?.dispose();
	}

	private async onMessage(message: PanelMessage): Promise<void> {
		switch (message.type) {
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
		.lede { opacity: .75; margin: 0 0 8px; max-width: 70ch; line-height: 1.45; }
		.lede b { opacity: 1; }
		.chiprow { display: flex; align-items: baseline; gap: 8px; margin: 2px 0 8px; flex-wrap: wrap; }
		.chiplabel { font-size: 11px; opacity: .55; white-space: nowrap; }
		.legend { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 12px; font-size: 11px; opacity: .8; }
		.key { padding-left: 8px; border-left: 3px solid var(--vscode-editorLineNumber-foreground); }
		.key.handler { border-left-color: var(--vscode-charts-blue, #3794ff); }
		.key.store { border-left-color: var(--vscode-charts-purple, #b180d7); }
		.key.query { border-left-color: var(--vscode-charts-green, #89d185); }
		.key.table { border-left-color: var(--vscode-charts-orange, #d18616); }
		.key.unknown { border-left-color: var(--vscode-charts-yellow, #cca700); border-left-style: dashed; }
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
		.chips { display: flex; flex-wrap: wrap; gap: 4px; }
		.chip { font-size: 11px; padding: 1px 8px; border-radius: 9px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); cursor: pointer; opacity: .85; }
		.chip:hover { opacity: 1; text-decoration: underline; }
		.canvas { position: relative; }
		.edges { position: absolute; inset: 0; }
		.edges path { fill: none; stroke: var(--vscode-editorLineNumber-foreground); stroke-width: 1.4; opacity: .6; }
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
	</style>
</head>
<body>
${renderFlow(flow)}
<div id="help">
	<div class="hh">The wire diagram</div>
	<div class="hlede">One route, and everything the backend runs to serve it — read left to right.
		Burrow builds this by reading the Go source, not by watching traffic, so it is here before you
		send a single request.</div>
	<div class="hh">The boxes</div>
	${LEGEND.map(item => `<div class="hrow"><span class="hk">${escapeHtml(item.label)}</span><span class="hv">${escapeHtml(item.what)}</span></div>`).join('')}
	<div class="hrow"><span class="hk">the curves</span><span class="hv">"this calls that". A box with two curves out of it does two things; a table with two curves in is touched twice.</span></div>
	<div class="hh">Clicking</div>
	<div class="hrow"><span class="hk">a box</span><span class="hv">opens its source at the exact line. A <b>table</b> has no source — it opens in the Data view instead. A faded box is one flowscan could not place, and there is nothing to open.</span></div>
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
	const help = document.getElementById('help');
	const setHelp = (on) => help.classList.toggle('on', on);
	document.getElementById('helpbtn').addEventListener('click', e => { e.stopPropagation(); setHelp(!help.classList.contains('on')); });
	document.addEventListener('keydown', e => {
		if (e.key === '?') { setHelp(true); return; }
		if (e.key !== 'Escape') { return; }
		if (help.classList.contains('on')) { setHelp(false); return; }
		vscode.postMessage({ type: 'exitFocus' });
	});
	document.addEventListener('click', e => {
		if (help.contains(e.target)) { return; }
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
		const el = e.target.closest('.node, .chip, .reg');
		if (el && el.dataset.file) {
			vscode.postMessage({ type: 'open', file: el.dataset.file, line: Number(el.dataset.line || 0), col: Number(el.dataset.col || 0) });
		}
	});
</script>
</body>
</html>`;
	}
}
