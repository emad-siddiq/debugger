/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// discovery.ts — the PURE test-discovery core (architecture task 11, Discovery).
// No `vscode` import: this file only turns Go source text (and `go test -list`
// output) into a structured list of test functions, so out/discovery.js is a
// clean CommonJS module unit-tested standalone (test/discovery.test.js).
//
// The design's real discovery is gopls-symbol driven; this first slice does a
// robust line-anchored `func Test*` scan — enough to populate the explorer and
// resolve exact `-run` names. Naming honors Go's `go test` convention: the rune
// after the Test/Benchmark/Fuzz/Example prefix must not be a lowercase letter
// (so `Testify` is not a test), and `TestMain` is the package entrypoint, not a
// test, so it is excluded.

/** The four kinds of `go test` functions the explorer understands. */
export type GoTestKind = 'test' | 'benchmark' | 'fuzz' | 'example';

/** A single discovered test function, with its 1-based declaration line. */
export interface GoTestFunc {
	/** The exact function name, e.g. `TestIngest` — used verbatim in `-run`. */
	readonly name: string;
	/** Which `go test` family the function belongs to. */
	readonly kind: GoTestKind;
	/** 1-based line of the `func` declaration (for the TestItem range). */
	readonly line: number;
}

/** Maps a matched `func` prefix to its {@link GoTestKind}. */
const PREFIX_KIND: ReadonlyArray<readonly [string, GoTestKind]> = [
	['Test', 'test'],
	['Benchmark', 'benchmark'],
	['Fuzz', 'fuzz'],
	['Example', 'example'],
];

// A declaration line: `func TestXxx(`, `func BenchmarkXxx(`, `func FuzzXxx(`,
// `func ExampleXxx(`. The suffix is optional (`func Test(` is valid) and, when
// present, must start with a non-lowercase rune per Go's convention.
const FUNC_DECL = /^func\s+(Test|Benchmark|Fuzz|Example)([A-Z0-9_][A-Za-z0-9_]*)?\s*\(/;

/**
 * Scans Go source text for top-level test/benchmark/fuzz/example functions.
 * Line-anchored so a `func Test…(` inside a string or block comment is not
 * matched in practice; `TestMain` is skipped as the package entrypoint.
 *
 * @param source The full text of a `*_test.go` file.
 * @returns The discovered functions in source order (deduped by name).
 */
export function parseTestFunctions(source: string): GoTestFunc[] {
	const found: GoTestFunc[] = [];
	const seen = new Set<string>();
	const lines = source.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const match = FUNC_DECL.exec(lines[i]);
		if (!match) {
			continue;
		}
		const name = match[1] + (match[2] ?? '');
		if (name === 'TestMain' || seen.has(name)) {
			continue;
		}
		const kind = PREFIX_KIND.find(([prefix]) => match[1] === prefix)![1];
		seen.add(name);
		found.push({ name, kind, line: i + 1 });
	}
	return found;
}

// A bare `go test -list` name row: a single identifier beginning with one of the
// four prefixes. Filters out the trailing `ok  pkg  0.02s` / `?  pkg [no test files]`
// status rows that `go test -list` also prints.
const LIST_NAME = /^(?:Test|Benchmark|Fuzz|Example)[A-Za-z0-9_]*$/;

/**
 * Extracts test names from `go test -list <pattern> ./pkg` stdout, discarding
 * the tool's status/summary rows. Useful as a cross-check against, or fallback
 * for, the static {@link parseTestFunctions} scan.
 *
 * @param stdout The raw stdout of a `go test -list` invocation.
 * @returns The listed test names, in order, deduped.
 */
export function parseTestList(stdout: string): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const raw of stdout.split(/\r?\n/)) {
		const name = raw.trim();
		if (name === 'TestMain' || !LIST_NAME.test(name) || seen.has(name)) {
			continue;
		}
		seen.add(name);
		names.push(name);
	}
	return names;
}
