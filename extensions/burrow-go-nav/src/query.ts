/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// query.ts — the qualified-symbol query grammar (architecture task 16, WO-1). Pure
// and vscode-free so it compiles to a clean CommonJS module we can unit-test
// standalone (`node test/query.test.js`). It turns a `pkg.Symbol`-style string into
// a structured target; the resolver (resolver.ts) turns that target into gopls
// queries. Nothing here touches gopls, `go list`, or the editor — parsing only.
//
// Grammar (see docs/architecture/16-code-navigation.md):
//   collator                     → bare symbol, fuzzy across the workspace
//   urduwhisper.collator         → symbol `collator` in package `urduwhisper`
//   urduwhisper.Collator.Reset   → method/field `Reset` on type `Collator` in `urduwhisper`
//   urduwhisper.                 → the package `urduwhisper` (trailing dot ⇒ package target)
//   text/collate.Collator        → import-path-qualified symbol `Collator`
//   text/collate                 → the package at import path `text/collate`

/** How the resolver should treat a parsed query. */
export type QueryKind = 'bare' | 'qualified' | 'package';

/** A parsed Go navigation query — the structured form of the raw palette input. */
export interface ParsedQuery {
	/** The trimmed input, verbatim. */
	readonly raw: string;
	/** A simple (dot-free, slash-free) package qualifier, e.g. `urduwhisper`. */
	readonly pkgQualifier?: string;
	/** An import-path qualifier when the query contains a `/`, e.g. `text/collate`. */
	readonly importPathQualifier?: string;
	/** Symbol segments after the qualifier, e.g. `['Collator', 'Reset']`. Empty ⇒ a package target. */
	readonly symbolPath: string[];
	/** The resolution strategy this query calls for. */
	readonly kind: QueryKind;
}

/** Drop empty segments produced by leading/trailing/double dots. */
function nonEmpty(s: string): boolean {
	return s.length > 0;
}

/**
 * Parse a raw palette string into a {@link ParsedQuery}. Splits an import-path
 * qualifier (anything containing `/`) at the first `.` after its last `/`;
 * otherwise splits a dotted `pkg.Sym.Sub` at the first `.`, taking the head as the
 * package qualifier and the tail as the symbol path. A lone token is `bare` (the
 * resolver still probes it as a package too); an empty symbol path means the query
 * targets the package itself.
 */
export function parseQuery(raw: string): ParsedQuery {
	const text = raw.trim();
	if (text.length === 0) {
		return { raw: text, symbolPath: [], kind: 'bare' };
	}

	const lastSlash = text.lastIndexOf('/');
	if (lastSlash >= 0) {
		// Import-path qualified: the qualifier ends at the first dot AFTER the last
		// path separator, so dots inside the path (e.g. `gopkg.in/yaml`) stay in it.
		const dot = text.indexOf('.', lastSlash + 1);
		if (dot < 0) {
			return { raw: text, importPathQualifier: text, symbolPath: [], kind: 'package' };
		}
		const importPathQualifier = text.slice(0, dot);
		const symbolPath = text.slice(dot + 1).split('.').filter(nonEmpty);
		return {
			raw: text,
			importPathQualifier,
			symbolPath,
			kind: symbolPath.length > 0 ? 'qualified' : 'package',
		};
	}

	const segments = text.split('.');
	if (segments.length === 1) {
		// A lone token: treat as a bare fuzzy symbol; the resolver additionally
		// probes the package index so `urduwhisper` can still open its package.
		return { raw: text, symbolPath: [text], kind: 'bare' };
	}

	// `pkg.Sym…`: head is the package qualifier, the rest is the symbol path.
	const head = segments[0];
	const symbolPath = segments.slice(1).filter(nonEmpty);
	if (!nonEmpty(head)) {
		// Leading dot (`.collator`) — no usable qualifier; fall back to bare.
		return { raw: text, symbolPath, kind: 'bare' };
	}
	return {
		raw: text,
		pkgQualifier: head,
		symbolPath,
		kind: symbolPath.length > 0 ? 'qualified' : 'package',
	};
}

