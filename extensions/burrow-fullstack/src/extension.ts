/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// burrow-fullstack — the one-click Full Stack Debugger orchestrator (milestone M6).
// A status-bar "⚡ Debug Full Stack" fans out to the three tiers, in order:
//   1. database  — `docker compose up -d --wait <service>` (single instance)
//   2. backend   — vscode.debug.startDebugging on a named `go` (dlv) config
//   3. frontend  — open the frontend-debugger in live mode (proxies to the backend)
// It is a thin, standalone Layer-4 extension: no new debug type (reuses burrow-go-
// debug's `go` adapter) and no new compose (reuses merkle's own), so the whole
// vision ships without a core patch. The scheme-bar title-bar host (task-03) is an
// optional alternate surface for the SAME command, added later.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DebugConfigProvider } from './configView';
import { FullStackProvider, Tier, hostPortOf, portOpen } from './statusView';
import { announceOnVisible } from './toolSurface';
import { composeUpArgs, resolveComposeFile } from './db';
import { SeedRunner } from './seed';
import { DEFAULT_MANIFEST, ToggleManifest, activeProcesses, effectiveState, envPatch, parseManifest } from './toggles';

const CONFIG_SECTION = 'burrow.fullstack';
const TOGGLES_SECTION = 'burrow.debugConfig';

