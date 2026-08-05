/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { Event, EventEmitter, ThemeColor, ThemeIcon, TreeDataProvider, TreeItem, TreeItemCollapsibleState } from 'vscode';
import { ModuleGroup, LineProgress, moduleProgress, modulesOf, stageNeeds, stageProgress, stageStatus } from './journey';
import { ScratchPlan, ScratchStage } from './planModel';
import { Progress, stateOf } from './progressModel';

// The **Scratch** view: the journey surface (WO-86 R81).
//
// Three levels, because a person's session has three: the module they are in,
// the stage they are on, and the file in front of them. The flat list this
// replaces put 477 stages at the top level, which is a scrollbar rather than a
// map — merkle's `.claude` alone is 69 of them, and finding the frontend meant
// knowing it starts somewhere after stage 300.
//
// Why the tree and not a webview map: 477 stages inside 12 modules is 12 rows
// until you open one, the workbench virtualizes the rest, and reveal/expand
// already work. A webview would have to reimplement all of that to arrive at
// something slower — and it would want the aux bar, which is WO-3 Option C's
// decision to make and not this one's.
//
// It follows the view contract (docs/plans/02): one purpose — where am I and
// what is next — and one primary action, clicking the next file. Only the branch
// you are working in is expanded; everything else stays shut, because a tree
// that opens forty-five packages at once is a wall, not an index.

type Node =
	| { readonly kind: 'module'; readonly group: ModuleGroup }
	| { readonly kind: 'stage'; readonly stage: ScratchStage; readonly index: number }
	| { readonly kind: 'step'; readonly id: string };

/** The directory a step lives in — `.` at the project root, where `slice(0, -1)`
 *  would otherwise turn `package-lock.json` into `package-lock.jso`. */
function dirOf(stepId: string): string {
	const slash = stepId.lastIndexOf('/');
	return slash < 0 ? '.' : stepId.slice(0, slash);
}

/** Progress as R82 denominates it, in the words the rest of the product uses. */
function lineLabel(p: LineProgress): string {
	return p.linesDone === p.lines ? `✓ ${p.lines.toLocaleString()} lines` : `${p.percent}% · ${p.linesDone.toLocaleString()}/${p.lines.toLocaleString()} lines`;
}

export class StepsProvider implements TreeDataProvider<Node> {

	public static readonly viewId = 'burrowScratchSteps';

	private readonly changed = new EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData: Event<Node | undefined> = this.changed.event;

	private groups: readonly ModuleGroup[];

	constructor(private plan: ScratchPlan, private progress: Progress) {
		this.groups = modulesOf(plan);
	}

	update(plan: ScratchPlan, progress: Progress): void {
		this.spreadCache.clear();
		this.plan = plan;
		this.progress = progress;
		this.groups = modulesOf(plan);
		this.changed.fire(undefined);
	}

	/** The node to reveal on open — the step the developer is on. */
	find(stepId: string): Node | undefined {
		return this.plan.steps[stepId] ? { kind: 'step', id: stepId } : undefined;
	}

	/** Three levels means `reveal` needs the whole chain, not just one hop. */
	getParent(node: Node): Node | undefined {
		if (node.kind === 'step') {
			const stageId = this.plan.steps[node.id]?.stage;
			const index = this.plan.stages.findIndex((s) => s.id === stageId);
			return index < 0 ? undefined : { kind: 'stage', stage: this.plan.stages[index], index };
		}
		if (node.kind === 'stage') {
			const group = this.groups.find((g) => g.stages.includes(node.stage.id));
			return group ? { kind: 'module', group } : undefined;
		}
		return undefined;
	}

	getTreeItem(node: Node): TreeItem {
		return node.kind === 'module' ? this.moduleItem(node.group)
			: node.kind === 'stage' ? this.stageItem(node.stage, node.index)
				: this.stepItem(node.id);
	}

	getChildren(node?: Node): Node[] {
		if (!node) {
			return this.groups.map((group): Node => ({ kind: 'module', group }));
		}
		if (node.kind === 'module') {
			return node.group.stages.map((id): Node => {
				const index = this.plan.stages.findIndex((s) => s.id === id);
				return { kind: 'stage', stage: this.plan.stages[index], index };
			});
		}
		return node.kind === 'stage' ? node.stage.steps.map((id): Node => ({ kind: 'step', id })) : [];
	}

	private currentStage(): string | undefined {
		return this.progress.current ? this.plan.steps[this.progress.current]?.stage : undefined;
	}

	private moduleItem(group: ModuleGroup): TreeItem {
		const p = moduleProgress(this.plan, this.progress, group);
		const holdsCurrent = group.stages.includes(this.currentStage() ?? '');
		const item = new TreeItem(
			group.title,
			holdsCurrent ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed,
		);
		item.id = `module:${group.id}`;
		item.description = `${lineLabel(p)} · ${group.stages.length} stage${group.stages.length === 1 ? '' : 's'}`;
		item.iconPath = new ThemeIcon(
			p.linesDone === p.lines ? 'pass-filled' : holdsCurrent ? 'circle-large-filled' : 'circle-large-outline',
			new ThemeColor(p.linesDone === p.lines ? 'testing.iconPassed' : 'descriptionForeground'),
		);
		item.tooltip = `${group.stages.length} stages · ${p.steps.toLocaleString()} files · ${p.lines.toLocaleString()} lines in the reference`;
		item.contextValue = 'burrowScratchModule';
		return item;
	}

	private stageItem(stage: ScratchStage, index: number): TreeItem {
		const p = stageProgress(this.plan, this.progress, stage.id);
		const status = stageStatus(this.plan, this.progress, stage.id);
		const item = new TreeItem(
			`${index + 1}. ${stage.title}`,
			status === 'current' ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed,
		);
		item.id = `stage:${stage.id}`;
		// Lines lead, files follow. "4/134 files" was the whole of what this said,
		// and 134 migrations averaging 40 lines against one 1,004-line component
		// tick the bar identically under it.
		item.description = status === 'done' ? `✓ ${p.steps} file${p.steps === 1 ? '' : 's'}`
			: `${lineLabel(p)} · ${p.stepsDone}/${p.steps}`;
		item.iconPath = new ThemeIcon(
			status === 'done' ? 'pass-filled'
				: status === 'current' ? 'arrow-right'
					: status === 'blocked' ? 'circle-outline' : 'circle-large-outline',
			new ThemeColor(status === 'done' ? 'testing.iconPassed'
				: status === 'current' ? 'testing.iconQueued' : 'descriptionForeground'),
		);
		const unmet = status === 'blocked' ? stageNeeds(this.plan, stage.id).length : 0;
		item.tooltip = status === 'blocked'
			? `${stage.blurb}\n\nNot yet: ${unmet} stage${unmet === 1 ? '' : 's'} it imports are unfinished. Nothing stops you opening it — the plan's order is the guarantee, and this is the map saying so.`
			: stage.blurb;
		item.contextValue = 'burrowScratchStage';
		// Opening a stage is opening its own page, not its first file: what it
		// builds and what needs it is the question you have on arriving.
		item.command = { command: 'burrow.scratch.stagePage', title: 'Open this stage', arguments: [stage.id] };
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
