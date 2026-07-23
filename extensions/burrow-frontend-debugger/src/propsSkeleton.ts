/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Heuristic props-SCHEMA parser for the isolation workbench: given a
// component's source, find its props type and produce (a) a typed control
// spec per member — the harness page renders these as live inputs — and
// (b) a JSON-safe skeleton for the REQUIRED members so first render works.
//
// Deliberately regex + brace-counting, no `typescript` module dependency
// (repo is dependency-light; the parse runs on every gallery click).
// Imported types resolve ONE hop through the caller-supplied resolver
// (relative + `@/` specifiers); deeper graphs fall back to `{}` — the
// props panel / samples are the refinement path. Function-typed members
// get the 'ƒ' marker, which the harness renders as a no-op stub.

export type PropKind =
	| 'string' | 'number' | 'boolean' | 'enum'
	| 'function' | 'component' | 'element'
	| 'array' | 'set' | 'object' | 'json';

export interface PropSpec {
	readonly name: string;
	readonly required: boolean;
	readonly kind: PropKind;
	/** Enum literals, for kind 'enum'. */
	readonly options?: string[];
	/** Initial value: the component's own destructuring default when it has
	 *  one, else a placeholder for required members. Optional members without
	 *  a destructuring default carry it in `shape` only (not auto-passed). */
	readonly value?: unknown;
	/** True when `value` is the component's own destructuring default —
	 *  shown in the panel but NOT passed (the component supplies it). */
	readonly fromDefault?: boolean;
	/** Placeholder to seed the control when the user enables an optional
	 *  member (or the JSON editor for object kinds). */
	readonly shape?: unknown;
}

export interface PropsSchema {
	readonly specs: PropSpec[];
	/** Values for the REQUIRED members only — the auto-applied first render. */
	readonly skeleton: Record<string, unknown>;
	readonly required: string[];
}

/** Resolve a type NAME imported by the component to its declaration text —
 *  `{ body }` for an interface/type-literal, `{ alias }` for a `type X = rhs`
 *  alias — or undefined. Supplied by the extension (fs access); one hop. */
export type TypeResolver = (name: string) => { body?: string; alias?: string } | undefined;

const COMPONENT_TYPE = /^(LucideIcon|ComponentType|React\.ComponentType|ElementType|React\.ElementType|FC|React\.FC|JSXElementConstructor)\b/;
const ELEMENT_TYPE = /^(ReactNode|ReactElement|React\.ReactNode|React\.ReactElement|JSX\.Element)\b/;

export function parsePropsSchema(source: string, stem: string, resolve?: TypeResolver): PropsSchema | undefined {
	const clean = stripComments(source);
	for (const body of candidateBodies(clean, stem, resolve)) {
		const schema = schemaFromBody(body, clean, defaultsFromSignature(clean), resolve, 0);
		if (schema) {
			return schema;
		}
	}
	return undefined;
}

