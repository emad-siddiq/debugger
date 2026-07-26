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
import { renderFlow } from './diagram';
import { Flow, handlerOf } from './model';

interface PanelMessage {
	readonly type: 'open' | 'query' | 'table' | 'breakpoint';
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
		.chips { margin: 2px 0 10px; display: flex; flex-wrap: wrap; gap: 4px; }
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
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	document.addEventListener('click', e => {
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
