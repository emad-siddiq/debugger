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
import { FlowsDoc, MIN_TRACED_FLOWS, buildPlan, commandCwdOf, routeIndex } from './planModel';
import { ghostLines, ghostSuggestion } from './ghost';
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

	context.subscriptions.push(vscode.commands.registerCommand('burrow.scratch.start', () => startScratch(context, log)));
	context.subscriptions.push(vscode.commands.registerCommand('burrow.scratch.openBuild', () => openScratchBuild(context)));

	if (root && isScratch(root)) {
		recordScratch(context, root);
		activateScratch(context, root, log);
	} else {
		void vscode.commands.executeCommand('setContext', 'burrow.scratch.active', false);
	}
}

// ---------------------------------------------------------------------------
// Finding your way back — a scratch is a folder, and folders get lost
// ---------------------------------------------------------------------------

const MRU_KEY = 'burrow.scratch.mru';

/** Cross-window MRU of scratch roots, newest first. `globalState` because a
 *  scratch is opened FROM other windows — the reference window, an empty one. */
function recordScratch(context: vscode.ExtensionContext, root: string): void {
	const mru = (context.globalState.get<string[]>(MRU_KEY) ?? []).filter((p) => p !== root);
	void context.globalState.update(MRU_KEY, [root, ...mru].slice(0, 20));
}

/** Where new scratches go by default — also where old ones are looked for. */
function scratchHome(): string {
	const configured = vscode.workspace.getConfiguration('burrow.scratch').get<string>('location', '');
	return configured ? configured.replace(/^~/, os.homedir()) : path.join(os.homedir(), 'Burrow Scratch');
}

/**
 * "Scratch: Open Scratch Build…" — resume a rebuild without re-planning it.
 *
 * Candidates are the MRU plus a one-level scan of the default location, so a
 * scratch made before the MRU existed is still found. Progress shown on each
 * row comes from SCRATCH.md's own headline — parsing the 1.5 MB plan.json per
 * row would make a QuickPick cost more than the thing it opens.
 */
async function openScratchBuild(context: vscode.ExtensionContext): Promise<void> {
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const p of context.globalState.get<string[]>(MRU_KEY) ?? []) {
		if (!seen.has(p) && isScratch(p)) {
			seen.add(p);
			candidates.push(p);
		}
	}
	try {
		for (const entry of fs.readdirSync(scratchHome(), { withFileTypes: true })) {
			const p = path.join(scratchHome(), entry.name);
			if (entry.isDirectory() && !seen.has(p) && isScratch(p)) {
				seen.add(p);
				candidates.push(p);
			}
		}
	} catch { /* no default location yet — the MRU is the whole list */ }
	// Prune the MRU of anything that stopped being a scratch (deleted, moved).
	void context.globalState.update(MRU_KEY, (context.globalState.get<string[]>(MRU_KEY) ?? []).filter((p) => seen.has(p)));

	if (!candidates.length) {
		void vscode.window.showInformationMessage('No scratch builds found — start one with "Scratch: New Scratch Build…" from the project you want to rebuild.');
		return;
	}
	const here = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const items = candidates.map((p) => {
		let description = '';
		try {
			// writeIndex's exact headline: `**NN%** — X of Y files (…)`.
			const m = /\*\*(\d+)%\*\*\s+—\s+(\d+) of (\d+) files/.exec(fs.readFileSync(path.join(p, 'SCRATCH.md'), 'utf8'));
			if (m) {
				description = `${m[1]}% · ${m[2]} of ${m[3]} files`;
			}
		} catch { /* no index — the path still identifies it */ }
		return {
			label: path.basename(p),
			description: p === here ? 'this window' : description,
			detail: p,
			path: p,
		};
	});
	const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Resume a scratch build', matchOnDetail: true });
	if (!picked || picked.path === here) {
		return;
	}
	await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(picked.path),
		{ forceNewWindow: !!vscode.workspace.workspaceFolders?.length });
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

