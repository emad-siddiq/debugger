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
import * as vscode from 'vscode';
import { composeUpArgs, resolveComposeFile } from './db';

const CONFIG_SECTION = 'burrow.fullstack';

export function activate(context: vscode.ExtensionContext): void {
	const out = vscode.window.createOutputChannel('Burrow Full Stack');

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	status.text = '$(rocket) Debug Full Stack';
	status.tooltip = 'Bring up the database, debug the Go backend under dlv, and open the frontend live — all three tiers at once.';
	status.command = 'burrow.fullstack.debug';
	status.show();

	context.subscriptions.push(
		out,
		status,
		vscode.commands.registerCommand('burrow.fullstack.debug', () => debugFullStack(out)),
		vscode.commands.registerCommand('burrow.fullstack.stop', () => stopFullStack(out)),
	);
}

function cfg<T>(key: string, fallback: T): T {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).get<T>(key) ?? fallback;
}

function workspaceRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function debugFullStack(out: vscode.OutputChannel): Promise<void> {
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

async function stopFullStack(out: vscode.OutputChannel): Promise<void> {
	// Stop the backend debug session + the frontend sidecar; leave the database
	// running — it is shared state a stop shouldn't tear down.
	await run(() => vscode.commands.executeCommand('workbench.action.debug.stop'));
	await run(() => vscode.commands.executeCommand('burrow.frontendDebugger.stop'));
	out.appendLine('[fullstack] stopped backend + frontend (database left running)');
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
