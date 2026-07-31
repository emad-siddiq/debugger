/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { Event, EventEmitter, ThemeColor, ThemeIcon, TreeDataProvider, TreeItem, TreeItemCollapsibleState } from 'vscode';
import { ScratchPlan, ScratchStage } from './planModel';
import { Progress, stageState, stageTally, stateOf } from './progressModel';

// The **Scratch** view: the whole project as an ordered list of stages, and the
// files inside the one you are on.
//
// It follows the view contract (docs/plans/02): one purpose — where am I and
// what is next — and one primary action, which is clicking the next file. The
// stage you are working in is the only one expanded; finished stages collapse
// behind a tick, and stages you have not reached stay shut. A tree that opens
// forty-five packages at once is a wall, not an index.

type Node =
	| { readonly kind: 'stage'; readonly stage: ScratchStage; readonly index: number }
	| { readonly kind: 'step'; readonly id: string };

/** The directory a step lives in — `.` at the project root, where `slice(0, -1)`
 *  would otherwise turn `package-lock.json` into `package-lock.jso`. */
function dirOf(stepId: string): string {
	const slash = stepId.lastIndexOf('/');
	return slash < 0 ? '.' : stepId.slice(0, slash);
}

export class StepsProvider implements TreeDataProvider<Node> {

	public static readonly viewId = 'burrowScratchSteps';

	private readonly changed = new EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData: Event<Node | undefined> = this.changed.event;

	constructor(private plan: ScratchPlan, private progress: Progress) { }

	update(plan: ScratchPlan, progress: Progress): void {
		this.spreadCache.clear();
		this.plan = plan;
		this.progress = progress;
		this.changed.fire(undefined);
	}

	/** The node to reveal on open — the step the developer is on. */
	find(stepId: string): Node | undefined {
		return this.plan.steps[stepId] ? { kind: 'step', id: stepId } : undefined;
	}

	getParent(node: Node): Node | undefined {
		if (node.kind === 'step') {
			const stageId = this.plan.steps[node.id]?.stage;
			const index = this.plan.stages.findIndex((s) => s.id === stageId);
			return index < 0 ? undefined : { kind: 'stage', stage: this.plan.stages[index], index };
		}
		return undefined;
	}

	getTreeItem(node: Node): TreeItem {
		return node.kind === 'stage' ? this.stageItem(node.stage, node.index) : this.stepItem(node.id);
	}

	getChildren(node?: Node): Node[] {
		if (!node) {
			return this.plan.stages.map((stage, index): Node => ({ kind: 'stage', stage, index }));
		}
		return node.kind === 'stage' ? node.stage.steps.map((id): Node => ({ kind: 'step', id })) : [];
	}

	private stageItem(stage: ScratchStage, index: number): TreeItem {
		const tally = stageTally(this.plan, this.progress, stage.id);
		const state = stageState(tally);
		const current = this.progress.current && this.plan.steps[this.progress.current]?.stage === stage.id;
		const item = new TreeItem(
			`${index + 1}. ${stage.title}`,
			state === 'finished' ? TreeItemCollapsibleState.Collapsed
				: current || state === 'open' ? TreeItemCollapsibleState.Expanded
					: TreeItemCollapsibleState.Collapsed,
		);
		item.id = `stage:${stage.id}`;
		// `unproven` gets a warning mark and says how many, never the tick. Every
		// file is written and something that was meant to prove it did not run —
		// which is a different fact from finished, and the one the old two-state
		// tally could not hold.
		item.description = state === 'finished' ? `✓ ${tally.total}`
			: state === 'unproven' ? `${tally.total} written · ${tally.unproven} unproven`
				: `${tally.settled}/${tally.total}`;
		item.iconPath = new ThemeIcon(
			state === 'finished' ? 'pass-filled' : state === 'unproven' ? 'warning'
				: state === 'open' ? 'circle-large-outline' : 'circle-outline',
			new ThemeColor(state === 'finished' ? 'testing.iconPassed'
				: state === 'unproven' ? 'testing.iconUnset' : 'descriptionForeground'),
		);
		item.tooltip = state === 'unproven'
			? `${stage.blurb}\n\n⚠︎ ${tally.unproven} file(s) here are written but unproven — a check that was supposed to run did not.`
			: stage.blurb;
		item.contextValue = 'burrowScratchStage';
		return item;
	}

	/** Stages whose files come from more than one directory — Foundations lists
	 *  three `go.mod`s and four `tsconfig.json`s, and a bare basename there is
	 *  not a name at all. Package stages have one directory and need no prefix. */
	private spread(stageId: string): boolean {
		let cached = this.spreadCache.get(stageId);
		if (cached === undefined) {
			const stage = this.plan.stages.find((s) => s.id === stageId);
			cached = new Set((stage?.steps ?? []).map(dirOf)).size > 1;
			this.spreadCache.set(stageId, cached);
		}
		return cached;
	}

	private readonly spreadCache = new Map<string, boolean>();

	private stepItem(id: string): TreeItem {
		const step = this.plan.steps[id];
		const state = stateOf(this.progress, id);
		const item = new TreeItem(step?.title ?? id, TreeItemCollapsibleState.None);
		item.id = `step:${id}`;
		const where = step && this.spread(step.stage) ? `${dirOf(id)} · ` : '';
		item.description = state === 'done' ? `${where}✓`
			: state === 'copied' ? `${where}copied`
				: state === 'writing' ? `${where}in progress`
					: `${where}${step?.lines ?? 0} lines`;
		item.iconPath = new ThemeIcon(
			state === 'done' ? 'pass-filled'
				: state === 'copied' ? 'files'
					: state === 'writing' ? 'edit'
						: id === this.progress.current ? 'arrow-right' : 'circle-outline',
			new ThemeColor(state === 'done' ? 'testing.iconPassed' : 'descriptionForeground'),
		);
		item.tooltip = `${id}${step?.summary ? `\n\n${step.summary}` : ''}`;
		item.contextValue = state === 'done' ? 'burrowScratchStepDone' : 'burrowScratchStep';
		item.command = { command: 'burrow.scratch.goto', title: 'Open this step', arguments: [id] };
		return item;
	}
}
