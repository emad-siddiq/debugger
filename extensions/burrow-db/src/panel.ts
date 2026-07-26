/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// panel.ts — the results grid webview (architecture task 10.3). A single reusable
// panel: a SQL editor bar on top, the type-classified grid below. It owns no
// database — it calls the injected `GridRunner` (extension.ts wires it to
// `runSelect(getClient(), …)`) and posts the resulting `GridModel` (or the error)
// to the webview. Virtualized windowing, filter chips and the EXPLAIN visualizer
// are later slices; this cut renders a capped result and lets you re-run edited
// SQL in place. Colours come from workbench CSS variables so it themes for free.

import { Disposable, ViewColumn, WebviewPanel, commands, window } from 'vscode';
import { GridModel, MAX_GRID_ROWS } from './grid';
import { nonce } from './webview';

/** Runs a SQL string and resolves its grid model. Rejects with a message on failure. */
export type GridRunner = (sql: string) => Promise<GridModel>;

// ---- wire protocol ---------------------------------------------------------

type Outbound =
	| { readonly type: 'running'; readonly sql: string }
	| { readonly type: 'grid'; readonly sql: string; readonly grid: GridModel; readonly elapsedMs: number }
	| { readonly type: 'error'; readonly sql: string; readonly message: string };

type Inbound =
	| { readonly type: 'ready' }
	| { readonly type: 'run'; readonly sql: string }
	| { readonly type: 'exitFocus' };

export class GridPanel {

	public static readonly viewType = 'burrow.db.grid';
	private static current: GridPanel | undefined;

	private readonly disposables: Disposable[] = [];
	private lastSql = 'SELECT 1';

	private constructor(private readonly panel: WebviewPanel, private run: GridRunner) {
		this.panel.webview.options = { enableScripts: true };
		this.panel.webview.html = this.html();
		this.disposables.push(this.panel.webview.onDidReceiveMessage((m: Inbound) => this.onMessage(m)));
		this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
	}

