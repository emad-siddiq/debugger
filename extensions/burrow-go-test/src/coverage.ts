/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// coverage.ts — the PURE Go cover-profile reader (architecture task 11's coverage
// slice, specified as painted gutters and left unbuilt). No `vscode` and no
// `fs` import: this file only turns the text `go test -coverprofile` writes into
// blocks and totals, so out/coverage.js is unit-tested standalone
// (test/coverage.test.js). The workbench glue lives in controller.ts.
//
// Why this is only now buildable: 11-first-class-tests.md specified gutter
// shading, and at the time painting a gutter meant a core patch. The workbench
// has since grown a coverage API of its own, so the whole feature is an
// extension-level parser plus two API calls — and the patch budget, which is
// spent, is not involved.
//
// The format `go test -coverprofile` writes:
//
//     mode: set
//     github.com/org/mod/pkg/file.go:12.34,15.2 3 1
//     ─────────── name ───────────── ↑    ↑  ↑  ↑ ↑
//                          start line.col │  │  │ execution count
//                                  end line.col  │
//                                     statements in the block
//
// A "block" is a straight-line run of statements, not a line: one block can span
// several lines, and one line can hold several blocks. `numStmt` is how many
// statements the block holds, which is what Go's own `-func` percentages count —
// so a percentage computed by counting blocks disagrees with `go tool cover`.

/** One coverage block, exactly as the profile records it. Columns are 1-based. */
export interface CoverageBlock {
	readonly startLine: number;
	readonly startCol: number;
	readonly endLine: number;
	readonly endCol: number;
	/** How many statements the block holds — the unit Go's own percentages count. */
	readonly numStmt: number;
	/** How many times it ran. In `set` mode this is only ever 0 or 1. */
	readonly count: number;
}

/** A parsed profile: file name (in import-path form) → its blocks. */
export interface CoverProfile {
	/** `set`, `count` or `atomic`; absent if the profile carried no mode line. */
	readonly mode?: string;
	readonly files: ReadonlyMap<string, readonly CoverageBlock[]>;
}

// `<name>:<startLine>.<startCol>,<endLine>.<endCol> <numStmt> <count>`. The name
// may contain colons on some platforms, so the coordinates are anchored to the
// END of the line and the name is whatever is left — splitting on the first
// colon loses files whose import path is unusual.
const BLOCK = /^(.*):(\d+)\.(\d+),(\d+)\.(\d+) (\d+) (\d+)$/;

/**
 * Parses the text of a Go cover profile.
 *
 * Blocks with identical coordinates are merged by summing their counts: `go test`
 * emits a block per test binary, so a package whose tests run in more than one
 * pass repeats every block, and taking the last one would report a line as
 * uncovered because the final binary happened not to reach it.
 *
 * Unparseable lines are skipped rather than thrown on — a profile is a report,
 * and half a report painted is worth more than an error where the gutters were.
 */
export function parseCoverProfile(text: string): CoverProfile {
	let mode: string | undefined;
	// Keyed by file, then by coordinates, so repeated blocks land on each other.
	const byFile = new Map<string, Map<string, CoverageBlock>>();

	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (line === '') {
			continue;
		}
		if (line.startsWith('mode:')) {
			mode = line.slice('mode:'.length).trim();
			continue;
		}
		const m = BLOCK.exec(line);
		if (!m) {
			continue;
		}
		const [, name, startLine, startCol, endLine, endCol, numStmt, count] = m;
		const key = `${startLine}.${startCol},${endLine}.${endCol}`;
		const blocks = byFile.get(name) ?? byFile.set(name, new Map()).get(name)!;
		const previous = blocks.get(key);
		blocks.set(key, {
			startLine: Number(startLine),
			startCol: Number(startCol),
			endLine: Number(endLine),
			endCol: Number(endCol),
			numStmt: Number(numStmt),
			count: (previous?.count ?? 0) + Number(count),
		});
	}

	const files = new Map<string, readonly CoverageBlock[]>();
	for (const [name, blocks] of byFile) {
		files.set(name, [...blocks.values()]);
	}
	return mode === undefined ? { files } : { mode, files };
}

/**
 * Covered and total STATEMENTS for a set of blocks — the unit `go tool cover`
 * counts, so Burrow's percentage and Go's own agree. Counting blocks instead
 * would over-weight a one-statement `return err` against a ten-statement body.
 */
export function coverageTotals(blocks: readonly CoverageBlock[]): { covered: number; total: number } {
	let covered = 0;
	let total = 0;
	for (const block of blocks) {
		total += block.numStmt;
		if (block.count > 0) {
			covered += block.numStmt;
		}
	}
	return { covered, total };
}

/**
 * Reads the module path out of a `go.mod` — the `module <path>` line.
 *
 * Needed because a cover profile names files by IMPORT PATH
 * (`github.com/org/mod/pkg/file.go`) and the workbench paints gutters on files
 * on disk. The import path is the module path with the file's path within the
 * module appended, so the module path is exactly the prefix to strip.
 */
export function parseModulePath(goModText: string): string | undefined {
	for (const raw of goModText.split('\n')) {
		const line = raw.trim();
		if (line.startsWith('module ')) {
			// `module foo` and `module "foo"` are both legal.
			return line.slice('module '.length).trim().replace(/^"|"$/g, '') || undefined;
		}
		if (line.startsWith('module(')) {
			return undefined; // a block form nothing in the wild uses; refuse rather than guess
		}
	}
	return undefined;
}

/**
 * Turns a profile's file name into a path within the module, or `undefined` when
 * the file is not part of this module.
 *
 * `undefined` is the honest answer for a dependency's file: with `-coverpkg`
 * pointed outside the module, the profile carries files that live in the module
 * cache, and painting a read-only cached file as "uncovered" says something
 * about the dependency's tests, not about yours.
 *
 * @returns The path relative to the module root, using forward slashes.
 */
export function relativeToModule(name: string, modulePath: string): string | undefined {
	if (name === modulePath) {
		return undefined;
	}
	if (!name.startsWith(modulePath + '/')) {
		return undefined;
	}
	const rel = name.slice(modulePath.length + 1);
	// A profile is generated, not typed, but it ends up joined onto a real path:
	// refuse anything that could climb out of the module root.
	if (rel === '' || rel.split('/').some(segment => segment === '..')) {
		return undefined;
	}
	return rel;
}
