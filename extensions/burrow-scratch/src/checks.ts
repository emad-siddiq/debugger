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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFile } from './parse';
import { Check, Precondition, tsDeclares } from './planModel';
import { fileState } from './workspace';

/**
 * Why a check could not answer.
 *
 * WO-79 delegated "what is the fourth check state called, and should
 * `unavailable` have been it all along?" — **it should have been.** There is no
 * fourth state. `unavailable` was already the right category ("this check did
 * not answer, and that is not your code's fault"); what it lacked was a reason,
 * so it hard-coded one — a missing tool — and everything else fell into `fail`,
 * which is where a syntax error lives. Three reasons now, one state.
 *
 *   no-tool    the command is not on PATH
 *   offline    it needed the network and the network was not there
 *   too-early  it ran, exited 0, and had nothing to work on (see `Precondition`)
 */
export type Unavailable = 'no-tool' | 'offline' | 'too-early';

export interface CheckResult {
	readonly check: Check;
	readonly verdict: 'pass' | 'fail' | 'unavailable';
	/** `unavailable` only. */
	readonly reason?: Unavailable;
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

/**
 * The network was the problem, not the code.
 *
 * `go mod tidy` on a plane exits non-zero with a DNS error, which is the same
 * red as a syntax error and tells a reader to go looking at their own work.
 * Matched on the transport's own wording — a proxy hostname would be a list of
 * registries to maintain, and these strings come from the resolver.
 */
function isOffline(output: string): boolean {
	return /dial tcp|no such host|ENOTFOUND|EAI_AGAIN|getaddrinfo|network is unreachable|Temporary failure in name resolution|ETIMEDOUT|proxy\.golang\.org|ECONNREFUSED.*:443/i.test(output);
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
		const state = stepId ? fileState(root, stepId) : 'missing';
		const name = stepId ?? 'the file';
		// `mayBeEmpty` is the reference saying this file is empty in the project
		// too, so an empty one here is the finished article and not a start.
		const ok = state === 'written' || (state === 'empty' && check.mayBeEmpty === true);
		return {
			check,
			verdict: ok ? 'pass' : 'fail',
			// Say which of the two it is. "Missing or empty" about a file the
			// learner can see in `ls` reads as the checker being broken, and sends
			// them to a terminal to argue with it — see `FileState`.
			output: ok ? ''
				: state === 'empty' ? `${name} is there but empty — nothing written to it yet. If you have typed into it, save it (⌘S) and run the checks again.`
					: `${name} does not exist yet.`,
			durationMs: Date.now() - started,
		};
	}
	// What the reference exports, read out of the scratch the same way it was read
	// out of the reference. Not a type-check and not a signature: the NAMES, which
	// is the smallest thing that distinguishes a file from a file with nothing in
	// it, and the largest thing that does not need the rest of the project.
	if (check.kind === 'declares') {
		const rel = stepId ?? '';
		let text: string;
		try {
			text = fs.readFileSync(path.join(root, rel), 'utf8');
		} catch {
			return { check, verdict: 'fail', output: `${rel} does not exist yet.`, durationMs: Date.now() - started };
		}
		const have = new Set(tsDeclares(text));
		const missing = (check.keys ?? []).filter((k) => !have.has(k));
		return {
			check,
			verdict: missing.length ? 'fail' : 'pass',
			output: missing.length ? `${rel}: nothing exported here is called ${missing.map((k) => `\`${k}\``).join(', ')}.` : '',
			durationMs: Date.now() - started,
		};
	}
	// A parser, in this process. No shell, no PATH, no network, and one file: the
	// three reasons a compiler cannot be the check at a step whose imports are
	// hundreds of steps away. See `parse.ts`.
	if (check.kind === 'parse') {
		const rel = stepId ?? '';
		let text: string;
		try {
			text = fs.readFileSync(path.join(root, rel), 'utf8');
		} catch {
			// Unreachable in a run — the `exists` check runs first and stops it. Said
			// plainly anyway rather than reported as a parse failure of nothing.
			return { check, verdict: 'fail', output: `${rel} does not exist yet.`, durationMs: Date.now() - started };
		}
		const verdict = parseFile(check.lang ?? 'json', rel, text, check.keys ?? []);
		return verdict.unavailable
			? { check, verdict: 'unavailable', reason: 'no-tool', output: verdict.message, durationMs: Date.now() - started }
			: { check, verdict: verdict.ok ? 'pass' : 'fail', output: verdict.message, durationMs: Date.now() - started };
	}
	const cwd = path.join(root, check.cwd ?? '');
	// A scratch starts with NO directories, so a check can arrive before the
	// place it runs in exists. `exec` with a nonexistent cwd fails with a blank
	// ENOENT — a red verdict with no words, about the learner's code, which is
	// wrong twice. It is the same fact as an unmet precondition: too early.
	if (!fs.existsSync(cwd)) {
		return {
			check, verdict: 'unavailable', reason: 'too-early',
			output: `${check.cwd || '.'}/ does not exist yet — nothing there to check.`,
			durationMs: Date.now() - started,
		};
	}
	const { code, output } = await runShell(check.cmd ?? '', cwd, timeoutMs);
	const durationMs = Date.now() - started;
	if (isMissingTool(output, code)) {
		return { check, verdict: 'unavailable', reason: 'no-tool', output, durationMs };
	}
	if (code !== 0 && isOffline(output)) {
		return { check, verdict: 'unavailable', reason: 'offline', output, durationMs };
	}
	const failed = code !== 0;
	if (!failed && check.needs && !preconditionMet(root, check.needs)) {
		return { check, verdict: 'unavailable', reason: 'too-early', output: check.needs.why, durationMs };
	}
	return { check, verdict: failed ? 'fail' : 'pass', output, durationMs };
}

/** Is there anything in `dir` for the command to have worked on? `match` is an
 *  exact filename or a suffix; both are one `endsWith` away. */
export function preconditionMet(root: string, needs: Precondition): boolean {
	let entries: string[];
	try {
		entries = fs.readdirSync(path.join(root, needs.dir));
	} catch {
		return false;  // the directory is not there, so neither are its inputs
	}
	return entries.some((name) => name === needs.match || (needs.match.startsWith('.') && name.endsWith(needs.match)));
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
		switch (missing.reason) {
			case 'offline':
				return `could not run "${missing.check.cmd}" — it needs the network and could not reach it. Nothing is wrong with what you wrote`;
			case 'too-early':
				return `"${missing.check.cmd}" ran and had nothing to do — ${missing.output}`;
			default:
				return `could not run "${missing.check.cmd}" — the tool is not on PATH`;
		}
	}
	return `${run.results.length} check${run.results.length === 1 ? '' : 's'} passed`;
}
