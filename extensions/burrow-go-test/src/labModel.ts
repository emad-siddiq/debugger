/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// What the Test Lab shows, as data (docs/plans/02 §3.4's "lab feel"). No
// `vscode` import, so the ordering, the counts and the want/got extraction are
// unit-tested standalone (test/labModel.test.js) — the parts that decide what a
// developer reads first are exactly the parts worth testing.
//
// The organising idea: FAILURES FIRST. A run of 400 passing tests and one
// failure is a screen about that one failure; the passes are a count, not a
// list to scroll past.

import { TestResult } from './events';

export interface LabTest {
	readonly name: string;
	readonly status: 'pass' | 'fail' | 'skip';
	readonly durationMs?: number;
	readonly output: string;
	/** Extracted from the failure output when it has the shape (see `wantGot`). */
	readonly want?: string;
	readonly got?: string;
}

export interface LabSuite {
	readonly packagePath: string;
	readonly label: string;
	readonly tests: readonly LabTest[];
	readonly failed: number;
	readonly passed: number;
	readonly skipped: number;
	readonly durationMs: number;
}

export interface LabRun {
	readonly suites: readonly LabSuite[];
	readonly failed: number;
	readonly passed: number;
	readonly skipped: number;
	readonly durationMs: number;
	/** Present when `go test` itself failed to build or run. */
	readonly stderr?: string;
	readonly race: boolean;
}

/** One package's results, failures first then skips then passes, each group by
 *  name so a re-run reads the same way twice. */
export function buildSuite(packagePath: string, label: string, results: Iterable<TestResult>): LabSuite {
	const tests = [...results]
		.map((result): LabTest => ({ ...result, ...wantGot(result.output) }))
		.sort(byFailureFirst);
	return {
		packagePath,
		label,
		tests,
		failed: tests.filter((t) => t.status === 'fail').length,
		passed: tests.filter((t) => t.status === 'pass').length,
		skipped: tests.filter((t) => t.status === 'skip').length,
		durationMs: tests.reduce((sum, t) => sum + (t.durationMs ?? 0), 0),
	};
}

const RANK = { fail: 0, skip: 1, pass: 2 } as const;

function byFailureFirst(a: LabTest, b: LabTest): number {
	return RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name);
}

/** Roll suites into a run, suites with failures first. */
export function buildRun(suites: readonly LabSuite[], race: boolean, stderr?: string): LabRun {
	const ordered = [...suites].sort((a, b) => (b.failed > 0 ? 1 : 0) - (a.failed > 0 ? 1 : 0) || a.label.localeCompare(b.label));
	return {
		suites: ordered,
		failed: sum(ordered, (s) => s.failed),
		passed: sum(ordered, (s) => s.passed),
		skipped: sum(ordered, (s) => s.skipped),
		durationMs: sum(ordered, (s) => s.durationMs),
		...(stderr ? { stderr } : {}),
		race,
	};
}

function sum<T>(items: readonly T[], of: (item: T) => number): number {
	return items.reduce((total, item) => total + of(item), 0);
}

/**
 * Pull `want`/`got` out of a Go failure, so the lab can diff them instead of
 * making the developer read two values out of a wall of text. Go has no single
 * assertion library, but its idiomatic failure messages converge on a handful
 * of shapes — these five cover `t.Errorf` conventions, testify, and
 * `go-cmp`'s `(-want +got)` header. Anything else is left as plain output
 * rather than guessed at.
 */
export function wantGot(output: string): { want?: string; got?: string } {
	const patterns: readonly [RegExp, 'gw' | 'wg'][] = [
		[/got[:\s]+(.+?)[,;]?\s+want(?:ed)?[:\s]+(.+?)$/im, 'gw'],
		[/want(?:ed)?[:\s]+(.+?)[,;]?\s+got[:\s]+(.+?)$/im, 'wg'],
		[/expected[:\s]+(.+?)[,;]?\s+(?:but\s+)?got[:\s]+(.+?)$/im, 'wg'],
		[/actual\s*:\s*(.+?)$[\s\S]*?expected\s*:\s*(.+?)$/im, 'gw'],
		[/-\s*want[\s\S]*?\n\s*-\s*(.+?)\n\s*\+\s*(.+?)$/im, 'wg'],
	];
	for (const [pattern, order] of patterns) {
		const match = pattern.exec(output);
		if (match) {
			const [, first, second] = match;
			const got = (order === 'gw' ? first : second).trim();
			const want = (order === 'gw' ? second : first).trim();
			if (want && got && want !== got) {
				return { want: clip(want), got: clip(got) };
			}
		}
	}
	return {};
}

function clip(value: string): string {
	return value.length > 400 ? `${value.slice(0, 400)}…` : value;
}

/** The tests a "Re-run failed" should run, as `-run` name anchors. */
export function failedNames(run: LabRun): string[] {
	return run.suites.flatMap((suite) => suite.tests.filter((t) => t.status === 'fail').map((t) => t.name));
}

/** A one-line verdict for the lab's header and the tree's description. */
export function verdict(run: LabRun): string {
	if (run.stderr) {
		return 'build failed';
	}
	const parts = [`${run.passed} passed`];
	if (run.failed) {
		parts.unshift(`${run.failed} failed`);
	}
	if (run.skipped) {
		parts.push(`${run.skipped} skipped`);
	}
	return `${parts.join(' · ')} · ${(run.durationMs / 1000).toFixed(2)}s`;
}
