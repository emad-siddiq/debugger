/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// progressModel.ts — how far through the rebuild you are, as data.
//
// Progress lives in the SCRATCH workspace (`.burrow-scratch/progress.json`),
// not in the IDE's storage, for one reason: the scratch is the artefact. Copy
// the folder to another machine, open it in Burrow there, and it knows exactly
// where you stopped. Nothing about your position is held anywhere else.
//
// Two states carry weight. `done` is "I wrote this and its checks passed".
// `copied` is "this came from the reference verbatim" — kept separate because a
// progress bar that counts copied lockfiles as work done is lying to you.
//
// No `vscode` import: unit-tested standalone (test/progressModel.test.js).

import { ScratchPlan } from './planModel';

export type StepState = 'todo' | 'writing' | 'done' | 'copied';

export interface StepRecord {
	readonly state: StepState;
	/** ISO timestamp of the last state change. */
	readonly at: string;
	/** The verdict of the last check run, if it has been run. */
	readonly checks?: 'pass' | 'fail';
	readonly note?: string;
}

export interface Progress {
	readonly version: 1;
	/** The step the developer is on. Undefined only before the first open. */
	readonly current?: string;
	readonly steps: Readonly<Record<string, StepRecord>>;
	readonly startedAt: string;
	readonly updatedAt: string;
}

export function emptyProgress(now: string): Progress {
	return { version: 1, steps: {}, startedAt: now, updatedAt: now };
}

export function stateOf(progress: Progress, stepId: string): StepState {
	return progress.steps[stepId]?.state ?? 'todo';
}

/** Written or copied — either way the file is there and the plan moves on. */
export function isSettled(state: StepState): boolean {
	return state === 'done' || state === 'copied';
}

export function setState(progress: Progress, stepId: string, state: StepState, now: string, extra?: Partial<StepRecord>): Progress {
	return {
		...progress,
		steps: { ...progress.steps, [stepId]: { ...progress.steps[stepId], ...extra, state, at: now } },
		updatedAt: now,
	};
}

export function setCurrent(progress: Progress, stepId: string, now: string): Progress {
	return { ...progress, current: stepId, updatedAt: now };
}

export function recordCheck(progress: Progress, stepId: string, verdict: 'pass' | 'fail', now: string): Progress {
	const record = progress.steps[stepId] ?? { state: 'writing' as StepState, at: now };
	return { ...progress, steps: { ...progress.steps, [stepId]: { ...record, checks: verdict, at: now } }, updatedAt: now };
}

/** The plan's steps in the order they are meant to be written. */
export function order(plan: ScratchPlan): string[] {
	return plan.stages.flatMap((s) => [...s.steps]);
}

/** The first unsettled step at or after `from` — the plan's own answer to
 *  "what now". Wraps to the start so a skipped step is not lost forever. */
export function nextStep(plan: ScratchPlan, progress: Progress, from?: string): string | undefined {
	const all = order(plan);
	const start = from ? all.indexOf(from) + 1 : 0;
	const rotated = [...all.slice(Math.max(start, 0)), ...all.slice(0, Math.max(start, 0))];
	return rotated.find((id) => !isSettled(stateOf(progress, id)));
}

/** Where to resume: the recorded current step if it is still unfinished,
 *  otherwise the next thing to write. */
export function resumeAt(plan: ScratchPlan, progress: Progress): string | undefined {
	if (progress.current && plan.steps[progress.current] && !isSettled(stateOf(progress, progress.current))) {
		return progress.current;
	}
	return nextStep(plan, progress, progress.current);
}

export interface Tally {
	readonly total: number;
	readonly done: number;
	readonly copied: number;
	readonly settled: number;
	readonly lines: number;
	readonly linesWritten: number;
}

function tallyOf(plan: ScratchPlan, progress: Progress, stepIds: readonly string[]): Tally {
	let done = 0, copied = 0, lines = 0, linesWritten = 0;
	for (const id of stepIds) {
		const step = plan.steps[id];
		lines += step?.lines ?? 0;
		const state = stateOf(progress, id);
		if (state === 'done') {
			done++;
			linesWritten += step?.lines ?? 0;
		} else if (state === 'copied') {
			copied++;
		}
	}
	return { total: stepIds.length, done, copied, settled: done + copied, lines, linesWritten };
}

export function stageTally(plan: ScratchPlan, progress: Progress, stageId: string): Tally {
	const stage = plan.stages.find((s) => s.id === stageId);
	return tallyOf(plan, progress, stage?.steps ?? []);
}

export function overallTally(plan: ScratchPlan, progress: Progress): Tally {
	return tallyOf(plan, progress, order(plan));
}

/** A stage is open once anything in it is settled, and closed when all of it
 *  is. Used for the tree's collapse state — you open where you are working. */
export function stageState(tally: Tally): 'untouched' | 'open' | 'finished' {
	return tally.settled === 0 ? 'untouched' : tally.settled === tally.total ? 'finished' : 'open';
}

/** Progress rounded the way a person reads it: never 100% until it is. */
export function percent(tally: Tally): number {
	if (!tally.total) {
		return 0;
	}
	const raw = (tally.settled / tally.total) * 100;
	return tally.settled === tally.total ? 100 : Math.min(99, Math.round(raw));
}
