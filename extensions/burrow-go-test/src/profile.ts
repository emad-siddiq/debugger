/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// profile.ts — run a Go profile and show its web UI inside Burrow.
//
// The survey's biggest single gap. IntelliJ ships async-profiler with flame
// graphs; Xcode ships Instruments; Burrow had nothing, and the repo contained
// zero references to pprof. What made that gap cheap to close is that Go already
// has both halves: `go test` writes the profile, and `go tool pprof -http`
// serves a full web UI — flame graph, top table, peek, source, disassembly —
// against it. `go tool trace -http` does the same for an execution trace.
//
// Why this lives in burrow-go-test rather than an extension of its own: a
// profiling run IS a `go test` run, this extension already owns that argv and
// its process boundary, and a new `extensions/burrow-go-profile` would have to
// be added to the `compilations` list in `build/gulpfile.extensions.ts` — a core
// file, so a sixteenth patch-ledger entry for a directory rename's worth of
// benefit. The budget is better spent elsewhere.
//
// Lifecycle discipline follows burrow-db's pgAdmin panel: one reused panel, an
// explicit loading → ready → failed progression that always says what happened,
// and a viewer process this class owns and kills. A profiler that leaves a
// `go tool pprof` holding a port after its tab closed is a bug the user finds
// three days later.

import { spawn, ChildProcess } from 'child_process';
import { createServer } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	Disposable,
	QuickPickItem,
	ViewColumn,
	WebviewPanel,
	window,
	workspace,
} from 'vscode';
import {
	PROFILE_SPECS,
	ProfileKind,
	ProfileSpec,
	buildPprofArgs,
	buildProfileArgs,
	buildTraceArgs,
	parseServingUrl,
	profileSpec,
	traceEnv,
} from './profileArgs';

export const PROFILE_VIEW_TYPE = 'burrowGoProfile';
const VIEW_TYPE = PROFILE_VIEW_TYPE;

/** How long to wait for a viewer to announce its address before giving up. */
const VIEWER_TIMEOUT_MS = 30_000;

interface KindItem extends QuickPickItem {
	readonly spec: ProfileSpec;
}

/** Where the profile came from: a package, and optionally the names to select. */
export interface ProfileTarget {
	readonly cwd: string;
	readonly packagePath: string;
	readonly names?: readonly string[];
}

export class GoProfiler implements Disposable {

	private panel: WebviewPanel | undefined;
	private viewer: ChildProcess | undefined;
	private readonly out = window.createOutputChannel('Burrow Go Profiler');
	/** Scratch directory for this session's profiles; removed on dispose. */
	private readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-profile-'));

	constructor(private readonly settings: () => { goExecutable: string; race: boolean }) { }

	/** Ask which profile, run it, and show the viewer. */
	async profile(target?: ProfileTarget): Promise<void> {
		const resolved = target ?? this.targetFromEditor();
		if (!resolved) {
			void window.showInformationMessage(
				'Profile: open a Go file first — the profile is taken of the package it belongs to.',
			);
			return;
		}

		const items: KindItem[] = PROFILE_SPECS.map(spec => ({
			label: spec.label,
			description: spec.detail,
			spec,
		}));
		const chosen = await window.showQuickPick(items, {
			title: `Profile ${resolved.packagePath}`,
			placeHolder: 'Benchmarks are run to produce the profile; ordinary tests are suppressed',
			matchOnDescription: true,
		});
		if (!chosen) {
			return;
		}
		await this.run(resolved, chosen.spec.kind);
	}

	dispose(): void {
		this.stopViewer();
		this.panel?.dispose();
		this.out.dispose();
		fs.rmSync(this.dir, { recursive: true, force: true });
	}