/** The symbol the resolver should ask gopls for — the deepest (last) path segment. */
export function targetSymbol(query: ParsedQuery): string {
	return query.symbolPath.length > 0 ? query.symbolPath[query.symbolPath.length - 1] : '';
}

/** The container (type) a `pkg.Type.Method` query narrows to, if any. */
export function parentContainer(query: ParsedQuery): string | undefined {
	return query.symbolPath.length >= 2 ? query.symbolPath[query.symbolPath.length - 2] : undefined;
}

/**
 * Score how well a dot-free qualifier matches a package's short name or the last
 * segment of its import path. Returns -1 for no match; higher is better so callers
 * can rank exact over fuzzy. Case-sensitive exact beats case-insensitive exact
 * beats last-segment match beats prefix beats substring.
 */
export function matchSimplePackage(qualifier: string, name: string, importPath: string): number {
	const q = qualifier.toLowerCase();
	const n = name.toLowerCase();
	const lastSeg = importPath.slice(importPath.lastIndexOf('/') + 1).toLowerCase();
	if (name === qualifier) {
		return 100;
	}
	if (n === q) {
		return 90;
	}
	if (lastSeg === q) {
		return 80;
	}
	if (n.startsWith(q) || lastSeg.startsWith(q)) {
		return 60;
	}
	if (n.includes(q) || lastSeg.includes(q)) {
		return 40;
	}
	return -1;
}

/**
 * Score how well an import-path qualifier (one containing `/`) matches a package's
 * full import path. Returns -1 for no match; exact beats path-suffix beats
 * substring. This wins over {@link matchSimplePackage} when short names collide.
 */
export function matchImportPath(qualifier: string, importPath: string): number {
	const q = qualifier.toLowerCase();
	const p = importPath.toLowerCase();
	if (importPath === qualifier) {
		return 100;
	}
	if (p === q) {
		return 90;
	}
	if (p.endsWith('/' + q)) {
		return 80;
	}
	if (p.includes(q)) {
		return 40;
	}
	return -1;
}

/**
 * Score how well a candidate symbol name matches the queried symbol. Returns -1
 * for no match. gopls already fuzzy-filters the candidate set; this ranks exact and
 * case-matching hits above fuzzy ones. An empty query matches everything at 0.
 */
export function matchSymbol(query: string, name: string): number {
	if (query.length === 0) {
		return 0;
	}
	const q = query.toLowerCase();
	const n = name.toLowerCase();
	if (name === query) {
		return 100;
	}
	if (n === q) {
		return 90;
	}
	if (n.startsWith(q)) {
		return 70;
	}
	if (n.includes(q)) {
		return 40;
	}
	return -1;
}

/**
 * Find the 0-based line of a Go file's `package` clause, skipping comments and the
 * build-constraint / blank preamble. Returns 0 when no clause is found so a jump
 * still lands somewhere sensible. Used to open a lone-package target on its
 * declaration rather than at the top of the file.
 */
export function findPackageClauseLine(text: string): number {
	const lines = text.split('\n');
	let inBlockComment = false;
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i].trim();
		if (inBlockComment) {
			const end = line.indexOf('*/');
			if (end < 0) {
				continue;
			}
			line = line.slice(end + 2).trim();
			inBlockComment = false;
		}
		// Strip a leading line comment or an opening block comment on this line.
		if (line.startsWith('//')) {
			continue;
		}
		const block = line.indexOf('/*');
		if (block >= 0 && line.indexOf('*/', block + 2) < 0) {
			inBlockComment = true;
			line = line.slice(0, block).trim();
		}
		if (/^package\s+[\p{L}_]/u.test(line)) {
			return i;
		}
	}
	return 0;
}
