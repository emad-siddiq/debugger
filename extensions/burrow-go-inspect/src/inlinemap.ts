/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// inlinemap.ts — "which names does this LINE introduce?" (IX, architecture task
// 05.7: "inline value decorations — active-frame ghost values … after `:=`/params").
// Pure and vscode-free (so `out/inlinemap.js` is plain CommonJS and unit-testable):
// it reads one line of Go source and returns the names DECLARED on it. Deliberately
// a heuristic, not a parser — the decoration is subtle by design, so a missed name
// costs a ghost value, never correctness. We only match the three binding forms the
// design names (`:=`, `var`, func params); plain `x = 1` reassignment is out of scope
// on purpose, so ghost text marks where a value is *introduced*, not every mention.

/** A Go identifier (ASCII subset — enough for the declaration forms below). */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isIdent(s: string): boolean {
	return IDENT.test(s) && s !== '_';
}

/** Drop a trailing line comment and surrounding space. String literals are left alone. */
function stripComment(line: string): string {
	const i = line.indexOf('//');
	return (i === -1 ? line : line.slice(0, i)).trim();
}

/** The identifiers on the left of a binding: `a, b` / `_, n` → the non-blank ones. */
function namesFromList(lhs: string): string[] {
	const out: string[] = [];
	for (const part of lhs.split(',')) {
		const first = part.trim().split(/\s+/)[0];
		if (first && isIdent(first)) {
			out.push(first);
		}
	}
	return out;
}

/**
 * Parameter names in a `func` signature's paren group. Go lets a type be shared
 * (`a, b int`), so a part is either a bare name (grouped) or `name type` — either
 * way the FIRST token is the name. A part that is only a type (`func(int) bool`)
 * yields a name too; harmless, since an unbound name simply has no value to ghost.
 */
function namesFromParams(line: string): string[] {
	if (!/^func\b/.test(line)) {
		return [];
	}
	const out: string[] = [];
	// Both groups on a method: the receiver `(s *Server)` and the params after the name.
	const groups = line.match(/\(([^()]*)\)/g) ?? [];
	for (const group of groups) {
		out.push(...namesFromList(group.slice(1, -1)));
	}
	return out;
}

/** The names a single line of Go source binds, in source order, deduped. */
export function declaredNamesOnLine(rawLine: string): string[] {
	const line = stripComment(rawLine);
	const names: string[] = [];

	names.push(...namesFromParams(line));

	// `a, b := f()` — also covers `for _, n := range xs` and `if v, ok := m[k]; ok`,
	// because we take everything after the last leading keyword up to `:=`.
	const short = line.indexOf(':=');
	if (short !== -1) {
		// The LHS starts after the last statement boundary before `:=` — that trims a
		// leading keyword's clause (`for`/`if`/`switch`) and any signature or block
		// opener sharing the line.
		const before = line.slice(0, short);
		const start = Math.max(before.lastIndexOf('{'), before.lastIndexOf(';'), before.lastIndexOf(')'));
		const lhs = before.slice(start + 1).replace(/^\s*(for|if|switch)\b/, '');
		names.push(...namesFromList(lhs));
	}

	// `var x int` / `var x, y = 1, 2` — the comma list between `var` and the type.
	const decl = /^var\s+(.+)$/.exec(line);
	if (decl) {
		names.push(...namesFromList(decl[1].split('=')[0]));
	}

	return [...new Set(names)];
}
