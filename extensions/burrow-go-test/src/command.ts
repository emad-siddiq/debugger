/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// command.ts — the PURE `go test` argv builder (architecture task 11, Runner
// core: flag composition). No `vscode` and no `child_process` import: this file
// only turns a run description into the exact argument vector, so out/command.js
// is unit-tested standalone (test/command.test.js). The impure spawn lives in
// runner.ts.

import { GoTestKind } from './discovery';

/** A run description the explorer hands the runner. */
export interface RunArgsOptions {
	/** The package spec, e.g. `./internal/ingest` or `.` (never a bare dir). */
	readonly packagePath: string;
	/** What is being run; governs `-run` vs `-bench` composition. */
	readonly kind: GoTestKind;
	/** Exact function names to select; empty runs the whole package. */
	readonly names?: readonly string[];
	/** Honor the scheme bar's race toggle (task 03). */
	readonly race?: boolean;
	/** Emit machine-readable events (`-json`); defaults to true. */
	readonly json?: boolean;
	/** Per-run `-count` override (e.g. 1 to defeat the test cache). */
	readonly count?: number;
}

/**
 * Builds an exact-match, anchored `-run`/`-bench` regexp for a set of names.
 * Test identifiers contain no regexp metacharacters, so a simple anchored
 * alternation is exact: `^(TestA|TestB)$`.
 *
 * @param names One or more test function names.
 * @returns The anchored alternation regexp.
 */
export function selectorRegex(names: readonly string[]): string {
	return `^(${names.join('|')})$`;
}

/**
 * Composes the full `go test` argument vector (excluding the `go` binary) for a
 * run. Benchmarks add `-bench` and neutralize `-run` (`^$`) so only benchmarks
 * fire; tests, examples and fuzz seed-corpus runs select via `-run`.
 *
 * @param opts The run description.
 * @returns The argv to pass to `spawn('go', argv, …)`.
 */
export function buildRunArgs(opts: RunArgsOptions): string[] {
	const args = ['test'];
	if (opts.json !== false) {
		args.push('-json');
	}
	if (opts.race) {
		args.push('-race');
	}
	if (opts.count !== undefined) {
		args.push('-count', String(opts.count));
	}
	const names = opts.names ?? [];
	if (opts.kind === 'benchmark') {
		// `-run '^$'` suppresses ordinary tests so a benchmark run is just benchmarks.
		args.push('-run', '^$', '-bench', names.length ? selectorRegex(names) : '.', '-benchmem');
	} else if (names.length) {
		// Tests, examples, and fuzz seed-corpus runs all select by name via -run.
		args.push('-run', selectorRegex(names));
	}
	args.push(opts.packagePath);
	return args;
}

/**
 * Composes `go test -list <pattern> <pkg>` argv for name discovery.
 *
 * @param packagePath The package spec, e.g. `./internal/ingest`.
 * @param pattern The name regexp to list; defaults to everything.
 * @returns The argv to pass to `spawn('go', argv, …)`.
 */
export function buildListArgs(packagePath: string, pattern = '.*'): string[] {
	return ['test', '-list', pattern, packagePath];
}
