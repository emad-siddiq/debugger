/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// events.ts — the PURE `go test -json` event parser (architecture task 11,
// Runner core: "parse events → live tree state; no output scraping"). No
// `vscode` import, so out/events.js is unit-tested standalone
// (test/events.test.js). runner.ts feeds raw stdout lines here; the controller
// maps the results onto TestItems.

/** One `go test -json` event line (only the fields we consume are typed). */
export interface GoTestEvent {
	/** The lifecycle action for the package/test. */
	readonly Action: 'start' | 'run' | 'pause' | 'cont' | 'output' | 'pass' | 'fail' | 'skip' | 'bench';
	/** Import path of the package the event concerns. */
	readonly Package?: string;
	/** Test/benchmark name; absent for package-scoped events. */
	readonly Test?: string;
	/** Wall time in seconds on a terminal (pass/fail/skip) event. */
	readonly Elapsed?: number;
	/** A chunk of captured output (only on `output` events). */
	readonly Output?: string;
}

/** The terminal disposition of a single test. */
export type TestStatus = 'pass' | 'fail' | 'skip';

/** The rolled-up result for one test name after a run. */
export interface TestResult {
	/** The test name exactly as `go test` reported it (may be `Parent/sub`). */
	readonly name: string;
	/** Its terminal status. */
	readonly status: TestStatus;
	/** Duration in milliseconds, when the event carried `Elapsed`. */
	readonly durationMs?: number;
	/** All captured output for the test, concatenated in order. */
	readonly output: string;
}

/**
 * Parses one line of `go test -json` stdout into an event, or `undefined` for
 * blank/non-JSON lines (a plain `go test` line, a shell banner, etc.). Never
 * throws — malformed lines are simply skipped.
 *
 * @param line A single raw stdout line (no trailing newline required).
 * @returns The parsed event, or `undefined` if the line is not a test event.
 */
export function parseTestJsonLine(line: string): GoTestEvent | undefined {
	const trimmed = line.trim();
	if (trimmed.length === 0 || trimmed[0] !== '{') {
		return undefined;
	}
	try {
		const parsed = JSON.parse(trimmed) as GoTestEvent;
		return typeof parsed.Action === 'string' ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Rolls a stream of `-json` events up into a per-test result map. Output events
 * accumulate; a terminal `pass`/`fail`/`skip` sets the status and duration.
 * Package-scoped events (no `Test`) are ignored here — the caller inspects the
 * process exit code and stderr for build failures.
 *
 * @param events The parsed events, in arrival order.
 * @returns A map from test name to its rolled-up {@link TestResult}.
 */
export function summarizeEvents(events: readonly GoTestEvent[]): Map<string, TestResult> {
	const outputs = new Map<string, string>();
	const results = new Map<string, TestResult>();
	for (const event of events) {
		const name = event.Test;
		if (!name) {
			continue;
		}
		if (event.Action === 'output') {
			outputs.set(name, (outputs.get(name) ?? '') + (event.Output ?? ''));
			continue;
		}
		if (event.Action === 'pass' || event.Action === 'fail' || event.Action === 'skip') {
			results.set(name, {
				name,
				status: event.Action,
				...(event.Elapsed !== undefined ? { durationMs: Math.round(event.Elapsed * 1000) } : {}),
				output: outputs.get(name) ?? '',
			});
		}
	}
	return results;
}
