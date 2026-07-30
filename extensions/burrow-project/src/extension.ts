/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// burrow-project — the project spine (WO-71). Burrow could open a folder; it
// could not make one, and every tool went inert without a config file that had
// been hand-written for one repository.
//
// A QUICK-PICK CHAIN, not a new surface. The constraint says a surface is a
// design decision this work order does not get to make alone, and it is right:
// "create a project" is four questions and a folder picker, which the palette
// already does well. If it later wants a welcome page, the commands underneath
// will not change.
//
// Commands:
//   burrow.project.create       stack → name → Postgres? → where → open
//   burrow.project.addPostgres  the same compose+env pair, into a project that exists
//   burrow.project.describe     write .burrow/project.json from what detection found
//   burrow.project.explain      what Burrow thinks this folder is, and what is inert

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	DESCRIPTOR_PATH, Project, capabilities, detect, merge, parse, serialize,
} from './descriptor';
import { DEFAULT_DB_PORT, GeneratedFile, goScaffold, postgresAddition, seedSql } from './goTemplate';
import { installedGoVersion, treeOf, writeDescriptor, writeFiles } from './scaffold';

export function activate(context: vscode.ExtensionContext): void {
	const out = vscode.window.createOutputChannel('Burrow Project');
	context.subscriptions.push(
		out,
		vscode.commands.registerCommand('burrow.project.create', () => createProject(out)),
		vscode.commands.registerCommand('burrow.project.addPostgres', () => addPostgres(out)),
		vscode.commands.registerCommand('burrow.project.describe', () => describe(out)),
		vscode.commands.registerCommand('burrow.project.explain', () => explain(out)),
		// Read-only, for the other extensions that currently hard-code merkle's
		// shape. Nothing consumes it yet — that is the follow-on work, and this
		// exists so it does not need a new detection pass of its own.
	);
	out.appendLine(`[project] ready · ${describeWorkspace()}`);
	// A window that just opened a freshly created project lands on the handler.
	void landOnFirstOpen();
}

export function deactivate(): void {
	// Output channel is disposed via context.subscriptions.
}

/** The read-only API other burrow-* extensions will consume. */
export function projectOf(folder: string): Project {
	const tree = treeOf(folder);
	return merge(detect(tree, path.basename(folder)), parse(tree.read(DESCRIPTOR_PATH)));
}

function describeWorkspace(): string {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		return 'no folder open';
	}
	const project = projectOf(root);
	const live = capabilities(project).filter((c) => c.live).map((c) => c.id);
	return `${project.name}: ${live.join(' + ') || 'nothing Burrow recognises'}`;
}

// --- create ----------------------------------------------------------------

