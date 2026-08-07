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
import { rememberResponse } from './requestsTree';
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

export const HTTP_WORKBENCH_VIEW_TYPE = 'burrowHttpWorkbench';

/**
 * What a revived workbench carries (WO-60): which `.http` file it is bound to
 * and which request was picked. **Never the response** — a body can be
 * megabytes, can carry a token, and is the one thing a restored panel must not
 * pretend it still has.
 */
interface HttpPanelState {
	readonly doc?: string;
	readonly index?: number;
	readonly help?: boolean;
}

/** Owns the singleton HTTP workbench panel and the pick → send → render loop. */
export class HttpWorkbench implements Disposable {
	private panel: WebviewPanel | undefined;
	/** The `.http` document the panel is bound to; re-read on each send. */
	private docUri: Uri | undefined;
	/**
	 * The last response this panel rendered, held **in memory only** (patches/0016).
	 *
	 * Moving a webview between windows destroys and rebuilds its iframe:
	 * `OverlayWebview.claim` clears on a window change and `_show` re-applies the
	 * HTML. Every other Burrow surface survives that because it renders from
	 * extension-side state; this one painted its response pane by `postMessage`
	 * alone, so popping the workbench out arrived showing an empty pane — the one
	 * thing the user was looking at, gone because they moved the window.
	 *
	 * This does NOT weaken the WO-60 rule above it. That rule is about
	 * `setState`, which is serialized to disk and revived in a later session; a
	 * body that could be megabytes or carry a token still never goes there. This
	 * field lives and dies with the extension host, is never written to state,
	 * and is dropped the moment the panel binds to a different file.
	 */
	private lastResponseHtml: string | undefined;
	private readonly disposables: Disposable[] = [];

	/**
	 * Come back with the rail, a reload and a relaunch (WO-60).
	 *
	 * The picker is rebuilt by re-parsing the bound file — a read of a file the
	 * workspace already has — and the response pane comes back empty and says
	 * why. Restoring a tab is not a reason to send an HTTP request.
	 */
	public register(): Disposable {
		return window.registerWebviewPanelSerializer(HTTP_WORKBENCH_VIEW_TYPE, {
			deserializeWebviewPanel: async (panel: WebviewPanel, state: unknown): Promise<void> => {
				const saved = (state ?? {}) as HttpPanelState;
				this.lastResponseHtml = undefined; // a revived tab has sent nothing
				this.panel?.dispose();
				this.panel = panel;
				this.wire(panel);
				let document: TextDocument | undefined;
				if (saved.doc) {
					try {
						document = await workspace.openTextDocument(Uri.parse(saved.doc));
					} catch {
						document = undefined;
					}
				}
				if (document) {
					this.docUri = document.uri;
					panel.webview.html = this.html(document, saved);
					return;
				}
				this.docUri = undefined;
				panel.webview.html = this.unboundHtml(saved.doc);
			},
		});
	}

