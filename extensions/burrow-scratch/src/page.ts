/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, ViewColumn, WebviewPanel, commands, window } from 'vscode';
import { CheckRun } from './checks';
import { conceptFor } from './concepts';
import { ScratchPlan, ScratchStage, ScratchStep, dependents, forwardDeps } from './planModel';
import { Progress, StepState, overallTally, percent, stageTally, stateOf } from './progressModel';

// The **step page**: one file's worth of context, in an editor tab beside the
// code you are about to write.
//
// It answers four questions in this order, because that is the order they
// occur to you: what is this file, what does it need that you have already
// written, what has to be true when you are done, and what does it unlock. The
// reference source is NOT shown here — it is one click away behind "Show the
// reference", deliberately a decision rather than a default, because a plan
// that puts the answer next to the question is a transcription exercise.
//
// Visual rules are the lab family's (docs/plans/04 §6): one 32px top bar, a
// quiet inset stage, theme tokens only.

export type PageMessage =
	| { readonly type: 'open' | 'reference' | 'copy' | 'done' | 'undone' | 'next' | 'check' | 'setup' | 'milestone' | 'terminal' | 'exitFocus' }
	| { readonly type: 'goto'; readonly id: string }
	| { readonly type: 'tool'; readonly command: string };

export interface PageState {
	readonly plan: ScratchPlan;
	readonly progress: Progress;
	readonly stepId: string;
	readonly checks?: CheckRun;
	readonly running?: boolean;
}

export class StepPage implements Disposable {

	public static readonly viewType = 'burrow.scratch.step';

	private panel: WebviewPanel | undefined;
	private state: PageState | undefined;

	constructor(private readonly onMessage: (message: PageMessage) => void) { }

	dispose(): void {
		this.panel?.dispose();
	}

	get visible(): boolean {
		return this.panel?.visible === true;
	}

	/**
	 * Come back with the rail, a reload and a relaunch (WO-60).
	 *
	 * Registered from `activateScratch`, so it exists only in a window that HAS a
	 * scratch. In any other window there is no reviver, the workbench declines to
	 * persist the tab in the first place, and a step page never reappears
	 * somewhere it would have nothing to point at.
	 *
	 * `build` resolves the step from the plan and progress already read off disk;
	 * a step id that is no longer in the plan falls back to the current one.
	 */
	register(build: (stepId: string | undefined) => PageState | undefined): Disposable {
		return window.registerWebviewPanelSerializer(StepPage.viewType, {
			deserializeWebviewPanel: async (panel: WebviewPanel, saved: unknown): Promise<void> => {
				const stepId = (saved as { stepId?: string } | undefined)?.stepId;
				const state = build(typeof stepId === 'string' ? stepId : undefined);
				this.panel?.dispose();
				this.panel = panel;
				this.wire(panel);
				if (!state) {
					panel.dispose();
					return;
				}
				this.state = state;
				this.render();
			},
		});
	}

	/** Listener wiring shared by a fresh open and a revive. */
	private wire(panel: WebviewPanel): void {
		panel.onDidDispose(() => { this.panel = undefined; });
		panel.webview.onDidReceiveMessage((message: PageMessage) => {
			if (message?.type === 'exitFocus') {
				void commands.executeCommand('burrow.focus.exit');
				return;
			}
			this.onMessage(message);
		});
	}

	/** Show the page for a step, creating the panel on first use. */
	show(state: PageState, focus = false): void {
		this.state = state;
		if (!this.panel) {
			// preserveFocus: the caller opens the FILE first and the page beside
			// it, and the cursor belongs in the file you are about to write.
			this.panel = window.createWebviewPanel(
				StepPage.viewType, 'Scratch',
				{ viewColumn: ViewColumn.Beside, preserveFocus: true },
				{ enableScripts: true, retainContextWhenHidden: true },
			);
			this.wire(this.panel);
		} else if (focus) {
			this.panel.reveal(this.panel.viewColumn ?? ViewColumn.Beside, false);
		}
		this.render();
	}

	/** Re-render in place if the page is open; never open it as a side effect. */
	refresh(state: PageState): void {
		this.state = state;
		if (this.panel) {
			this.render();
		}
	}

