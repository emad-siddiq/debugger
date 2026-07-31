/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// workspace.ts — the scratch folder on disk.
//
// A scratch is an ordinary directory that happens to carry `.burrow-scratch/`:
// the plan, the progress, and a readable index. Everything else in it is code
// you wrote. It is deliberately NOT a copy of the reference — the directories
// exist so the tools can find a project, the files do not exist until you write
// them.
//
// Every operation here is idempotent. Re-running the launcher on an existing
// scratch re-plans against the reference (which moves on) and KEEPS the
// progress, because losing three evenings of typing to a re-scan would be
// unforgivable.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ScratchPlan, StepMode } from './planModel';
import { Progress, emptyProgress, overallTally, percent } from './progressModel';

export const SCRATCH_DIR = '.burrow-scratch';
export const PLAN_FILE = `${SCRATCH_DIR}/plan.json`;
export const PROGRESS_FILE = `${SCRATCH_DIR}/progress.json`;

export function planPath(root: string): string {
	return path.join(root, PLAN_FILE);
}

export function progressPath(root: string): string {
	return path.join(root, PROGRESS_FILE);
}

/** Is this folder a scratch? The one question the extension asks at startup. */
export function isScratch(root: string): boolean {
	try {
		return fs.statSync(planPath(root)).isFile();
	} catch {
		return false;
	}
}

export function readPlan(root: string): ScratchPlan | undefined {
	try {
		const plan = JSON.parse(fs.readFileSync(planPath(root), 'utf8')) as ScratchPlan;
		return plan.version === 1 && plan.stages?.length ? plan : undefined;
	} catch {
		return undefined;
	}
}

export function readProgress(root: string, now: string): Progress {
	try {
		const progress = JSON.parse(fs.readFileSync(progressPath(root), 'utf8')) as Progress;
		if (progress.version === 1 && progress.steps) {
			return progress;
		}
	} catch {
		// A missing or corrupt progress file means "start over", never "crash".
	}
	return emptyProgress(now);
}

export function writeProgress(root: string, progress: Progress): void {
	fs.mkdirSync(path.join(root, SCRATCH_DIR), { recursive: true });
	fs.writeFileSync(progressPath(root), `${JSON.stringify(progress, undefined, '\t')}\n`);
}

/**
 * Create — or refresh — the scratch at `root`. Returns the progress that
 * survived, so the caller never has to think about the resume case.
 */
export function materialize(root: string, plan: ScratchPlan, now: string): Progress {
	fs.mkdirSync(path.join(root, SCRATCH_DIR), { recursive: true });
	fs.writeFileSync(planPath(root), `${JSON.stringify(plan, undefined, '\t')}\n`);

	// Directories only. An empty file would make `go build` and the checks pass
	// for work that has not been done.
	for (const id of Object.keys(plan.steps)) {
		const dir = path.dirname(path.join(root, id));
		if (dir !== root) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	const progress = readProgress(root, now);
	writeProgress(root, progress);
	writeIndex(root, plan, progress);
	writeGitignore(root);
	return progress;
}

function writeGitignore(root: string): void {
	const file = path.join(root, '.gitignore');
	if (fs.existsSync(file)) {
		return;
	}
	// The plan is worth committing; the progress is a working note. Both stay
	// readable — this is a learning artefact, not a build directory.
	fs.writeFileSync(file, ['node_modules/', 'dist/', '.env', ''].join('\n'));
}

/** A human-readable index at the scratch root, rewritten on every change so it
 *  is never stale. Read it outside the IDE — that is the point. */
export function writeIndex(root: string, plan: ScratchPlan, progress: Progress): void {
	const tally = overallTally(plan, progress);
	const lines: string[] = [
		`# ${plan.name} — scratch build`,
		'',
		`Rebuilding \`${plan.reference}\` by hand, one file at a time, in dependency order.`,
		'',
		`**${percent(tally)}%** — ${tally.settled} of ${tally.total} files (${tally.done} written, ${tally.copied} copied)`,
		` · ${tally.linesWritten.toLocaleString()} of ${tally.lines.toLocaleString()} lines`,
		'',
		'Open this folder in Burrow and the **Scratch** view in the left rail picks up where you left off.',
		'',
		'| # | Stage | Files | Done |',
		'|---|---|---|---|',
	];
	plan.stages.forEach((stage, i) => {
		const settled = stage.steps.filter((id) => {
			const state = progress.steps[id]?.state;
			return state === 'done' || state === 'copied';
		}).length;
		lines.push(`| ${i + 1} | ${stage.title} | ${stage.steps.length} | ${settled === stage.steps.length ? '✓' : `${settled}/${stage.steps.length}`} |`);
	});
	lines.push('', '---', '', `Plan: \`${PLAN_FILE}\` · Progress: \`${PROGRESS_FILE}\``, '');
	fs.writeFileSync(path.join(root, 'SCRATCH.md'), lines.join('\n'));
}

/**
 * Create the file for a step if it is not there yet. Returns its absolute path.
 *
 * `generate` steps are the exception, and it is not a nicety: `go mod init`
 * REFUSES to run when a `go.mod` is already there, so opening the step created
 * an empty file and the step's own command could then never succeed —
 * `go: …/backend/go.mod already exists`, forever, on step 1 of 16. Measured in
 * the bundle 2026-07-31. A file the toolchain writes is not ours to touch.
 */
export function ensureFile(root: string, stepId: string, mode?: StepMode): string {
	const abs = path.join(root, stepId);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	if (!fs.existsSync(abs) && mode !== 'generate') {
		fs.writeFileSync(abs, '');
	}
	return abs;
}

/** Copy the reference's version of a step in. Used for lockfiles, and as the
 *  escape hatch on anything you decide not to type. */
export function copyReference(root: string, reference: string, stepId: string): void {
	const abs = path.join(root, stepId);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.copyFileSync(path.join(reference, stepId), abs);
}

/** Non-empty on disk — the `exists` check, and what the tree's icons read. */
export function hasContent(root: string, stepId: string): boolean {
	try {
		return fs.statSync(path.join(root, stepId)).size > 0;
	} catch {
		return false;
	}
}
