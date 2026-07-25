/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, ViewColumn, WebviewPanel, commands, window } from 'vscode';
import { LabRun, LabTest, verdict } from './labModel';

// The **Test Lab** (docs/plans/02 §3.4): the tree in the rail is the index, the
// result surface is a full editor tab. Left, the suites with a state dot and a
// duration bar; right, the selected run with FAILURES FIRST, a want/got diff
// where the failure had that shape, and a sticky header carrying the verdict
// and the run actions.
//
// It follows the lab family's visual rules (docs/plans/04 §6): one 32px top
// bar, a quiet inset stage, theme tokens only, no borders doing work that
// spacing can do. Those ~40 lines of shell CSS are DUPLICATED here rather than
// shared from tools/frontend-debugger — §6 offers the choice, and a test
// extension that imports its stylesheet from a frontend tool would couple two
// things that have no other reason to know about each other.

export class TestLab implements Disposable {

	public static readonly viewType = 'burrow.test.lab';

	private panel: WebviewPanel | undefined;
	private run: LabRun | undefined;

	constructor(private readonly onAction: (action: 'run' | 'rerunFailed' | 'race') => void) { }

	dispose(): void {
		this.panel?.dispose();
	}

	/** Show the lab, creating it if needed. */
	open(): void {
		this.reveal();
		this.render();
	}

	/** Publish a finished run. Opens the lab only if it is already showing —
	 *  running tests from the tree should not steal the editor area unless the
	 *  developer asked for the lab. */
	publish(run: LabRun): void {
		this.run = run;
		if (this.panel) {
			this.render();
		}
	}

	get last(): LabRun | undefined {
		return this.run;
	}

	private reveal(): void {
		if (this.panel) {
			this.panel.reveal(ViewColumn.Active, false);
			return;
		}
		this.panel = window.createWebviewPanel(TestLab.viewType, 'Test Lab', ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});
		this.panel.onDidDispose(() => { this.panel = undefined; });
		this.panel.webview.onDidReceiveMessage((message: { type?: string; file?: string; line?: number }) => {
			if (message?.type === 'run' || message?.type === 'rerunFailed' || message?.type === 'race') {
				this.onAction(message.type);
			} else if (message?.type === 'exitFocus') {
				// Esc bridge (docs/plans/01 §4) — the webview owns the keystroke.
				void commands.executeCommand('burrow.focus.exit');
			}
		});
	}

	private render(): void {
		if (this.panel) {
			this.panel.webview.html = html(this.run);
			this.panel.title = this.run ? `Test Lab — ${this.run.failed ? `${this.run.failed} failed` : 'green'}` : 'Test Lab';
		}
	}
}

function nonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}

function esc(text: string): string {
	return text.replace(/[&<>"']/g, (ch) => (
		ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
	));
}

/** One test, as the right-hand column renders it. */
function testBlock(test: LabTest, longest: number): string {
	const bar = longest > 0 ? Math.max(2, Math.round(((test.durationMs ?? 0) / longest) * 100)) : 2;
	const diff = test.want !== undefined && test.got !== undefined
		? `<div class="diff"><div class="want"><span>want</span><code>${esc(test.want)}</code></div>` +
		`<div class="got"><span>got</span><code>${esc(test.got)}</code></div></div>`
		: '';
	const output = test.status === 'fail' && test.output.trim()
		? `<pre>${esc(test.output.trim())}</pre>`
		: '';
	return `<div class="test ${test.status}">
		<div class="row">
			<span class="dot"></span>
			<span class="name">${esc(test.name)}</span>
			<span class="ms">${test.durationMs === undefined ? '' : `${test.durationMs} ms`}</span>
		</div>
		<div class="bar"><i style="width:${bar}%"></i></div>
		${diff}${output}
	</div>`;
}