async function createProject(out: vscode.OutputChannel): Promise<void> {
	const stack = await vscode.window.showQuickPick(
		[
			{ label: '$(symbol-namespace) Go', description: 'module + one HTTP route', id: 'go' },
			{
				label: '$(circle-slash) Python, Rust, C/C++', description: 'not yet — Go is the only stack with a debugger and inspector aboard',
				id: 'none',
			},
		],
		{ title: 'New project — stack', ignoreFocusOut: true },
	);
	if (!stack || stack.id !== 'go') {
		if (stack) {
			void vscode.window.showInformationMessage('Only Go ships end-to-end so far. The scaffold engine is stack-agnostic; the templates are the work.');
		}
		return;
	}

	const name = await vscode.window.showInputBox({
		title: 'New project — name',
		prompt: 'Directory name, and the last segment of the Go module path',
		value: 'myservice',
		ignoreFocusOut: true,
		validateInput: (value) => {
			const v = value.trim();
			if (!v) { return 'A name is required.'; }
			if (!/^[a-z][a-z0-9-]*$/.test(v)) { return 'Lower-case letters, digits and dashes; must start with a letter.'; }
			return undefined;
		},
	});
	if (!name) {
		return;
	}

	const wantsDb = await vscode.window.showQuickPick(
		[
			{ label: '$(database) With Postgres', description: 'compose.yaml + .env + a first table — pulls an image on first `up`', id: 'yes' },
			{ label: '$(file-code) Just the service', description: 'stdlib only; builds and runs with no network at all', id: 'no' },
		],
		{ title: 'New project — Postgres', ignoreFocusOut: true },
	);
	if (!wantsDb) {
		return;
	}
	const postgres = wantsDb.id === 'yes';

	// ANNOUNCE THE NETWORK BEFORE IT HAPPENS (§3's ruling), and that means before
	// the folder picker, not after it. Scaffolding is user-initiated so the
	// invariant permits network — but "writing files" and "downloading a Postgres
	// image" are different moments, and asking someone WHERE to put a thing before
	// telling them what the thing costs is the wrong order. Nothing here goes to
	// the network at all: the files are local and the Go template is stdlib-only.
	// The image is pulled by `docker compose up`, which is the user's next gesture.
	if (postgres) {
		const go = await vscode.window.showInformationMessage(
			`Create ${name.trim()} with Postgres?`,
			{
				modal: true,
				detail: 'Writing the files touches no network — the Go template is stdlib-only and builds offline.\n\n'
					+ 'Starting the database later (`docker compose up -d`) downloads the postgres:17-alpine image the first time, '
					+ 'about 80 MB. That is a separate step you run yourself, and the service starts and answers without it.',
			},
			'Create',
		);
		if (go !== 'Create') {
			return;
		}
	}

	const parent = await vscode.window.showOpenDialog({
		title: 'New project — where',
		canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
		openLabel: 'Create here',
	});
	if (!parent?.length) {
		return;
	}
	const root = path.join(parent[0].fsPath, name.trim());
	if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
		void vscode.window.showErrorMessage(`${root} already exists and is not empty.`);
		return;
	}

	// The INSTALLED toolchain's version, not a constant — see installedGoVersion.
	const goVersion = installedGoVersion();
	const files: GeneratedFile[] = goScaffold({ name: name.trim(), postgres, goVersion });
	if (postgres) {
		files.push(seedSql());
	}
	fs.mkdirSync(root, { recursive: true });
	const result = writeFiles(root, files);
	out.appendLine(`[project] created ${root}: ${result.written.join(', ')}`);

	// The descriptor, from detection over what we just wrote — so the file records
	// the same thing a fresh detection would, and is provably not load-bearing.
	const project = projectOf(root);
	writeDescriptor(root, DESCRIPTOR_PATH, serialize(project));

	// A launch configuration, because F5 is the done-state. This is the project's
	// own `.vscode/launch.json` in the form any Go user would write it — no Burrow
	// in it anywhere.
	writeVsCodeLaunch(root, name.trim());

	const main = files.find((f) => f.path === 'main.go');
	await openProject(root, main?.breakpointLine);
}

/**
 * `.vscode/launch.json` — the project's, not ours.
 *
 * Kept out of `goTemplate.ts` because it is editor configuration rather than
 * project source, but it obeys the same rule: a plain `go` launch config, the one
 * the Go extension's own documentation shows. Delete `.vscode/` and
 * `go run .` still works.
 */
function writeVsCodeLaunch(root: string, name: string): void {
	const target = path.join(root, '.vscode', 'launch.json');
	if (fs.existsSync(target)) {
		return;
	}
	const config = {
		version: '0.2.0',
		configurations: [
			{
				name: `Debug ${name}`,
				type: 'go',
				request: 'launch',
				mode: 'debug',
				program: '${workspaceFolder}',
				cwd: '${workspaceFolder}',
				envFile: '${workspaceFolder}/.env',
			},
		],
	};
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, JSON.stringify(config, null, '\t') + '\n', 'utf8');
}

/** Open the new folder, and leave the cursor on the line worth breaking on. */
async function openProject(root: string, breakpointLine: number | undefined): Promise<void> {
	// A file, not in-memory state: `openFolder` restarts the extension host, so
	// everything after it in this function is gone. The marker lives under
	// `.burrow/` and is deleted the first time it is read.
	const marker = path.join(root, '.burrow', 'created.json');
	try {
		fs.writeFileSync(marker, JSON.stringify({ open: 'main.go', line: breakpointLine ?? 1 }, null, '\t') + '\n', 'utf8');
	} catch {
		// A marker we cannot write costs a cursor position, not the project.
	}
	await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), { forceNewWindow: false });
}

