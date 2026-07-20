/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// symbols.ts — the pure symbol-anchoring logic for the Oracle read path (architecture
// task 08, task 4: "selection → symbol chain → note resolution"). A stack invariant is
// that notes anchor to symbols, NEVER to line numbers, so this module walks a
// DocumentSymbol tree to the innermost symbol enclosing a position and renders a stable
// dotted symbol path. It reads only the structural shape of a symbol (name + range +
// children), which vscode.DocumentSymbol satisfies, so extension.ts passes the real
// symbols straight in while the tests drive plain object literals — no 'vscode' import.

/** A line/character position (0-based), mirroring vscode.Position's shape. */
export interface SymbolPosition {
	readonly line: number;
	readonly character: number;
}

/** A closed range, mirroring vscode.Range's shape. */
export interface SymbolRange {
	readonly start: SymbolPosition;
	readonly end: SymbolPosition;
}

/** The structural subset of vscode.DocumentSymbol this module needs. */
export interface SymbolNode {
	readonly name: string;
	/** Full symbol range used for containment (vscode.DocumentSymbol.range). */
	readonly range: SymbolRange;
	readonly children?: readonly SymbolNode[];
}

/** Whether `pos` lies within `[range.start, range.end]` inclusive. */
function contains(range: SymbolRange, pos: SymbolPosition): boolean {
	const afterStart = pos.line > range.start.line || (pos.line === range.start.line && pos.character >= range.start.character);
	const beforeEnd = pos.line < range.end.line || (pos.line === range.end.line && pos.character <= range.end.character);
	return afterStart && beforeEnd;
}

/**
 * Descend the symbol tree collecting each symbol that encloses the position, outermost
 * first. When siblings overlap (rare) the tightest range wins at each level so the chain
 * follows the most specific nesting. Returns `[]` when nothing encloses the position.
 */
export function enclosingSymbolChain(symbols: readonly SymbolNode[], pos: SymbolPosition): SymbolNode[] {
	const chain: SymbolNode[] = [];
	let level: readonly SymbolNode[] | undefined = symbols;
	while (level && level.length) {
		let best: SymbolNode | undefined;
		for (const sym of level) {
			if (contains(sym.range, pos) && (!best || tighter(sym.range, best.range))) {
				best = sym;
			}
		}
		if (!best) {
			break;
		}
		chain.push(best);
		level = best.children;
	}
	return chain;
}

/** True when range `a` is narrower than `b` (fewer lines, then fewer columns). */
function tighter(a: SymbolRange, b: SymbolRange): boolean {
	const spanA = (a.end.line - a.start.line) * 100000 + (a.end.character - a.start.character);
	const spanB = (b.end.line - b.start.line) * 100000 + (b.end.character - b.start.character);
	return spanA < spanB;
}

/**
 * Render a chain (as produced by {@link enclosingSymbolChain}) as a dotted symbol path,
 * optionally prefixed with the package name — e.g. `ingest.Inserter.loop`. gopls already
 * folds receivers into the symbol name (`(*Inserter).loop`), so a plain join preserves
 * gopls' identity without inventing our own receiver grammar.
 */
export function symbolPath(chain: readonly SymbolNode[], pkg?: string): string {
	const tail = chain.map(s => s.name).join('.');
	if (pkg && tail) {
		return `${pkg}.${tail}`;
	}
	return pkg || tail;
}

/**
 * The candidate symbol paths to look a note up under, innermost first then falling
 * outward — `[ingest.Type.method, ingest.Type, ingest]` — so the resolver can attach a
 * note to the tightest symbol yet still surface a package note when nothing tighter has
 * one (architecture task 08: "falling back outward to the package note").
 */
export function symbolPathCandidates(chain: readonly SymbolNode[], pkg?: string): string[] {
	const candidates: string[] = [];
	for (let i = chain.length; i >= 1; i--) {
		candidates.push(symbolPath(chain.slice(0, i), pkg));
	}
	if (pkg) {
		candidates.push(pkg);
	}
	return candidates;
}
