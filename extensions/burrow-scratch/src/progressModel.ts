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

/**
 * One check's last known answer, kept so a reopened window can show it.
 *
 * Keyed by LABEL, which is what `checksBlock` already matches on, and which
 * survives a re-plan that renumbers steps. The output is kept short: this is a
 * memory of a verdict, not a log.
 */
export interface CheckMemory {
	readonly label: string;
	readonly verdict: 'pass' | 'fail' | 'unavailable';
	readonly output: string;
}

export interface StepRecord {
	readonly state: StepState;
	/** ISO timestamp of the last state change. */
	readonly at: string;
	/**
	 * The verdict of the last check run, if it has been run.
	 *
	 * `unavailable` used to be written down as `pass` — the call site folded three
	 * verdicts into two — so "could not run" and "ran and passed" were the same
	 * fact on disk, and a stage went green on checks that never executed.
	 */
	readonly checks?: 'pass' | 'fail' | 'unavailable';
	/** Row by row, so reopening shows what you were looking at rather than a
	 *  column of hollow circles that reads as "nothing has ever run". */
	readonly results?: readonly CheckMemory[];
	/** When those results were produced — a remembered verdict has to say it is
	 *  remembered, or it is a claim about a file that may have changed since. */
	readonly checkedAt?: string;
	/**
	 * The reader opened the reference for this step (R86).
	 *
	 * Recorded and shown; it gates nothing and subtracts from nothing. The
	 * reference is on their disk and pretending otherwise would be the product's
	 * first dishonest sentence — but a rebuild you looked things up during is a
	 * different rebuild from one you did not, and only the person doing it can
	 * decide what that is worth.
	 */
	readonly consulted?: boolean;
	readonly note?: string;
}

export interface Progress {
	readonly version: 2;
	/** The step the developer is on. Undefined only before the first open. */
	readonly current?: string;
	readonly steps: Readonly<Record<string, StepRecord>>;
	readonly startedAt: string;
	readonly updatedAt: string;
}

export const PROGRESS_VERSION = 2;

export function emptyProgress(now: string): Progress {
	return { version: 2, steps: {}, startedAt: now, updatedAt: now };
}

/**
 * A version 1 progress file, read by this version. Lossless in both directions
 * of what version 1 could express: every field it had survives, and the three
 * this version adds are simply absent until something records them.
 *
 * Written back as version 2 on the next save, so the migration happens once and
 * a reader who never runs a check keeps a file that is still true.
 */
export function migrateProgress(raw: unknown): Progress | undefined {
	const p = raw as Partial<Progress> | undefined;
	const version = (p as { version?: number } | undefined)?.version;
	if (!p || typeof p !== 'object' || !p.steps || (version !== 1 && version !== 2)) {
		return undefined;
	}
	return {
		version: 2,
		...(p.current ? { current: p.current } : {}),
		steps: p.steps,
		startedAt: p.startedAt ?? new Date(0).toISOString(),
		updatedAt: p.updatedAt ?? p.startedAt ?? new Date(0).toISOString(),
	};
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

export function recordCheck(progress: Progress, stepId: string, verdict: 'pass' | 'fail' | 'unavailable', now: string, results?: readonly CheckMemory[]): Progress {
	const record = progress.steps[stepId] ?? { state: 'writing' as StepState, at: now };
	return {
		...progress,
		steps: {
			...progress.steps,
			[stepId]: { ...record, checks: verdict, at: now, ...(results ? { results, checkedAt: now } : {}) },
		},
		updatedAt: now,
	};
}

/** R86: the reader opened the reference for this step. Sticky — having looked
 *  once is a fact about the rebuild, and un-looking is not a thing. */
export function recordConsulted(progress: Progress, stepId: string, now: string): Progress {
	const record = progress.steps[stepId] ?? { state: 'todo' as StepState, at: now };
	if (record.consulted) {
		return progress;
	}
	return { ...progress, steps: { ...progress.steps, [stepId]: { ...record, consulted: true } }, updatedAt: now };
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
	/**
	 * Settled steps whose executable check has not passed — it was never run, or
	 * it came back `unavailable`. A step with nothing but an `exists` check can
	 * never be unproven: existing is the whole of what it claims.
	 *
	 * 13 of Foundations' 17 steps are exactly that, so a stage could read
	 * green with three of its four real checks unexecuted. This is the number
	 * that stops it.
	 */
	readonly unproven: number;
}

function hasExecutableCheck(plan: ScratchPlan, id: string): boolean {
	return (plan.steps[id]?.checks ?? []).some((c) => c.kind === 'shell');
}

function tallyOf(plan: ScratchPlan, progress: Progress, stepIds: readonly string[]): Tally {
	let done = 0, copied = 0, lines = 0, linesWritten = 0, unproven = 0;
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
		if (isSettled(state) && hasExecutableCheck(plan, id) && progress.steps[id]?.checks !== 'pass') {
			unproven++;
		}
	}
	return { total: stepIds.length, done, copied, settled: done + copied, lines, linesWritten, unproven };
}

export function stageTally(plan: ScratchPlan, progress: Progress, stageId: string): Tally {
	const stage = plan.stages.find((s) => s.id === stageId);
	return tallyOf(plan, progress, stage?.steps ?? []);
}

export function overallTally(plan: ScratchPlan, progress: Progress): Tally {
	return tallyOf(plan, progress, order(plan));
}

/**
 * A stage is open once anything in it is settled, and closed when all of it is.
 * Used for the tree's collapse state — you open where you are working.
 *
 * `unproven` is the fourth: every file is written and at least one command that
 * was supposed to prove it did not run. It is not `finished`, because a tick
 * that appears when nothing ran is the exact failure this feature was built to
 * refuse, and it is not `open`, because there is nothing left to write.
 */
export function stageState(tally: Tally): 'untouched' | 'open' | 'unproven' | 'finished' {
	if (tally.settled === 0) {
		return 'untouched';
	}
	if (tally.settled < tally.total) {
		return 'open';
	}
	return tally.unproven ? 'unproven' : 'finished';
}

/** Progress rounded the way a person reads it: never 100% until it is. */
export function percent(tally: Tally): number {
	if (!tally.total) {
		return 0;
	}
	const raw = (tally.settled / tally.total) * 100;
	return tally.settled === tally.total ? 100 : Math.min(99, Math.round(raw));
}
