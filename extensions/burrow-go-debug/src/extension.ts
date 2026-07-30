/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, execFile, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import {
	DebugAdapterDescriptor,
	DebugAdapterDescriptorFactory,
	DebugAdapterServer,
	DebugConfiguration,
	DebugConfigurationProvider,
	DebugSession,
	ExtensionContext,
	ProviderResult,
	WorkspaceFolder,
	debug,
	window,
} from 'vscode';
import { buildError } from './buildOutput';
import { mergeEnv, parseEnvFile } from './envfile';

// burrow-go-debug is the WO-2 IX prerequisite: the smallest extension that turns
// the intact workbench debug UI into a working Go debugger by bridging to a
// host-installed `dlv dap`. The full Delve engine (breakpoint matrix, attach,
// panic UX, pinned dlv) is architecture task 04; this only needs to reach a live
// stopped session so the inspector work (WO-3+) has a real DAP model to build on.

const DEBUG_TYPE = 'go';

// `dlv dap --listen` prints this once its DAP listener is bound; we parse the
// bound host:port from it (ephemeral port -> collision-free, per task 04).
const LISTEN_RE = /DAP server listening at:\s*(?<host>[^:\s]+):(?<port>\d+)/;
// How long to wait for that banner. dlv binds its listener before it does any
// build work, so this is a "did it start at all" bound, not a build budget.
const LISTEN_TIMEOUT_MS = 30_000;

/**
 * Resolves the Delve binary. WO-2 uses the host-installed `dlv`; bundling a
 * pinned Delve is a task-03 concern. Order: `BURROW_DLV_PATH`, then the
 * conventional `$GOBIN` / `$GOPATH/bin` / `$HOME/go/bin`, then PATH.
 */
function resolveDelve(): string {
	const fromEnv = process.env.BURROW_DLV_PATH;
	if (fromEnv && existsSync(fromEnv)) {
		return fromEnv;
	}
	const goBin = process.env.GOBIN || join(process.env.GOPATH || join(homedir(), 'go'), 'bin');
	const candidate = join(goBin, 'dlv');
	if (existsSync(candidate)) {
		return candidate;
	}
	return 'dlv'; // let the OS resolve it from PATH
}

/**
 * On macOS, Delve launches debuggees through Apple's `debugserver`, which needs
 * task-port authorization. With Developer Mode DISABLED the authorization
 * prompt never reaches a headless extension host, so `dlv dap` hangs FOREVER
 * inside the launch request — no error, no timeout (observed against merkle:
 * the DAP `launch` simply never answers). Fail fast with the one-time fix
 * instead. Cached per window; `DevToolsSecurity -status` is non-privileged.
 */
let devModeOk = false;
function macDeveloperModeDisabled(): Promise<boolean> {
	if (process.platform !== 'darwin' || devModeOk || process.env.BURROW_SKIP_DEVMODE_CHECK) {
		return Promise.resolve(false);
	}
	return new Promise((resolve) => {
		// Absolute path: /usr/sbin is routinely missing from the extension host's
		// PATH, and an ENOENT here would silently skip the check.
		execFile('/usr/sbin/DevToolsSecurity', ['-status'], { timeout: 3000 }, (err, stdout) => {
			if (!err && /disabled/i.test(stdout)) {
				resolve(true);
				return;
			}
			devModeOk = true; // enabled, or the tool is unavailable — don't re-run per window
			resolve(false);
		});
	});
}

/**
 * The directory holding the `go.mod` this workspace's program lives in.
 *
 * The same order `burrow-project`'s detection uses, deliberately duplicated rather
 * than imported: an extension that cannot start a debug session because a SIBLING
 * extension failed to activate is a worse failure than one that repeats six lines.
 * If the two ever disagree, `burrow.project.explain` is the tie-breaker and says
 * which root it found.
 */
function goModuleRoot(folderPath: string): string | undefined {
	for (const dir of ['.', 'backend', 'server', 'api', 'cmd', 'src', 'service']) {
		const at = dir === '.' ? folderPath : join(folderPath, dir);
		if (existsSync(join(at, 'go.mod'))) {
			return at;
		}
	}
	return undefined;
}