async function startScratch(context: vscode.ExtensionContext, log: vscode.OutputChannel): Promise<void> {
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

	// A destination that is ALREADY a scratch has a decision attached, and
	// re-planning silently is not it: opening picks up exactly where the learner
	// stopped, re-planning rewrites plan.json against a reference that may have
	// moved. Ask.
	if (isScratch(dest)) {
		const choice = await vscode.window.showInformationMessage(
			`${path.basename(dest)} is already a scratch build. Open it where you left off, or re-plan it against ${folder.name} first?`,
			'Open it', 'Re-plan and open',
		);
		if (choice === undefined) {
			return;
		}
		if (choice === 'Open it') {
			recordScratch(context, dest);
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dest), { forceNewWindow: true });
			return;
		}
	}

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

	recordScratch(context, dest);
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
		await openIfPresent(id, { preview: true, preserveFocus: focusPage, viewColumn: vscode.ViewColumn.One });
		page.show({ plan, progress, stepId: id, checks, running }, focusPage);
		const node = tree.find(id);
		if (node && view.visible) {
			try {
				await view.reveal(node, { select: true, focus: false });
			} catch { /* the tree may not have rendered that branch yet */ }
		}
	};

	/**
	 * The type-along guide (WO-82): the next characters of the reference render
	 * as ghost text ahead of the cursor while the learner types a `write` step.
	 *
	 * The rule lives in ghost.ts, pure and unit-tested; this wrapper only maps a
	 * document to its step and its reference. It stays SYNCHRONOUS on purpose —
	 * reference lines come from an in-memory cache, so nothing can change between
	 * reading the position and returning, and no version guard is needed. Make it
	 * async and it grows one.
	 *
	 * Deliberately keyed off the DOCUMENT, never `currentId()`: the learner may
	 * type in a tab before the follow-listener has made it current, and the guide
	 * must already be there.
	 */
	const referenceLines = new Map<string, readonly string[]>();
	const referenceFor = (id: string): readonly string[] => {
		let lines = referenceLines.get(id);
		if (!lines) {
			try {
				lines = ghostLines(fs.readFileSync(path.join(plan.reference, id), 'utf8'));
			} catch {
				lines = [];  // reference unreadable → the guide stays quiet, forever
			}
			referenceLines.set(id, lines);
		}
		return lines;
	};
	context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider(
		{ scheme: 'file', pattern: new vscode.RelativePattern(root, '**') },
		{
			provideInlineCompletionItems: (document, position) => {
				if (!vscode.workspace.getConfiguration('burrow.scratch').get<boolean>('ghostText', true)) {
					return undefined;
				}
				const rel = path.relative(root, document.uri.fsPath).split(path.sep).join('/');
				if (rel.startsWith('..') || plan.steps[rel]?.mode !== 'write') {
					return undefined;
				}
				const doc = ghostLines(document.getText());
				const suggestion = ghostSuggestion(referenceFor(rel), doc, position.line, position.character);
				return suggestion ? [new vscode.InlineCompletionItem(suggestion, new vscode.Range(position, position))] : undefined;
			},
		},
	));

	/**
	 * The page follows the TABS, not only the rail.
	 *
	 * Navigation used to be one-directional — rail/page → editor — so clicking an
	 * editor tab left the step page stuck on whatever `goto` last set: the one
	 * concrete "switching files doesn't work well" complaint. This is the other
	 * direction. Guards, each load-bearing:
	 *
	 *   - `viewColumn === undefined` excludes diff-editor sides — the "Compare
	 *     With the Reference" contract says a diff does NOT make its row current —
	 *     plus output and peek editors;
	 *   - `rel === progress.current` is what stops it fighting `goto`, which sets
	 *     current BEFORE opening the file, so the event arrives as a no-op;
	 *   - `checks = undefined` exactly as `goto` does: `checksBlock` matches
	 *     results to checks by label, and labels repeat across steps, so a stale
	 *     run would paint the previous step's verdicts onto this one;
	 *   - `page.refresh`, never `page.show` — following must not OPEN the page as
	 *     a side effect.
	 */
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
		if (!editor || editor.viewColumn === undefined || editor.document.uri.scheme !== 'file') {
			return;
		}
		const rel = path.relative(root, editor.document.uri.fsPath).split(path.sep).join('/');
		if (rel.startsWith('..') || path.isAbsolute(rel) || !plan.steps[rel] || rel === progress.current) {
			return;
		}
		checks = undefined;
		save(setCurrent(progress, rel, new Date().toISOString()), false);
		tree.update(plan, progress);
		badge();
		page.refresh({ plan, progress, stepId: rel, checks, running });
		const node = tree.find(rel);
		if (node && view.visible) {
			view.reveal(node, { select: true, focus: false }).then(undefined, () => { /* branch not rendered yet */ });
		}
	}));

	/**
	 * Open a step's file when there is one to open.
	 *
	 * A `generate` step has no file until its command has run, and creating an
	 * empty one is exactly what WO-79 removed: `go mod init` REFUSES to run when
	 * a `go.mod` is already there, so pre-creating it made step 1 of the plan
	 * permanently unpassable. What WO-79 did not follow through is this half —
	 * three call sites still assumed `ensureFile` had created something, so
	 * clicking the first row of a fresh scratch threw
	 * `Unable to resolve nonexistent file …/test/go.mod` and took the rest of the
	 * navigation (the page, the tree selection, the reveal) down with it.
	 *
	 * The page opens either way. There is nothing to type on a generate step, so
	 * there is nothing to be in the editor for.
	 */
	const openIfPresent = async (id: string, options: vscode.TextDocumentShowOptions): Promise<boolean> => {
		const abs = ensureFile(root, id, plan.steps[id]?.mode);
		if (!fs.existsSync(abs)) {
			return false;
		}
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
		await vscode.window.showTextDocument(doc, options);
		return true;
	};

	/** A `generate` step's command runs INSIDE the directory it populates, and in
	 *  an empty-start scratch that directory does not exist until the step is
	 *  reached. Reaching it is what creates it. */
	const ensureGenerateCwd = (id: string): string => {
		const step = plan.steps[id];
		const rel = commandCwdOf(step) ?? '';
		const abs = path.join(root, rel === '.' ? '' : rel);
		fs.mkdirSync(abs, { recursive: true });
		return abs;
	};

	/**
	 * Write the learner's typing to disk before any check reads it.
	 *
	 * Every check asks the filesystem — `exists` stats the file, `go build` opens
	 * it — and an editor is under no obligation to have written there yet. Burrow
	 * ships no autosave and scratch mode sets none, so the obvious gesture — type
	 * the file, press "Run the checks" — reads a buffer that never reached disk
	 * and reports the learner's work missing. The one sentence the feature must
	 * not get wrong, and the ⌘S that avoids it is nowhere on the page.
	 *
	 * Scoped to documents inside the scratch. Running a check is not a licence to
	 * save whatever else happens to be open in the window.
	 */
	const flushScratchEdits = async (): Promise<void> => {
		const inside = `${root}${path.sep}`;
		await Promise.all(vscode.workspace.textDocuments
			.filter((doc) => doc.isDirty && doc.uri.scheme === 'file' && doc.uri.fsPath.startsWith(inside))
			.map((doc) => doc.save()));
	};

	const runStepChecks = async (id: string): Promise<CheckRun> => {
		running = true;
		page.refresh({ plan, progress, stepId: id, checks, running });
		try {
			await flushScratchEdits();
			if (plan.steps[id].mode === 'generate') {
				ensureGenerateCwd(id);
			}
			const run = await runChecks(root, id, plan.steps[id].checks);
			// Keep the run for the page only while this step is still the one on
			// it — the shared slot must not outlive a tab switch (see the finally).
			checks = currentId() === id ? run : undefined;
			log.appendLine(`check ${id}: ${run.verdict} — ${summarize(run)}`);
			// The real verdict, all three of them. Folding `unavailable` into `pass`
			// here is what let a stage go green on checks that never executed.
			save(recordCheck(progress, id, run.verdict, new Date().toISOString()), false);
			return run;
		} finally {
			running = false;
			// The CURRENT step, not the captured one. The tab-follow listener can
			// move the page while a check runs, and a final refresh pinned to the
			// step that ran would yank the page back — worse, `checksBlock` matches
			// results to checks by LABEL, and "the file exists and is not empty" is
			// every step's label, so another step's page would wear these verdicts.
			const showing = currentId() ?? id;
			page.refresh({ plan, progress, stepId: showing, checks, running });
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
			case 'terminal': return void vscode.commands.executeCommand('burrow.scratch.terminal');
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
		const step = plan.steps[id];
		if (!await openIfPresent(id, { preview: false, viewColumn: vscode.ViewColumn.One })) {
			// Not an error, and worth saying rather than opening an empty tab: the
			// toolchain writes this file, and the step's own check is what runs it.
			void vscode.window.showInformationMessage(
				`${step.title} is not written by hand — press "Open a terminal in ${step.commandCwd || '.'}" and type \`${step.command}\`, then "Run the checks" to verify.`);
			return;
		}
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
		// …and a diff needs two sides. A `generate` step has no file until its
		// command has run, so show the reference on its own rather than diffing
		// against something that is not there.
		if (!fs.existsSync(ensureFile(root, id, plan.steps[id]?.mode))) {
			const reference = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(plan.reference, id)));
			await vscode.window.showTextDocument(reference, { preview: true });
			return;
		}
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
			async () => {
				await flushScratchEdits();
				return runChecks(root, undefined, stage.checks);
			},
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

	// EMPTY, deliberately — this and the two terminals below. The commands are
	// printed on the step page, and the learner types them. A terminal that runs
	// things for you is a button wearing a prompt; the whole premise of scratch
	// mode is that the fingers do the work, and a command you typed once is a
	// command you own. (Requested in as many words: the terminal pops up, the
	// command stays on the page, you type it.)
	register('burrow.scratch.setup', (() => {
		const stage = plan.stages.find((s) => s.id === plan.steps[currentId() ?? '']?.stage);
		if (!stage?.setup.length) {
			return;
		}
		vscode.window.createTerminal({ name: 'Scratch setup', cwd: root }).show();
	}) as never);

	/**
	 * A terminal in the directory a `generate` step's command runs in — created
	 * on demand, because in an empty-start scratch the directory does not exist
	 * until the learner reaches the step. Opening the terminal is reaching it.
	 */
	register('burrow.scratch.terminal', (() => {
		const id = currentId();
		const step = id ? plan.steps[id] : undefined;
		const rel = step ? commandCwdOf(step) : undefined;
		if (!id || !step || rel === undefined) {
			return;
		}
		const cwd = ensureGenerateCwd(id);
		vscode.window.createTerminal({ name: `Scratch — ${rel || '.'}`, cwd }).show();
		log.appendLine(`terminal for ${id} (cwd ${rel || '.'})`);
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
	 * The precondition WARNS now rather than refusing: since WO-82 the terminal
	 * executes nothing — the learner types the command off the page — so opening
	 * one early is harmless, and blocking a terminal is hostile. The warning
	 * still says why the command will not work yet.
	 */
	register('burrow.scratch.milestone', (async () => {
		const stage = plan.stages.find((s) => s.id === plan.steps[currentId() ?? '']?.stage);
		const milestone = stage?.milestone;
		if (!stage || !milestone) {
			return;
		}
		if (milestone.needs && !preconditionMet(root, milestone.needs)) {
			void vscode.window.showWarningMessage(`${milestone.label} — not yet: ${milestone.needs.why}`);
		}
		// mkdir first: a terminal handed a nonexistent cwd falls back to $HOME
		// silently, and the learner's typed command then runs in the wrong place —
		// the worst failure mode a typing tutorial can have.
		const cwd = path.join(root, milestone.cwd);
		fs.mkdirSync(cwd, { recursive: true });
		vscode.window.createTerminal({ name: `Scratch — ${stage.title}`, cwd }).show();
		log.appendLine(`milestone terminal ${stage.id}: learner types \`${milestone.command}\` (cwd ${milestone.cwd || '.'})`);
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
