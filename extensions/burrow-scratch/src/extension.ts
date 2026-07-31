/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// extension.ts — Scratch mode.
//
// One extension, two roles, decided by what is open:
//
//   * In an ordinary project window it contributes ONE command, "Scratch: New
//     Scratch Build…", which plans the project and opens the plan in a second
//     Burrow window. The rail icon stays hidden — `burrow.scratch.active` is
//     false, so the view's `when` clause hides its container.
//
//   * In a scratch window (`.burrow-scratch/plan.json` is present) it is the
//     Scratch view, the step page, the checks and the progress file.
//
// The second window is a plain `vscode.openFolder … forceNewWindow`, which
// means it is a full Burrow: the same debugger, the same Data grid, the same
// API view, the same isolation harness — pointed at code you are writing rather
// than code that already exists. That is the entire trick, and it is why this
// needed no core patch.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CheckRun, preconditionMet, runChecks, summarize } from './checks';
import { FlowsDoc, MIN_TRACED_FLOWS, buildPlan, routeIndex } from './planModel';
import { PageMessage, StepPage } from './page';
import { Progress, isSettled, nextStep, order, overallTally, percent, recordCheck, resumeAt, setCurrent, setState, stateOf } from './progressModel';
import { scanProject } from './scan';
import { StepsProvider } from './stepsTree';
import { announceOnVisible } from './toolSurface';
import { copyReference, ensureFile, isScratch, materialize, readPlan, readProgress, writeIndex, writeProgress } from './workspace';

const TOOL_ID = 'burrow-scratch';

export function activate(context: vscode.ExtensionContext): void {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const log = vscode.window.createOutputChannel('Burrow Scratch');
	context.subscriptions.push(log);

	context.subscriptions.push(vscode.commands.registerCommand('burrow.scratch.start', () => startScratch(log)));

	if (root && isScratch(root)) {
		activateScratch(context, root, log);
	} else {
		void vscode.commands.executeCommand('setContext', 'burrow.scratch.active', false);
	}
}

export function deactivate(): void {
	// Disposables are owned by the extension context; progress is on disk.
}

// ---------------------------------------------------------------------------
// The launcher — runs in the reference project's window
// ---------------------------------------------------------------------------

/**
 * Route annotations, when flowscan has produced something worth reading.
 *
 * Every failure path returns `undefined` and says why in the log: annotations
 * are enrichment, and a plan that explains a handful of routes reads as though
 * the rest serve nothing. The staged flowscan binary going stale is exactly this
 * case — it reports six traced flows out of two hundred and thirty-five rather
 * than failing — which is why the floor is on the traced count and not on the
 * file existing.
 */
function loadRoutes(reference: string, log: vscode.OutputChannel): ReadonlyMap<string, readonly string[]> | undefined {
	const configured = vscode.workspace.getConfiguration('burrow.scratch').get<string>('flowsFile', '');
	const candidate = configured
		? configured.replace(/^~/, os.homedir())
		: path.join(reference, '.burrow', 'flows.json');
	if (!fs.existsSync(candidate)) {
		log.appendLine(`no route annotations: ${candidate} does not exist (run "API Flows: Refresh" or set burrow.scratch.flowsFile)`);
		return undefined;
	}
	let doc: FlowsDoc;
	try {
		doc = JSON.parse(fs.readFileSync(candidate, 'utf8')) as FlowsDoc;
	} catch (error) {
		log.appendLine(`no route annotations: ${candidate} is not readable JSON (${error instanceof Error ? error.message : String(error)})`);
		return undefined;
	}
	// flows.json records the absolute backend directory it scanned; trust that
	// over any convention, and fall back only when the file predates the field.
	const backendAbs = doc.backend && path.isAbsolute(doc.backend) ? doc.backend : guessBackend(reference);
	const rel = path.relative(reference, backendAbs);
	const index = routeIndex(doc, rel.startsWith('..') ? '' : rel.split(path.sep).join('/'));
	if (!index) {
		log.appendLine(`no route annotations: ${candidate} traced ${doc.coverage?.traced ?? 0} flows, below the floor of ${MIN_TRACED_FLOWS} — a degraded scan explains less than nothing`);
		return undefined;
	}
	log.appendLine(`route annotations: ${index.size} files carry at least one route, from ${doc.coverage?.traced} traced flows`);
	return index;
}