/** Does this directory hold a `package main`? */
function isMainPackage(dir: string): boolean {
	try {
		for (const file of readdirSync(dir)) {
			if (!file.endsWith('.go') || file.endsWith('_test.go')) {
				continue;
			}
			if (/^\s*package\s+main\b/m.test(readFileSync(join(dir, file), 'utf8'))) {
				return true;
			}
		}
	} catch {
		// absent or unreadable — not a main
	}
	return false;
}

/**
 * Every runnable package under a module: the module root, plus one level under the
 * conventional command directories.
 *
 * A MODULE ROOT IS NOT A PROGRAM (WO-72, measured on `alertmanager`). The module is
 * at the root and the runnable code is `cmd/alertmanager` and `cmd/amtool`; pointing
 * dlv at the root builds nothing and the session dies.
 *
 * Mirrors `burrow-project`'s `goEntries` and does not import it, for the reason
 * stated on `goModuleRoot`: a debug session that cannot start because a sibling
 * extension failed to activate is a worse failure than repeated lines.
 */
function goEntryPoints(moduleRoot: string): { label: string; path: string }[] {
	const found: { label: string; path: string }[] = [];
	if (isMainPackage(moduleRoot)) {
		found.push({ label: basename(moduleRoot), path: moduleRoot });
	}
	for (const parent of ['cmd', 'cmds', 'apps', 'tools']) {
		let names: string[] = [];
		try { names = readdirSync(join(moduleRoot, parent)); } catch { continue; }
		for (const name of names) {
			const at = join(moduleRoot, parent, name);
			if (isMainPackage(at)) {
				found.push({ label: name, path: at });
			}
		}
	}
	return found;
}


/** A path as a person would refer to it inside their own project. */
function relativeTo(root: string, target: string): string {
	return target === root ? '.' : target.startsWith(root + '/') ? target.slice(root.length + 1) : target;
}

/** Where a remembered entry-point choice lives: the project descriptor. */
const DESCRIPTOR = '.burrow/project.json';

function rememberedEntry(folderPath: string): string | undefined {
	try {
		const raw = JSON.parse(readFileSync(join(folderPath, DESCRIPTOR), 'utf8')) as { entry?: string };
		return typeof raw.entry === 'string' ? raw.entry : undefined;
	} catch {
		return undefined;
	}
}

function rememberEntry(folderPath: string, entry: string): void {
	const at = join(folderPath, DESCRIPTOR);
	let body: Record<string, unknown> = {};
	try { body = JSON.parse(readFileSync(at, 'utf8')) as Record<string, unknown>; } catch { body = { version: 1 }; }
	body.entry = entry;
	try {
		mkdirSync(dirname(at), { recursive: true });
		writeFileSync(at, JSON.stringify(body, null, '\t') + '\n', 'utf8');
	} catch {
		// A choice we cannot persist costs one extra prompt, not the session.
	}
}

/**
 * Fills the gaps VS Code leaves in a bare `go` config so a fixture can debug
 * with just `{ "type": "go", "request": "launch" }` (or an F5 with no launch.json).
 */
class GoDebugConfigurationProvider implements DebugConfigurationProvider {
	constructor(private readonly out: import('vscode').OutputChannel) { }

