/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// journey.ts — where you are in the rebuild, as data.
//
// The plan is a list of 2,094 steps. A person's session is not: it is a stage,
// inside a module, with a position in it (R81). Everything here answers "where
// am I and what is reachable" over that unit, and nothing here knows about the
// workbench — the tree, the pages and the offers all read from these functions
// so that one definition of "next" exists rather than three.
//
// PROGRESS IS LINES, NOT STEPS (R82). `backend/migrations/031_…sql` is eight
// lines and `frontend/src/pages/NodeDashboard/NodeDashboard.tsx` is 1,004, and a
// bar that ticks the same amount for each is telling you something that is not
// true about the afternoon you just spent. Step counts survive as a secondary
// figure, because "14 of 134 files" is a real thing to want to know — it is just
// not the measure of how far through you are.
//
// No `vscode` import: unit-tested standalone (test/journey.test.js).

import { ScratchPlan, ScratchStage } from './planModel';
import { Progress, isSettled, stateOf } from './progressModel';

/** The first path segment — the top-level thing a person calls "the backend". */
export function moduleOf(stepId: string): string {
	const slash = stepId.indexOf('/');
	return slash < 0 ? '(root)' : stepId.slice(0, slash);
}

export interface ModuleGroup {
	readonly id: string;
	readonly title: string;
	/** Stage ids, in plan order. */
	readonly stages: readonly string[];
}

/**
 * The modules of a plan, in the order their first stage appears.
 *
 * Foundations is its own group and not `backend`'s: it holds four modules' root
 * manifests, and filing it under whichever one happens to own its first step
 * would be a lie told by an implementation detail. Every other stage belongs to
 * the module most of its steps live in — package stages have exactly one, so the
 * "most" only ever decides the handful that straddle.
 */
export function modulesOf(plan: ScratchPlan): readonly ModuleGroup[] {
	const groups = new Map<string, string[]>();
	for (const stage of plan.stages) {
		const id = moduleOfStage(stage);
		const list = groups.get(id);
		if (list) {
			list.push(stage.id);
		} else {
			groups.set(id, [stage.id]);
		}
	}
	return [...groups].map(([id, stages]) => ({ id, title: id === '(foundations)' ? 'Foundations' : id, stages }));
}

export function moduleOfStage(stage: ScratchStage): string {
	if (stage.cls === 'foundations') {
		return '(foundations)';
	}
	const counts = new Map<string, number>();
	for (const id of stage.steps) {
		const m = moduleOf(id);
		counts.set(m, (counts.get(m) ?? 0) + 1);
	}
	let best = '(root)';
	let most = -1;
	for (const [m, n] of counts) {
		if (n > most) {
			best = m;
			most = n;
		}
	}
	return best;
}

/**
 * Progress the way R82 denominates it.
 *
 * `lines` counts what a `write` step asks you to type and what a `copy` step
 * asks you to read; both are the reference's own line count, because both are
 * work even though only one is typing. A `generate` step contributes its lines
 * too — the toolchain writes them, and pretending the file has no size would
 * make the bar jump on a step that took one command.
 */
export interface LineProgress {
	readonly lines: number;
	readonly linesDone: number;
	readonly steps: number;
	readonly stepsDone: number;
	readonly percent: number;
}

export function lineProgress(plan: ScratchPlan, progress: Progress, stepIds: readonly string[]): LineProgress {
	let lines = 0;
	let linesDone = 0;
	let stepsDone = 0;
	for (const id of stepIds) {
		const step = plan.steps[id];
		const n = step?.lines ?? 0;
		lines += n;
		if (isSettled(stateOf(progress, id))) {
			linesDone += n;
			stepsDone++;
		}
	}
	// Never 100% until it is, and never 0% once something is done: both roundings
	// say something false at exactly the moment a person looks for reassurance.
	const raw = lines ? (linesDone / lines) * 100 : 0;
	const percent = linesDone === lines ? 100 : linesDone === 0 ? 0 : Math.min(99, Math.max(1, Math.round(raw)));
	return { lines, linesDone, steps: stepIds.length, stepsDone, percent };
}

export function stageProgress(plan: ScratchPlan, progress: Progress, stageId: string): LineProgress {
	return lineProgress(plan, progress, plan.stages.find((s) => s.id === stageId)?.steps ?? []);
}

export function moduleProgress(plan: ScratchPlan, progress: Progress, group: ModuleGroup): LineProgress {
	return lineProgress(plan, progress, group.stages.flatMap((id) => plan.stages.find((s) => s.id === id)?.steps ?? []));
}

/**
 * The stages a stage cannot be started before.
 *
 * Two sources, both already in the plan: `depStages` (a Go package importing
 * another) and the stage that owns each file-level `deps` entry (TypeScript
 * resolves to files). A stage never needs itself.
 */