/**
 * Notes a person wrote about THIS project's files, discovered in the reference.
 *
 * `<reference>/.burrow/scratch-notes/<step path>.md` — so `vite.config.ts`'s note
 * is `.burrow/scratch-notes/frontend/vite.config.ts.md`. The path IS the key;
 * there is no index to keep in step with the tree.
 *
 * WHY THE REFERENCE AND NOT THE EXTENSION. A concept paragraph is about a tool
 * and belongs to Burrow (`concepts.ts`). A note about why *this* config file has
 * a proxy block in it is about somebody's application, and shipping it inside an
 * IDE would make Burrow the author of opinions about a repository it has never
 * seen. It also goes stale the moment that repository moves, where the repository
 * itself does not.
 *
 * `burrow.scratch.notesDir` overrides the location, which is what makes the
 * mechanism usable against a reference you cannot write to.
 */
function loadNotes(reference: string, log: vscode.OutputChannel): ReadonlyMap<string, string> | undefined {
	const configured = vscode.workspace.getConfiguration('burrow.scratch').get<string>('notesDir', '');
	const dir = configured ? configured.replace(/^~/, os.homedir()) : path.join(reference, '.burrow', 'scratch-notes');
	const notes = new Map<string, string>();
	const walk = (abs: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(abs, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const next = path.join(abs, entry.name);
			if (entry.isDirectory()) {
				walk(next);
			} else if (entry.name.endsWith('.md')) {
				const rel = path.relative(dir, next).split(path.sep).join('/').replace(/\.md$/, '');
				try {
					notes.set(rel, fs.readFileSync(next, 'utf8'));
				} catch { /* unreadable note — the plan is not worth failing for one */ }
			}
		}
	};
	walk(dir);
	log.appendLine(notes.size
		? `authored notes: ${notes.size} from ${dir}`
		: `no authored notes: nothing under ${dir} (set burrow.scratch.notesDir to point elsewhere)`);
	return notes.size ? notes : undefined;
}

/** flows.json records an absolute backend dir; prefer it, fall back to the
 *  conventional layout so a hand-copied file still resolves. */
function guessBackend(reference: string): string {
	for (const name of ['backend', 'server', 'api']) {
		if (fs.existsSync(path.join(reference, name, 'go.mod'))) {
			return path.join(reference, name);
		}
	}
	return reference;
}

async function startScratch(log: vscode.OutputChannel): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		void vscode.window.showWarningMessage('Open the project you want to rebuild first — Scratch plans it from the folder you have open.');
		return;
	}
	const reference = folder.uri.fsPath;
	if (isScratch(reference)) {
		void vscode.window.showInformationMessage('This window is already a scratch. Use "Scratch: Re-plan Against the Reference" to pick up changes.');
		return;
	}

	const configured = vscode.workspace.getConfiguration('burrow.scratch').get<string>('location', '');
	const suggested = configured
		? path.join(configured.replace(/^~/, os.homedir()), `${folder.name}-scratch`)
		: path.join(os.homedir(), 'Burrow Scratch', `${folder.name}-scratch`);
	const answer = await vscode.window.showInputBox({
		title: `Rebuild ${folder.name} from scratch`,
		prompt: 'Where should the scratch live? An existing scratch here is resumed, never overwritten.',
		value: suggested,
		ignoreFocusOut: true,
	});
	if (!answer) {
		return;
	}
	const dest = answer.replace(/^~/, os.homedir());

	const plan = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Scratch: reading ${folder.name}…`, cancellable: false },
		async (progress) => {
			const scan = scanProject(reference);
			progress.report({ message: `${scan.files.length} files — working out the order…` });
			// Yield once so the notification paints before the plan is built.
			await new Promise((resolve) => setTimeout(resolve, 0));
			const built = buildPlan(scan.files, { name: folder.name, reference, routes: loadRoutes(reference, log), notes: loadNotes(reference, log) });
			log.appendLine(`planned ${folder.name}: ${built.counts.steps} steps in ${built.counts.stages} stages, ${built.counts.lines} lines (${scan.skipped} binary/oversized files left out)`);
			return built;
		},
	);

	if (!plan.counts.steps) {
		void vscode.window.showWarningMessage(`Nothing to plan in ${folder.name} — no source files were found.`);
		return;
	}

	try {
		const progress = materialize(dest, plan, new Date().toISOString());
		const resumed = overallTally(plan, progress).settled;
		log.appendLine(`scratch at ${dest} — ${resumed} steps already settled`);
	} catch (error) {
		void vscode.window.showErrorMessage(`Could not create the scratch at ${dest}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dest), { forceNewWindow: true });
}

// ---------------------------------------------------------------------------
// The scratch — runs in the second window
// ---------------------------------------------------------------------------