	/** Run `go test` to produce the profile, then start and frame its viewer. */
	private async run(target: ProfileTarget, kind: ProfileKind): Promise<void> {
		const spec = profileSpec(kind);
		if (!spec) {
			return;
		}
		const profilePath = path.join(this.dir, spec.file);
		const binaryPath = path.join(this.dir, 'profile.test');
		const { goExecutable, race } = this.settings();

		this.show(spec, 'running', `Running benchmarks in ${target.packagePath} to collect the ${spec.label.toLowerCase()} profile…`);

		const args = buildProfileArgs({
			packagePath: target.packagePath,
			kind,
			profilePath,
			binaryPath,
			names: target.names,
			race,
		});
		this.out.appendLine(`[profile] ${goExecutable} ${args.join(' ')}   (cwd ${target.cwd})`);

		const result = await this.spawnAndWait(goExecutable, args, target.cwd);
		this.out.append(result.output);
		if (result.code !== 0) {
			this.show(spec, 'failed', `\`go test\` exited ${result.code ?? 'killed'}.`, result.output.trim().split('\n').slice(-12).join('\n'));
			return;
		}
		// A benchmark that never ran writes no profile, and the exit code is still
		// 0 — `go test` considers "no benchmarks matched" a success. Saying so
		// beats framing a viewer that will fail to parse an empty file.
		if (!fs.existsSync(profilePath) || fs.statSync(profilePath).size === 0) {
			this.show(spec, 'failed',
				`No profile was written. \`go test\` succeeded but ${target.names?.length ? `none of ${target.names.join(', ')}` : `${target.packagePath} has no benchmarks that`} produced any samples.`,
				result.output.trim().split('\n').slice(-8).join('\n'));
			return;
		}

		this.show(spec, 'starting', `Starting ${spec.viewer === 'trace' ? '`go tool trace`' : '`go tool pprof`'}…`);

		const port = await freePort();
		const viewerArgs = spec.viewer === 'trace'
			? buildTraceArgs(port, profilePath, binaryPath)
			: buildPprofArgs(port, profilePath, binaryPath);
		this.out.appendLine(`[profile] ${goExecutable} ${viewerArgs.join(' ')}`);

		this.stopViewer();
		const child = spawn(goExecutable, viewerArgs, {
			cwd: target.cwd,
			// `go tool trace` has no -no_browser flag and opens the system browser on
			// start. It does honour $BROWSER, so this is what keeps the page from
			// also appearing outside Burrow.
			env: spec.viewer === 'trace' ? traceEnv(process.env) : process.env,
		});
		this.viewer = child;

		const url = await this.awaitViewerUrl(child);
		if (!url) {
			this.stopViewer();
			this.show(spec, 'failed',
				`The viewer did not report an address within ${VIEWER_TIMEOUT_MS / 1000}s.`,
				'See the "Burrow Go Profiler" output for what it printed.');
			return;
		}
		this.out.appendLine(`[profile] viewer serving on ${url}`);
		this.show(spec, 'ready', url);
	}

	/** Reads the viewer's own "serving on <url>" line off its output. */
	private awaitViewerUrl(child: ChildProcess): Promise<string | undefined> {
		return new Promise(resolve => {
			let settled = false;
			const finish = (url: string | undefined) => {
				if (!settled) {
					settled = true;
					resolve(url);
				}
			};
			const read = (buf: Buffer) => {
				const text = buf.toString();
				this.out.append(text);
				const url = parseServingUrl(text);
				if (url) {
					finish(url);
				}
			};
			// pprof prints to stderr, trace to stderr as well — but neither promises
			// it, so both streams are read.
			child.stdout?.on('data', read);
			child.stderr?.on('data', read);
			child.on('error', err => {
				this.out.appendLine(`[profile] viewer failed to start: ${err.message}`);
				finish(undefined);
			});
			child.on('exit', code => {
				this.out.appendLine(`[profile] viewer exited ${code ?? 'killed'} before reporting an address`);
				finish(undefined);
			});
			setTimeout(() => finish(undefined), VIEWER_TIMEOUT_MS);
		});
	}

	/** Kills the running viewer, if any. */
	private stopViewer(): void {
		const child = this.viewer;
		this.viewer = undefined;
		if (child && child.exitCode === null) {
			child.kill();
		}
	}

	/** Runs a command to completion, collecting its combined output. */
	private spawnAndWait(command: string, args: readonly string[], cwd: string): Promise<{ code: number | null; output: string }> {
		return new Promise(resolve => {
			let output = '';
			const child = spawn(command, args as string[], { cwd });
			child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
			child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
			child.on('error', err => resolve({ code: null, output: `${output}\n${err.message}` }));
			child.on('exit', code => resolve({ code, output }));
		});
	}

