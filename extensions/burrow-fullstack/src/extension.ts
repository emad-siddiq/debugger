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

	// A FAN-OUT, not a chain (docs/plans/04 §8). Every tier is attempted and each
	// reports for itself; one that cannot start no longer strands the others.
	// Leaving a developer with a running database, no frontend and a modal was
	// the worst of both worlds — and the Run view's rows say what is up anyway,
	// so the compound's job is to try everything and then be honest about it.
	const results: { tier: string; ok: boolean; why?: string }[] = [];
	const attempt = async (tier: string, run: () => Promise<boolean | void>): Promise<boolean> => {
		try {
			const ok = await run();
			results.push({ tier, ok: ok !== false });
			return ok !== false;
		} catch (err) {
			out.appendLine(`[fullstack] ${tier}: ${errText(err)}`);
			results.push({ tier, ok: false, why: errText(err) });
			return false;
		}
	};

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Full Stack', cancellable: false },
		async (progress) => {
			progress.report({ message: `database (${service})…` });
			await attempt('database', () => runDocker(composeUpArgs(composeFile, service), out));

			progress.report({ message: 'backend (dlv)…' });
			const backendUp = await attempt('backend', async () => {
				const started = await vscode.debug.startDebugging(folder, backendConfig);
				if (!started) {
					throw new Error(`the "${backendConfig}" configuration did not start — check .vscode/launch.json, that dlv is installed, and (on macOS) that Developer Mode is enabled: sudo DevToolsSecurity -enable`);
				}
				return true;
			});
			if (backendUp) {
				afterBackendUp?.();
			}

			progress.report({ message: 'frontend (live)…' });
			await attempt('frontend', () => openFrontendLive());

			progress.report({ message: 'browser (chrome)…' });
			await attempt('browser', () => startBrowserDebug(out, folder));
		},
	);

	const up = results.filter((r) => r.ok).map((r) => r.tier);
	const down = results.filter((r) => !r.ok);
	out.appendLine(`[fullstack] up: ${up.join(', ') || 'nothing'}${down.length ? ` — did not start: ${down.map((d) => d.tier).join(', ')}` : ''}`);
	if (!down.length) {
		void vscode.window.showInformationMessage('Full Stack up: database + backend (dlv) + frontend (live) + Chrome.');
		return;
	}
	// Name what did NOT come up, with the first reason — a compound that says
	// "failed" without saying which tier is a compound you debug twice.
	const detail = down[0].why ? ` ${down[0].tier}: ${down[0].why}` : '';
	void vscode.window.showWarningMessage(
		`Full Stack: ${up.length ? `${up.join(' + ')} up` : 'nothing came up'} · ${down.map((d) => d.tier).join(', ')} did not.${detail}`,
		'Show Logs',
	).then((choice) => {
		if (choice === 'Show Logs') {
			out.show(true);
		}
	});
}

/**
 * The browser tier: merkle's OWN chrome launch configuration if it has one —
 * §8 calls the workspace's `launch.json` the invariant contract, and its url,
 * webRoot and sourcemap settings are the project's business, not ours. Only
 * when there is no such config do we synthesize one, pointed at the URL the
 * frontend-debugger sidecar reports rather than a guessed port.
 *
 * Returns false (never throws) when the browser cannot start: the stack is up
 * without it, and stranding a running backend over a missing Chrome would be
 * the worse failure.
 */
async function startBrowserDebug(out: vscode.OutputChannel, folder: vscode.WorkspaceFolder | undefined): Promise<boolean> {
	const named = cfg('chromeConfig', 'Frontend: debug in Chrome (:5173)');
	try {
		if (named && folder && hasLaunchConfig(folder, named)) {
			out.appendLine(`[fullstack] browser: starting "${named}" from the workspace launch.json`);
			return await vscode.debug.startDebugging(folder, named);
		}
		const url = await sidecarTargetUrl();
		if (!url) {
			out.appendLine('[fullstack] browser: no chrome launch config and the sidecar reported no URL — skipped');
			return false;
		}
		out.appendLine(`[fullstack] browser: no "${named}" config — launching Chrome at ${url}`);
		return await vscode.debug.startDebugging(folder, {
			type: 'chrome',
			request: 'launch',
			name: 'Full Stack: Chrome',
			url,
			webRoot: folder ? `${folder.uri.fsPath}/frontend` : undefined,
		} as vscode.DebugConfiguration);
	} catch (err) {
		out.appendLine(`[fullstack] browser: ${errText(err)}`);
		return false;
	}
}

