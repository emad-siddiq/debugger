/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, ViewColumn, WebviewPanel, commands, window } from 'vscode';
import { CheckRun } from './checks';
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
	| { readonly type: 'open' | 'reference' | 'copy' | 'done' | 'undone' | 'next' | 'check' | 'setup' | 'exitFocus' }
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
		return `Run <code>${escape(step.command ?? '')}</code>${step.commandCwd ? ` in <code>${escape(step.commandCwd)}</code>` : ''}. `
			+ `A ${step.title} is written by the toolchain — the check runs the command and then looks for the file.`;
	}
	if (step.mode === 'copy') {
		return step.kind === 'doc'
			? `Copy this one in. It is prose, not code — reading it is the point, and typing it out is not.`
			: `Copy this one in. A ${step.title} is generated by the toolchain — typing it would teach you nothing and get it wrong.`;
	}
	const size = step.lines < 40 ? 'a short file' : step.lines < 200 ? `about ${Math.round(step.lines / 10) * 10} lines` : `a long one — ${step.lines} lines`;
	// The exports sentence belongs to code and nothing else. A go.mod does not
	// "export nothing — it is wiring": it is a manifest, and saying otherwise
	// made the page sound like it had not read the file.
	const isCode = step.kind === 'go' || step.kind === 'gotest' || step.kind === 'ts' || step.kind === 'tsx';
	const what = !isCode ? (step.kind === 'sql' ? ' It runs in order with the other migrations beside it.' : '')
		: step.declares.length
			? ` It declares ${step.declares.slice(0, 3).map((d) => `\`${escape(d)}\``).join(', ')}${step.declares.length > 3 ? ` and ${step.declares.length - 3} more` : ''}.`
			: ' It exports nothing — it is wiring, or a file whose work is all internal.';
	return `Write \`${escape(step.id)}\` in ${escape(stage.title)}: ${size}.${what}`;
}

/**
 * A manifest has no import edges and so no dependents in the graph, but calling
 * that "nothing depends on this" about a `go.mod` is exactly backwards — its
 * whole tree does. Count the tree instead.
 */
function unlocksAll(plan: ScratchPlan, step: ScratchStep): string {
	if (step.kind !== 'manifest' && step.kind !== 'lock') {
		return '';
	}
	const slash = step.id.lastIndexOf('/');
	const dir = slash < 0 ? '' : step.id.slice(0, slash + 1);
	const under = Object.keys(plan.steps).filter((id) => id !== step.id && id.startsWith(dir)).length;
	return under
		? `Everything under <code>${escape(dir || './')}</code> — ${under} files resolve through it. It has no imports of its own, so the graph shows no single dependent.`
		: '';
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

function checksBlock(state: PageState, step: ScratchStep): string {
	const rows = step.checks.map((check) => {
		const result = state.checks?.results.find((r) => r.check.label === check.label);
		const mark = !result ? '○' : result.verdict === 'pass' ? '✓' : result.verdict === 'fail' ? '✕' : '!';
		const cls = !result ? 'idle' : result.verdict;
		const detail = result?.output ? `<pre class="out">${escape(result.output.slice(0, 4000))}</pre>` : '';
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
	ul.checks .ck code { margin-left: 8px; }
	.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 22px; }
	button { font: inherit; font-size: 12px; padding: 5px 13px; border: none; border-radius: 4px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	button:hover { opacity: .88; }
	.tool { display: flex; gap: 10px; align-items: flex-start; padding: 9px 0; font-size: 12px; }
	.tool p { margin: 2px 0 0; }
	.decl { font-family: var(--vscode-editor-font-family); font-size: 12px; display: flex; flex-wrap: wrap; gap: 6px; }
	.decl span { background: var(--vscode-textCodeBlock-background); padding: 1px 7px; border-radius: 3px; }
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
	${step.summary ? `<p class="quiet">The reference's own note: ${escape(step.summary.slice(0, 400))}</p>` : ''}
	${routeNote(step)}

	<section>
		<h2>What it needs</h2>
		${linkList(plan, step.deps, step.depStages.length
		? `Nothing file-by-file. It imports ${step.depStages.slice(0, 4).map((d) => `<code>${escape(d)}</code>`).join(', ')} — packages you have already written.`
		: 'Nothing in this project. This is a leaf: it can be written first and on its own.',
		stepId)}
	</section>

	${step.declares.length ? `<section><h2>What it declares</h2><div class="decl">${step.declares.map((d) => `<span>${escape(d)}</span>`).join('')}</div></section>` : ''}

	${checksBlock(state, step)}

	<section>
		<h2>What it unlocks</h2>
		${linkList(plan, unlocks, unlocksAll(plan, step)
		|| 'Nothing yet depends on this — it is a leaf of the graph, or the last thing written.')}
	</section>

	${stage.tools.length ? `<section><h2>Tools this stage lights up</h2>${stage.tools.map((t) => `
		<div class="tool"><button data-tool="${escape(t.command)}">${escape(t.label)}</button><p class="quiet">${escape(t.why)}</p></div>`).join('')}</section>` : ''}

	${stage.setup.length ? `<section><h2>Run once</h2><p class="quiet">Before this stage's checks can pass:</p>
		<ul class="links">${stage.setup.map((s) => `<li><code>${escape(s)}</code></li>`).join('')}</ul>
		<div class="actions"><button data-act="setup">Run these in a terminal</button></div></section>` : ''}

	<div class="actions">
		<button class="primary" data-act="open">Open the file</button>
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
	vscode.setState({ stepId: ${JSON.stringify(state.stepId)}, scroll: (vscode.getState() || {}).scroll || 0 });
	const restoreScroll = (vscode.getState() || {}).scroll || 0;
	if (restoreScroll) { window.scrollTo(0, restoreScroll); }
	let scrollTimer;
	window.addEventListener('scroll', () => {
		clearTimeout(scrollTimer);
		scrollTimer = setTimeout(() => vscode.setState({ stepId: ${JSON.stringify(state.stepId)}, scroll: window.scrollY }), 200);
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
