/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// pgadmin.ts — the pgAdmin surface for the Burrow database explorer (architecture
// task 10). One command brings up a Burrow-managed pgAdmin container, pre-
// provisioned to the SAME connection the native explorer uses (setting →
// DATABASE_URL → a prompted default), and embeds it in a webview. The pure file
// generation lives in pgadminConfig.ts; this is the vscode/docker wiring seam.
//
// Lifecycle mirrors the frontend-debugger sidecar: spawn `docker compose up`,
// poll the app's own health endpoint, then open the panel — with actionable
// errors when Docker is absent or the daemon is down (no auto-install).

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Dsn, describeDsn, parsePostgresUrl, pickConnectionString } from './dsn';
import { pgAdminPassLine, pgAdminServers } from './pgadminConfig';
import { findWorkspaceDatabaseUrl } from './workspaceDsn';
import { nonce } from './webview';

/** Escape text interpolated into the panel's HTML. */
function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (ch) => (
		ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
	));
}

const CONFIG_SECTION = 'burrow.db';
const DEFAULT_PORT = 6110;
// A sensible starting point for merkle's single Postgres — offered in the input
// box when nothing is configured, so the demo is turnkey without hardcoding a
// path. The user can edit or replace it; the value is then persisted.
// A neutral shape to type over — Burrow must not bake one project's
// credentials into its own tooling (the workspace's launch.json is where a
// real default comes from, and burrow-db already reads it).
const EXAMPLE_DSN = 'postgres://user:password@localhost:5432/database';

/** Owns the pgAdmin container + its embedded webview. One per window. */
export class PgAdmin implements vscode.Disposable {

	private readonly out = vscode.window.createOutputChannel('Burrow pgAdmin');
	private panel: vscode.WebviewPanel | undefined;

	constructor(private readonly extensionPath: string) { }

	private get dir(): string { return path.join(this.extensionPath, 'tools', 'db-admin'); }
	private port(): number { return vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('pgadmin.port') ?? DEFAULT_PORT; }

	/** Resolve the connection, provision + boot pgAdmin, and reveal the panel. */
	async open(): Promise<void> {
		if (this.panel) {
			this.panel.reveal();
			return;
		}
		const conn = await this.resolveConnection();
		if (!conn) {
			return; // user cancelled the prompt
		}
		let dsn: Dsn;
		try {
			dsn = parsePostgresUrl(conn);
		} catch (err) {
			void vscode.window.showErrorMessage(`Burrow pgAdmin: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		this.writeProvisioning(dsn);
		const port = this.port();
		// The panel opens FIRST, saying what it is waiting for (docs/plans/02
		// §3.6 step 1: a sentence and a spinner, never a white flash). The old
		// order — notification, then panel — left the editor area empty for the
		// two minutes an image pull can take.
		this.showPanel(port, describeDsn(dsn), 'loading');
		try {
			await this.composeUp();
			await this.waitReady(port, 120_000);
		} catch (err) {
			this.out.appendLine(`[pgadmin] ${err instanceof Error ? err.message : String(err)}`);
			this.showPanel(port, describeDsn(dsn), 'failed', err instanceof Error ? err.message : String(err));
			return;
		}
		this.showPanel(port, describeDsn(dsn), 'ready');
	}

	/** Stop the pgAdmin container (and close the panel), leaving no orphan. */
	async stop(): Promise<void> {
		this.panel?.dispose();
		this.panel = undefined;
		await this.compose(['down'], 'stop').catch(() => undefined);
	}

	dispose(): void {
		this.panel?.dispose();
		this.out.dispose();
	}

	/**
	 * The connection pgAdmin manages: the existing `burrow.db.connectionString`
	 * setting or `DATABASE_URL` if set (shared with the native explorer), else a
	 * prompt pre-filled with the merkle default. A freshly entered value is
	 * persisted so both surfaces agree.
	 */
	private async resolveConnection(): Promise<string | undefined> {
		const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const existing = pickConnectionString({
			setting: cfg.get<string>('connectionString'),
			env: process.env.DATABASE_URL,
			workspace: findWorkspaceDatabaseUrl(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
		});
		if (existing) {
			return existing;
		}
		const entered = await vscode.window.showInputBox({
			title: 'pgAdmin — Postgres connection',
			prompt: 'No burrow.db.connectionString or DATABASE_URL is set. Enter the Postgres URL for pgAdmin to manage.',
			value: EXAMPLE_DSN,
			ignoreFocusOut: true,
		});
		if (!entered) {
			return undefined;
		}
		const target = vscode.workspace.workspaceFolders?.length
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;
		await cfg.update('connectionString', entered, target);
		return entered;
	}

	/** Write the (git-ignored) servers.json + pgpass the container mounts. */
	private writeProvisioning(dsn: Dsn): void {
		fs.mkdirSync(this.dir, { recursive: true });
		fs.writeFileSync(path.join(this.dir, 'servers.json'), pgAdminServers(dsn), { mode: 0o644 });
		// 0600: pgAdmin refuses a pgpass with broader permissions.
		fs.writeFileSync(path.join(this.dir, 'pgpass'), pgAdminPassLine(dsn), { mode: 0o600 });
	}

	private composeUp(): Promise<void> {
		return this.compose(['up', '-d', 'pgadmin'], 'start');
	}

	/** Run `docker compose <args>` in the db-admin dir; reject with a directive message. */
	private compose(args: string[], verb: string): Promise<void> {
		return new Promise((resolve, reject) => {
			this.out.appendLine(`[pgadmin] docker compose ${args.join(' ')}`);
			const child = cp.spawn('docker', ['compose', '-f', 'docker-compose.yml', ...args], { cwd: this.dir });
			child.stdout.on('data', (d: Buffer) => this.out.append(d.toString()));
			child.stderr.on('data', (d: Buffer) => this.out.append(d.toString()));
			child.on('error', (err: NodeJS.ErrnoException) => {
				reject(new Error(err.code === 'ENOENT'
					? 'Docker was not found on your PATH. Install Docker Desktop, then run "Burrow DB: Open pgAdmin" again.'
					: `Could not ${verb} pgAdmin: ${err.message}`));
			});
			child.on('exit', code => {
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`Could not ${verb} pgAdmin (docker compose exited ${code ?? '?'}). Is the Docker daemon running? See the "Burrow pgAdmin" output.`));
				}
			});
		});
	}

	/** Poll pgAdmin's own /misc/ping until it answers (image pull + boot is slow). */
	private async waitReady(port: number, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				const res = await fetch(`http://127.0.0.1:${port}/misc/ping`, { signal: AbortSignal.timeout(1500) });
				if (res.ok) {
					return;
				}
			} catch {
				// not up yet — pgAdmin is still booting (or pulling the image)
			}
			await new Promise(r => setTimeout(r, 1000));
		}
		throw new Error(`pgAdmin did not answer on http://127.0.0.1:${port} within ${timeoutMs / 1000}s — see the "Burrow pgAdmin" output.`);
	}

