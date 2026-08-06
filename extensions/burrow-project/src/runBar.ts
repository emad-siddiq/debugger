/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// runBar.ts — the IMPURE half of the scheme bar and the toolchain doctor: status
// bar items, the run/debug/stop commands, the target picker, and the four
// `--version` probes.
//
// The decisions all live in schemeBar.ts and toolchain.ts. What is here is
// process spawning, vscode object construction, and one read-modify-write of the
// project descriptor.

import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import * as vscode from 'vscode';
import { DESCRIPTOR_PATH, EntryPoint, Project, chooseEntry } from './descriptor';
import {
	BarItem, BarItemId, DEBUG_COMMAND, DOCTOR_COMMAND, PICK_COMMAND, RACE_COMMAND, RUN_COMMAND, STOP_COMMAND,
	barItems, debugConfiguration, runArgs,
} from './schemeBar';
import { TOOLS, ToolId, ToolStatus, ToolchainSummary, goMinor, installPlan, isInstallable, parseVersion, summarise, versionArgs } from './toolchain';

/** Where the race-detector toggle lives. A session preference, not a project fact —
 *  the descriptor is for things that are true about the repository. */
const RACE_KEY = 'burrow.run.race';

/** Right-hand group, descending priority so they render Run · Debug · target · race · toolchain. */
const PRIORITY: Readonly<Record<BarItemId, number>> = {
	run: 60, debug: 59, stop: 58, target: 57, race: 56, toolchain: 55,
};

/** Where a host tool lives, if it is anywhere. Same order burrow-go-debug uses for
 *  Delve: `go install` puts these in $GOBIN or $GOPATH/bin, neither of which the
 *  extension host's PATH reliably carries. */
function resolveTool(id: ToolId): string {
	if (id === 'go') {
		return 'go';
	}
	const goBin = process.env.GOBIN || join(process.env.GOPATH || join(homedir(), 'go'), 'bin');
	const candidate = join(goBin, id);
	return existsSync(candidate) ? candidate : id;
}

function probe(id: ToolId): Promise<ToolStatus> {
	const program = resolveTool(id);
	return new Promise((resolve) => {
		execFile(program, versionArgs(id), { timeout: 8000 }, (err, stdout, stderr) => {
			const banner = `${stdout}${stderr}`.trim();
			if (err && !banner) {
				resolve({ id, error: err.message });
				return;
			}
			resolve({ id, version: parseVersion(id, banner), path: program, banner });
		});
	});
}

async function probeAll(): Promise<ToolStatus[]> {
	return Promise.all(TOOLS.map((t) => probe(t.id)));
}

// --- the remembered target -------------------------------------------------

/**
 * Records the chosen entry in `.burrow/project.json`, preserving everything else
 * in the file.
 *
 * The SAME file and the SAME key `burrow-go-debug` reads. The two extensions meet
 * at a file rather than an import on purpose — that extension documents why it
 * duplicates detection rather than importing it, and the argument holds in this
 * direction too: a status bar that cannot render because a sibling extension has
 * not activated is worse than two writers of one well-known key.
 */
function rememberEntry(folderPath: string, entryId: string): void {
	const at = join(folderPath, DESCRIPTOR_PATH);
	let body: Record<string, unknown> = { version: 1 };
	try { body = JSON.parse(readFileSync(at, 'utf8')) as Record<string, unknown>; } catch { /* first write */ }
	body.entry = entryId;
	try {
		mkdirSync(dirname(at), { recursive: true });
		writeFileSync(at, JSON.stringify(body, null, '\t') + '\n', 'utf8');
	} catch {
		// A choice we cannot persist costs one extra prompt, not the run.
	}
}

// --- the bar ---------------------------------------------------------------