/** Does the workspace's launch.json define this configuration? Read through the
 *  workspace configuration API, so a multi-root or settings-level `launch`
 *  block counts too. */
function hasLaunchConfig(folder: vscode.WorkspaceFolder, name: string): boolean {
	const configs = vscode.workspace.getConfiguration('launch', folder.uri).get<{ name?: string }[]>('configurations') ?? [];
	return configs.some((c) => c?.name === name);
}

/** Where the frontend-debugger is actually serving the app. */
async function sidecarTargetUrl(): Promise<string | undefined> {
	try {
		const ext = vscode.extensions.getExtension('burrow.burrow-frontend-debugger');
		if (!ext) {
			return undefined;
		}
		const api = (ext.isActive ? ext.exports : await ext.activate()) as
			{ sidecar?: () => { targetUrl?: string } } | undefined;
		return api?.sidecar?.()?.targetUrl;
	} catch {
		return undefined;
	}
}

/** Boot the frontend-debugger in live mode (proxy to the dlv-debugged backend). */
/**
 * The frontend tier, in LIVE mode — meaning it really is live, not merely asked
 * to be.
 *
 * The setting alone is not enough. The sidecar reads its data mode at boot, and
 * `Sidecar.start()` ATTACHES to one that is already running (a warm start from
 * the Components view, or one left over from another window) instead of
 * spawning. An attached sidecar keeps whatever mode it booted with — so the
 * compound used to announce "frontend (live)" while the app was still serving
 * mock data and never touching the backend. Every breakpoint on the request
 * path then sits there doing nothing, which is a maddening thing to debug.
 *
 * So: set the setting, open the panel, then ASK the sidecar what mode it is
 * actually in and flip it if the answer is wrong.
 */
async function openFrontendLive(): Promise<void> {
	try {
		await vscode.workspace.getConfiguration('burrow.frontendDebugger').update('mode', 'live', vscode.ConfigurationTarget.Workspace);
	} catch {
		// no workspace folder to write a setting into — proceed with the default
	}
	await vscode.commands.executeCommand('burrow.frontendDebugger.open');

	const port = await sidecarUiPort();
	if (!port) {
		return; // no sidecar to interrogate; the tier reported for itself already
	}
	try {
		const current = await fetch(`http://127.0.0.1:${port}/api/mode`, { signal: AbortSignal.timeout(3000) })
			.then((r) => r.json() as Promise<{ mode?: string }>);
		if (current?.mode === 'live') {
			return;
		}
		// Flipping restarts the target Vite in-process, hence the long timeout.
		await fetch(`http://127.0.0.1:${port}/api/mode`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ mode: 'live' }),
			signal: AbortSignal.timeout(60000),
		});
	} catch (err) {
		throw new Error(`the frontend is up but could not be put in live mode — it may still be serving mock data (${errText(err)})`);
	}
}

/** The running sidecar's UI port, via the frontend-debugger's read-only API. */
async function sidecarUiPort(): Promise<number> {
	try {
		const ext = vscode.extensions.getExtension('burrow.burrow-frontend-debugger');
		if (!ext) {
			return 0;
		}
		const api = (ext.isActive ? ext.exports : await ext.activate()) as
			{ sidecar?: () => { uiPort: number } } | undefined;
		return api?.sidecar?.().uiPort ?? 0;
	} catch {
		return 0;
	}
}

async function stopFullStack(out: vscode.OutputChannel, seeds: SeedRunner): Promise<void> {
	// Stop the seed emitters, the backend debug session and the frontend
	// sidecar; leave the database running — shared state a stop shouldn't tear down.
	seeds.stopAll();
	// EVERY session, not the focused one. `workbench.action.debug.stop` ends
	// whichever session the debug UI is pointed at, so with Chrome attached
	// alongside dlv it left one running; `stopDebugging()` with no argument is
	// the API that means all of them.
	await run(() => vscode.debug.stopDebugging());
	await run(() => vscode.commands.executeCommand('burrow.frontendDebugger.stop'));
	out.appendLine('[fullstack] stopped seeds + backend + browser + frontend (database left running)');
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