/** On startup in a freshly created project, open main.go at the handler. */
export async function landOnFirstOpen(): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		return;
	}
	const marker = path.join(root, '.burrow', 'created.json');
	if (!fs.existsSync(marker)) {
		return;
	}
	try {
		const { open, line } = JSON.parse(fs.readFileSync(marker, 'utf8')) as { open: string; line: number };
		fs.unlinkSync(marker);   // once, not on every window
		const doc = await vscode.workspace.openTextDocument(path.join(root, open));
		const editor = await vscode.window.showTextDocument(doc);
		const at = new vscode.Position(Math.max(0, line - 1), 0);
		editor.selection = new vscode.Selection(at, at);
		editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenter);
	} catch {
		// Nothing here is worth an error message on a window that just opened.
	}
}

// --- add Postgres to a project that exists ---------------------------------

async function addPostgres(out: vscode.OutputChannel): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		void vscode.window.showInformationMessage('Open a folder first.');
		return;
	}
	const name = path.basename(root).replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'app';
	const go = await vscode.window.showInformationMessage(
		`Add a local Postgres to ${path.basename(root)}?`,
		{
			modal: true,
			detail: 'Writes compose.yaml, .env, .env.example and db/init/001_init.sql. Existing files are never overwritten.\n\n'
				+ 'No network now. `docker compose up -d` later pulls postgres:17-alpine (~80 MB).',
		},
		'Add',
	);
	if (go !== 'Add') {
		return;
	}
	const result = writeFiles(root, [...postgresAddition(name), seedSql()]);
	out.appendLine(`[project] +postgres in ${root}: wrote ${result.written.join(', ') || 'nothing'}; kept ${result.skipped.join(', ') || 'nothing'}`);
	writeDescriptor(root, DESCRIPTOR_PATH, serialize(projectOf(root)));

	const message = result.skipped.length
		? `Postgres added. Kept your existing ${result.skipped.join(', ')}.`
		: `Postgres added. Next: docker compose up -d (Postgres on :${DEFAULT_DB_PORT}).`;
	void vscode.window.showInformationMessage(message);
}

// --- describe / explain ----------------------------------------------------

async function describe(out: vscode.OutputChannel): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		void vscode.window.showInformationMessage('Open a folder first.');
		return;
	}
	const project = projectOf(root);
	writeDescriptor(root, DESCRIPTOR_PATH, serialize(project));
	out.appendLine(`[project] wrote ${DESCRIPTOR_PATH} for ${project.name}`);
	const doc = await vscode.workspace.openTextDocument(path.join(root, DESCRIPTOR_PATH));
	await vscode.window.showTextDocument(doc);
}

/**
 * What Burrow thinks this folder is — and, for anything inert, why.
 *
 * This is the answer to §4's question, made readable. A rail that goes quiet
 * without saying why is the thing that made Burrow feel like it only worked on
 * one repository.
 */
async function explain(out: vscode.OutputChannel): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		void vscode.window.showInformationMessage('Open a folder first.');
		return;
	}
	const project = projectOf(root);
	const caps = capabilities(project);
	out.appendLine('');
	out.appendLine(`── ${project.name}  (${root})`);
	out.appendLine(`   descriptor: ${fs.existsSync(path.join(root, DESCRIPTOR_PATH)) ? DESCRIPTOR_PATH : 'none — detection only'}`);
	for (const stack of project.stacks) {
		out.appendLine(`   stack: ${stack.id} in ${stack.root}${stack.module ? ` (${stack.module})` : ''} · build \`${stack.build}\` · run \`${stack.run}\``);
	}
	if (!project.stacks.length) {
		out.appendLine('   stack: none detected');
	}
	for (const service of project.services) {
		out.appendLine(`   service: ${service.kind}${service.composeService ? ` (${service.composeFile}#${service.composeService})` : ''}${service.urlEnv ? ` · ${service.urlEnv}` : ''}`);
	}
	if (!project.services.length) {
		out.appendLine('   service: none detected');
	}
	for (const cap of caps) {
		out.appendLine(`   ${cap.live ? 'LIVE ' : 'inert'} ${cap.id.padEnd(6)} ${cap.why}`);
	}
	out.show(true);
}
