/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, ExtensionContext, ViewColumn, WebviewPanel, commands, window } from 'vscode';
import { LabRun, LabTest, sizeOf, trimRunForStorage, verdict } from './labModel';

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

/** Where the last run is kept so a restored lab has something to show (WO-60).
 *  Workspace-scoped, because a verdict set belongs to a project. */
const LAST_RUN_KEY = 'burrow.test.lab.lastRun';

interface StoredRun {
	readonly run: LabRun;
	/** ISO timestamp of the run, so a restored lab can say how old it is. */
	readonly at: string;
	/** True when per-failure output had to be dropped to fit the budget. */
	readonly trimmed: boolean;
}

export class TestLab implements Disposable {

	public static readonly viewType = 'burrow.test.lab';

	private panel: WebviewPanel | undefined;
	private run: LabRun | undefined;
	private context: ExtensionContext | undefined;
	/** Set while showing a run recovered from storage rather than one that just
	 *  finished — the header says so, so nobody reads it as fresh. */
	private restored: StoredRun | undefined;

	constructor(private readonly onAction: (action: 'run' | 'rerunFailed' | 'race') => void) { }

	dispose(): void {
		this.panel?.dispose();
	}

	/**
	 * Persist the last run and make the panel revivable (WO-60).
	 *
	 * The lab restores its verdict set because a `go test` run is a record of
	 * something that happened, not a live session — and re-running it on restore
	 * would be minutes of CPU nobody asked for. Nothing here restores a DEBUG
	 * session: dlv-backed surfaces come back empty by construction, because the
	 * lab has never held one.
	 */
	register(context: ExtensionContext): Disposable {
		this.context = context;
		return window.registerWebviewPanelSerializer(TestLab.viewType, {
			deserializeWebviewPanel: async (panel: WebviewPanel, _state: unknown): Promise<void> => {
				this.panel?.dispose();
				this.panel = panel;
				this.wire(panel);
				const stored = context.workspaceState.get<StoredRun>(LAST_RUN_KEY);
				if (stored?.run) {
					this.run = stored.run;
					this.restored = stored;
				}
				this.render();
			},
		});
	}

	/** Show the lab, creating it if needed. */
	open(): void {
		this.reveal();
		if (!this.run && this.context) {
			// Opened by hand in a window that has not run tests yet: the last run
			// this workspace produced is a better answer than an empty stage.
			const stored = this.context.workspaceState.get<StoredRun>(LAST_RUN_KEY);
			if (stored?.run) {
				this.run = stored.run;
				this.restored = stored;
			}
		}
		this.render();
	}

	/** Publish a finished run. Opens the lab only if it is already showing —
	 *  running tests from the tree should not steal the editor area unless the
	 *  developer asked for the lab. */
	publish(run: LabRun): void {
		this.run = run;
		this.restored = undefined;
		if (this.context) {
			const { run: small, trimmed } = trimRunForStorage(run);
			void this.context.workspaceState.update(LAST_RUN_KEY, { run: small, at: new Date().toISOString(), trimmed } satisfies StoredRun);
		}
		if (this.panel) {
			this.render();
		}
	}

	get last(): LabRun | undefined {
		return this.run;
	}

	/** Bytes the persisted run occupies — reported, not guessed (WO-60 §4). */
	get storedBytes(): number {
		return sizeOf(this.context?.workspaceState.get<StoredRun>(LAST_RUN_KEY));
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
		this.wire(this.panel);
	}

