/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// checks.ts — running a step's or a stage's checks and saying what happened.
//
// The rule the whole feature rests on: a check must be able to FAIL and the
// failure must be readable. A green tick that appears because nothing ran is
// worse than no tick, so a missing toolchain reports as "could not run", never
// as a pass.

import { exec } from 'node:child_process';
import * as path from 'node:path';
import { Check } from './planModel';
import { hasContent } from './workspace';

export interface CheckResult {
	readonly check: Check;
	readonly verdict: 'pass' | 'fail' | 'unavailable';
	readonly output: string;
	readonly durationMs: number;
}

export interface CheckRun {
	readonly results: readonly CheckResult[];
	readonly verdict: 'pass' | 'fail' | 'unavailable';
}

/** `command not found` from a shell, on either platform's wording. */
function isMissingTool(output: string, code: number | null): boolean {
	return code === 127 || /command not found|is not recognized as an internal|executable file not found/i.test(output);
}

function runShell(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve) => {
		exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			const output = `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.trim();
			resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output });
		});
	});
}

export async function runCheck(root: string, stepId: string | undefined, check: Check, timeoutMs = 120_000): Promise<CheckResult> {
	const started = Date.now();
	if (check.kind === 'exists') {
		const ok = !!stepId && hasContent(root, stepId);
		return {
			check,
			verdict: ok ? 'pass' : 'fail',
			output: ok ? '' : `${stepId ?? 'the file'} is missing or empty`,
			durationMs: Date.now() - started,
		};
	}
	const cwd = path.join(root, check.cwd ?? '');
	const { code, output } = await runShell(check.cmd ?? '', cwd, timeoutMs);
	const durationMs = Date.now() - started;
	if (isMissingTool(output, code)) {
		return { check, verdict: 'unavailable', output, durationMs };
	}
	// `gofmt -l` exits 0 and NAMES the files it objects to; silence is the pass.
	const failed = code !== 0 || (check.emptyOutput === true && output.length > 0);
	return { check, verdict: failed ? 'fail' : 'pass', output, durationMs };
}

export async function runChecks(root: string, stepId: string | undefined, checks: readonly Check[]): Promise<CheckRun> {
	const results: CheckResult[] = [];
	for (const check of checks) {
		const result = await runCheck(root, stepId, check);
		results.push(result);
		if (result.verdict === 'fail') {
			// Stop at the first failure: `go build` after a parse error tells you
			// nothing you did not already know.
			break;
		}
	}
	const verdict = results.some((r) => r.verdict === 'fail') ? 'fail'
		: results.some((r) => r.verdict === 'unavailable') ? 'unavailable'
			: 'pass';
	return { results, verdict };
}

/** One line for the notification and the tree. */
export function summarize(run: CheckRun): string {
	const failed = run.results.find((r) => r.verdict === 'fail');
	if (failed) {
		const first = failed.output.split('\n').find((l) => l.trim()) ?? failed.check.label;
		return `${failed.check.label} — ${first.slice(0, 160)}`;
	}
	const missing = run.results.find((r) => r.verdict === 'unavailable');
	if (missing) {
		return `could not run "${missing.check.cmd}" — the tool is not on PATH`;
	}
	return `${run.results.length} check${run.results.length === 1 ? '' : 's'} passed`;
}