	/** Reveal the shared panel (creating it once), refreshing its runner to the caller's. */
	static show(run: GridRunner): GridPanel {
		if (GridPanel.current) {
			GridPanel.current.run = run;
			GridPanel.current.panel.reveal(ViewColumn.Active);
			return GridPanel.current;
		}
		const panel = window.createWebviewPanel(
			GridPanel.viewType,
			'Database Explorer',
			ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		GridPanel.current = new GridPanel(panel, run);
		return GridPanel.current;
	}

	/** Run `sql` and show its result, revealing the panel. */
	async runAndShow(sql: string): Promise<void> {
		this.lastSql = sql;
		this.panel.reveal(ViewColumn.Active);
		await this.execute(sql);
	}

	private async onMessage(message: Inbound): Promise<void> {
		if (message.type === 'exitFocus') {
			void commands.executeCommand('burrow.focus.exit');
		} else if (message.type === 'ready') {
			await this.execute(this.lastSql);
		} else if (message.type === 'run' && typeof message.sql === 'string') {
			this.lastSql = message.sql;
			await this.execute(message.sql);
		}
	}

	private async execute(sql: string): Promise<void> {
		const trimmed = sql.trim();
		if (!trimmed) {
			return;
		}
		this.post({ type: 'running', sql: trimmed });
		const started = Date.now();
		try {
			const grid = await this.run(trimmed);
			this.post({ type: 'grid', sql: trimmed, grid, elapsedMs: Date.now() - started });
		} catch (err) {
			this.post({ type: 'error', sql: trimmed, message: err instanceof Error ? err.message : String(err) });
		}
	}

	private post(message: Outbound): void {
		void this.panel.webview.postMessage(message);
	}

	private dispose(): void {
		GridPanel.current = undefined;
		this.disposables.forEach(d => d.dispose());
		this.disposables.length = 0;
	}

	private html(): string {
		const n = nonce();
		const csp = `default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';`;
		// Self-contained: inline CSS/JS (no bundler). The webview builds every cell
		// with textContent, so result data is never interpolated into markup.
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style nonce="${n}">
		:root { color-scheme: light dark; }
		body { margin: 0; padding: 0; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); display: flex; flex-direction: column; height: 100vh; }
		#editor { flex: 0 0 auto; border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 8px; }
		#sql { width: 100%; box-sizing: border-box; resize: vertical; min-height: 2.4em; font: var(--vscode-editor-font-size) var(--vscode-editor-font-family, monospace); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; }
		#bar { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
		#bar button { font: inherit; padding: 2px 10px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 2px; cursor: pointer; }
		#bar button:hover { background: var(--vscode-button-hoverBackground); }
		#status { flex: 1 1 auto; font-size: 11px; opacity: .8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		#status.err { color: var(--vscode-errorForeground); opacity: 1; }
		#gridwrap { flex: 1 1 auto; overflow: auto; }
		table { border-collapse: collapse; font-size: 12px; width: max-content; min-width: 100%; }
		thead th { position: sticky; top: 0; z-index: 1; text-align: left; padding: 3px 8px; background: var(--vscode-keybindingTable-headerBackground, var(--vscode-sideBar-background)); border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; }
		td { padding: 2px 8px; border-bottom: 1px solid var(--vscode-panel-border); border-right: 1px solid var(--vscode-panel-border); white-space: pre; max-width: 40ch; overflow: hidden; text-overflow: ellipsis; }
		tbody tr:hover { background: var(--vscode-list-hoverBackground); }
		td.gutter { text-align: right; opacity: .5; user-select: none; font-variant-numeric: tabular-nums; }
		td.null { opacity: .5; font-style: italic; }
		td.number, td.bytes { text-align: right; font-variant-numeric: tabular-nums; }
		td.bool { color: var(--vscode-charts-blue); }
		td.json { color: var(--vscode-charts-purple); }
		td.date { color: var(--vscode-charts-green); }
		#banner { padding: 4px 8px; font-size: 11px; opacity: .8; background: var(--vscode-inputValidation-warningBackground, transparent); border-bottom: 1px solid var(--vscode-panel-border); }
		[hidden] { display: none !important; }
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
	<div id="editor">
		<textarea id="sql" spellcheck="false" placeholder="SELECT …"></textarea>
		<div id="bar">
			<button id="run" title="Run (Ctrl/Cmd+Enter)">Run</button>
			<span id="status"></span>
			<button id="helpbtn" title="What is this? — every part of this editor, in one sentence each">?</button>
		</div>
	</div>
	<div id="banner" hidden></div>
	<div id="gridwrap"></div>
	<div id="help" hidden>
		<div class="hh"><b>Database explorer</b><button id="helpclose" title="Close (Esc)">✕</button></div>
		<div class="lede">A SQL scratchpad over the connection the Data view discovered. Every run is a
			round trip to the real database — there is no cache between you and it.</div>
		<div class="hrow"><span class="hk">The box</span><span class="hv">Any SQL the connection allows. Clicking a table in the Data view fills this in with a SELECT for you.</span></div>
		<div class="hrow"><span class="hk">Run</span><span class="hv">⌘↵ / Ctrl+↵ from inside the box. The status line to the right reports rows and elapsed time, or the database's own error.</span></div>
		<div class="hrow"><span class="hk">Row cap</span><span class="hv">At most ${MAX_GRID_ROWS.toLocaleString()} rows cross to this view, so a forgotten LIMIT cannot hang the window. The banner says when you are seeing a prefix, and the count above it is the honest total.</span></div>
		<div class="hrow"><span class="hk">Cell colours</span><span class="hv">The column's type, not its value: NULL is greyed italic (never an empty string), numbers right-align, booleans blue, json/jsonb purple, timestamps green as ISO, bytea as \\x hex.</span></div>
		<div class="hrow"><span class="hk">Writes</span><span class="hv">The Data view's connection row carries the writes guard — locked, this connection is read-only. Unlock it there, deliberately, not here.</span></div>
		<div class="hrow"><span class="hk">Esc</span><span class="hv">Closes this sheet, then exits Focus Mode.</span></div>
	</div>
	<script nonce="${n}">
		const vscode = acquireVsCodeApi();
		const $sql = document.getElementById('sql');
		const $run = document.getElementById('run');
		const $status = document.getElementById('status');
		const $banner = document.getElementById('banner');
		const $gridwrap = document.getElementById('gridwrap');

		function post(msg) { vscode.postMessage(msg); }
		function run() { post({ type: 'run', sql: $sql.value }); }

		$run.onclick = run;
		$sql.addEventListener('keydown', e => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { run(); e.preventDefault(); }
		});