	/**
	 * The pgAdmin surface, in whichever state it is in. Reuses the one panel, so
	 * loading → ready is a repaint rather than a second tab, and every state
	 * looks like a Burrow tool: theme tokens, a sentence, no white flash, and a
	 * failure that names the thing to start rather than showing a dead frame.
	 */
	private showPanel(port: number, label: string, state: 'loading' | 'ready' | 'failed', detail = ''): void {
		const origin = `http://127.0.0.1:${port}`;
		const panel = this.panel ?? vscode.window.createWebviewPanel(
			'burrow.db.pgadmin',
			'pgAdmin',
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		if (!this.panel) {
			panel.onDidDispose(() => { this.panel = undefined; });
			panel.webview.onDidReceiveMessage((message: { type?: string }) => {
				if (message?.type === 'exitFocus') {
					// Esc bridge (docs/plans/01 §4): the iframe owns the keystroke.
					void vscode.commands.executeCommand('burrow.focus.exit');
				} else if (message?.type === 'retry') {
					void this.open();
				}
			});
			this.panel = panel;
		}
		panel.title = state === 'ready' ? 'pgAdmin' : state === 'loading' ? 'pgAdmin — starting…' : 'pgAdmin — not running';
		const n = nonce();
		const body = state === 'ready'
			? `<iframe src="${origin}/browser/" allow="clipboard-read; clipboard-write"></iframe>`
			: state === 'loading'
				? `<div class="wait"><div class="spinner"></div><p>Starting pgAdmin for <b>${escapeHtml(label)}</b>…</p>
					<p class="muted">First run pulls the <code>dpage/pgadmin4</code> image, which can take a minute.</p></div>`
				: `<div class="wait"><h3>pgAdmin is not running</h3>
					<p>Its container could not start. Docker Desktop must be running; the tool then brings up <code>pgadmin</code> itself.</p>
					<pre>${escapeHtml(detail.trim() || 'no detail')}</pre>
					<button id="retry">Try again</button></div>`;
		panel.webview.html = `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'nonce-${n}'; script-src 'nonce-${n}'">
	<style nonce="${n}">
		html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
			background: var(--vscode-editor-background); color: var(--vscode-foreground);
			font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
		iframe { display: block; width: 100%; height: 100%; border: 0; }
		.wait { max-width: 52ch; margin: 12vh auto 0; padding: 0 20px; line-height: 1.55; }
		.wait h3 { font-size: 13px; margin: 0 0 8px; }
		.wait .muted { opacity: .6; font-size: 12px; }
		.wait pre { background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 5px;
			font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre-wrap; }
		.wait button { font: inherit; font-size: 12px; padding: 2px 10px; border-radius: 4px; cursor: pointer;
			color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; }
		.spinner { width: 14px; height: 14px; border-radius: 50%; margin-bottom: 10px;
			border: 2px solid var(--vscode-foreground); border-right-color: transparent; opacity: .5;
			animation: spin 900ms linear infinite; }
		@keyframes spin { to { transform: rotate(360deg); } }
	</style>
	<title>pgAdmin — ${escapeHtml(label)}</title>
</head>
<body>
	${body}
<script nonce="${n}">
	const vscode = acquireVsCodeApi();
	const retry = document.getElementById('retry');
	if (retry) { retry.addEventListener('click', () => vscode.postMessage({ type: 'retry' })); }
	window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { vscode.postMessage({ type: 'exitFocus' }); } });
</script>
</body>
</html>`;
	}
}
