/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, execFile, spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
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
 * Fills the gaps VS Code leaves in a bare `go` config so a fixture can debug
 * with just `{ "type": "go", "request": "launch" }` (or an F5 with no launch.json).
 */
class GoDebugConfigurationProvider implements DebugConfigurationProvider {
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
			if (!config.program) {
				config.program = folder ? folder.uri.fsPath : '${workspaceFolder}';
			}
			// dlv builds (`go build`) from cwd; without it dlv uses its own process
			// cwd (the IDE root, which has no go.mod) and the build fails with
			// "cannot find main module". Default cwd to the package/workspace folder.
			if (!config.cwd) {
				config.cwd = folder ? folder.uri.fsPath : '${workspaceFolder}';
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
			};
			// dlv binds before it builds anything, so the banner is prompt or never.
			// Failing loudly beats a session that never starts and never says why.
			timer = setTimeout(
				() => fail(new Error(`Delve started but never announced its DAP port within ${LISTEN_TIMEOUT_MS / 1000}s. Output so far: ${seen.trim() || '(none)'}`)),
				LISTEN_TIMEOUT_MS);
			child.stdout.on('data', scan);
			child.stderr.on('data', scan);
			child.on('error', err => fail(new Error(`Could not start Delve at '${dlv}': ${err.message}. Install Delve or set BURROW_DLV_PATH.`)));
			child.on('exit', code => fail(new Error(`Delve exited before it began listening (code ${code ?? 'null'}).`)));
		});
	}

	terminate(session: DebugSession): void {
		const child = this.servers.get(session.id);
		if (child) {
			child.kill();
			this.servers.delete(session.id);
		}
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
		debug.registerDebugConfigurationProvider(DEBUG_TYPE, new GoDebugConfigurationProvider()),
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