		const $help = document.getElementById('help');
		const setHelp = on => { $help.hidden = !on; };
		document.getElementById('helpbtn').onclick = () => setHelp($help.hidden);
		document.getElementById('helpclose').onclick = () => setHelp(false);

		// Esc bridge (docs/plans/01 §4): this webview has focus, so the workbench
		// never sees the keystroke — hand it back so Focus Mode exits from here
		// exactly as it does from an editor. The help sheet is the shallowest
		// thing Escape can close, so it goes first.
		window.addEventListener('keydown', e => {
			if (e.key !== 'Escape') { return; }
			if (!$help.hidden) { setHelp(false); return; }
			post({ type: 'exitFocus' });
		});

		function setStatus(text, isError) {
			$status.textContent = text;
			$status.className = isError ? 'err' : '';
		}

		function renderGrid(grid) {
			$gridwrap.textContent = '';
			const table = document.createElement('table');
			const thead = document.createElement('thead');
			const htr = document.createElement('tr');
			const corner = document.createElement('th');
			corner.textContent = '#';
			htr.appendChild(corner);
			grid.columns.forEach(name => {
				const th = document.createElement('th');
				th.textContent = name;
				htr.appendChild(th);
			});
			thead.appendChild(htr);
			table.appendChild(thead);
			const tbody = document.createElement('tbody');
			grid.rows.forEach((row, i) => {
				const tr = document.createElement('tr');
				const gutter = document.createElement('td');
				gutter.className = 'gutter';
				gutter.textContent = String(i + 1);
				tr.appendChild(gutter);
				row.forEach(cell => {
					const td = document.createElement('td');
					td.className = cell.kind;
					td.textContent = cell.text;
					td.title = cell.text;
					tr.appendChild(td);
				});
				tbody.appendChild(tr);
			});
			table.appendChild(tbody);
			if (grid.columns.length === 0) {
				const empty = document.createElement('div');
				empty.style.padding = '12px';
				empty.style.opacity = '.7';
				empty.textContent = 'Query returned no columns.';
				$gridwrap.appendChild(empty);
			} else {
				$gridwrap.appendChild(table);
			}
		}

		function apply(state) {
			if (state.type === 'running') {
				setStatus('Running…', false);
				return;
			}
			if (state.type === 'error') {
				$banner.hidden = true;
				$gridwrap.textContent = '';
				setStatus(state.message, true);
				return;
			}
			// grid
			const g = state.grid;
			setStatus(g.rowCount.toLocaleString() + ' row' + (g.rowCount === 1 ? '' : 's') + ' · ' + state.elapsedMs + ' ms', false);
			if (g.truncated) {
				$banner.hidden = false;
				$banner.textContent = 'Showing the first ' + g.rows.length.toLocaleString() + ' of ' + g.rowCount.toLocaleString() + ' rows.';
			} else {
				$banner.hidden = true;
			}
			renderGrid(g);
		}

		window.addEventListener('message', e => {
			const state = e.data;
			// Echo the SQL the host actually ran back into the editor, so the box and
			// the grid never disagree about what produced these rows.
			if (state && typeof state.sql === 'string' && document.activeElement !== $sql) {
				$sql.value = state.sql;
			}
			apply(state);
		});

		post({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}