	/** The package the active editor's file belongs to, relative to its folder. */
	private targetFromEditor(): ProfileTarget | undefined {
		const editor = window.activeTextEditor;
		if (!editor || editor.document.languageId !== 'go' || editor.document.uri.scheme !== 'file') {
			return undefined;
		}
		const folder = workspace.getWorkspaceFolder(editor.document.uri);
		if (!folder) {
			return undefined;
		}
		const dir = path.dirname(editor.document.uri.fsPath);
		const rel = path.relative(folder.uri.fsPath, dir);
		return {
			cwd: folder.uri.fsPath,
			// `go test` wants a package spec, and a bare relative path is not one:
			// `internal/x` is read as an import path, `./internal/x` as a directory.
			packagePath: rel === '' ? '.' : `./${rel.split(path.sep).join('/')}`,
		};
	}

	/** Paints the panel in whichever state the run is in. */
	private show(spec: ProfileSpec, state: 'running' | 'starting' | 'ready' | 'failed', message: string, detail = ''): void {
		if (!this.panel) {
			this.panel = window.createWebviewPanel(
				VIEW_TYPE,
				`Profile — ${spec.label}`,
				ViewColumn.Active,
				{ enableScripts: true, retainContextWhenHidden: true },
			);
			this.panel.onDidDispose(() => {
				this.panel = undefined;
				// The viewer exists to serve this panel. Closing the tab is the user
				// saying they are done with it, and leaving `go tool pprof` holding a
				// port afterwards is how a machine ends up with nine of them.
				this.stopViewer();
			});
		}
		this.panel.title = `Profile — ${spec.label}`;
		this.panel.webview.html = state === 'ready'
			? frame(message)
			: status(spec, state, message, detail);
		this.panel.reveal(this.panel.viewColumn ?? ViewColumn.Active, false);
	}

	// NO webview panel serializer. The viewer is a child process that does not
	// survive a window reload, so a restored tab would frame a dead port. The
	// panel is one command away.
}

/**
 * Picks a port nothing is listening on, by binding one and letting go.
 *
 * There is a race here — something else could take the port between the close
 * and the viewer's bind — and it is accepted deliberately, because the
 * alternative does not exist: **neither `go tool pprof` nor `go tool trace`
 * reports the port it bound when given `:0`.** Both echo the literal `:0` back
 * in their "serving on" line, measured against the Go 1.24 toolchain, so there
 * is no way to ask them. A concrete port chosen this way is the only option.
 */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(() => (port ? resolve(port) : reject(new Error('could not reserve a port'))));
		});
	});
}

/** The frame around a running viewer. */
function frame(url: string): string {
	const n = nonce();
	const origin = new URL(url).origin;
	const csp = `default-src 'none'; frame-src ${origin}; style-src 'nonce-${n}';`;
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<style nonce="${n}">
		:root { color-scheme: light dark; }
		html, body { height: 100%; margin: 0; }
		body { background: var(--vscode-editor-background); }
		iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
	</style>
</head>
<body><iframe src="${escapeAttribute(url)}" title="profile"></iframe></body>
</html>`;
}

/** The panel while it is working, or when it could not. */
function status(spec: ProfileSpec, state: 'running' | 'starting' | 'failed', message: string, detail: string): string {
	const n = nonce();
	const csp = `default-src 'none'; style-src 'nonce-${n}';`;
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<style nonce="${n}">
		:root { color-scheme: light dark; }
		body { margin: 0; padding: 48px 40px; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
		h1 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
		p { margin: 0 0 14px; max-width: 68ch; line-height: 1.55; color: var(--vscode-descriptionForeground); }
		pre { margin: 0; padding: 12px 14px; max-width: 100%; overflow-x: auto; border: 1px solid var(--vscode-panel-border); border-radius: 4px; font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre-wrap; }
		.bad { color: var(--vscode-errorForeground); }
	</style>
</head>
<body>
	<h1${state === 'failed' ? ' class="bad"' : ''}>${escapeHtml(spec.label)} profile${state === 'failed' ? ' — failed' : ''}</h1>
	<p>${escapeHtml(spec.detail)}</p>
	<p>${escapeHtml(message)}</p>
	${detail ? `<pre>${escapeHtml(detail)}</pre>` : ''}
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
	return escapeHtml(value).replace(/"/g, '&quot;');
}

function nonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return out;
}