export function activate(context: vscode.ExtensionContext): void {
	const out = vscode.window.createOutputChannel('Burrow Full Stack');

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	status.text = '$(rocket) Debug Full Stack';
	status.tooltip = 'Bring up the database, debug the Go backend under dlv, and open the frontend live — all three tiers at once.';
	status.command = 'burrow.fullstack.debug';
	status.show();

	// ---- Debug Config panel (WO-5): manifest + state + effects ---------------

	const manifest = (): ToggleManifest => {
		const root = workspaceRoot();
		if (root) {
			const projectFile = path.join(root, '.vscode', 'debug-toggles.json');
			try {
				return parseManifest(fs.readFileSync(projectFile, 'utf8'));
			} catch (err) {
				if (fs.existsSync(projectFile)) {
					out.appendLine(`[debug-config] ${projectFile}: ${errText(err)} — using the built-in manifest`);
				}
			}
		}
		return DEFAULT_MANIFEST;
	};

	const storedState = (): Record<string, boolean> =>
		vscode.workspace.getConfiguration(TOGGLES_SECTION).get<Record<string, boolean>>('toggles') ?? {};

	const state = (): Record<string, boolean> => effectiveState(manifest(), storedState());

	const seeds = new SeedRunner(out);
	let goSessionActive = false;

	const view = new DebugConfigProvider(
		(id, enabled) => { void applyToggle(id, enabled); },
		() => { void debugFullStack(out, syncSeeds); },
		() => { void stopFullStack(out, seeds); },
	);

	const refreshView = (): void => {
		view.update(manifest(), state(), goSessionActive, seeds.activeNames);
		void tiersView.refresh();
	};

	// ---- Full Stack status rows (docs/plans/02 §3.4) -------------------------
	// Each tier is read from the thing that actually knows: the database from a
	// TCP probe of the DSN's port, the backend from the live debug session, the
	// frontend from the frontend-debugger extension's own report.
	const readTiers = async (): Promise<Tier[]> => {
		const dsn = await databaseUrl();
		const where = hostPortOf(dsn);
		const dbUp = where ? await portOpen(where.host, where.port) : false;
		const session = vscode.debug.activeDebugSession;
		const stopped = !!vscode.debug.activeStackItem;
		const fe = await frontendSidecar();
		return [
			{
				id: 'db',
				label: 'Postgres',
				state: !where ? 'unknown' : dbUp ? 'running' : 'stopped',
				detail: where ? `:${where.port}` : 'no connection string',
				action: dbUp ? undefined : { command: 'burrow.fullstack.debug', title: 'Start the stack', icon: 'play' },
			},
			{
				id: 'backend',
				label: 'Go backend (dlv)',
				state: session?.type === 'go' ? (stopped ? 'paused' : 'running') : goSessionActive ? 'starting' : 'stopped',
				detail: session?.type === 'go' ? session.name : undefined,
				action: session?.type === 'go' ? { command: 'workbench.action.debug.stop', title: 'Stop debugging', icon: 'debug-stop' } : undefined,
			},
			{
				id: 'frontend',
				label: 'Frontend (Vite)',
				state: fe.phase,
				detail: fe.uiPort ? `:${fe.uiPort}` : undefined,
				action: fe.phase === 'running'
					? { command: 'burrow.frontendDebugger.stop', title: 'Stop the dev server', icon: 'debug-stop' }
					: { command: 'burrow.frontendDebugger.open', title: 'Open the app', icon: 'play' },
			},
		];
	};

	/** The connection the Data view is actually pointed at, through burrow-db's
	 *  read-only export — the same discovery (setting → DATABASE_URL → the
	 *  workspace's own launch.json), so the two views can never disagree about
	 *  which database this is. */
	const databaseUrl = async (): Promise<string | undefined> => {
		const api = await apiOf<{ connection?: () => { connectionString: string } | undefined }>('burrow.burrow-db');
		return api?.connection?.()?.connectionString
			?? vscode.workspace.getConfiguration('burrow.db').get<string>('connectionString')
			?? process.env.DATABASE_URL;
	};

	/** The frontend-debugger's own sidecar phase, through its read-only export.
	 *  Absent extension → `unknown`, never a guess. */
	const frontendSidecar = async (): Promise<{ phase: Tier['state']; uiPort: number }> => {
		const api = await apiOf<{ sidecar?: () => { phase: 'stopped' | 'starting' | 'running'; uiPort: number } }>('burrow.burrow-frontend-debugger');
		const live = api?.sidecar?.();
		return live ? { phase: live.phase, uiPort: live.uiPort } : { phase: 'unknown', uiPort: 0 };
	};

	/** Another Burrow extension's read-only API, activating it if the workbench
	 *  has not needed it yet — activation registers views and commands, it does
	 *  not start anything, so this row can be true without being expensive. */
	const apiOf = async <T>(id: string): Promise<T | undefined> => {
		try {
			const ext = vscode.extensions.getExtension(id);
			if (!ext) {
				return undefined;
			}
			return (ext.isActive ? ext.exports : await ext.activate()) as T;
		} catch {
			return undefined;
		}
	};

	const tiersView = new FullStackProvider(readTiers);
	const tiersTree = vscode.window.createTreeView(FullStackProvider.viewId, { treeDataProvider: tiersView });

	/** Start/stop seed processes so they match the current toggle state. Only
	 *  while a backend session runs — seeding an unbooted backend just errors. */
	const syncSeeds = (): void => {
		const root = workspaceRoot();
		if (goSessionActive && root) {
			seeds.sync(activeProcesses(manifest(), state()), root);
		} else {
			seeds.stopAll();
		}
		refreshView();
	};

	const applyToggle = async (id: string, enabled: boolean): Promise<void> => {
		const next = { ...storedState(), [id]: enabled };
		await vscode.workspace.getConfiguration(TOGGLES_SECTION).update('toggles', next, vscode.ConfigurationTarget.Workspace);
		syncSeeds();
		// Env toggles bake into the dlv process at launch — offer the ~1s reboot.
		const toggle = manifest().toggles.find(t => t.id === id);
		if (goSessionActive && toggle?.env) {
			const restart = await vscode.window.showInformationMessage(
				`"${toggle.label}" applies at backend launch — restart the debug session?`,
				'Restart Backend',
			);
			if (restart) {
				await vscode.commands.executeCommand('workbench.action.debug.restart');
			}
		}
	};

	context.subscriptions.push(
		out,
		status,
		tiersView,
		tiersTree,
		tiersView.watch(tiersTree),
		// Tool-surface isolation (docs/plans/02 §6): the Run tool announces
		// itself; its transient surface (the Test Lab) is claimed by burrow-go-test.
		announceOnVisible('run', tiersTree),
		vscode.debug.onDidChangeActiveDebugSession(() => void tiersView.refresh()),
		vscode.debug.onDidChangeActiveStackItem(() => void tiersView.refresh()),
		vscode.window.registerWebviewViewProvider(DebugConfigProvider.viewId, view),
		vscode.commands.registerCommand('burrow.fullstack.debug', () => debugFullStack(out, syncSeeds)),
		vscode.commands.registerCommand('burrow.fullstack.stop', () => stopFullStack(out, seeds)),

		// The panel's env toggles reach the backend by resolving into every `go`
		// debug configuration — the panel is authoritative for its declared vars.
		vscode.debug.registerDebugConfigurationProvider('go', {
			resolveDebugConfiguration(_folder, config) {
				const patch = envPatch(manifest(), state());
				const env: Record<string, string> = { ...(config.env as Record<string, string> | undefined) };
				for (const [name, value] of Object.entries(patch)) {
					if (value === undefined) {
						delete env[name];
					} else {
						env[name] = value;
					}
				}
				config.env = env;
				return config;
			},
		}),

		vscode.debug.onDidStartDebugSession(session => {
			if (session.type === 'go') {
				goSessionActive = true;
				syncSeeds();
			}
		}),
		vscode.debug.onDidTerminateDebugSession(session => {
			if (session.type === 'go') {
				goSessionActive = false;
				syncSeeds();
			}
		}),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(`${TOGGLES_SECTION}.toggles`)) {
				refreshView();
			}
		}),
		{ dispose: () => seeds.stopAll() },
	);

	refreshView();
}

