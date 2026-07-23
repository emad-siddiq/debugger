/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Heuristic props-skeleton parser for the isolation workbench: given a
// component's SOURCE TEXT, find its props type and produce a JSON-safe object
// covering the REQUIRED members, so isolating a required-props component
// renders something instead of crashing into the error boundary, and the
// Edit Props command has a seeded starting point.
//
// Deliberately regex + brace-counting, no `typescript` module dependency
// (repo is dependency-light; the parse runs on every gallery click). Known
// limit: no cross-file type resolution — a required prop typed by an IMPORTED
// interface (e.g. `node: Node`) gets `{}`, which may still fail inside the
// component; Edit Props is the refinement path. Function-typed members get the
// 'ƒ' marker, which the harness renders as a no-op stub.

export interface PropsSkeleton {
	/** Placeholder values for the REQUIRED members only. */
	readonly props: Record<string, unknown>;
	/** The required member names, in declaration order. */
	readonly required: string[];
}

/**
 * Parse a props skeleton out of component source. `stem` is the file basename
 * without extension (the conventional component name). Returns undefined when
 * no props type can be found or it has no required members.
 */
export function parsePropsSkeleton(source: string, stem: string): PropsSkeleton | undefined {
	const clean = stripComments(source);
	for (const body of candidateBodies(clean, stem)) {
		const skeleton = skeletonFromBody(body, clean);
		if (skeleton) {
			return skeleton;
		}
	}
	return undefined;
}

/**
 * The export name a gallery click should isolate: the named export matching
 * the file basename — but only when the module has NO default export (a
 * default is already the harness's first pick). Undefined = let the harness
 * pick (default, then first PascalCase export).
 */
export function preferredExport(source: string, stem: string): string | undefined {
	const clean = stripComments(source);
	if (/^\s*export\s+default\b/m.test(clean)) {
		return undefined;
	}
	const named =
		new RegExp(`^\\s*export\\s+(?:async\\s+)?(?:function|const|class)\\s+${stem}\\b`, 'm').test(clean) ||
		new RegExp(`^\\s*export\\s*\\{[^}]*\\b${stem}\\b[^}]*\\}`, 'm').test(clean);
	return named ? stem : undefined;
}

/** Bodies of plausible props types, most-specific first: the annotation on the
 *  component's own signature, then the conventional names. */
function* candidateBodies(clean: string, stem: string): Generator<string> {
	const names: string[] = [];
	const addName = (name: string | undefined) => {
		if (name && !names.includes(name)) {
			names.push(name);
		}
	};

	// `function X({…}: P)` / `const X = ({…}: P) =>` / `(props: P)` — capture the
	// annotation that closes the parameter list of a PascalCase component.
	for (const m of clean.matchAll(/(?:function\s+[A-Z]\w*\s*\(|const\s+[A-Z]\w*\s*=[^=]*?\()[^)]*?\}?\s*:\s*([A-Z]\w*)\s*\)/g)) {
		addName(m[1]);
	}
	// forwardRef<Ref, P>(…)
	const fwd = /forwardRef\s*<\s*[^,<>]+,\s*([A-Z]\w*)\s*>/.exec(clean);
	addName(fwd?.[1]);
	addName('Props');
	addName(`${stem}Props`);

	for (const name of names) {
		const body = typeBody(clean, name);
		if (body !== undefined) {
			yield body;
		}
	}

	// Inline literal annotation: `({ … }: { a: string; b?: number })`.
	const inline = /\}\s*:\s*(\{)/.exec(clean);
	if (inline) {
		const body = braceBlock(clean, inline.index + inline[0].length - 1);
		if (body !== undefined) {
			yield body;
		}
	}
}

/** The `{…}` body of `interface Name …{` or `type Name = {`, own members only
 *  (an `extends` heritage clause is skipped, not resolved — inherited members
 *  are treated as optional). */
function typeBody(clean: string, name: string): string | undefined {
	const decl = new RegExp(`(?:interface\\s+${name}\\b[^{]*|type\\s+${name}\\s*=\\s*)\\{`).exec(clean);
	if (!decl) {
		return undefined;
	}
	return braceBlock(clean, decl.index + decl[0].length - 1);
}

/** The text INSIDE the balanced braces opening at `openIdx`. */
function braceBlock(text: string, openIdx: number): string | undefined {
	let depth = 0;
	for (let i = openIdx; i < text.length; i++) {
		const ch = text[i];
		if (ch === '{') {
			depth++;
		} else if (ch === '}') {
			depth--;
			if (depth === 0) {
				return text.slice(openIdx + 1, i);
			}
		}
	}
	return undefined;
}

function skeletonFromBody(body: string, clean: string): PropsSkeleton | undefined {
	const props: Record<string, unknown> = {};
	const required: string[] = [];
	for (const member of splitMembers(body)) {
		const m = /^(?:readonly\s+)?([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*(\?)?\s*:\s*([\s\S]+)$/.exec(member.trim());
		if (!m || m[2]) {
			continue; // unparseable or optional — the skeleton covers required only
		}
		const key = m[1].replace(/^['"]|['"]$/g, '');
		props[key] = placeholderFor(m[3].trim(), clean);
		required.push(key);
	}
	return required.length ? { props, required } : undefined;
}

/** Split interface members at brace/paren/angle depth 0 on `;` and newlines. */
function splitMembers(body: string): string[] {
	const members: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of body) {
		if ('{(<['.includes(ch)) {
			depth++;
		} else if ('})>]'.includes(ch)) {
			depth--;
		}
		if (depth === 0 && (ch === ';' || ch === '\n')) {
			if (current.trim()) {
				members.push(current);
			}
			current = '';
		} else {
			current += ch;
		}
	}
	if (current.trim()) {
		members.push(current);
	}
	return members;
}

/** A JSON-safe placeholder for a type expression. `clean` is the whole source,
 *  for resolving one level of LOCAL literal-union aliases. */
function placeholderFor(type: string, clean: string): unknown {
	const t = type.trim();
	if (t.includes('=>')) {
		return 'ƒ'; // function marker — the harness stubs it at render time
	}
	const literal = /^['"]([^'"]*)['"]/.exec(t);
	if (literal) {
		return literal[1]; // literal union → its first literal
	}
	if (/^(string)\b/.test(t)) {
		return '';
	}
	if (/^(number)\b/.test(t)) {
		return 0;
	}
	if (/^(boolean|true|false)\b/.test(t)) {
		return false;
	}
	if (/\[\]\s*$/.test(t) || /^(Array|ReadonlyArray)\s*</.test(t)) {
		return [];
	}
	if (/^(ReactNode|ReactElement|React\.ReactNode|React\.ReactElement|JSX\.Element)\b/.test(t)) {
		return 'Sample';
	}
	// A bare local identifier may alias a literal union (`type Range = '24h' | '7d'`).
	const ident = /^([A-Z]\w*)\s*$/.exec(t);
	if (ident) {
		const alias = new RegExp(`type\\s+${ident[1]}\\s*=\\s*([^\\n;]+)`).exec(clean);
		if (alias) {
			const aliased = alias[1].trim();
			if (aliased !== t) {
				return placeholderFor(aliased, clean);
			}
		}
	}
	return {};
}

function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
