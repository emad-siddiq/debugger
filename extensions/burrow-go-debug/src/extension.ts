/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { existsSync } from 'fs';
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
} from 'vscode';

// burrow-go-debug is the WO-2 IX prerequisite: the smallest extension that turns
// the intact workbench debug UI into a working Go debugger by bridging to a
// host-installed `dlv dap`. The full Delve engine (breakpoint matrix, attach,
// panic UX, pinned dlv) is architecture task 04; this only needs to reach a live
// stopped session so the inspector work (WO-3+) has a real DAP model to build on.

const DEBUG_TYPE = 'go';

// `dlv dap --listen` prints this once its DAP listener is bound; we parse the
// bound host:port from it (ephemeral port -> collision-free, per task 04).
const LISTEN_RE = /DAP server listening at:\s*(?<host>[^:\s]+):(?<port>\d+)/;

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
 * Fills the gaps VS Code leaves in a bare `go` config so a fixture can debug
 * with just `{ "type": "go", "request": "launch" }` (or an F5 with no launch.json).
 */
class GoDebugConfigurationProvider implements DebugConfigurationProvider {
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration): ProviderResult<DebugConfiguration> {
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
}

/**
 * `dlv dap` is a headless TCP DAP server with no stdio mode, so we spawn it on
 * an ephemeral port, wait for its listen banner, and point the workbench at the
 * port. We own the process and kill it when the session ends (kill-safe: no
 * orphaned dlv, per task 04).
 */
class GoDebugAdapterDescriptorFactory implements DebugAdapterDescriptorFactory {
	private readonly servers = new Map<string, ChildProcessWithoutNullStreams>();

	createDebugAdapterDescriptor(session: DebugSession): Promise<DebugAdapterDescriptor> {
		const dlv = resolveDelve();
		// Run dlv in the debuggee's folder so its `go build` resolves the module,
		// even if the config's cwd is unset (safety net for the resolver above).
		const cwd = session.configuration.cwd || session.workspaceFolder?.uri.fsPath;
		const child = spawn(dlv, ['dap', '--listen=127.0.0.1:0'], cwd ? { cwd } : {});

		return new Promise<DebugAdapterDescriptor>((resolve, reject) => {
			let settled = false;
			const fail = (err: Error) => {
				if (!settled) {
					settled = true;
					child.kill();
					reject(err);
				}
			};
			const scan = (chunk: Buffer) => {
				const match = LISTEN_RE.exec(chunk.toString());
				if (match?.groups && !settled) {
					settled = true;
					this.servers.set(session.id, child);
					resolve(new DebugAdapterServer(Number(match.groups.port), match.groups.host));
				}
			};
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
	const factory = new GoDebugAdapterDescriptorFactory();
	context.subscriptions.push(
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