export function stageNeeds(plan: ScratchPlan, stageId: string): readonly string[] {
	const stage = plan.stages.find((s) => s.id === stageId);
	if (!stage) {
		return [];
	}
	const needs = new Set<string>();
	for (const id of stage.steps) {
		const step = plan.steps[id];
		if (!step) {
			continue;
		}
		for (const d of step.depStages) {
			needs.add(d);
		}
		for (const d of step.deps) {
			const owner = plan.steps[d]?.stage;
			if (owner) {
				needs.add(owner);
			}
		}
	}
	needs.delete(stageId);
	return [...needs];
}

/**
 * `done` — every step settled.
 * `current` — the step you are on lives here.
 * `available` — every stage it needs is done, so it can be started.
 * `blocked` — something it imports has not been written.
 *
 * `blocked` is descriptive and never enforced. The plan's own ordering is the
 * guarantee; this is here so the map can be read at a glance rather than to stop
 * anybody opening a stage they feel like opening.
 */
export type StageStatus = 'done' | 'current' | 'available' | 'blocked';

export function stageStatus(plan: ScratchPlan, progress: Progress, stageId: string): StageStatus {
	const stage = plan.stages.find((s) => s.id === stageId);
	if (!stage) {
		return 'blocked';
	}
	if (stage.steps.every((id) => isSettled(stateOf(progress, id)))) {
		return 'done';
	}
	if (progress.current && plan.steps[progress.current]?.stage === stageId) {
		return 'current';
	}
	const unmet = stageNeeds(plan, stageId).filter((need) => {
		const other = plan.stages.find((s) => s.id === need);
		return !other || !other.steps.every((id) => isSettled(stateOf(progress, id)));
	});
	return unmet.length ? 'blocked' : 'available';
}

/**
 * What a green step offers next (R85), and the only definition of it.
 *
 * The next incomplete step in the stage you are in, and only when that runs out,
 * the first step of the next stage whose needs are met. Deliberately NOT
 * `nextStep`, which walks the whole plan in order and wraps: on a plan where
 * someone has jumped ahead — clicked a stage in the map, worked in it — walking
 * from the top lands them back at the earliest unwritten file in the project,
 * hundreds of stages behind where they are. Finishing a file in stage 63 and
 * being offered a migration from stage 2 is the version of "next" this replaces.
 *
 * Returns `undefined` only when there is nothing left anywhere.
 */
export function nextActionable(plan: ScratchPlan, progress: Progress, from: string): string | undefined {
	const step = plan.steps[from];
	const stageIndex = plan.stages.findIndex((s) => s.id === step?.stage);
	if (stageIndex >= 0) {
		const stage = plan.stages[stageIndex];
		const here = stage.steps.indexOf(from);
		const rest = stage.steps.slice(here + 1).find((id) => !isSettled(stateOf(progress, id)));
		if (rest) {
			return rest;
		}
		// Earlier in the same stage counts too: a stage you skipped into the middle
		// of is not finished, and sending you to the next one would leave it behind.
		const earlier = stage.steps.slice(0, here).find((id) => !isSettled(stateOf(progress, id)));
		if (earlier) {
			return earlier;
		}
		for (let i = stageIndex + 1; i < plan.stages.length; i++) {
			const next = firstOpenStep(plan, progress, plan.stages[i]);
			if (next) {
				return next;
			}
		}
	}
	// Nothing after where you are — wrap once, so a stage skipped near the front
	// is offered rather than lost.
	for (const stage of plan.stages) {
		const next = firstOpenStep(plan, progress, stage);
		if (next && next !== from) {
			return next;
		}
	}
	return undefined;
}

function firstOpenStep(plan: ScratchPlan, progress: Progress, stage: ScratchStage): string | undefined {
	if (stageStatus(plan, progress, stage.id) === 'blocked') {
		return undefined;
	}
	return stage.steps.find((id) => !isSettled(stateOf(progress, id)));
}

/**
 * The copy steps of a stage — what one action materializes (R83).
 *
 * 624 of the plan's steps are `copy`, and 465 of them fall in three unbroken
 * runs. A run of 275 consecutive "press Copy, press Copy" is not reading and it
 * is not typing; it is transcription theatre with a progress bar attached. The
 * content of a copy step is the reading, the `same` check stays per file, and
 * the plan does not move — what goes is the two hundred and seventy-five presses.
 */
export function copySteps(plan: ScratchPlan, stageId: string): readonly string[] {
	const stage = plan.stages.find((s) => s.id === stageId);
	return (stage?.steps ?? []).filter((id) => plan.steps[id]?.mode === 'copy');
}
