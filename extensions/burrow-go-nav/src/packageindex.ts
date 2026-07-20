/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// packageindex.ts — the `go list -json` package index (architecture task 16, WO-1).
// gopls gives us symbols; it does NOT expose the package↔directory mapping we need
// to (a) filter `pkg.Symbol` hits down to the right package and (b) resolve a lone
// `pkg` target to a file. `go list -json` gives exactly that. This module is
// vscode-free: the RAW parsing (`parseGoList`, splitting the concatenated JSON
// stream), the index, and package resolution are all pure and unit-tested
// standalone. The actual `go` invocation lives behind the {@link GoListRunner}
// interface (implemented by golist.ts with child_process) so tests inject a fake.

import { matchImportPath, matchSimplePackage } from './query';

/** A Go package as reported by `go list -json` (the fields task 16 needs). */
export interface GoPackage {
	/** The canonical import path, e.g. `text/collate`. */
	readonly importPath: string;
	/** The package's short (clause) name, e.g. `collate`. */
	readonly name: string;
	/** The absolute directory the package's files live in. */
	readonly dir: string;
	/** Base names of the package's non-test `.go` files, in `go list` order. */
	readonly goFiles: string[];
}

/** Runs `go list` with the given args and resolves the raw stdout. Injected for testability. */
export interface GoListRunner {
	list(args: string[]): Promise<string>;
}

/**
 * Split a `go list -json` stdout stream into its top-level JSON object texts.
 * `go list -json` emits one pretty-printed object per package, concatenated with
 * no array wrapper, so a plain `JSON.parse` fails. This scans brace depth while
 * respecting strings and escapes. Pure and standalone-testable.
 */
export function splitJsonObjects(stdout: string): string[] {
	const objects: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < stdout.length; i++) {
		const ch = stdout[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === '{') {
			if (depth === 0) {
				start = i;
			}
			depth++;
		} else if (ch === '}') {
			depth--;
			if (depth === 0 && start >= 0) {
				objects.push(stdout.slice(start, i + 1));
				start = -1;
			}
		}
	}
	return objects;
}

/** The subset of `go list -json` fields we read, before normalizing to {@link GoPackage}. */
interface RawGoPackage {
	ImportPath?: string;
	Name?: string;
	Dir?: string;
	GoFiles?: string[];
}

/**
 * Parse `go list -json` stdout into {@link GoPackage} records. Objects without an
 * import path or directory are skipped (e.g. error-only entries). Missing
 * `GoFiles` becomes an empty list. Pure — no `go`, no filesystem.
 */
export function parseGoList(stdout: string): GoPackage[] {
	const packages: GoPackage[] = [];
	for (const text of splitJsonObjects(stdout)) {
		let raw: RawGoPackage;
		try {
			raw = JSON.parse(text) as RawGoPackage;
		} catch {
			continue;
		}
		if (!raw.ImportPath || !raw.Dir) {
			continue;
		}
		packages.push({
			importPath: raw.ImportPath,
			name: raw.Name ?? '',
			dir: raw.Dir,
			goFiles: Array.isArray(raw.GoFiles) ? raw.GoFiles.slice() : [],
		});
	}
	return packages;
}

/**
 * The file that carries a package's `package X` clause: `doc.go` by convention,
 * else the first non-test `.go` file. Returns an absolute path (joined with `/`)
 * or `undefined` when the package has no Go files. The exact clause LINE is found
 * separately (see `findPackageClauseLine`) so the index stays filesystem-free.
 */
export function packageClauseFile(pkg: GoPackage): string | undefined {
	const doc = pkg.goFiles.find(f => f === 'doc.go');
	const chosen = doc ?? pkg.goFiles.find(f => !f.endsWith('_test.go')) ?? pkg.goFiles[0];
	if (!chosen) {
		return undefined;
	}
	const sep = pkg.dir.endsWith('/') ? '' : '/';
	return pkg.dir + sep + chosen;
}

/** A package match with its ranking score, so callers can order results. */
export interface RankedPackage {
	readonly pkg: GoPackage;
	readonly score: number;
}

/**
 * An in-memory index over the packages `go list -json` reported: import-path and
 * directory lookups plus scored qualifier resolution. Pure and standalone-testable
 * (construct it from `parseGoList` output). The owner rebuilds it on `go.mod` /
 * `go.work` change; this class holds no watchers or IO itself.
 */
export class PackageIndex {
	private readonly byImportPath = new Map<string, GoPackage>();
	private readonly byDir = new Map<string, GoPackage>();

	constructor(packages: readonly GoPackage[]) {
		for (const pkg of packages) {
			this.byImportPath.set(pkg.importPath, pkg);
			this.byDir.set(normalizeDir(pkg.dir), pkg);
		}
	}

	/** Number of indexed packages. */
	get size(): number {
		return this.byImportPath.size;
	}

	/** The package whose files live in `dir`, if indexed. Used to name a symbol's package. */
	packageForDir(dir: string): GoPackage | undefined {
		return this.byDir.get(normalizeDir(dir));
	}

	/** The package at an exact import path, if indexed. */
	packageForImportPath(importPath: string): GoPackage | undefined {
		return this.byImportPath.get(importPath);
	}

	/**
	 * Resolve a simple (dot-free) qualifier to matching packages, best score first.
	 * Ties break on the shorter import path (the "closest" package).
	 */
	resolveSimple(qualifier: string): RankedPackage[] {
		return this.rank(pkg => matchSimplePackage(qualifier, pkg.name, pkg.importPath));
	}

	/** Resolve an import-path qualifier (one containing `/`) to matching packages, best first. */
	resolveImportPath(qualifier: string): RankedPackage[] {
		return this.rank(pkg => matchImportPath(qualifier, pkg.importPath));
	}

	/** Score every package with `scorer`, drop non-matches, sort best-first. */
	private rank(scorer: (pkg: GoPackage) => number): RankedPackage[] {
		const ranked: RankedPackage[] = [];
		for (const pkg of this.byImportPath.values()) {
			const score = scorer(pkg);
			if (score >= 0) {
				ranked.push({ pkg, score });
			}
		}
		ranked.sort((a, b) => b.score - a.score || a.pkg.importPath.length - b.pkg.importPath.length || a.pkg.importPath.localeCompare(b.pkg.importPath));
		return ranked;
	}
}

/** Normalize a directory for map keys: drop a single trailing slash (but keep root `/`). */
function normalizeDir(dir: string): string {
	return dir.length > 1 && dir.endsWith('/') ? dir.slice(0, -1) : dir;
}
