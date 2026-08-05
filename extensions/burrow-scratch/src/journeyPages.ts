/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// journeyPages.ts — the two pages that are about the journey rather than a file:
// the front door, and a stage's own entry.
//
// EVERY SENTENCE IS GENERATED. Not "mostly", and not "the figures are": the
// clause that names what a stage builds, the clause that names what needs it,
// the size of the thing you are about to start — all of it is computed from the
// plan, because a hand-written paragraph about a project Burrow has never seen
// is the shape of claim this whole feature exists to stop making. The one
// exception is prose about Burrow itself (what a scratch build IS), which is
// about Burrow and not about anybody's repository.
//
// No `vscode` import: unit-tested standalone (test/journeyPages.test.js).

import { LineProgress, ModuleGroup, lineProgress, moduleProgress, modulesOf, stageNeeds, stageProgress, stageStatus } from './journey';
import { ScratchPlan, ScratchStage, StepKind, dependents } from './planModel';
import { Progress, isSettled, stateOf } from './progressModel';

export function escape(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The lab family's visual rules (docs/plans/04 §6), for the two journey pages:
 * theme tokens only, a quiet inset stage, no colour that is not a state.
 *
 * The CSP is part of it. `style-src-attr` is whitelisted because the progress
 * bar's width is an inline `style="…"` and a nonce-only `style-src` drops every
 * one of those silently — a page that renders as unpositioned boxes with nothing
 * in any console.
 */
export function journeyStyle(nonce: string): string {
	const csp = `default-src 'none'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}';`;
	return `<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${nonce}">
	:root { color-scheme: light dark; }
	body { margin: 0; font: var(--vscode-font-size, 13px)/1.5 var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
	main { max-width: 760px; margin: 0 auto; padding: 30px 22px 60px; }
	h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
	h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--vscode-descriptionForeground); margin: 26px 0 8px; font-weight: 600; }
	.lede { margin: 12px 0 0; font-size: 13px; }
	.quiet { color: var(--vscode-descriptionForeground); }
	section { border-top: 1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.18)); }
	section:first-of-type { border-top: none; }
	code { font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
	a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
	a:hover { text-decoration: underline; }
	ul { margin: 8px 0 0; padding: 0; list-style: none; }
	ul.links li, ul.steps li { padding: 3px 0; font-size: 12px; font-family: var(--vscode-editor-font-family); }
	ul.steps .mark { display: inline-block; width: 18px; color: var(--vscode-descriptionForeground); }
	ul.steps li.done .mark, ul.steps li.copied .mark, ul.steps li.pass .mark { color: var(--vscode-testing-iconPassed, #3fb950); }
	ul.steps li.fail .mark { color: var(--vscode-testing-iconFailed, #f85149); }
	ul.steps li.unavailable .mark { color: var(--vscode-editorWarning-foreground, #d29922); }
	ul.steps pre.out { margin: 4px 0 0 18px; padding: 6px 9px; background: var(--vscode-textCodeBlock-background); border-radius: 4px; font-size: 11px; white-space: pre-wrap; }
	table { border-collapse: collapse; margin-top: 12px; font-size: 12px; }
	th, td { text-align: left; padding: 3px 18px 3px 0; }
	th { font-weight: 600; color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
	td.n, th.n { text-align: right; font-family: var(--vscode-editor-font-family); }
	.track { width: 100%; max-width: 340px; height: 4px; border-radius: 2px; margin-top: 10px; background: var(--vscode-editorWidget-border, rgba(127,127,127,.3)); overflow: hidden; }
	.track i { display: block; height: 100%; background: var(--vscode-testing-iconPassed, #3fb950); }
	.chip { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
	.chip.current { background: var(--vscode-testing-iconQueued, #d29922); color: var(--vscode-editor-background); }
	.chip.done { background: var(--vscode-testing-iconPassed, #3fb950); color: var(--vscode-editor-background); }
	.chiprow { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
	.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 26px; }
	button { font: inherit; font-size: 12px; padding: 5px 13px; border: none; border-radius: 4px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	button:hover { opacity: .88; }
	button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
</style>`;
}

/** The click delegation both journey pages use. Same contract as the step page:
 *  the webview posts, the extension host decides. */
export function journeyScript(nonce: string): string {
	return `<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	document.addEventListener('click', (e) => {
		const act = e.target.closest('[data-act]');
		if (act) { vscode.postMessage({ type: act.dataset.act }); return; }
		const goto = e.target.closest('[data-goto]');
		if (goto) { vscode.postMessage({ type: 'goto', id: goto.dataset.goto }); return; }
		const stage = e.target.closest('[data-stage]');
		if (stage) { vscode.postMessage({ type: 'stage', id: stage.dataset.stage }); }
	});
</script>`;
}

const KIND_PLURAL: Record<StepKind, string> = {
	go: 'Go file', gotest: 'Go test', ts: 'TypeScript file', tsx: 'React component',
	style: 'stylesheet', sql: 'migration', manifest: 'manifest', lock: 'lockfile',
	doc: 'document', other: 'file',
};

/** `3 migrations, 1 Go file` — the composition of a set of steps, in the words
 *  the step pages already use, and never a bare count of "files". */
export function composition(plan: ScratchPlan, stepIds: readonly string[]): string {
	const counts = new Map<StepKind, number>();
	for (const id of stepIds) {
		const kind = plan.steps[id]?.kind;
		if (kind) {
			counts.set(kind, (counts.get(kind) ?? 0) + 1);
		}
	}
	const parts = [...counts].sort((a, b) => b[1] - a[1])
		.map(([kind, n]) => `${n} ${KIND_PLURAL[kind]}${n === 1 ? '' : 's'}`);
	return parts.length <= 1 ? (parts[0] ?? 'nothing') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** `1,004 lines` / `8 lines` — always the reference's own count (R82). */
function lines(n: number): string {
	return `${n.toLocaleString()} line${n === 1 ? '' : 's'}`;
}

function bar(p: LineProgress, id = ''): string {
	return `<div class="track"${id ? ` id="${id}"` : ''}><i style="width:${p.percent}%"></i></div>`;
}

// ---------------------------------------------------------------------------
// The front door
// ---------------------------------------------------------------------------

/**
 * What a scratch build is, how big this one is, and where it ends.
 *
 * The size is stated before anything is created, because 279,257 lines is a
 * decision and finding it out on step 900 is finding it out too late. It is also
 * the first honest thing the product can say: every figure below came from
 * reading the reference a moment ago, and the sentence about the produced tree
 * is a fact about the checks rather than a promise about the reader.
 */
export function frontDoorHtml(plan: ScratchPlan, style: string): string {
	const groups = modulesOf(plan);
	const all = plan.stages.flatMap((s) => [...s.steps]);
	const total = all.reduce((n, id) => n + (plan.steps[id]?.lines ?? 0), 0);
	const modes = { write: 0, copy: 0, generate: 0 };
	for (const id of all) {
		const mode = plan.steps[id]?.mode;
		if (mode) {
			modes[mode]++;
		}
	}
	const last = plan.stages[plan.stages.length - 1];
	const rows = groups.map((g) => {
		const p = moduleProgress(plan, { version: 1, steps: {}, startedAt: '', updatedAt: '' }, g);
		return `<tr><td>${escape(g.title)}</td><td class="n">${g.stages.length}</td><td class="n">${p.steps.toLocaleString()}</td><td class="n">${p.lines.toLocaleString()}</td></tr>`;
	}).join('');

	return `${style}
<main>
	<h1>Rebuild ${escape(plan.name)} by hand</h1>
	<p class="lede">Burrow read ${escape(plan.name)} and worked out an order in which it can be written from
	nothing: no file is asked for before the things it imports exist. You type the code; the reference
	stays one click away rather than beside you.</p>

	<section>
		<h2>How big it is</h2>
		<p class="lede"><strong>${total.toLocaleString()} lines</strong> across
		<strong>${all.length.toLocaleString()} files</strong>, in
		<strong>${plan.stages.length} stages</strong> and ${groups.length} modules.</p>
		<p class="quiet">${modes.write.toLocaleString()} of those files you type,
		${modes.copy.toLocaleString()} are prose and diagrams you read and copy in, and
		${modes.generate} are written by a toolchain from a command you run.</p>
		<table>
			<thead><tr><th>module</th><th class="n">stages</th><th class="n">files</th><th class="n">lines</th></tr></thead>
			<tbody>${rows}</tbody>
		</table>
	</section>

	<section>
		<h2>Where it ends</h2>
		<p class="lede">At stage ${plan.stages.length}, <code>${escape(last?.title ?? '')}</code>.</p>
		<p class="quiet">The produced tree builds — <code>go build ./...</code> and <code>npm run build</code>
		are among the checks the plan runs, not a promise made here. Every file carries its own check, and a
		check that cannot fail on wrong content is not shipped as one.</p>
	</section>

	<div class="actions">
		<button class="primary" data-act="start">Choose where it lives →</button>
		<button data-act="cancel">Not now</button>
	</div>
</main>`;
}

// ---------------------------------------------------------------------------
// A stage's own entry
// ---------------------------------------------------------------------------

/** The stages that import this one, via any of its steps. Stage ids, deduped. */
export function stageDependents(plan: ScratchPlan, stageId: string): readonly string[] {
	const stage = plan.stages.find((s) => s.id === stageId);
	const out = new Set<string>();
	for (const id of stage?.steps ?? []) {
		for (const reader of dependents(plan, id)) {
			const owner = plan.steps[reader]?.stage;
			if (owner && owner !== stageId) {
				out.add(owner);
			}
		}
	}
	return [...out];
}

/**
 * What this stage builds, and what downstream needs it.
 *
 * The second half is the one a reader cannot get anywhere else. "You are about
 * to write four files" is visible from the tree; "eleven stages further on
 * import this one, and the first is the router" is the answer to *why am I
 * doing this now*, and it is a fact the plan already holds.
 */
/** One file's verdict after a stage-wide materialize — R83 keeps the checks per
 *  file, so the report is per file too. */
export interface CopyResult {
	readonly id: string;
	readonly verdict: 'pass' | 'fail' | 'unavailable';
	readonly output: string;
}

/**
 * The report a bulk copy leaves behind.
 *
 * Per file, and the failures first. "624 files copied" is the sentence that
 * makes a bulk action feel like a cheat; "624 copied, 624 byte-identical to the
 * reference, and here are the three that are not" is the same action with its
 * verdict still attached.
 */
export function copyReport(results: readonly CopyResult[]): string {
	if (!results.length) {
		return '';
	}
	const bad = results.filter((r) => r.verdict !== 'pass');
	const rows = [...bad, ...results.filter((r) => r.verdict === 'pass')].slice(0, 60).map((r) =>
		`<li class="${r.verdict}"><span class="mark">${r.verdict === 'pass' ? '✓' : r.verdict === 'fail' ? '✕' : '!'}</span>`
		+ `<a data-goto="${escape(r.id)}">${escape(r.id)}</a>`
		+ `${r.output ? `<pre class="out">${escape(r.output.slice(0, 600))}</pre>` : ''}</li>`).join('');
	return `<section>
		<h2>What came in</h2>
		<p class="lede">${results.length} file${results.length === 1 ? '' : 's'} copied · ${results.length - bad.length} byte-identical to the reference${bad.length ? ` · <strong>${bad.length} not</strong>` : ''}.</p>
		<ul class="steps">${rows}${results.length > 60 ? `<li class="quiet">…and ${results.length - 60} more</li>` : ''}</ul>
	</section>`;
}

export function stagePageHtml(plan: ScratchPlan, progress: Progress, stageId: string, style: string, results: readonly CopyResult[] = []): string {
	const index = plan.stages.findIndex((s) => s.id === stageId);
	const stage = plan.stages[index];
	if (!stage) {
		return `${style}<main><p>That stage is not in the plan.</p></main>`;
	}
	const p = stageProgress(plan, progress, stageId);
	const status = stageStatus(plan, progress, stageId);
	const readers = stageDependents(plan, stageId);
	const needs = stageNeeds(plan, stageId);
	const unmet = needs.filter((id) => {
		const other = plan.stages.find((s) => s.id === id);
		return !other || !other.steps.every((step) => isSettled(stateOf(progress, step)));
	});
	const copies = stage.steps.filter((id) => plan.steps[id]?.mode === 'copy');
	const copyLines = copies.reduce((n, id) => n + (plan.steps[id]?.lines ?? 0), 0);

	const stepRows = stage.steps.map((id) => {
		const step = plan.steps[id];
		const state = stateOf(progress, id);
		const mark = state === 'done' ? '✓' : state === 'copied' ? '⧉' : state === 'writing' ? '·' : '○';
		return `<li class="${state}"><span class="mark">${mark}</span>`
			+ `<a data-goto="${escape(id)}">${escape(step?.title ?? id)}</a>`
			+ `<span class="quiet"> — ${escape(KIND_PLURAL[step?.kind ?? 'other'])}, ${lines(step?.lines ?? 0)}</span></li>`;
	}).join('');

	const readerRows = readers.slice(0, 8).map((id) => {
		const other = plan.stages.find((s) => s.id === id);
		const at = plan.stages.findIndex((s) => s.id === id) + 1;
		return `<li><a data-stage="${escape(id)}">${escape(other?.title ?? id)}</a><span class="quiet"> — stage ${at}</span></li>`;
	}).join('');

	// Generated, every clause of it. `readers.length` is the count of stages the
	// import graph says will not compile without this one; naming the nearest is
	// what makes the number checkable rather than merely large.
	const why = readers.length
		? `${readers.length} later stage${readers.length === 1 ? '' : 's'} import${readers.length === 1 ? 's' : ''} something written here`
		+ `${readers.length > 1 ? `, the first of them <code>${escape(plan.stages.find((s) => s.id === readers[0])?.title ?? readers[0])}</code>` : ''}.`
		: 'Nothing later in the plan imports anything written here — it is a leaf of the graph, which is a fact about the imports and not about whether it matters.';

	return `${style}
<main>
	<div class="chiprow">
		<span class="chip ${status}">${status === 'current' ? 'you are here' : status}</span>
		<span class="quiet">stage ${index + 1} of ${plan.stages.length}</span>
	</div>
	<h1>${escape(stage.title)}</h1>
	<p class="lede">${escape(stage.blurb)}</p>

	<section>
		<h2>Progress</h2>
		${bar(p)}
		<p class="quiet">${p.linesDone.toLocaleString()} of ${p.lines.toLocaleString()} lines · ${p.stepsDone} of ${p.steps} files</p>
	</section>

	<section>
		<h2>What it builds</h2>
		<p class="lede">${composition(plan, stage.steps)} — ${lines(p.lines)} in the reference.</p>
		<ul class="steps">${stepRows}</ul>
	</section>

	${copyReport(results)}

	${copies.length > 1 ? `<section>
		<h2>The ${copies.length} files here you do not type</h2>
		<p class="quiet">Prose and diagrams — ${lines(copyLines)} of reading. Bringing them in one press at a time is
		transcription, not reading, so one action does the lot and every file still gets its own check against the reference.</p>
		<div class="actions"><button class="primary" data-act="materialize">Bring in all ${copies.length} — then check each</button></div>
		<p class="quiet">If the reference has moved, nothing is written at all and this says which files it could not find.</p>
	</section>` : ''}

	<section>
		<h2>What needs it</h2>
		<p class="lede">${why}</p>
		${readerRows ? `<ul class="links">${readerRows}${readers.length > 8 ? `<li class="quiet">…and ${readers.length - 8} more</li>` : ''}</ul>` : ''}
	</section>

	<section>
		<h2>What it needs</h2>
		<p class="lede">${needs.length
			? `${needs.length} earlier stage${needs.length === 1 ? '' : 's'}${unmet.length ? `, ${unmet.length} of which ${unmet.length === 1 ? 'is' : 'are'} unfinished` : ', all of them finished'}.`
			: 'Nothing — every file here can be written from what the language gives you.'}</p>
	</section>

	<div class="actions">
		${p.stepsDone < p.steps ? `<button class="primary" data-act="enter">Start on ${escape(plan.steps[stage.steps.find((id) => !isSettled(stateOf(progress, id))) ?? stage.steps[0]]?.title ?? '')}</button>` : ''}
		<button data-act="close">Close</button>
	</div>
</main>`;
}

/** Every module, for the front door and for anything that wants the shape of the
 *  plan without walking it again. */
export function moduleSummary(plan: ScratchPlan, progress: Progress): readonly (ModuleGroup & { readonly progress: LineProgress })[] {
	return modulesOf(plan).map((g) => ({ ...g, progress: lineProgress(plan, progress, g.stages.flatMap((id) => plan.stages.find((s) => s.id === id)?.steps ?? [])) }));
}

export function stageOf(plan: ScratchPlan, stepId: string): ScratchStage | undefined {
	return plan.stages.find((s) => s.id === plan.steps[stepId]?.stage);
}