	/** Listener wiring shared by a fresh open and a revive. */
	private wire(panel: WebviewPanel): void {
		panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.disposables);
		panel.webview.onDidReceiveMessage(message => this.onMessage(message), undefined, this.disposables);
	}

	/** Read the send timeout (ms) from configuration; `0` disables it. */
	private timeoutMs(): number {
		return workspace.getConfiguration('burrow.http').get<number>('timeoutMs', 30000);
	}

	/**
	 * Reveal the workbench for `document`, populate the request picker, and (when
	 * `sendLine` is given, e.g. from a codelens) immediately send that request.
	 */
	public open(document: TextDocument, sendLine?: number): void {
		if (this.docUri?.toString() !== document.uri.toString()) {
			// Rebinding to a different file. The cached response belongs to the old
			// one, and a pane that answers about a file you have left is worse than
			// an empty pane (patches/0016).
			this.lastResponseHtml = undefined;
		}
		this.docUri = document.uri;
		if (!this.panel) {
			this.panel = window.createWebviewPanel(
				HTTP_WORKBENCH_VIEW_TYPE,
				'HTTP Workbench',
				{ viewColumn: ViewColumn.Beside, preserveFocus: true },
				{ enableScripts: true, retainContextWhenHidden: true },
			);
			this.wire(this.panel);
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

	/** Handle a message posted from the webview (`send` with a request index, the
	 *  Esc bridge's `exitFocus`, or the post-boot `ready` handshake). */
	private onMessage(message: { type?: string; index?: number }): void {
		if (message.type === 'send' && typeof message.index === 'number') {
			void this.send(message.index);
		} else if (message.type === 'exitFocus') {
			void commands.executeCommand('burrow.focus.exit');
		} else if (message.type === 'ready') {
			// The iframe just booted. If that was a rebuild — a pop-out, a dock, a
			// re-render of the same document — put the response back. On a genuine
			// revive there is nothing to put back: a fresh extension host has no
			// `lastResponseHtml`, so a restored tab still comes up empty and says so.
			if (this.lastResponseHtml) {
				void this.panel?.webview.postMessage({ type: 'response', html: this.lastResponseHtml });
			}
		}
	}

	/** Render a response into the pane and remember it for an iframe rebuild. */
	private renderInto(panel: WebviewPanel, html: string): void {
		this.lastResponseHtml = html;
		void panel.webview.postMessage({ type: 'response', html });
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
			this.renderInto(panel, renderError(String(err)));
			return;
		}

		const parsed = parseHttpFile(document.getText());
		const request = parsed.requests[index];
		if (!request) {
			this.renderInto(panel, renderError(`No request at index ${index}.`));
			return;
		}

		const variables = resolveVariables(parsed.variables, name => process.env[name]);
		const resolved = resolveRequest(request, { variables, env: name => process.env[name] });
		panel.webview.postMessage({ type: 'sending', label: `${resolved.method} ${interpolate(resolved.url, { variables })}` });

		try {
			const result = await sendRequest(resolved, { timeoutMs: this.timeoutMs() });
			this.renderInto(panel, renderResponse(result));
			// The API view's Requests section shows what the last few sends
			// answered (docs/plans/02 §3.5) — recorded here, where the result is.
			rememberResponse({
				method: resolved.method,
				url: interpolate(resolved.url, { variables }),
				status: result.status,
				ms: Math.round(result.durationMs),
				file: this.docUri,
				line: request.line,
			});
		} catch (err) {
			const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
			this.renderInto(panel, renderError(message));
		}
	}

	/** Build the full webview page: the request picker toolbar plus the response pane. */
	private html(document: TextDocument, restored?: HttpPanelState): string {
		const n = nonce();
		const parsed = parseHttpFile(document.getText());
		const selected = restored && typeof restored.index === 'number' && restored.index >= 0 && restored.index < parsed.requests.length
			? restored.index
			: undefined;
		const options = parsed.requests
			.map((r, i) => `<option value="${i}"${i === selected ? ' selected' : ''}>${escapeAttr(`${r.method}  ${r.name}`)}</option>`)
			.join('');
		// A restored panel says what it is holding and what it is not. The picked
		// request is back; the response is not, because nothing was sent.
		const opening = restored
			? (selected === undefined
				? `Restored. The request you had picked is no longer in ${basename(document.uri)} — pick another and press Send.`
				: 'Restored — nothing sent. Press Send to run it again.')
			: 'Pick a request and press Send.';
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
		/* The help sheet — anchored, not modal, so you read it while clicking the
		   thing it describes. Duplicated per surface on purpose (the lab-shell
		   decision): three extensions cannot share a stylesheet without a bundler. */
		#helpbtn { flex: 0 0 auto; background: transparent; color: var(--vscode-foreground); border-color: var(--vscode-panel-border); }
		#help {
			position: fixed; top: 8px; right: 8px; z-index: 10; width: 400px; max-width: calc(100vw - 16px);
			max-height: calc(100vh - 24px); overflow: auto; padding: 10px 12px; font-size: 12px; line-height: 1.5;
			background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground);
			border: 1px solid var(--vscode-panel-border); border-radius: 6px; box-shadow: 0 8px 26px rgba(0,0,0,.35);
		}
		#help .hh { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
		#help .hh b { font-size: 13px; }
		#help .hh button { margin-left: auto; padding: 0 6px; background: transparent; color: inherit; border: 0; cursor: pointer; }
		#help .lede { opacity: .8; margin-bottom: 6px; }
		#help .hrow { display: flex; gap: 8px; padding: 2px 0; border-top: 1px solid var(--vscode-panel-border); }
		#help .hk { flex: 0 0 108px; font-weight: 600; }
		#help .hv { flex: 1; opacity: .85; }
	</style>