function html(run: LabRun | undefined): string {
	const n = nonce();
	const longest = run ? Math.max(1, ...run.suites.flatMap((s) => s.tests.map((t) => t.durationMs ?? 0))) : 1;
	const body = !run
		? '<div class="empty">No run yet. Run a Go package from the <b>Tests</b> section, or press Run above.</div>'
		: (run.stderr
			? `<div class="stderr"><h3>go test could not run</h3><pre>${esc(run.stderr.trim())}</pre></div>`
			: run.suites.map((suite) => `<section>
				<h2>${esc(suite.label)} <span class="tally">${suite.failed ? `${suite.failed} failed · ` : ''}${suite.passed} passed${suite.skipped ? ` · ${suite.skipped} skipped` : ''}</span></h2>
				${suite.tests.map((test) => testBlock(test, longest)).join('')}
			</section>`).join(''));

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}'">
<style nonce="${n}">
	/* --- the lab shell (docs/plans/04 §6) ------------------------------- */
	* { box-sizing: border-box; }
	html, body { height: 100%; margin: 0; }
	body {
		display: flex; flex-direction: column;
		font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
		color: var(--vscode-foreground); background: var(--vscode-editor-background);
	}
	#top {
		flex: none; height: 32px; display: flex; align-items: center; gap: 10px; padding: 0 12px;
		background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground);
	}
	#top .name { font-weight: 600; }
	#top .chip {
		font-size: 11px; padding: 1px 7px; border-radius: 9px;
		background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
	}
	#top .spacer { flex: 1; }
	#top button {
		font: inherit; font-size: 11px; padding: 1px 9px; border-radius: 4px; cursor: pointer;
		color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
		background: var(--vscode-button-secondaryBackground, transparent);
		border: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border));
	}
	#top button.go { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: transparent; }
	#stage { flex: 1; overflow: auto; padding: 20px; }
	/* --- results -------------------------------------------------------- */
	section { margin-bottom: 22px; }
	h2 { font-size: 12px; font-weight: 600; margin: 0 0 8px; }
	h2 .tally { font-weight: 400; opacity: .6; margin-left: 8px; }
	.test { margin-bottom: 10px; }
	.test .row { display: flex; align-items: baseline; gap: 8px; }
	.test .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--vscode-testing-iconPassed, #3fb950); }
	.test.fail .dot { background: var(--vscode-testing-iconFailed, #f85149); }
	.test.skip .dot { background: var(--vscode-testing-iconSkipped, #8b949e); }
	.test .name { font-family: var(--vscode-editor-font-family); font-size: .95em; }
	.test.fail .name { color: var(--vscode-testing-iconFailed, #f85149); }
	.test .ms { margin-left: auto; opacity: .55; font-size: 11px; }
	.bar { height: 2px; margin: 3px 0 0 15px; background: var(--vscode-editorWidget-background); }
	.bar i { display: block; height: 2px; background: var(--vscode-testing-iconPassed, #3fb950); opacity: .5; }
	.test.fail .bar i { background: var(--vscode-testing-iconFailed, #f85149); }
	.diff { margin: 6px 0 0 15px; font-family: var(--vscode-editor-font-family); font-size: .95em; }
	.diff div { display: flex; gap: 8px; padding: 2px 6px; border-radius: 3px; }
	.diff span { opacity: .6; width: 34px; flex: none; }
	.diff .want { background: var(--vscode-diffEditor-removedTextBackground, rgba(255,0,0,.12)); }
	.diff .got { background: var(--vscode-diffEditor-insertedTextBackground, rgba(0,255,0,.12)); }
	pre {
		margin: 6px 0 0 15px; padding: 8px 10px; overflow-x: auto; border-radius: 5px;
		background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family);
		font-size: .9em; line-height: 1.45; white-space: pre-wrap;
	}
	.empty, .stderr { opacity: .7; max-width: 60ch; }
	.stderr h3 { font-size: 12px; margin: 0 0 6px; color: var(--vscode-testing-iconFailed, #f85149); }
</style>
</head>
<body>
	<div id="top">
		<span class="name">Test Lab</span>
		<span class="chip">${run ? esc(verdict(run)) : 'no run yet'}</span>
		${run?.race ? '<span class="chip">race</span>' : ''}
		<span class="spacer"></span>
		<button id="rerun" ${run && run.failed ? '' : 'disabled'}>Re-run failed</button>
		<button id="race">Race</button>
		<button id="run" class="go">Run</button>
	</div>
	<div id="stage">${body}</div>
<script nonce="${n}">
	const vscode = acquireVsCodeApi();
	for (const [id, type] of [['run', 'run'], ['rerun', 'rerunFailed'], ['race', 'race']]) {
		document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type }));
	}
	window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { vscode.postMessage({ type: 'exitFocus' }); } });
</script>
</body>
</html>`;
}