	private render(): void {
		if (this.panel && this.state) {
			const step = this.state.plan.steps[this.state.stepId];
			this.panel.title = step ? `Scratch — ${step.title}` : 'Scratch';
			this.panel.webview.html = html(this.state);
		}
	}
}

// ---------------------------------------------------------------------------

function escape(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The two marks the authored prose uses, and nothing else: `code` and **bold**.
 *  Escaped first, so a paragraph can never inject an element. */
function markdown(text: string): string {
	return escape(text)
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function nonceOf(): string {
	let out = '';
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return out;
}

/** What the developer is being asked to do, in one sentence built from facts. */
export function instruction(step: ScratchStep, stage: ScratchStage): string {
	if (step.mode === 'generate') {
		// What the checks ACTUALLY assert, named one by one. The sentence this
		// replaced — "the check runs the command and then looks for the file" —
		// promised a verdict the step could not deliver: `go.mod`'s check also ran
		// `go mod tidy`, whose inputs are hundreds of steps away, so step 1 of the
		// plan reported "could not run" whatever the learner did. The command moved
		// (see `checksFor`); this is the half that has to move with it, because a
		// page that describes a check it no longer runs is the same defect again.
		const asserts = step.title === 'go.mod'
			? 'the checks confirm the command ran, that the file is there, and that it declares the right module path'
			+ ' — the <code>require</code> list is filled in later, by the first package you write'
			: 'the checks run the command and then look for the file';
		return `Run <code>${escape(step.command ?? '')}</code>${step.commandCwd ? ` in <code>${escape(step.commandCwd)}</code>` : ''}. `
			+ `A ${step.title} is written by the toolchain — ${asserts}.`;
	}
	if (step.mode === 'copy') {
		return step.kind === 'doc'
			? `Copy this one in. It is prose, not code — reading it is the point, and typing it out is not.`
			: `Copy this one in. A ${step.title} is generated by the toolchain — typing it would teach you nothing and get it wrong.`;
	}
	const size = step.lines < 40 ? 'a short file' : step.lines < 200 ? `about ${Math.round(step.lines / 10) * 10} lines` : `a long one — ${step.lines} lines`;
	// NOT ALL OF IT. A step that carries a `DerivedPart` asks for the authored half
	// and nothing else, and the lede is the first place that has to say so —
	// otherwise the reader meets thirty-nine lines of version ranges and a page
	// telling them to write the file.
	if (step.derived?.length) {
		const parts = step.derived.map((d) => `<code>${escape(d.writes)}</code>`).join(' and ');
		return `Write <code>${escape(step.id)}</code> in ${escape(stage.title)} — ${size}, but not all of it.`
			+ ` The ${parts} block is a command's to write, and the command is below.`;
	}
	// The exports sentence belongs to code and nothing else. A go.mod does not
	// "export nothing — it is wiring": it is a manifest, and saying otherwise
	// made the page sound like it had not read the file.
	const isCode = step.kind === 'go' || step.kind === 'gotest' || step.kind === 'ts' || step.kind === 'tsx';
	const what = !isCode ? (step.kind === 'sql' ? ' It runs in order with the other migrations beside it.' : '')
		: step.declares.length
			? ` It declares ${step.declares.slice(0, 3).map((d) => `<code>${escape(d)}</code>`).join(', ')}${step.declares.length > 3 ? ` and ${step.declares.length - 3} more` : ''}.`
			: ' It exports nothing — it is wiring, or a file whose work is all internal.';
	// `<code>`, not backticks: the lede is inserted as HTML and never passed
	// through `markdown`, so a backtick here reached the reader as a backtick.
	return `Write <code>${escape(step.id)}</code> in ${escape(stage.title)}: ${size}.${what}`;
}

/**
 * The half of this file a command writes, on a step that is otherwise typed.
 *
 * Named rather than merely omitted. A reader who is told to write a
 * `package.json` and finds thirty-nine of its sixty-three lines are version
 * ranges concludes the plan has not read the file — which was the objection, in
 * as many words. This section is the answer: here is the part that is not yours,
 * here is what writes it, and here is the order to do it in.
 */
export function derivedBlock(step: ScratchStep): string {
	if (!step.derived?.length) {
		return '';
	}
	const rows = step.derived.map((d) =>
		`<li><code>${escape(d.cmd)}</code>${d.cwd ? `<span class="quiet"> — in ${escape(d.cwd)}</span>` : ''}</li>`).join('');
	const what = step.derived.map((d) => `<code>${escape(d.writes)}</code>`).join(' and ');
	return `<section><h2>Not yours to type</h2>
		<p class="quiet">The ${what} block is version ranges, and a range copied off another file is transcription
		rather than a decision. The versions below are the reference's own: resolving them fresh would install
		whatever is newest today, which can be a major the code you are about to write was not built against.
		Type the rest of the file first — the command edits what is already there — then run this.</p>
		<ul class="links">${rows}</ul>
		<div class="actions"><button data-act="terminal">Open a terminal in ${escape(step.derived[0].cwd || '.')}</button></div></section>`;
}

/**
 * What a manifest unlocks — the files that actually import something it names.
 *
 * WO-79 narrowed this from "every step under this prefix" to "every `.ts`-ish
 * step under this prefix" and the narrowing did not make it true. It was still a
 * count of file NAMES presented as a fact about imports, and on `test/package.json`
 * — a manifest whose own description reads *"Dependency-free"* — it rendered
 * *"every bare import under `test/` — 1 modules' worth — resolves through the
 * dependencies this file names"*, about a manifest that names none and a file
 * (`test/ts/oracle.mjs`) whose only imports are `node:` builtins. Two false
 * claims and a plural disagreement in one sentence, none of which required
 * opening a file to produce.
 *
 * The number is now {@link ManifestReach}: files that import a specifier this
 * manifest resolves. It is smaller — 333 rather than 465 on merkle's frontend —
 * and it is quoted AGAINST the old denominator, on purpose. "333 of the 465" is
 * the sentence a reader can check; "465" alone was the sentence that could not
 * be wrong because it was not about anything.
 *
 * A Makefile is on nobody's import path and a tsconfig has real dependents the
 * graph can name, so both still get nothing from here and fall back to those.
 */
export function unlocksAll(plan: ScratchPlan, step: ScratchStep): string {
	const base = step.title;
	const slash = step.id.lastIndexOf('/');
	const dir = slash < 0 ? '' : step.id.slice(0, slash + 1);
	const where = `<code>${escape(dir || './')}</code>`;
	const under = (suffix: string): number =>
		Object.keys(plan.steps).filter((id) => id !== step.id && id.startsWith(dir) && id.endsWith(suffix)).length;
	const reach = step.resolves;
	// No reach is no sentence. A manifest nothing imports through unlocks nothing,
	// and saying so in a paragraph about zero would be the same defect politely.
	if ((base === 'go.mod' || base === 'package.json') && !reach?.files) {
		return '';
	}
	// Named, not just counted. `26` on its own is a number a reader has to take on
	// trust; `react, lucide-react, vitest and 23 more` is one they can go and look
	// at — and naming them is what makes the count checkable rather than merely
	// smaller than the one it replaced.
	const named = reach?.top.map((t) => `<code>${escape(t)}</code>`).join(', ') ?? '';
	const more = reach && reach.names > reach.top.length ? ` and ${reach.names - reach.top.length} more` : '';
	if (base === 'go.mod' && reach) {
		const via = reach.names ? `its own module path, or one of ${named}${more}` : 'its own module path';
		return `${reach.files} of the ${under('.go')} Go files under ${where}`
			+ ` resolve${reach.files === 1 ? 's' : ''} an import through this file — ${via}.`;
	}
	if (base === 'package.json' && reach) {
		const total = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].reduce((sum, ext) => sum + under(ext), 0);
		return `${reach.files} of the ${total} files under ${where} import${reach.files === 1 ? 's' : ''}`
			+ ` a package this file names${named ? ` — ${named}${more}` : ''}.`;
	}
	if (step.kind === 'lock') {
		const manifest = Object.keys(plan.steps).find((id) => id.startsWith(dir) && /(package|go)\.(json|mod)$/.test(id));
		return `Nothing imports a lockfile. It pins the versions ${manifest ? `<code>${escape(manifest)}</code>` : where} asked for,`
			+ ' so two machines install the same tree.';
	}
	return '';
}

/**
 * What kind of thing this file is — the answer to the question a reader asks
 * before any of the four the page is built around.
 *
 * INLINE, not behind a disclosure. WO-78 counted eleven terms the surface
 * requires you to already know and one it explains, and a paragraph you have to
 * ask for is a paragraph read by people who already knew. It sits above the
 * file's own note because the two answer different questions — what a lockfile
 * IS, and what this particular one is for — and the generic one comes first.
 */
/**
 * *Now run it* — on the LAST step of a stage that has a milestone.
 *
 * On the last step and not the first, because a milestone is what the stage's
 * work adds up to; offering it at the top would be offering to run something
 * that is not written. On every step would be worse still — a call to action
 * that is usually premature is a call to action nobody reads.
 *
 * The command is SHOWN as well as buttoned. This is a curriculum: a learner who
 * only ever sees a button learns a button, and the command is the transferable
 * half.
 */
function milestoneBlock(plan: ScratchPlan, stage: ScratchStage, step: ScratchStep): string {
	const last = stage.steps[stage.steps.length - 1];
	if (!stage.milestone || last !== step.id) {
		return '';
	}
	const m = stage.milestone;
	const settled = stage.steps.filter((id) => plan.steps[id]).length;
	return `<section class="milestone">
		<h2>Now run it</h2>
		<p class="lede">${escape(m.label)}. <span class="quiet">${markdown(m.why)}</span></p>
		<ul class="links"><li><code>${escape(m.command)}</code>${m.cwd ? `<span class="quiet"> — in ${escape(m.cwd)}</span>` : ''}</li></ul>
		<div class="actions"><button class="primary" data-act="milestone">Open a terminal — you type it</button></div>
		<p class="quiet">The ${settled} files of ${escape(stage.title)} are what this needs.</p>
	</section>`;
}

function conceptBlock(step: ScratchStep): string {
	const concept = conceptFor(step.id);
	return concept ? `<section class="concept"><h2>${escape(concept.term)}</h2><p>${markdown(concept.text)}</p></section>` : '';
}

/**
 * Why this file is here rather than later, for a step with no dependencies.
 *
 * The sentence this replaces was rendered on **all seventeen** Foundations steps
 * — *"Nothing in this project. This is a leaf: it can be written first and on
 * its own"* — and it is not an absent explanation but seventeen identical
 * claims, false for four of them. Every branch below is computed from the plan;
 * none of it is authored prose about any particular project.
 */
export function whyNow(plan: ScratchPlan, step: ScratchStep): string {
	const readers = dependents(plan, step.id);
	const order = plan.stages.flatMap((s) => s.steps);
	const here = order.indexOf(step.id);

	// 1 — the root of its own module or package. The tree below it is the reason.
	if (step.title === 'go.mod') {
		return 'Nothing — this is the root of its own Go module, so there is nothing above it to write first.';
	}
	if (step.title === 'package.json') {
		return 'Nothing — this is the root of its own npm package, so there is nothing above it to write first.';
	}

	// 2 — something already in the plan names this file. Say which, and say
	//     honestly when the plan put that reader FIRST: an ordering defect the
	//     reader has to act on is worth more than a tidy sentence.
	const after = readers.filter((id) => order.indexOf(id) > here);
	const before = readers.filter((id) => order.indexOf(id) < here);
	if (after.length) {
		const more = after.length > 1 ? ` and ${after.length - 1} other file${after.length > 2 ? 's' : ''}` : '';
		// A reader the plan put EARLIER does not stop being one. Saying only the
		// happy half here would read as "everything downstream is fine".
		const caveat = before.length
			? ` <code>${escape(before[0])}</code> also names it and the plan put that one first — see its own page.`
			: '';
		return `Nothing. <code>${escape(after[0])}</code>${more} name${after.length > 1 ? '' : 's'} this file`
			+ ` and cannot be written until it exists, so it comes first.${caveat}`;
	}
	if (before.length) {
		return `Nothing — but <code>${escape(before[0])}</code> names this file and the plan put that one FIRST.`
			+ ' That is an ordering defect, not a cycle: write this one now and go back to it.';
	}

	// 3 — nothing reads it and nothing it needs is a file. If its neighbours are
	//     in the same position, that is the truth worth saying: the order among
	//     them is arbitrary, and pretending otherwise is what the old sentence did.
	const peers = plan.stages.find((s) => s.id === step.stage)?.steps.filter((id) => {
		const other = plan.steps[id];
		return id !== step.id && other && other.kind === step.kind
			&& other.id.slice(0, other.id.lastIndexOf('/') + 1) === step.id.slice(0, step.id.lastIndexOf('/') + 1)
			&& !other.deps.length && !other.depStages.length && !dependents(plan, id).length;
	}) ?? [];
	if (peers.length) {
		return peers.length === 1
			? `Nothing, and nothing in the project reads it. It and <code>${escape(peers[0])}</code> are independent of each other — write them in either order.`
			: `Nothing, and nothing in the project reads it. It and the other ${peers.length} files beside it here are independent — write them in any order.`;
	}

	// 4 — a person wrote the argument, because the graph has none to make. Two
	//     files in Foundations are in this position and both now carry one
	//     (`concepts.ts`); WO-79 shipped the placeholder below and this replaces it
	//     wherever the judgement has actually been written down.
	const authored = conceptFor(step.id)?.order;
	if (authored) {
		return markdown(authored);
	}

	// 5 — the honest placeholder, for a file nobody has thought about yet. A false
	//     claim is worse than admitting the graph has nothing to say.
	return 'Nothing, and nothing in the project reads it either. Where it sits in the order is a judgement'
		+ ' rather than a dependency — and nobody has written that judgement down yet.';
}

/**
 * Why this file is in the project at all, in the only terms a reader already
 * has: the routes it serves. Absent whenever flowscan has not run — a step
 * without it renders exactly as it did before annotations existed.
 */
export function routeNote(step: ScratchStep): string {
	if (!step.routes?.length) {
		return '';
	}
	const named = step.routes.map((r) => `<code>${escape(r)}</code>`).join(', ');
	const rest = (step.routeCount ?? step.routes.length) - step.routes.length;
	return `<p class="quiet">Serves ${named}${rest > 0 ? ` and ${rest} more route${rest === 1 ? '' : 's'}` : ''}.</p>`;
}

/**
 * An import cycle means SOMETHING has to come first: the plan picked one, and
 * no other plan could have done better. Say so, and say it only when it is true.
 */
export const CYCLE_NOTE = 'comes later — an import cycle, so one of the two has to be first either way';

/**
 * Not a cycle: the plan could have put this dependency first and did not. The
 * reader is the one who has to act on that, so the note says what to do rather
 * than blaming a graph.
 */
export const DEFECT_NOTE = 'comes later, and it did not have to — write it first, or expect this file\'s checks to fail until you do';

/** How many ordinary entries a list shows before it starts counting. */
const LINK_CAP = 12;

const KIND_LABEL: Record<string, string> = {
	go: 'Go', gotest: 'Go test', ts: 'TypeScript', tsx: 'React component',
	style: 'stylesheet', sql: 'migration', manifest: 'manifest', lock: 'lockfile', doc: 'document', other: 'file',
};

function stateChip(state: StepState): string {
	const label = state === 'done' ? 'written' : state === 'copied' ? 'copied' : state === 'writing' ? 'in progress' : 'not started';
	return `<span class="chip ${state}">${label}</span>`;
}

/**
 * A check with no result is one of TWO things, and they must not look alike.
 *
 * `runChecks` stops at the first `fail` — `go build` after a parse error tells
 * you nothing you did not already know — so after a failing run the checks below
 * it have no result at all. This used to render them with the same hollow `○` as
 * a step whose checks have never been run, which made one failure read as every
 * check failing. That is, in as many words, how a run of this feature was
 * reported: *"both checks didn't pass"*, when one had failed and the other had
 * simply never been reached.
 */
export function checksBlock(state: PageState, step: ScratchStep): string {
	const ran = !!state.checks;
	const stopped = state.checks?.results.some((r) => r.verdict === 'fail') === true;
	const rows = step.checks.map((check) => {
		const result = state.checks?.results.find((r) => r.check.label === check.label);
		// Skipped only AFTER the one that failed, never before it: the results array
		// is in check order, so anything already reported is not a skip.
		const skipped = !result && ran && stopped;
		const mark = !result ? (skipped ? '–' : '○') : result.verdict === 'pass' ? '✓' : result.verdict === 'fail' ? '✕' : '!';
		const cls = !result ? (skipped ? 'skipped' : 'idle') : result.verdict;
		const detail = result?.output ? `<pre class="out">${escape(result.output.slice(0, 4000))}</pre>`
			: skipped ? `<pre class="out">not run — an earlier check failed, so this one was never reached.</pre>` : '';
		return `<li class="${cls}"><span class="mark">${mark}</span><span class="ck">${escape(check.label)}`
			+ `${check.cmd ? `<code>${escape(check.cmd)}</code>` : ''}</span>${detail}</li>`;
	}).join('');
	return `<section><h2>When it is done</h2><ul class="checks">${rows}</ul></section>`;
}

/**
 * A list of steps you can click through to. `ofStep`, when given, is the step
 * whose list this is: its dependencies are classified against the plan's own
 * invariant pass, so anything ordered after it is labelled with the reason.
 */
export function linkList(plan: ScratchPlan, ids: readonly string[], empty: string, ofStep?: string): string {
	if (!ids.length) {
		return `<p class="quiet">${empty}</p>`;
	}
	const forward = ofStep === undefined ? undefined : forwardDeps(plan).get(ofStep);
	// A forward dependency is the one entry in this list a reader must not miss,
	// so the cap never hides one — it applies to the ordinary entries around it.
	// `frontend/src/primitives/index.ts` names 25 dependencies with its first
	// forward one at index 22, and a flat slice(0, 12) told it nothing at all.
	let budget = LINK_CAP;
	const shown = ids.filter((id) => forward?.has(id) || budget-- > 0);
	const rows = shown.map((id) => {
		const step = plan.steps[id];
		const note = forward?.has(id) ? `<span class="quiet"> — ${forward.get(id) ? CYCLE_NOTE : DEFECT_NOTE}</span>`
			: step?.declares.length ? `<span class="quiet"> — ${escape(step.declares.slice(0, 2).join(', '))}</span>` : '';
		return `<li><a data-goto="${escape(id)}">${escape(step ? step.id : id)}</a>${note}</li>`;
	}).join('');
	const hidden = ids.length - shown.length;
	return `<ul class="links">${rows}${hidden ? `<li class="quiet">…and ${hidden} more</li>` : ''}</ul>`;
}

function html(state: PageState): string {
	const { plan, progress, stepId } = state;
	const step = plan.steps[stepId];
	const stage = plan.stages.find((s) => s.id === step?.stage);
	const nonce = nonceOf();
	// style-src whitelists <style> ELEMENTS only. Every inline style="…" in the
	// body needs style-src-attr, or the geometry silently vanishes and the page
	// renders as a pile of unpositioned boxes with no error anywhere.
	const csp = `default-src 'none'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}';`;

	if (!step || !stage) {
		return `<meta http-equiv="Content-Security-Policy" content="${csp}"><p>Step not in the plan.</p>`;
	}

	const overall = overallTally(plan, progress);
	const inStage = stageTally(plan, progress, stage.id);
	const state_ = stateOf(progress, stepId);
	const settled = state_ === 'done' || state_ === 'copied';
	const unlocks = dependents(plan, stepId);
	const index = stage.steps.indexOf(stepId) + 1;

	return `<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${nonce}">
	:root { color-scheme: light dark; }
	body { margin: 0; font: var(--vscode-font-size, 13px)/1.5 var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
	.bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px; height: 32px; padding: 0 14px; background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-editorWidget-border, transparent); font-size: 11px; }
	.bar .grow { flex: 1; }
	.track { width: 120px; height: 4px; border-radius: 2px; background: var(--vscode-editorWidget-border, rgba(127,127,127,.3)); overflow: hidden; }
	.track i { display: block; height: 100%; background: var(--vscode-testing-iconPassed, #3fb950); }
	main { max-width: 760px; margin: 0 auto; padding: 26px 22px 60px; }
	h1 { font-size: 20px; margin: 0 0 2px; font-weight: 600; }
	h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--vscode-descriptionForeground); margin: 26px 0 8px; font-weight: 600; }
	.path { font-family: var(--vscode-editor-font-family); font-size: 12px; color: var(--vscode-descriptionForeground); }
	.lede { margin: 14px 0 0; font-size: 13px; }
	.quiet { color: var(--vscode-descriptionForeground); }
	.chip { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
	.chip.done { background: var(--vscode-testing-iconPassed, #3fb950); color: var(--vscode-editor-background); }
	.chiprow { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
	section { border-top: 1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.18)); }
	section:first-of-type { border-top: none; }
	code { font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
	pre.out { margin: 6px 0 0 22px; padding: 8px 10px; background: var(--vscode-textCodeBlock-background); border-radius: 4px; font-size: 11px; white-space: pre-wrap; overflow-x: auto; }
	ul { margin: 0; padding: 0; list-style: none; }
	ul.links li { padding: 3px 0; font-size: 12px; font-family: var(--vscode-editor-font-family); }
	a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
	a:hover { text-decoration: underline; }
	ul.checks li { display: grid; grid-template-columns: 22px 1fr; align-items: baseline; padding: 4px 0; font-size: 12px; }
	ul.checks li pre.out { grid-column: 2; }
	ul.checks .mark { font-size: 13px; }
	ul.checks li.pass .mark { color: var(--vscode-testing-iconPassed, #3fb950); }
	ul.checks li.fail .mark { color: var(--vscode-testing-iconFailed, #f85149); }
	ul.checks li.unavailable .mark { color: var(--vscode-editorWarning-foreground, #d29922); }
	ul.checks li.skipped { opacity: .6; }
	ul.checks li.skipped .mark { color: var(--vscode-descriptionForeground); }
	ul.checks .ck code { margin-left: 8px; }
	.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 22px; }
	button { font: inherit; font-size: 12px; padding: 5px 13px; border: none; border-radius: 4px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	button:hover { opacity: .88; }
	.tool { display: flex; gap: 10px; align-items: flex-start; padding: 9px 0; font-size: 12px; }
	.tool p { margin: 2px 0 0; }
	.decl { font-family: var(--vscode-editor-font-family); font-size: 12px; display: flex; flex-wrap: wrap; gap: 6px; }
	.decl span { background: var(--vscode-textCodeBlock-background); padding: 1px 7px; border-radius: 3px; }
	section.concept p { margin: 0; font-size: 12.5px; line-height: 1.65; color: var(--vscode-descriptionForeground); max-width: 74ch; }
	section.concept h2 { color: var(--vscode-foreground); }
</style>
<div class="bar">
	<span>Stage ${plan.stages.indexOf(stage) + 1}/${plan.stages.length} · file ${index}/${stage.steps.length}</span>
	<span class="grow"></span>
	<span class="quiet">${overall.settled}/${overall.total} files</span>
	<span class="track"><i style="width:${percent(overall)}%"></i></span>
	<span>${percent(overall)}%</span>
</div>
<main>
	<h1>${escape(step.title)}</h1>
	<div class="path">${escape(step.id)}</div>
	<div class="chiprow">
		${stateChip(state_)}
		<span class="quiet">${KIND_LABEL[step.kind] ?? step.kind} · ${step.lines} lines in the reference · ${inStage.settled}/${inStage.total} done in ${escape(stage.title)}</span>
	</div>
	<p class="lede">${instruction(step, stage)}</p>
	${conceptBlock(step)}
	${step.summary ? `<p class="quiet">The reference's own note: ${escape(step.summary.slice(0, 400))}</p>` : ''}
	${step.note ? `<p class="lede">${markdown(step.note).replace(/\n\n/g, '</p><p class="quiet">')}</p>` : ''}
	${routeNote(step)}
	${derivedBlock(step)}

	<section>
		<h2>What it needs</h2>
		${linkList(plan, step.deps, step.depStages.length
		? `Nothing file-by-file. It imports ${step.depStages.slice(0, 4).map((d) => `<code>${escape(d)}</code>`).join(', ')} — packages you have already written.`
		: whyNow(plan, step),
		stepId)}
	</section>

	${step.declares.length ? `<section><h2>What it declares</h2><div class="decl">${step.declares.map((d) => `<span>${escape(d)}</span>`).join('')}</div></section>` : ''}

	${checksBlock(state, step)}

	<section>
		<h2>What it unlocks</h2>
		${linkList(plan, unlocks, unlocksAll(plan, step)
		|| 'Nothing else in the project names this file. Finishing it unblocks nothing — which is a fact about the graph, not about whether it matters.')}
	</section>

	${stage.tools.length ? `<section><h2>Tools this stage lights up</h2>${stage.tools.map((t) => `
		<div class="tool"><button data-tool="${escape(t.command)}">${escape(t.label)}</button><p class="quiet">${escape(t.why)}</p></div>`).join('')}</section>` : ''}

	${milestoneBlock(plan, stage, step)}

	${stage.setup.length ? `<section><h2>Run once</h2><p class="quiet">${stage.setupWhy
			? markdown(stage.setupWhy)
			: stage.checks.length
				? `Before this stage's checks can pass:`
				: `Once the manifests in this stage exist, these install what they name. Nothing in ${escape(stage.title)}
			   is checked against them — the first <code>go build</code> and the first <code>npm run</code> further down are:`}</p>
		<ul class="links">${stage.setup.map((s) => `<li><code>${escape(s)}</code></li>`).join('')}</ul>
		<div class="actions"><button data-act="setup">Open a terminal — you type these</button></div></section>` : ''}

	<div class="actions">
		${step.mode === 'generate'
		? `<button class="primary" data-act="terminal">Open a terminal in ${escape(step.commandCwd || '.')}</button>`
		: `<button class="primary" data-act="open">Open the file</button>`}
		<button data-act="check"${state.running ? ' disabled' : ''}>${state.running ? 'Checking…' : 'Run the checks'}</button>
		<button data-act="reference">Show the reference</button>
		${step.mode === 'copy' || !settled ? `<button data-act="copy">Copy the reference in</button>` : ''}
		${settled ? `<button data-act="undone">Reopen this step</button>` : `<button data-act="done">Mark written</button>`}
		<button data-act="next">Next file →</button>
	</div>
</main>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	// WO-60: which step this tab is on, and how far down it you had read. The
	// plan and your progress are on disk in the scratch folder — the page holds
	// a pointer into them, never a copy.
	// The scroll slot is per STEP. A single global slot restored the PREVIOUS
	// step's offset on every switch — a wart the tab-follow listener would have
	// turned from occasional into constant.
	const stepId = ${JSON.stringify(state.stepId)};
	const saved = vscode.getState() || {};
	const restoreScroll = saved.stepId === stepId ? (saved.scroll || 0) : 0;
	vscode.setState({ stepId, scroll: restoreScroll });
	if (restoreScroll) { window.scrollTo(0, restoreScroll); }
	let scrollTimer;
	window.addEventListener('scroll', () => {
		clearTimeout(scrollTimer);
		scrollTimer = setTimeout(() => vscode.setState({ stepId, scroll: window.scrollY }), 200);
	});
	document.addEventListener('click', (e) => {
		const act = e.target.closest('[data-act]');
		if (act) { vscode.postMessage({ type: act.dataset.act }); return; }
		const tool = e.target.closest('[data-tool]');
		if (tool) { vscode.postMessage({ type: 'tool', command: tool.dataset.tool }); return; }
		const goto = e.target.closest('[data-goto]');
		if (goto) { vscode.postMessage({ type: 'goto', id: goto.dataset.goto }); }
	});
	document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { vscode.postMessage({ type: 'exitFocus' }); } });
</script>`;
}