export function registerRunBar(
	context: vscode.ExtensionContext,
	projectOf: (folder: string) => Project,
	out: vscode.OutputChannel,
): vscode.Disposable[] {
	const items = new Map<BarItemId, vscode.StatusBarItem>();
	for (const id of Object.keys(PRIORITY) as BarItemId[]) {
		items.set(id, vscode.window.createStatusBarItem(`burrow.run.${id}`, vscode.StatusBarAlignment.Right, PRIORITY[id]));
	}

	let toolchain: ToolchainSummary = { text: 'checking…', healthy: true, missing: [] };
	let statuses: ToolStatus[] = [];
	/** The task execution started by the Run button, so Stop has something to stop. */
	let running: vscode.TaskExecution | undefined;

	const folder = () => vscode.workspace.workspaceFolders?.[0];

	function currentTarget(): { entry?: EntryPoint; count: number; options: readonly EntryPoint[] } {
		const root = folder();
		if (!root) {
			return { count: 0, options: [] };
		}
		const choice = chooseEntry(projectOf(root.uri.fsPath));
		return { entry: choice.entry, count: choice.options.length, options: choice.options };
	}

	function render(): void {
		const root = folder();
		const target = currentTarget();
		const model: BarItem[] = barItems({
			target: target.entry,
			targetCount: target.count,
			race: context.workspaceState.get<boolean>(RACE_KEY) === true,
			running: running !== undefined,
			toolchain,
		});
		for (const item of model) {
			const bar = items.get(item.id)!;
			// A workspace with no folder open has no project to run — the whole
			// group goes away rather than offering buttons over nothing.
			if (!root || !item.visible) {
				bar.hide();
				continue;
			}
			bar.name = `Burrow: ${item.id}`;
			bar.text = item.text;
			bar.tooltip = item.tooltip;
			bar.command = item.command;
			bar.backgroundColor = item.warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
			bar.show();
		}
	}

	async function refreshToolchain(): Promise<void> {
		statuses = await probeAll();
		toolchain = summarise(statuses);
		out.appendLine(`[toolchain] ${statuses.map((s) => `${s.id}=${s.version ?? 'absent'}`).join(' · ')}`);
		render();
	}

	// --- commands ----------------------------------------------------------

	async function pick(): Promise<EntryPoint | undefined> {
		const root = folder();
		if (!root) {
			return undefined;
		}
		const target = currentTarget();
		if (target.count === 0) {
			void vscode.window.showInformationMessage(
				'Nothing to run: this module has no `package main` at its root or under cmd/. That is a library, not a broken project.');
			return undefined;
		}
		const picked = await vscode.window.showQuickPick(
			target.options.map((e) => ({
				label: e.label,
				description: e.path ?? e.command,
				detail: e.id === target.entry?.id ? 'The current target' : undefined,
				entry: e,
			})),
			{
				title: 'Which program?',
				placeHolder: 'Remembered in .burrow/project.json — the same choice F5 uses',
				ignoreFocusOut: true,
			});
		if (!picked) {
			return undefined;
		}
		rememberEntry(root.uri.fsPath, picked.entry.id);
		out.appendLine(`[run] target is ${picked.entry.label} (${picked.entry.id})`);
		render();
		return picked.entry;
	}

	/** The target, asking only when the project has more than one and none is remembered. */
	async function resolveTarget(): Promise<EntryPoint | undefined> {
		const target = currentTarget();
		return target.entry ?? (await pick());
	}

	async function start(): Promise<void> {
		const root = folder();
		const entry = await resolveTarget();
		if (!root || !entry) {
			return;
		}
		const project = projectOf(root.uri.fsPath);
		const stackRoot = project.stacks.find((s) => s.id === 'go')?.root ?? '.';
		const cwd = stackRoot === '.' ? root.uri.fsPath : join(root.uri.fsPath, stackRoot);
		const race = context.workspaceState.get<boolean>(RACE_KEY) === true;
		// `entry.path` is relative to the WORKSPACE, and go runs in the MODULE.
		const relativeToModule = stackRoot === '.' || !entry.path
			? entry.path ?? '.'
			: entry.path.startsWith(`${stackRoot}/`) ? entry.path.slice(stackRoot.length + 1) : entry.path;
		const task = new vscode.Task(
			{ type: 'go', task: 'run' },
			root,
			`run ${entry.label}`,
			'go',
			new vscode.ProcessExecution('go', runArgs({ ...entry, path: relativeToModule }, race), { cwd }),
			[],
		);
		task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
		running = await vscode.tasks.executeTask(task);
		render();
	}

	async function debugTarget(): Promise<void> {
		const root = folder();
		const entry = await resolveTarget();
		if (!root || !entry) {
			return;
		}
		const project = projectOf(root.uri.fsPath);
		const stackRoot = project.stacks.find((s) => s.id === 'go')?.root ?? '.';
		const moduleDir = stackRoot === '.' ? root.uri.fsPath : join(root.uri.fsPath, stackRoot);
		const program = entry.path ? join(root.uri.fsPath, entry.path) : moduleDir;
		const race = context.workspaceState.get<boolean>(RACE_KEY) === true;
		await vscode.debug.startDebugging(root, debugConfiguration(entry, race, program, moduleDir) as vscode.DebugConfiguration);
	}

	function stop(): void {
		running?.terminate();
		running = undefined;
		render();
	}

	async function toggleRace(): Promise<void> {
		const next = context.workspaceState.get<boolean>(RACE_KEY) !== true;
		await context.workspaceState.update(RACE_KEY, next);
		out.appendLine(`[run] race detector ${next ? 'on' : 'off'}`);
		render();
	}

	async function doctor(): Promise<void> {
		await refreshToolchain();
		showDoctor(context, statuses, out);
	}

	const disposables: vscode.Disposable[] = [
		...items.values(),
		vscode.commands.registerCommand(RUN_COMMAND, start),
		vscode.commands.registerCommand(DEBUG_COMMAND, debugTarget),
		vscode.commands.registerCommand(STOP_COMMAND, stop),
		vscode.commands.registerCommand(PICK_COMMAND, pick),
		vscode.commands.registerCommand(RACE_COMMAND, toggleRace),
		vscode.commands.registerCommand(DOCTOR_COMMAND, doctor),
		// A run that ends on its own must put the Stop button away.
		vscode.tasks.onDidEndTaskProcess((e) => {
			if (running && e.execution === running) {
				running = undefined;
				render();
			}
		}),
		// A new go.mod, a new cmd/ directory, or a descriptor edit all change the bar.
		vscode.workspace.onDidChangeWorkspaceFolders(() => render()),
	];

	render();
	void refreshToolchain();
	return disposables;
}