</head>
<body>
	<div class="toolbar">
		<select id="picker">${options || '<option>(no requests in this .http file)</option>'}</select>
		<button id="send">Send</button>
		<button id="helpbtn" title="What is this? — every part of this editor, in one sentence each">?</button>
	</div>
	<div id="result"><div class="note">${escapeAttr(opening)}</div></div>
	<div id="help" hidden>
		<div class="hh"><b>API workbench</b><button id="helpclose" title="Close (Esc)">✕</button></div>
		<div class="lede">The requests in the <code>.http</code> file beside this pane, sent for real against
			whatever the file's variables point at. Nothing is mocked here.</div>
		<div class="hrow"><span class="hk">The picker</span><span class="hv">Every request in the bound file, in file order. Add one by writing it in the file — this list follows the file, never the other way round.</span></div>
		<div class="hrow"><span class="hk">Send</span><span class="hv">Sends the picked request. The same send runs from the CodeLens above each request in the file itself.</span></div>
		<div class="hrow"><span class="hk">Variables</span><span class="hv">@name = value lines in the file, and the environment this window was launched with. Both resolve at send time, so a variable you just edited takes effect on the next send.</span></div>
		<div class="hrow"><span class="hk">The chips</span><span class="hv">Status and duration. Green is 2xx, yellow a redirect, red 4xx/5xx or a transport failure — a request that never reached the server says so rather than showing a status it never got.</span></div>
		<div class="hrow"><span class="hk">Afterwards</span><span class="hv">The API view's Recent group keeps the last ten sends with their status and duration, so you can compare a run against the one before it.</span></div>
		<div class="hrow"><span class="hk">Esc</span><span class="hv">Closes this sheet, then exits Focus Mode.</span></div>
	</div>
	<script nonce="${n}">
		const vscode = acquireVsCodeApi();
		const picker = document.getElementById('picker');
		const result = document.getElementById('result');
		// WO-60: the binding and the pick, and nothing else. The response pane's
		// contents are deliberately absent — a restored tab must not be able to
		// show a body it did not just receive.
		let saved = { doc: ${JSON.stringify(document.uri.toString())}, index: Number(picker.value) || 0, help: ${restored?.help === true ? 'true' : 'false'} };
		const remember = (patch) => { saved = Object.assign({}, saved, patch); vscode.setState(saved); };
		remember({});
		picker.addEventListener('change', () => remember({ index: Number(picker.value) || 0 }));
		document.getElementById('send').addEventListener('click', () => {
			const index = Number(picker.value);
			if (!Number.isNaN(index)) {
				remember({ index });
				result.innerHTML = '<div class="note">Sending…</div>';
				vscode.postMessage({ type: 'send', index });
			}
		});
		const help = document.getElementById('help');
		const setHelp = on => { help.hidden = !on; remember({ help: on }); };
		if (saved.help) { setHelp(true); }
		document.getElementById('helpbtn').addEventListener('click', () => setHelp(help.hidden));
		document.getElementById('helpclose').addEventListener('click', () => setHelp(false));
		// Esc bridge (docs/plans/01 §4): this webview has focus, so the workbench
		// never sees the keystroke — hand it back so Focus Mode exits from here
		// exactly as it does from an editor. The help sheet is the shallowest
		// thing Escape can close, so it goes first.
		window.addEventListener('keydown', e => {
			if (e.key !== 'Escape') { return; }
			if (!help.hidden) { setHelp(false); return; }
			vscode.postMessage({ type: 'exitFocus' });
		});
		window.addEventListener('message', event => {
			const msg = event.data;
			if (msg.type === 'sending') {
				result.innerHTML = '<div class="note">Sending ' + msg.label + '…</div>';
			} else if (msg.type === 'response') {
				result.innerHTML = msg.html;
			}
		});
		// Say we are up (patches/0016). Moving this panel to another window rebuilds
		// the iframe from the same HTML, and the response pane is the one part of
		// this page that is painted by message rather than by markup — so the host
		// re-sends it here. Deliberately the LAST line: the listener above must
		// already exist when the reply comes back.
		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}

	/**
	 * The workbench came back but its `.http` file did not — deleted, renamed, or
	 * a different workspace opened in the same window. It says which file, rather
	 * than presenting an empty picker that looks like the file has no requests
	 * (WO-60, "grey with a reason").
	 */
	private unboundHtml(doc: string | undefined): string {
		const n = nonce();
		const name = doc ? basename(Uri.parse(doc)) : 'the file it was opened from';
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
	<style nonce="${n}">
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 14px 16px; }
		h3 { font-size: 13px; margin: 0 0 8px; }
		p { max-width: 60ch; line-height: 1.55; opacity: .8; font-size: 12px; }
		code { font-family: var(--vscode-editor-font-family); }
	</style>
</head>
<body>
	<h3>No requests to show</h3>
	<p>This workbench was bound to <code>${escapeAttr(name)}</code>, which this window cannot open. Open a
		<code>.http</code> file and run <b>Burrow HTTP: Open HTTP Workbench</b> to bind it to another one.</p>
<script nonce="${n}">
	const vscode = acquireVsCodeApi();
	vscode.setState({ doc: ${JSON.stringify(doc ?? null)} });
	window.addEventListener('keydown', e => { if (e.key === 'Escape') { vscode.postMessage({ type: 'exitFocus' }); } });
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

/** Last path segment of a uri — the name a person calls the file. */
function basename(uri: Uri): string {
	const parts = uri.path.split('/');
	return parts[parts.length - 1] || uri.toString();
}