	/** Listener wiring shared by a fresh open and a revive. */
	private wire(panel: WebviewPanel): void {
		panel.onDidDispose(() => { this.panel = undefined; });
		panel.webview.onDidReceiveMessage((message: { type?: string; file?: string; line?: number }) => {
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
			this.panel.webview.html = html(this.run, this.restored);
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

/** "3 minutes ago" — precise enough to know whether a restored verdict is stale. */
function ago(iso: string): string {
	const ms = Date.now() - Date.parse(iso);
	if (!Number.isFinite(ms) || ms < 0) {
		return 'earlier';
	}
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) {
		return 'just now';
	}
	if (minutes < 60) {
		return `${minutes} min ago`;
	}
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function html(run: LabRun | undefined, restored?: StoredRun): string {
	const n = nonce();
	const longest = run ? Math.max(1, ...run.suites.flatMap((s) => s.tests.map((t) => t.durationMs ?? 0))) : 1;
	// A restored verdict set is a RECORD, and says so. Presenting it as if the
	// tests had just run is the one way this feature could mislead.
	const note = restored
		? `<div class="restored">Restored from the run ${esc(ago(restored.at))} — these tests have not been re-run.${restored.trimmed
			? ' The failure output was too large to keep; press <b>Re-run failed</b> to see it.'
			: ''}</div>`
		: '';
	const body = !run
		? '<div class="empty">No run yet. Run a Go package from the <b>Tests</b> section, or press Run above.</div>'
		: note + (run.stderr
			? `<div class="stderr"><h3>go test could not run</h3><pre>${esc(run.stderr.trim())}</pre></div>`
			: run.suites.map((suite) => `<section>
				<h2>${esc(suite.label)} <span class="tally">${suite.failed ? `${suite.failed} failed · ` : ''}${suite.passed} passed${suite.skipped ? ` · ${suite.skipped} skipped` : ''}</span></h2>
				${suite.tests.map((test) => testBlock(test, longest)).join('')}
			</section>`).join(''));

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<!-- style-src-attr: the per-test duration bar is sized with an inline style
     attribute, and a nonce covers <style> elements only — without this every bar
     renders at zero width. Same defect as the wire diagram's node positions. -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; style-src-attr 'unsafe-inline'; script-src 'nonce-${n}'">
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
	/* The help sheet — anchored, not modal, so you read it while clicking the
	   thing it describes. Duplicated per surface on purpose (the lab-shell
	   decision): three extensions cannot share a stylesheet without a bundler. */
	#help {
		position: fixed; top: 38px; right: 8px; z-index: 10; width: 400px; max-width: calc(100vw - 16px);
		max-height: calc(100vh - 54px); overflow: auto; padding: 10px 12px; font-size: 12px; line-height: 1.5;
		background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground);
		border: 1px solid var(--vscode-panel-border); border-radius: 6px; box-shadow: 0 8px 26px rgba(0,0,0,.35);
	}
	#help .hh { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
	#help .hh b { font-size: 13px; }
	#help .hh button { margin-left: auto; padding: 0 6px; background: transparent; border: 0; cursor: pointer; }
	#help .lede { opacity: .8; margin-bottom: 6px; }
	#help .hrow { display: flex; gap: 8px; padding: 2px 0; border-top: 1px solid var(--vscode-panel-border); }
	#help .hk { flex: 0 0 108px; font-weight: 600; }
	#help .hv { flex: 1; opacity: .85; }
	[hidden] { display: none !important; }
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
	.restored { margin: -6px 0 16px; padding: 6px 10px; border-radius: 5px; font-size: 12px; line-height: 1.5;
		max-width: 72ch; opacity: .85; background: var(--vscode-editorWidget-background); }
	.stderr h3 { font-size: 12px; margin: 0 0 6px; color: var(--vscode-testing-iconFailed, #f85149); }
</style>
</head>
<body>
	<div id="top">
		<span class="name">Test Lab</span>
		<span class="chip">${run ? esc(verdict(run)) : 'no run yet'}</span>
		${restored ? '<span class="chip">restored</span>' : ''}
		${run?.race ? '<span class="chip">race</span>' : ''}
		<span class="spacer"></span>
		<button id="rerun" ${run && run.failed ? '' : 'disabled'}>Re-run failed</button>
		<button id="race">Race</button>
		<button id="run" class="go">Run</button>
		<button id="helpbtn" title="What is this? — every part of this lab, in one sentence each">?</button>
	</div>
	<div id="stage">${body}</div>
	<div id="help" hidden>
		<div class="hh"><b>Test Lab</b><button id="helpclose" title="Close (Esc)">✕</button></div>
		<div class="lede">One <code>go test</code> run, read the way you actually read one: what broke, then why,
			then how long it all took.</div>
		<div class="hrow"><span class="hk">The order</span><span class="hv">Failures first, always. A green run is a list you scroll past; a red one is the only thing you came here for.</span></div>
		<div class="hrow"><span class="hk">want / got</span><span class="hv">Go has no assertion library, so the lab recognises the five shapes the standard conventions converge on and lines them up. A failure it cannot parse is shown verbatim rather than reformatted into something it might not mean.</span></div>
		<div class="hrow"><span class="hk">The bars</span><span class="hv">Each test's duration relative to the slowest in the run — the shape of a slow suite, not a number to optimise.</span></div>
		<div class="hrow"><span class="hk">Run</span><span class="hv">The packages the Tests section last targeted. <b>Re-run failed</b> narrows to the ones that broke, so a two-minute suite answers a one-line question in seconds.</span></div>
		<div class="hrow"><span class="hk">Race</span><span class="hv">The same run under <code>-race</code>. It is several times slower and it is the only way a data race announces itself before production does.</span></div>
		<div class="hrow"><span class="hk">Elsewhere</span><span class="hv">The verdict rolls up per package in the Run view's Tests section, and the same execution path backs the stock Test Explorer — three surfaces, one run.</span></div>
		<div class="hrow"><span class="hk">Esc</span><span class="hv">Closes this sheet, then exits Focus Mode.</span></div>
	</div>
<script nonce="${n}">
	const vscode = acquireVsCodeApi();
	// WO-60: the lab's OWN view state. The verdict set is not here — it lives in
	// workspace storage, trimmed, because the host renders it and a run can be
	// far larger than a webview state blob should ever be.
	const stage = document.getElementById('stage');
	let saved = Object.assign({ scroll: 0, help: false }, vscode.getState() || {});
	const remember = (patch) => { saved = Object.assign({}, saved, patch); vscode.setState(saved); };
	stage.scrollTop = saved.scroll || 0;
	let scrollTimer;
	stage.addEventListener('scroll', () => {
		clearTimeout(scrollTimer);
		scrollTimer = setTimeout(() => remember({ scroll: stage.scrollTop }), 200);
	});
	for (const [id, type] of [['run', 'run'], ['rerun', 'rerunFailed'], ['race', 'race']]) {
		document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type }));
	}
	const help = document.getElementById('help');
	const setHelp = (on) => { help.hidden = !on; remember({ help: on }); };
	if (saved.help) { setHelp(true); }
	document.getElementById('helpbtn').addEventListener('click', () => setHelp(help.hidden));
	document.getElementById('helpclose').addEventListener('click', () => setHelp(false));
	// The help sheet is the shallowest thing Escape can close, so it goes first.
	window.addEventListener('keydown', (e) => {
		if (e.key !== 'Escape') { return; }
		if (!help.hidden) { setHelp(false); return; }
		vscode.postMessage({ type: 'exitFocus' });
	});
</script>
</body>
</html>`;
}