// --- the doctor panel ------------------------------------------------------

let doctorPanel: vscode.WebviewPanel | undefined;

function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

/**
 * Four tools, their versions, their paths, and — for each one that is absent —
 * the exact command that installs it.
 *
 * The install command is shown, not run. `go install` writes to $GOBIN and can
 * take minutes on a cold module cache; a button that silently does that from a
 * status bar click is the kind of convenience that is indistinguishable from a
 * hang. Copying a line into a terminal is one extra action and zero surprises.
 */
function showDoctor(context: vscode.ExtensionContext, statuses: readonly ToolStatus[], out: vscode.OutputChannel): void {
	if (!doctorPanel) {
		doctorPanel = vscode.window.createWebviewPanel('burrowToolchain', 'Go Toolchain', vscode.ViewColumn.Active, { enableScripts: false });
		doctorPanel.onDidDispose(() => { doctorPanel = undefined; }, undefined, context.subscriptions);
	}
	const byId = new Map(statuses.map((s) => [s.id, s]));
	const goVersion = byId.get('go')?.version;

	const rows = TOOLS.map((tool) => {
		const status = byId.get(tool.id);
		const found = Boolean(status?.version);
		const plan = installPlan(tool.id, goVersion);
		const remedy = found
			? ''
			: isInstallable(plan)
				? `<p class="fix"><span class="env">${Object.entries(plan.env).map(([k, v]) => `${k}=${v}`).join(' ')}</span> <code>${escapeHtml(plan.command)}</code></p>`
				: `<p class="why">${escapeHtml((plan as { reason: string }).reason)}</p>`;
		return `<section class="${found ? 'ok' : tool.required ? 'bad' : 'warn'}">
			<h2>${escapeHtml(tool.label)} <span class="version">${escapeHtml(status?.version ?? (tool.required ? 'not found' : 'not installed'))}</span></h2>
			<p class="provides">${escapeHtml(tool.provides)}</p>
			${status?.path && found ? `<p class="path">${escapeHtml(status.path)}</p>` : ''}
			${status?.banner && found ? `<pre>${escapeHtml(status.banner)}</pre>` : ''}
			${status?.error ? `<p class="why">${escapeHtml(status.error)}</p>` : ''}
			${remedy}
		</section>`;
	}).join('\n');

	const minor = goMinor(goVersion);
	doctorPanel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px 28px; max-width: 68ch; line-height: 1.5; }
	h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
	.lede { opacity: 0.7; margin: 0 0 24px; }
	section { border-left: 3px solid var(--vscode-panel-border); padding: 2px 0 2px 14px; margin: 0 0 20px; }
	section.ok { border-left-color: var(--vscode-testing-iconPassed, #3fb950); }
	section.bad { border-left-color: var(--vscode-testing-iconFailed, #f85149); }
	section.warn { border-left-color: var(--vscode-testing-iconQueued, #d29922); }
	h2 { font-size: 14px; font-weight: 600; margin: 0 0 2px; display: flex; gap: 8px; align-items: baseline; }
	.version { font-family: var(--vscode-editor-font-family); font-weight: 400; opacity: 0.75; font-size: 12px; }
	.provides, .path, .why, .fix { margin: 2px 0; font-size: 12px; }
	.provides { opacity: 0.7; }
	.path, pre { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: 0.6; }
	pre { margin: 6px 0 0; white-space: pre-wrap; }
	.why { opacity: 0.85; }
	.fix code, .env { font-family: var(--vscode-editor-font-family); font-size: 12px; }
	.fix { margin-top: 8px; padding: 8px 10px; background: var(--vscode-textCodeBlock-background); border-radius: 4px; }
	.env { opacity: 0.6; }
</style></head>
<body>
	<h1>Go toolchain</h1>
	<p class="lede">${minor ? `Go ${escapeHtml(minor)} — tool versions below are the ones Burrow has recorded for it.` : 'Go itself did not answer, so nothing below can be matched to a Go minor.'}</p>
	${rows}
</body></html>`;
	doctorPanel.reveal(vscode.ViewColumn.Active, true);
	out.appendLine('[toolchain] doctor shown');
}
