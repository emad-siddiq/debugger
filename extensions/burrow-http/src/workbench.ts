/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// workbench.ts — the editor-area webview that hosts the HTTP workbench (architecture
// task 09, task 4: the "workbench panel"). This first slice is the request picker +
// response viewer: it lists the requests in the active `.http` document, sends the one
// the user picks (re-reading + re-parsing the document so live edits count), and renders
// the response with render.ts. It owns a single reusable panel.

import { Disposable, TextDocument, Uri, ViewColumn, WebviewPanel, commands, window, workspace } from 'vscode';
import { interpolate, parseHttpFile, resolveRequest, resolveVariables } from './httpFile';
import { renderError, renderResponse } from './render';
import { sendRequest } from './send';

/** A 24-char nonce for the strict inline-script CSP. */
function nonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 24; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}

/** Owns the singleton HTTP workbench panel and the pick → send → render loop. */
export class HttpWorkbench implements Disposable {
	private panel: WebviewPanel | undefined;
	/** The `.http` document the panel is bound to; re-read on each send. */
	private docUri: Uri | undefined;
	private readonly disposables: Disposable[] = [];

	/** Read the send timeout (ms) from configuration; `0` disables it. */
	private timeoutMs(): number {
		return workspace.getConfiguration('burrow.http').get<number>('timeoutMs', 30000);
	}

	/**
	 * Reveal the workbench for `document`, populate the request picker, and (when
	 * `sendLine` is given, e.g. from a codelens) immediately send that request.
	 */
	public open(document: TextDocument, sendLine?: number): void {
		this.docUri = document.uri;
		if (!this.panel) {
			this.panel = window.createWebviewPanel(
				'burrowHttpWorkbench',
				'HTTP Workbench',
				{ viewColumn: ViewColumn.Beside, preserveFocus: true },
				{ enableScripts: true, retainContextWhenHidden: true },
			);
			this.panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.disposables);
			this.panel.webview.onDidReceiveMessage(message => this.onMessage(message), undefined, this.disposables);
		}
		this.panel.webview.html = this.html(document);
		this.panel.reveal(ViewColumn.Beside, true);

		if (sendLine !== undefined) {
			const parsed = parseHttpFile(document.getText());
			const index = parsed.requests.findIndex(r => r.line === sendLine);
			if (index >= 0) {
				void this.send(index);
			}
		}
	}

	/** Handle a message posted from the webview (`send` with a request index, or
	 *  the Esc bridge's `exitFocus`). */
	private onMessage(message: { type?: string; index?: number }): void {
		if (message.type === 'send' && typeof message.index === 'number') {
			void this.send(message.index);
		} else if (message.type === 'exitFocus') {
			void commands.executeCommand('burrow.focus.exit');
		}
	}

	/** Re-read the bound document, resolve variables, send request `index`, render the result. */
	private async send(index: number): Promise<void> {
		if (!this.panel || !this.docUri) {
			return;
		}
		const panel = this.panel;
		let document: TextDocument;
		try {
			document = await workspace.openTextDocument(this.docUri);
		} catch (err) {
			panel.webview.postMessage({ type: 'response', html: renderError(String(err)) });
			return;
		}

		const parsed = parseHttpFile(document.getText());
		const request = parsed.requests[index];
		if (!request) {
			panel.webview.postMessage({ type: 'response', html: renderError(`No request at index ${index}.`) });
			return;
		}

		const variables = resolveVariables(parsed.variables, name => process.env[name]);
		const resolved = resolveRequest(request, { variables, env: name => process.env[name] });
		panel.webview.postMessage({ type: 'sending', label: `${resolved.method} ${interpolate(resolved.url, { variables })}` });

		try {
			const result = await sendRequest(resolved, { timeoutMs: this.timeoutMs() });
			panel.webview.postMessage({ type: 'response', html: renderResponse(result) });
		} catch (err) {
			const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
			panel.webview.postMessage({ type: 'response', html: renderError(message) });
		}
	}

	/** Build the full webview page: the request picker toolbar plus the response pane. */
	private html(document: TextDocument): string {
		const n = nonce();
		const parsed = parseHttpFile(document.getText());
		const options = parsed.requests
			.map((r, i) => `<option value="${i}">${escapeAttr(`${r.method}  ${r.name}`)}</option>`)
			.join('');
		const csp = `default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';`;

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<style nonce="${n}">
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px 12px; }
		.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
		select { flex: 1; font: inherit; padding: 3px 4px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 2px; }
		button { font: inherit; padding: 3px 12px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 2px; cursor: pointer; }
		button:hover { background: var(--vscode-button-hoverBackground); }
		h3 { margin: 12px 0 4px; font-size: 12px; text-transform: uppercase; opacity: .7; }
		.chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
		.chip { padding: 2px 8px; border-radius: 10px; font-size: 12px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
		.chip.ok { background: var(--vscode-testing-iconPassed, #2e7d32); color: #fff; }
		.chip.redirect { background: var(--vscode-charts-yellow, #b58900); color: #000; }
		.chip.error { background: var(--vscode-testing-iconFailed, #c62828); color: #fff; }
		table.headers { border-collapse: collapse; width: 100%; font-size: 12px; }
		table.headers td { border-bottom: 1px solid var(--vscode-panel-border); padding: 2px 6px; vertical-align: top; word-break: break-all; }
		td.hk { opacity: .8; white-space: nowrap; }
		pre.body { margin: 0; padding: 8px; background: var(--vscode-textCodeBlock-background); border-radius: 3px; white-space: pre-wrap; word-break: break-all; max-height: 60vh; overflow: auto; font-family: var(--vscode-editor-font-family, monospace); }
		.note { opacity: .7; font-size: 12px; margin: 4px 0; }
	</style>
</head>
<body>
	<div class="toolbar">
		<select id="picker">${options || '<option>(no requests in this .http file)</option>'}</select>
		<button id="send">Send</button>
	</div>
	<div id="result"><div class="note">Pick a request and press Send.</div></div>
	<script nonce="${n}">
		const vscode = acquireVsCodeApi();
		const picker = document.getElementById('picker');
		const result = document.getElementById('result');
		document.getElementById('send').addEventListener('click', () => {
			const index = Number(picker.value);
			if (!Number.isNaN(index)) {
				result.innerHTML = '<div class="note">Sending…</div>';
				vscode.postMessage({ type: 'send', index });
			}
		});
		// Esc bridge (docs/plans/01 §4): this webview has focus, so the workbench
		// never sees the keystroke — hand it back so Focus Mode exits from here
		// exactly as it does from an editor.
		window.addEventListener('keydown', e => {
			if (e.key === 'Escape') { vscode.postMessage({ type: 'exitFocus' }); }
		});
		window.addEventListener('message', event => {
			const msg = event.data;
			if (msg.type === 'sending') {
				result.innerHTML = '<div class="note">Sending ' + msg.label + '…</div>';
			} else if (msg.type === 'response') {
				result.innerHTML = msg.html;
			}
		});
	</script>
</body>
</html>`;
	}

	public dispose(): void {
		this.panel?.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

/** Escape a string for safe use inside a double-quoted HTML attribute. */
function escapeAttr(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