function activateScratch(context: vscode.ExtensionContext, root: string, log: vscode.OutputChannel): void {
	const plan = readPlan(root);
	if (!plan) {
		void vscode.window.showErrorMessage('This scratch has a plan file Burrow cannot read. Re-run "Scratch: New Scratch Build…" against the reference to rebuild it — your files are untouched.');
		return;
	}
	void vscode.commands.executeCommand('setContext', 'burrow.scratch.active', true);

	let progress = readProgress(root, new Date().toISOString());
	let checks: CheckRun | undefined;
	let running = false;

	const tree = new StepsProvider(plan, progress);
	const view = vscode.window.createTreeView(StepsProvider.viewId, { treeDataProvider: tree, showCollapseAll: true });
	const page = new StepPage((message) => void onPageMessage(message));
	// No `claimSurface` here, deliberately. The step page is not a transient
	// result tab like the Test Lab — it is where the work happens, and the rail
	// already tidies it: patch 0014's per-rail editor sets hide it when you go
	// to Data and bring the set back when you return. Claiming it as well would
	// mean two mechanisms closing the same tab.
	const currentId = (): string | undefined => progress.current ?? resumeAt(plan, progress);

	context.subscriptions.push(
		view,
		page,
		announceOnVisible(TOOL_ID, view),
		// Panel persistence (WO-60): the step page comes back on the step it was
		// on. Registered here rather than in `activate`, so a window that is not a
		// scratch has no reviver and the workbench never persists the tab at all.
		page.register((savedStepId) => {
			const id = savedStepId && plan.steps[savedStepId] ? savedStepId : currentId();
			return id ? { plan, progress, stepId: id, checks: undefined, running: false } : undefined;
		}),
	);

	const save = (next: Progress, redraw = true): void => {
		progress = next;
		writeProgress(root, progress);
		writeIndex(root, plan, progress);
		if (redraw) {
			tree.update(plan, progress);
			const id = currentId();
			if (id) {
				page.refresh({ plan, progress, stepId: id, checks, running });
			}
		}
	};

	const badge = (): void => {
		const tally = overallTally(plan, progress);
		view.title = 'Scratch';
		view.description = `${percent(tally)}% · ${tally.settled}/${tally.total}`;
	};
	badge();

	/** Move to a step: it becomes current, the page follows, and so does the code. */
	const goto = async (id: string, focusPage = false): Promise<void> => {
		if (!plan.steps[id]) {
			return;
		}
		checks = undefined;
		save(setCurrent(progress, id, new Date().toISOString()), false);
		tree.update(plan, progress);
		badge();
		// The FILE first, then the page beside it. The other order looks right and
		// is not: on a fresh window with nothing open, `ViewColumn.Beside`
		// resolves to column one, and the file then opens on top of the page.
		//
		// A PREVIEW tab replaces itself, so walking the plan does not leave one
		// tab per file behind — the same rule the API view follows.
		const uri = vscode.Uri.file(ensureFile(root, id, plan.steps[id]?.mode));
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: focusPage, viewColumn: vscode.ViewColumn.One });
		page.show({ plan, progress, stepId: id, checks, running }, focusPage);
		const node = tree.find(id);
		if (node && view.visible) {
			try {
				await view.reveal(node, { select: true, focus: false });
			} catch { /* the tree may not have rendered that branch yet */ }
		}
	};

	const runStepChecks = async (id: string): Promise<CheckRun> => {
		running = true;
		page.refresh({ plan, progress, stepId: id, checks, running });
		try {
			const run = await runChecks(root, id, plan.steps[id].checks);
			checks = run;
			log.appendLine(`check ${id}: ${run.verdict} — ${summarize(run)}`);
			// The real verdict, all three of them. Folding `unavailable` into `pass`
			// here is what let a stage go green on checks that never executed.
			save(recordCheck(progress, id, run.verdict, new Date().toISOString()), false);
			return run;
		} finally {
			running = false;
			page.refresh({ plan, progress, stepId: id, checks, running });
			tree.update(plan, progress);
		}
	};

	const markDone = async (id: string): Promise<void> => {
		const run = await runStepChecks(id);
		// `unavailable` asks too. It is not a failure and it is not a pass: the
		// step goes down as written and unproven, and saying so at the moment of
		// marking is the only place a reader will notice.
		if (run.verdict !== 'pass') {
			const anyway = await vscode.window.showWarningMessage(
				`${plan.steps[id].title}: ${summarize(run)}`,
				run.verdict === 'fail' ? 'Mark written anyway' : 'Mark written, unproven', 'Keep working',
			);
			if (anyway === 'Keep working' || anyway === undefined) {
				return;
			}
		}
		save(setState(progress, id, 'done', new Date().toISOString()));
		badge();
		const next = nextStep(plan, progress, id);
		if (next) {
			await goto(next);
		} else {
			void vscode.window.showInformationMessage(`${plan.name} is rebuilt — every file in the plan is written.`);
		}
	};

	async function onPageMessage(message: PageMessage): Promise<void> {
		const id = currentId();
		if (!id) {
			return;
		}
		switch (message.type) {
			case 'open': return void vscode.commands.executeCommand('burrow.scratch.open');
			case 'reference': return void vscode.commands.executeCommand('burrow.scratch.reference');
			case 'copy': return void vscode.commands.executeCommand('burrow.scratch.copy');
			case 'check': { await runStepChecks(id); return; }
			case 'done': return void markDone(id);
			case 'undone': {
				save(setState(progress, id, 'writing', new Date().toISOString()));
				badge();
				return;
			}
			case 'next': return void vscode.commands.executeCommand('burrow.scratch.next');
			case 'setup': return void vscode.commands.executeCommand('burrow.scratch.setup');
			case 'milestone': return void vscode.commands.executeCommand('burrow.scratch.milestone');
			case 'goto': return void goto(message.id);
			case 'tool': {
				try {
					await vscode.commands.executeCommand(message.command);
				} catch {
					void vscode.window.showWarningMessage(`That tool is not available in this window (${message.command}).`);
				}
				return;
			}
			default: return;
		}
	}

	const register = (id: string, handler: (...args: never[]) => unknown): void => {
		context.subscriptions.push(vscode.commands.registerCommand(id, handler));
	};

	register('burrow.scratch.goto', ((arg?: string | { id?: string }) => {
		const id = typeof arg === 'string' ? arg : arg?.id;
		return id ? goto(id) : undefined;
	}) as never);

	register('burrow.scratch.page', (() => {
		const id = currentId();
		return id ? goto(id, true) : undefined;
	}) as never);

	register('burrow.scratch.open', (async () => {
		const id = currentId();
		if (!id) {
			return;
		}
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(ensureFile(root, id, plan.steps[id]?.mode)));
		await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
		if (stateOf(progress, id) === 'todo') {
			save(setState(progress, id, 'writing', new Date().toISOString()));
		}
	}) as never);

	// Also reachable as an inline action on a tree row, which does NOT make that
	// row current — comparing a file you have not opened is a fair thing to want.
	register('burrow.scratch.reference', (async (node?: { id?: string }) => {
		const id = (typeof node === 'object' && node?.id && plan.steps[node.id]) ? node.id : currentId();
		if (!id) {
			return;
		}
		// A DIFF, not the file: side by side with what you have written, so the
		// reference answers "what is still missing" instead of being a thing to
		// copy out of.
		ensureFile(root, id, plan.steps[id]?.mode);
		await vscode.commands.executeCommand(
			'vscode.diff',
			vscode.Uri.file(path.join(plan.reference, id)),
			vscode.Uri.file(path.join(root, id)),
			`${plan.steps[id].title} — reference ↔ yours`,
			{ preview: true },
		);
	}) as never);

	register('burrow.scratch.copy', (async () => {
		const id = currentId();
		if (!id) {
			return;
		}
		const step = plan.steps[id];
		if (step.mode !== 'copy') {
			const ok = await vscode.window.showWarningMessage(
				`Copy ${step.title} in from the reference? It will count as copied, not written.`,
				'Copy it in', 'Cancel',
			);
			if (ok !== 'Copy it in') {
				return;
			}
		}
		try {
			copyReference(root, plan.reference, id);
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not copy ${id}: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		save(setState(progress, id, 'copied', new Date().toISOString()));
		badge();
		const next = nextStep(plan, progress, id);
		if (next) {
			await goto(next);
		}
	}) as never);

	register('burrow.scratch.check', (async () => {
		const id = currentId();
		if (!id) {
			return;
		}
		const run = await runStepChecks(id);
		const message = `${plan.steps[id].title}: ${summarize(run)}`;
		if (run.verdict === 'pass') {
			void vscode.window.showInformationMessage(message);
		} else if (run.verdict === 'unavailable') {
			void vscode.window.showWarningMessage(message);
		} else {
			void vscode.window.showErrorMessage(message);
		}
	}) as never);

	register('burrow.scratch.checkStage', (async (node?: { stage?: { id: string } }) => {
		const stageId = node?.stage?.id ?? plan.steps[currentId() ?? '']?.stage;
		const stage = plan.stages.find((s) => s.id === stageId);
		if (!stage) {
			return;
		}
		if (!stage.checks.length) {
			void vscode.window.showInformationMessage(`${stage.title} has no stage check — its files are checked one at a time.`);
			return;
		}
		const run = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Scratch: checking ${stage.title}…` },
			() => runChecks(root, undefined, stage.checks),
		);
		log.appendLine(`check stage ${stage.id}: ${run.verdict} — ${summarize(run)}`);
		const message = `${stage.title}: ${summarize(run)}`;
		if (run.verdict === 'pass') {
			void vscode.window.showInformationMessage(message);
		} else {
			void vscode.window.showWarningMessage(message);
		}
	}) as never);

	register('burrow.scratch.done', (() => {
		const id = currentId();
		return id ? markDone(id) : undefined;
	}) as never);

	register('burrow.scratch.next', (() => {
		const id = currentId();
		const next = nextStep(plan, progress, id);
		if (!next) {
			void vscode.window.showInformationMessage('Nothing left unwritten in the plan.');
			return undefined;
		}
		return goto(next);
	}) as never);

	register('burrow.scratch.setup', (() => {
		const stage = plan.stages.find((s) => s.id === plan.steps[currentId() ?? '']?.stage);
		if (!stage?.setup.length) {
			return;
		}
		const terminal = vscode.window.createTerminal({ name: 'Scratch setup', cwd: root });
		terminal.show();
		for (const line of stage.setup) {
			terminal.sendText(line);
		}
	}) as never);

	/**
	 * The stage's milestone, in a terminal the learner keeps.
	 *
	 * A terminal and not a task or a spawned child, for the reason the command is
	 * printed on the page as well as buttoned: this is the first thing the project
	 * DOES, and the output belongs somewhere the learner can scroll back to, run
	 * again, and edit. A milestone whose result vanishes into a notification is a
	 * magic trick.
	 *
	 * The precondition is checked first and refuses rather than running: a
	 * `docker compose up` against a compose file nobody has written yet fails with
	 * the tool's own words, which are about YAML rather than about the plan.
	 */
	register('burrow.scratch.milestone', (async () => {
		const stage = plan.stages.find((s) => s.id === plan.steps[currentId() ?? '']?.stage);
		const milestone = stage?.milestone;
		if (!stage || !milestone) {
			return;
		}
		if (milestone.needs && !preconditionMet(root, milestone.needs)) {
			void vscode.window.showWarningMessage(`${milestone.label} — not yet: ${milestone.needs.why}`);
			return;
		}
		const terminal = vscode.window.createTerminal({ name: `Scratch — ${stage.title}`, cwd: path.join(root, milestone.cwd) });
		terminal.show();
		terminal.sendText(milestone.command);
		log.appendLine(`milestone ${stage.id}: ${milestone.command} (cwd ${milestone.cwd || '.'})`);
	}) as never);

	register('burrow.scratch.replan', (async () => {
		const scan = scanProject(plan.reference);
		const rebuilt = buildPlan(scan.files, { name: plan.name, reference: plan.reference, routes: loadRoutes(plan.reference, log), notes: loadNotes(plan.reference, log) });
		const kept = order(rebuilt).filter((id) => isSettled(stateOf(progress, id))).length;
		const lost = order(plan).filter((id) => isSettled(stateOf(progress, id)) && !rebuilt.steps[id]);
		const ok = await vscode.window.showWarningMessage(
			`Re-plan against ${plan.reference}? ${rebuilt.counts.steps} files (was ${plan.counts.steps}). `
			+ `${kept} of your finished files are still in the plan${lost.length ? `; ${lost.length} are no longer in the reference` : ''}.`,
			'Re-plan', 'Cancel',
		);
		if (ok !== 'Re-plan') {
			return;
		}
		materialize(root, rebuilt, new Date().toISOString());
		void vscode.window.showInformationMessage('Plan rewritten. Reload the window to pick it up.', 'Reload')
			.then((choice) => choice === 'Reload' && vscode.commands.executeCommand('workbench.action.reloadWindow'));
	}) as never);

	// Resume where the developer stopped, without stealing focus at startup.
	const resume = resumeAt(plan, progress);
	if (resume) {
		save(setCurrent(progress, resume, new Date().toISOString()), false);
		tree.update(plan, progress);
		badge();
		log.appendLine(`resumed at ${resume} (${percent(overallTally(plan, progress))}%)`);
	}
}