function cfg<T>(key: string, fallback: T): T {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).get<T>(key) ?? fallback;
}

function workspaceRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function debugFullStack(out: vscode.OutputChannel, afterBackendUp?: () => void): Promise<void> {
	const composeFile = resolveComposeFile(cfg('dbComposeFile', 'infra/docker-compose.yml'), workspaceRoot());
	const service = cfg('dbService', 'nodewatch-db');
	const backendConfig = cfg('backendConfig', 'Backend: debug (Auth0 OFF)');
	const folder = vscode.workspace.workspaceFolders?.[0];

	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Full Stack', cancellable: false },
			async (progress) => {
				progress.report({ message: `database (${service})…` });
				await runDocker(composeUpArgs(composeFile, service), out);

				progress.report({ message: 'backend (dlv)…' });
				const started = await vscode.debug.startDebugging(folder, backendConfig);
				if (!started) {
					throw new Error(`could not start the "${backendConfig}" launch configuration — check .vscode/launch.json or set burrow.fullstack.backendConfig.`);
				}
				afterBackendUp?.();

				progress.report({ message: 'frontend (live)…' });
				await openFrontendLive();
			},
		);
		void vscode.window.showInformationMessage('Full Stack up: database + backend (dlv) + frontend (live).');
	} catch (err) {
		out.show(true);
		void vscode.window.showErrorMessage(`Full Stack: ${errText(err)}`);
	}
}

/** Boot the frontend-debugger in live mode (proxy to the dlv-debugged backend). */
async function openFrontendLive(): Promise<void> {
	// The sidecar reads its data mode at boot, so persist 'live' before opening.
	// Best-effort: with no workspace the FD command falls back to its own default.
	try {
		await vscode.workspace.getConfiguration('burrow.frontendDebugger').update('mode', 'live', vscode.ConfigurationTarget.Workspace);
	} catch {
		// no workspace folder to write a setting into — proceed with the default
	}
	await vscode.commands.executeCommand('burrow.frontendDebugger.open');
}

async function stopFullStack(out: vscode.OutputChannel, seeds: SeedRunner): Promise<void> {
	// Stop the seed emitters, the backend debug session and the frontend
	// sidecar; leave the database running — shared state a stop shouldn't tear down.
	seeds.stopAll();
	await run(() => vscode.commands.executeCommand('workbench.action.debug.stop'));
	await run(() => vscode.commands.executeCommand('burrow.frontendDebugger.stop'));
	out.appendLine('[fullstack] stopped seeds + backend + frontend (database left running)');
	void vscode.window.showInformationMessage('Full Stack stopped (database left running).');
}

function run(fn: () => Thenable<unknown>): Promise<void> {
	return Promise.resolve(fn()).then(() => undefined, () => undefined);
}

function runDocker(args: string[], out: vscode.OutputChannel): Promise<void> {
	return new Promise((resolve, reject) => {
		out.appendLine('[fullstack] docker ' + args.join(' '));
		const child = cp.spawn('docker', args);
		child.stdout.on('data', (d: Buffer) => out.append(d.toString()));
		child.stderr.on('data', (d: Buffer) => out.append(d.toString()));
		child.on('error', (e: NodeJS.ErrnoException) => reject(new Error(e.code === 'ENOENT'
			? 'Docker was not found on your PATH. Install Docker Desktop and try again.'
			: e.message)));
		child.on('exit', code => code === 0
			? resolve()
			: reject(new Error(`\`docker compose up\` exited ${code ?? '?'} — is the daemon running? See the "Burrow Full Stack" output.`)));
	});
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function deactivate(): void {
	// Status bar item + output channel are disposed via context.subscriptions.
}