	async resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration): Promise<DebugConfiguration | undefined> {
		// Abort HERE (undefined = clean cancel; startDebugging resolves false)
		// rather than failing later in the adapter factory — a descriptor
		// rejection leaves a half-open "initializing" session in the UI.
		if (await macDeveloperModeDisabled()) {
			void window.showErrorMessage(
				'Go debug: macOS Developer Mode is disabled, so Delve\'s debugserver would hang forever waiting for debug authorization. '
				+ 'Run `sudo DevToolsSecurity -enable` once in a terminal, then start debugging again.',
			);
			return undefined;
		}
		if (!config.type && !config.request) {
			config.type = DEBUG_TYPE;
			config.name = 'Debug';
			config.request = 'launch';
		}
		if (config.request === 'launch') {
			if (!config.mode) {
				config.mode = 'debug';
			}
			// THE MODULE ROOT, not the workspace root (WO-72 §2).
			//
			// This used to default `program` and `cwd` to the workspace folder, which
			// is right only when the go.mod is AT the folder. For a repository whose
			// module sits under `backend/` — merkle's shape, and a common one — dlv
			// then runs `go build` somewhere with no go.mod and fails with "cannot
			// find main module". It worked for merkle only because merkle's
			// launch.json spells the path out by hand.
			//
			// The descriptor knows where the module is, from detection, with no config
			// file required. This is the only thing migrated onto it in this work
			// order: the line is drawn at "what F5 needs to find the program", and
			// nothing else in the debug path changes behaviour.
			const moduleRoot = folder ? goModuleRoot(folder.uri.fsPath) : undefined;
			if (moduleRoot && folder && moduleRoot !== folder.uri.fsPath) {
				this.out.appendLine(`[go-debug] module root is ${moduleRoot} (not the workspace root)`);
			}

			// ── THE ENTRY POINT (WO-74 §2) ────────────────────────────────────
			// Zero, one and many are three different obligations. Only resolved when
			// the config does not already name a program: a launch.json that spells
			// the path out is the project's business and is left alone.
			if (!config.program && moduleRoot && folder) {
				const entries = goEntryPoints(moduleRoot);

				if (entries.length === 0) {
					// ZERO — say there is nothing to run, and why. A library is not a
					// broken project, so this is information, not an error dialog.
					void window.showInformationMessage(
						`Nothing to debug in ${basename(folder.uri.fsPath)}: no \`package main\` under `
						+ `${relativeTo(folder.uri.fsPath, moduleRoot)} or its cmd/ directories. `
						+ `This module is a library — open a package with a main, or add a launch configuration that names one.`,
					);
					this.out.appendLine(`[go-debug] no entry point under ${moduleRoot} — nothing to launch`);
					return undefined;
				}

				let chosen = entries.length === 1 ? entries[0] : undefined;

				if (!chosen) {
					// MANY — a remembered choice settles it, but only if it still exists.
					const remembered = rememberedEntry(folder.uri.fsPath);
					chosen = remembered
						? entries.find((e) => relativeTo(folder.uri.fsPath, e.path) === remembered)
						: undefined;
					if (remembered && !chosen) {
						this.out.appendLine(`[go-debug] remembered entry ${remembered} no longer exists — asking again`);
					}
				}

				if (!chosen) {
					// ASK. Never guess: `cmd/<reponame>` was available and is declined
					// on purpose — picking a binary because its name matched the
					// directory is how you debug the wrong process at 2am.
					const picked = await window.showQuickPick(
						entries.map((e) => ({
							label: e.label,
							description: relativeTo(folder.uri.fsPath, e.path),
							detail: e.path === entries[0].path ? undefined : undefined,
							path: e.path,
						})),
						{
							title: `${basename(folder.uri.fsPath)} has ${entries.length} programs — which one?`,
							placeHolder: 'Remembered in .burrow/project.json; you will not be asked again',
							ignoreFocusOut: true,
						},
					);
					if (!picked) {
						// Cancelled. Declining is fine; declining SILENTLY is not.
						this.out.appendLine('[go-debug] entry point not chosen — nothing started');
						return undefined;
					}
					chosen = entries.find((e) => e.path === picked.path);
					if (chosen) {
						// RELATIVE, never the absolute path. The descriptor is a project
						// file — committable, shareable, and meaningless on another
						// machine if it names /private/tmp/... Also the id contract
						// `chooseEntry` reads: ids are project-relative paths.
						const id = relativeTo(folder.uri.fsPath, chosen.path);
						rememberEntry(folder.uri.fsPath, id);
						this.out.appendLine(`[go-debug] remembered "${id}" in ${DESCRIPTOR}`);
					}
				}

				config.program = chosen!.path;
				this.out.appendLine(`[go-debug] entry point: ${chosen!.label} (${chosen!.path})`);
			}

			if (!config.program) {
				config.program = moduleRoot ?? (folder ? folder.uri.fsPath : '${workspaceFolder}');
			}
			// dlv builds (`go build`) from cwd; without it dlv uses its own process
			// cwd (the IDE root, which has no go.mod) and the build fails with
			// "cannot find main module". The MODULE root, not the program's directory:
			// `go build` needs to see the go.mod.
			if (!config.cwd) {
				config.cwd = moduleRoot ?? (folder ? folder.uri.fsPath : '${workspaceFolder}');
			}
		} else if (config.request === 'attach' && !config.mode) {
			config.mode = 'local';
		}
		return config;
	}

	/**
	 * Merges any `envFile` into `env` AFTER variable substitution (so a
	 * `${workspaceFolder}` in the path is already resolved). `dlv dap` honors
	 * `env` in the launch request but ignores `envFile` (a vscode-go
	 * convenience), so we resolve it here, let inline `env` win on conflict, and
	 * drop `envFile` before handing the config to Delve. A missing/unreadable
	 * file warns and is skipped rather than aborting the session — inline `env`
	 * usually carries the essentials.
	 */
	resolveDebugConfigurationWithSubstitutedVariables(_folder: WorkspaceFolder | undefined, config: DebugConfiguration): ProviderResult<DebugConfiguration> {
		const envFile = config.envFile;
		if (!envFile) {
			return config;
		}
		const files = Array.isArray(envFile) ? envFile : [envFile];
		const fileEnvs: Array<Record<string, string>> = [];
		for (const file of files) {
			if (typeof file !== 'string' || !file) {
				continue;
			}
			try {
				fileEnvs.push(parseEnvFile(readFileSync(file, 'utf8')));
			} catch (err) {
				void window.showWarningMessage(`Burrow: could not read envFile '${file}': ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		config.env = mergeEnv(fileEnvs, config.env);
		delete config.envFile;
		return config;
	}
}

/**
 * `dlv dap` is a headless TCP DAP server with no stdio mode, so we spawn it on
 * an ephemeral port, wait for its listen banner, and point the workbench at the
 * port. We own the process and kill it when the session ends (kill-safe: no
 * orphaned dlv, per task 04).
 */
class GoDebugAdapterDescriptorFactory implements DebugAdapterDescriptorFactory {
	private readonly servers = new Map<string, ChildProcessWithoutNullStreams>();
	/** Sessions already told about a build failure — dlv repeats the error across
	 *  several chunks and one dialog is the message, five is noise. */
	private readonly reported = new Set<string>();

	constructor(private readonly out: import('vscode').OutputChannel) { }

	createDebugAdapterDescriptor(session: DebugSession): Promise<DebugAdapterDescriptor> {
		const dlv = resolveDelve();
		// Run dlv in the debuggee's folder so its `go build` resolves the module,
		// even if the config's cwd is unset (safety net for the resolver above).
		const cwd = session.configuration.cwd || session.workspaceFolder?.uri.fsPath;
		const child = spawn(dlv, ['dap', '--listen=127.0.0.1:0'], cwd ? { cwd } : {});

		return new Promise<DebugAdapterDescriptor>((resolve, reject) => {
			let settled = false;
			// The banner is one short line, but it still arrives as a stream: an
			// unlucky flush splits it across two chunks ("…listening at: 127.0.0" +
			// ".1:54321"). Matching the chunk in hand loses the port for good, and
			// because nothing below times out the session then sits in "starting"
			// forever with dlv idle and no error anywhere. Match what we have seen
			// so far instead.
			let seen = '';
			let timer: ReturnType<typeof setTimeout> | undefined;
			const settle = () => {
				settled = true;
				if (timer) {
					clearTimeout(timer);
					timer = undefined;
				}
			};
			const fail = (err: Error) => {
				if (!settled) {
					settle();
					child.kill();
					reject(err);
				}
			};
			const scan = (chunk: Buffer) => {
				const text = chunk.toString();
				if (!settled) {
					seen += text;
					const match = LISTEN_RE.exec(seen);
					if (match?.groups) {
						settle();
						this.servers.set(session.id, child);
						resolve(new DebugAdapterServer(Number(match.groups.port), match.groups.host));
					}
					return;
				}
				// `dlv dap` in server mode prints the DEBUGGEE's stdout/stderr on its
				// own streams (not as DAP output events) — surface it instead of
				// silently dropping it.
				this.out.append(text);

				// A BUILD FAILURE MUST NOT BE SILENT (WO-74 §3).
				//
				// dlv binds its DAP port BEFORE it builds, so a compile error arrives
				// here — after the banner, on a channel nobody has open. The session
				// then starts, fails, and ends with no message anywhere: exactly what
				// `alertmanager` produced, and the reason two runs disagreed about
				// whether a session had existed at all.
				//
				// Fixed here rather than only in the entry-point resolution, because
				// this arrives again from every stack we add and next time the entry
				// point will not be the cause.
				const build = buildError(text);
				if (build && !this.reported.has(session.id)) {
					this.reported.add(session.id);
					void window.showErrorMessage(`Go debug: the build failed, so nothing is running.\n\n${build}`, 'Show Output')
						.then((choice) => {
							if (choice === 'Show Output') {
								this.out.show(true);
							}
						});
				}
			};
			// dlv binds before it builds anything, so the banner is prompt or never.
			// Failing loudly beats a session that never starts and never says why.
			timer = setTimeout(
				() => fail(new Error(`Delve started but never announced its DAP port within ${LISTEN_TIMEOUT_MS / 1000}s. Output so far: ${seen.trim() || '(none)'}`)),
				LISTEN_TIMEOUT_MS);
			child.stdout.on('data', scan);
			child.stderr.on('data', scan);
			child.on('error', err => fail(new Error(`Could not start Delve at '${dlv}': ${err.message}. Install Delve or set BURROW_DLV_PATH.`)));
			// PRE-BANNER FAILURE (WO-74 §3, second half). dlv binds before it builds,
			// so a session that dies BEFORE the banner died for a different reason —
			// usually the build, and `seen` is holding the compiler's exact words.
			// Reporting only "exited (code 1)" is the silent decline in a thin
			// disguise: measured on prometheus/alertmanager, which embeds a web UI a
			// fresh clone has not built, and whose real message is
			// `ui/web.go:31:12: pattern app/dist: no matching files found`.
			child.on('exit', (code) => {
				const build = buildError(seen);
				fail(new Error(build
					? `Go debug: the build failed, so nothing started.\n\n${build}\n\n`
					+ `This is the project's own build, not Burrow's — run its build steps (a Makefile target, `
					+ `a generate step, or an embedded asset that has to be produced first) and try again.`
					: `Delve exited before it began listening (code ${code ?? 'null'}).`
					+ `${seen.trim() ? ` Output: ${seen.trim().slice(0, 400)}` : ' It printed nothing.'}`));
			});
		});
	}

	terminate(session: DebugSession): void {
		const child = this.servers.get(session.id);
		if (child) {
			child.kill();
			this.servers.delete(session.id);
		}
		this.reported.delete(session.id);
	}

	dispose(): void {
		for (const child of this.servers.values()) {
			child.kill();
		}
		this.servers.clear();
	}
}

export function activate(context: ExtensionContext): void {
	const out = window.createOutputChannel('Go Debug (dlv)');
	const factory = new GoDebugAdapterDescriptorFactory(out);
	context.subscriptions.push(
		out,
		debug.registerDebugConfigurationProvider(DEBUG_TYPE, new GoDebugConfigurationProvider(out)),
		debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, factory),
		factory,
		debug.onDidTerminateDebugSession(session => {
			if (session.type === DEBUG_TYPE) {
				factory.terminate(session);
			}
		}),
	);
}

export function deactivate(): void {
	// Live sessions are torn down via onDidTerminateDebugSession; anything still
	// running is killed by the factory's dispose() on subscription teardown.
}
