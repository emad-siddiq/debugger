/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// scaffold.js — what a single accreted line needs around it to be legal Go.
//
// Shared by plan.js (which must CLOSE the references those lines make) and
// materialise.js (which must WRITE them). Kept in one file because the two
// drifting apart would make the build result meaningless.
//
// A route registration is reported by flowscan as one line. It is not one line:
//
//   func (a *App) setupRouter() {          <- 1. the declaration's signature
//       r := chi.NewRouter()               <- 3. a local it hangs off
//       if len(a.Config.CORSOrigins) > 0 { <- 2. an enclosing block
//           r.Use(cors.New(cors.Options{   <- 4. …of a statement spanning 8 lines
//               …
//           }).Handler)
//       }                                  <- 2'. and the block's closer
//   }
//
// Four rules, all of them recovering the reference's own text and none of them
// inventing any:
//
//   1. signature   — the declaration's own opening lines
//   2. blocks      — every block opening the target line, and its closer
//   3. locals      — `x := …` / `var x …` statements the kept text names,
//                    transitively (a local's initialiser can name another)
//   4. statements  — a line whose parens or brackets are still open continues
//                    onto the next; the unit is the statement, not the line
//
// Rule 3 has a boundary this deliberately does not cross: it recovers local
// DECLARATIONS, not arbitrary preceding statements. A registration that depends
// on a mutation (`r.Use(...)` earlier in the same block changing behaviour) is
// not recovered, because nothing short of dataflow analysis would.

'use strict';

/** Strip strings, runes and line comments so brace counting is sound. */
function strip(line) {
	return line.replace(/"(\\.|[^"\\])*"|`[^`]*`|'(\\.|[^'\\])'|\/\/.*$/g, '');
}

/** Rule 4: the last line of the statement beginning at `start`. */
function statementEnd(lines, start, limit) {
	let depth = 0;
	for (let i = start; i <= limit && i <= lines.length; i++) {
		for (const ch of strip(lines[i - 1])) {
			if (ch === '(' || ch === '[') {
				depth++;
			} else if (ch === ')' || ch === ']') {
				depth--;
			}
		}
		if (depth <= 0) {
			return i;
		}
	}
	return start;
}

const LOCAL = /^\s*(?:var\s+)?([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?::=|\bvar\b|=[^=])/;
const DECLARES = /^\s*(?:var\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)|([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:=)/;

/**
 * Every line that must be written for `target` to stand, given the declaration
 * `decl` ({ line, endLine, sigEnd }) and the file's lines.
 */
function scaffoldFor(lines, decl, target) {
	const opens = new Map();       // opener line -> closer line
	const stackAt = new Map();     // line -> enclosing opener lines
	const stack = [];
	for (let i = decl.line; i <= decl.endLine && i <= lines.length; i++) {
		stackAt.set(i, [...stack]);
		for (const ch of strip(lines[i - 1])) {
			if (ch === '{') {
				stack.push(i);
			} else if (ch === '}') {
				const o = stack.pop();
				if (o !== undefined) {
					opens.set(o, i);
				}
			}
		}
	}

	const keep = new Set();
	const addStatement = (start) => {
		const end = statementEnd(lines, start, decl.endLine);
		for (let i = start; i <= end; i++) {
			keep.add(i);
		}
	};

	// 1 — signature
	for (let i = decl.line; i <= (decl.sigEnd || decl.line); i++) {
		keep.add(i);
	}
	// 2 — enclosing blocks and their closers
	const enclosingOpeners = stackAt.get(target) || [];
	for (const o of enclosingOpeners) {
		addStatement(o);
		if (opens.has(o)) {
			keep.add(opens.get(o));
		}
	}
	// 4 — the target statement itself
	addStatement(target);

	// 3 — locals the kept text names, to a fixpoint
	const declaredAt = new Map();  // name -> line
	for (let i = decl.line; i <= decl.endLine && i <= lines.length; i++) {
		const m = DECLARES.exec(strip(lines[i - 1]));
		if (!m) {
			continue;
		}
		for (const raw of (m[1] || m[2]).split(',')) {
			const name = raw.trim();
			if (name && name !== '_' && !declaredAt.has(name)) {
				declaredAt.set(name, i);
			}
		}
	}
	for (let pass = 0; pass < 8; pass++) {
		const text = [...keep].sort((a, b) => a - b).map((i) => strip(lines[i - 1])).join('\n');
		let grew = false;
		for (const [name, at] of declaredAt) {
			if (keep.has(at) || at > target) {
				continue;
			}
			if (new RegExp(`\\b${name}\\b`).test(text)) {
				addStatement(at);
				for (const o of stackAt.get(at) || []) {
					addStatement(o);
					if (opens.has(o)) {
						keep.add(opens.get(o));
					}
				}
				grew = true;
			}
		}
		if (!grew) {
			break;
		}
	}
	// The declaration's own closing brace.
	if (opens.has(decl.line)) {
		keep.add(opens.get(decl.line));
	} else {
		keep.add(decl.endLine);
	}
	return [...keep].sort((a, b) => a - b);
}

module.exports = { scaffoldFor, statementEnd, strip };