/** Back-compat wrapper: required-members-only skeleton (the auto-isolate seed). */
export function parsePropsSkeleton(source: string, stem: string, resolve?: TypeResolver): { props: Record<string, unknown>; required: string[] } | undefined {
	const schema = parsePropsSchema(source, stem, resolve);
	return schema && schema.required.length ? { props: schema.skeleton, required: schema.required } : undefined;
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
 *  component's own signature, then the conventional names. Local declarations
 *  win; imported props types resolve one hop. */
function* candidateBodies(clean: string, stem: string, resolve?: TypeResolver): Generator<string> {
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
		} else if (resolve) {
			// The props type itself may be IMPORTED (`({…}: TabHelpers)` with
			// TabHelpers declared in a sibling) — one resolver hop finds it.
			const found = resolve(name);
			if (found?.body !== undefined) {
				yield found.body;
			}
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

/** The component's own destructuring defaults: `({ a = 'x', b = 2 }: Props)`.
 *  Literal defaults only (string/number/boolean) — expressions are skipped. */
function defaultsFromSignature(clean: string): Map<string, unknown> {
	const out = new Map<string, unknown>();
	const sig = /(?:function\s+[A-Z]\w*|const\s+[A-Z]\w*\s*=[^=]*?)\(\s*\{([^)]*?)\}\s*:/.exec(clean);
	if (!sig) {
		return out;
	}
	for (const m of sig[1].matchAll(/([A-Za-z_$][\w$]*)\s*=\s*('[^']*'|"[^"]*"|-?\d+(?:\.\d+)?|true|false)/g)) {
		const raw = m[2];
		out.set(m[1], raw === 'true' ? true : raw === 'false' ? false : /^['"]/.test(raw) ? raw.slice(1, -1) : Number(raw));
	}
	return out;
}

function schemaFromBody(body: string, clean: string, defaults: Map<string, unknown>, resolve: TypeResolver | undefined, depth: number): PropsSchema | undefined {
	const specs: PropSpec[] = [];
	const skeleton: Record<string, unknown> = {};
	const required: string[] = [];
	for (const member of splitMembers(body)) {
		const m = /^(?:readonly\s+)?([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*(\?)?\s*:\s*([\s\S]+)$/.exec(member.trim());
		if (!m) {
			continue;
		}
		const name = m[1].replace(/^['"]|['"]$/g, '');
		const isRequired = !m[2];
		const t = typeOf(m[3].trim(), clean, resolve, depth);
		const spec: PropSpec = {
			name,
			required: isRequired,
			kind: t.kind,
			options: t.options,
			value: defaults.has(name) ? defaults.get(name) : (isRequired ? t.placeholder : undefined),
			fromDefault: defaults.has(name) || undefined,
			shape: t.placeholder,
		};
		specs.push(spec);
		if (isRequired) {
			skeleton[name] = t.placeholder;
			required.push(name);
		}
	}
	return specs.length ? { specs, skeleton, required } : undefined;
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

const MAX_DEPTH = 2;

/** Kind + JSON-safe placeholder (+ enum options) for a type expression.
 *  `clean` is the component source, for local alias resolution; `resolve`
 *  reaches one hop into imported declarations. */
function typeOf(type: string, clean: string, resolve: TypeResolver | undefined, depth: number): { kind: PropKind; placeholder: unknown; options?: string[] } {
	const t = type.trim();
	if (t.includes('=>')) {
		return { kind: 'function', placeholder: 'ƒ' };
	}
	if (COMPONENT_TYPE.test(t)) {
		return { kind: 'component', placeholder: 'ƒ' };
	}
	if (ELEMENT_TYPE.test(t)) {
		return { kind: 'element', placeholder: 'Sample' };
	}
	// Literal union → enum. All top-level `|` branches must be quoted literals.
	if (/^['"]/.test(t)) {
		const options = t.split('|').map((p) => p.trim()).filter((p) => /^['"].*['"]$/.test(p)).map((p) => p.slice(1, -1));
		if (options.length) {
			return { kind: 'enum', placeholder: options[0], options };
		}
	}
	// Arrays before scalars — `number[]` must not match the `number` check.
	if (/\[\]\s*$/.test(t) || /^(Array|ReadonlyArray)\s*</.test(t)) {
		return { kind: 'array', placeholder: [] };
	}
	if (/^(Set|ReadonlySet)\s*</.test(t)) {
		return { kind: 'set', placeholder: [] };
	}
	if (/^(Map|ReadonlyMap|Record)\s*</.test(t)) {
		return { kind: 'json', placeholder: {} };
	}
	if (/^(string)\b/.test(t)) {
		return { kind: 'string', placeholder: '' };
	}
	if (/^(number)\b/.test(t)) {
		return { kind: 'number', placeholder: 0 };
	}
	if (/^(boolean|true|false)\b/.test(t)) {
		return { kind: 'boolean', placeholder: false };
	}
	if (/^\{/.test(t)) {
		const body = braceBlock(t, t.indexOf('{'));
		return { kind: 'object', placeholder: body !== undefined && depth < MAX_DEPTH ? nestedSkeleton(body, clean, resolve, depth + 1) : {} };
	}
	// A bare identifier: a local alias, or an imported type (one resolver hop).
	const ident = /^([A-Z]\w*)\s*$/.exec(t);
	if (ident) {
		const local = new RegExp(`type\\s+${ident[1]}\\s*=\\s*([^\\n;]+)`).exec(clean);
		if (local && local[1].trim() !== t) {
			return typeOf(local[1], clean, resolve, depth);
		}
		const localBody = typeBody(clean, ident[1]);
		if (localBody !== undefined && depth < MAX_DEPTH) {
			return { kind: 'object', placeholder: nestedSkeleton(localBody, clean, resolve, depth + 1) };
		}
		if (resolve && depth < MAX_DEPTH) {
			const found = resolve(ident[1]);
			if (found?.alias) {
				return typeOf(found.alias, clean, resolve, depth + 1);
			}
			if (found?.body !== undefined) {
				return { kind: 'object', placeholder: nestedSkeleton(found.body, clean, resolve, depth + 1) };
			}
		}
	}
	return { kind: 'json', placeholder: {} };
}

/** Required members of a nested object type, as placeholder values. */
function nestedSkeleton(body: string, clean: string, resolve: TypeResolver | undefined, depth: number): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const member of splitMembers(body)) {
		const m = /^(?:readonly\s+)?([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*(\?)?\s*:\s*([\s\S]+)$/.exec(member.trim());
		if (!m || m[2]) {
			continue;
		}
		out[m[1].replace(/^['"]|['"]$/g, '')] = typeOf(m[3].trim(), clean, resolve, depth).placeholder;
	}
	return out;
}

function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
