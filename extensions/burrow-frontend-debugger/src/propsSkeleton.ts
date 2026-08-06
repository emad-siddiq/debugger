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

/** A type declaration the resolver found, and the context it was found IN. */
export interface ResolvedType {
	/** `{…}` members, for an interface or a type-literal alias. */
	readonly body?: string;
	/** The right-hand side, for `type X = rhs`. */
	readonly alias?: string;
	/**
	 * The declaring file's source, comments stripped.
	 *
	 * Without this a body resolved out of another file was then parsed against
	 * the COMPONENT's text, so a member typed by something declared beside the
	 * declaration — `status: ValidatorStatus` inside `ValidatorGridRow` — could
	 * never resolve, and fell through to the give-up value `{}`.
	 */
	readonly source?: string;
	/** A resolver rooted at the declaring file, for ITS imports — same reason. */
	readonly nested?: TypeResolver;
	/** `interface X extends A, B` — the names, unresolved. */
	readonly bases?: readonly string[];
}

/** Resolve a type NAME imported by the component to its declaration. Supplied
 *  by the extension (fs access); one hop per `depth`. */
export type TypeResolver = (name: string) => ResolvedType | undefined;

const COMPONENT_TYPE = /^(LucideIcon|ComponentType|React\.ComponentType|ElementType|React\.ElementType|FC|React\.FC|JSXElementConstructor)\b/;
const ELEMENT_TYPE = /^(ReactNode|ReactElement|React\.ReactNode|React\.ReactElement|JSX\.Element)\b/;

export function parsePropsSchema(source: string, stem: string, resolve?: TypeResolver): PropsSchema | undefined {
	const clean = stripComments(source);
	for (const found of candidateBodies(clean, stem, resolve)) {
		// The defaults always come from the COMPONENT's own signature, even when
		// the props type itself lives in another file.
		const schema = schemaFromBody(found.body, found.clean, defaultsFromSignature(clean), found.resolve, 0);
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
function* candidateBodies(clean: string, stem: string, resolve?: TypeResolver): Generator<{ body: string; clean: string; resolve?: TypeResolver }> {
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
		const local = declarationOf(clean, name);
		if (local) {
			yield { body: withBases(local.body, local.bases, ctxFor(clean, resolve, 0)), clean, resolve };
		} else if (resolve) {
			// The props type itself may be IMPORTED (`({…}: TabHelpers)` with
			// TabHelpers declared in a sibling) — one resolver hop finds it, and
			// its members are then read in ITS file's context, not the caller's.
			const found = resolve(name);
			if (found?.body !== undefined) {
				const inner = ctxFor(found.source ?? clean, found.nested ?? resolve, 0);
				yield { body: withBases(found.body, found.bases, inner), clean: inner.clean, resolve: inner.resolve };
			}
		}
	}

	// Inline literal annotation: `({ … }: { a: string; b?: number })`.
	const inline = /\}\s*:\s*(\{)/.exec(clean);
	if (inline) {
		const body = braceBlock(clean, inline.index + inline[0].length - 1);
		if (body !== undefined) {
			yield { body, clean, resolve };
		}
	}
}

/**
 * A named declaration: its `{…}` body and the names it extends.
 *
 * Shared with the resolver (typeResolver.ts) so the two cannot disagree about
 * what counts as a declaration. The `extends` clause used to be swallowed by
 * the `[^{]*` and thrown away, which cost merkle's five annotation types the
 * `id`, `color` and `created_at` they all inherit from `AnnotationBase` — and
 * AnnotationOverlay keys its list on that missing `id`.
 */
export function declarationOf(text: string, name: string): { body: string; bases: string[] } | undefined {
	const decl = new RegExp(`(?:interface\\s+${name}\\b([^{]*)|type\\s+${name}\\s*=\\s*)\\{`).exec(text);
	if (!decl) {
		return undefined;
	}
	const body = braceBlock(text, decl.index + decl[0].length - 1);
	return body === undefined ? undefined : { body, bases: basesOf(decl[1]) };
}

/**
 * The plain names in an `extends` clause.
 *
 * Anything generic or dotted is dropped, and that is the point rather than a
 * limitation: 12 of merkle's 22 `extends` clauses are
 * `Omit<HTMLAttributes<HTMLDivElement>, 'className'>`, whose members are
 * optional DOM attributes. Synthesizing those would put `autoFocus`, `dir` and
 * `slot` on every primitive — noise the component never reads. What is left is
 * the app's own bases: AnnotationBase, FieldFlags, ToastOptions, PolledOptions.
 */
function basesOf(clause: string | undefined): string[] {
	if (!clause || !/\bextends\b/.test(clause)) {
		return [];
	}
	return clause
		.slice(clause.indexOf('extends') + 'extends'.length)
		.split(',')
		.map((part) => part.trim())
		.filter((part) => /^[A-Z]\w*$/.test(part));
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
		const m = MEMBER.exec(member.trim());
		if (!m) {
			continue;
		}
		const name = m[1].replace(/^['"]|['"]$/g, '');
		const isRequired = !m[2];
		const t = typeOf(memberType(m), ctxFor(clean, resolve, depth, name));
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

/** Split interface members at brace/paren/angle depth 0 on `;` and newlines.
 *  The `>` of an arrow (`onSelect: (r: Row) => void`) is NOT a closer — counting
 *  it drove depth negative, and every member declared after the first function
 *  member was then silently swallowed into it. Depth also clamps at 0 so one
 *  stray bracket can't hide the rest of the interface. */
/**
 * One member of an interface or type literal: name, `?`, type.
 *
 * The `(?:\([^)]*\))?` is METHOD SHORTHAND. `valueToY(v: number): number` is a
 * function member written the other legal way, and requiring a `:` straight
 * after the name dropped it from the object entirely — so merkle's
 * AnnotationOverlay got a `scale` with no `valueToY` on it and died calling one.
 * 10 members across merkle are written this way.
 */
const MEMBER = /^(?:readonly\s+)?([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*(\?)?\s*(\([^)]*\))?\s*:\s*([\s\S]+)$/;

/** A member's type. Method shorthand is rewritten as the arrow type it means,
 *  so there is one place that decides what a function member looks like. */
function memberType(m: RegExpExecArray): string {
	return m[3] ? `${m[3]} => ${m[4].trim()}` : m[4].trim();
}

function splitMembers(body: string): string[] {
	const members: string[] = [];
	let depth = 0;
	let current = '';
	let prev = '';
	for (const ch of body) {
		if ('{(<['.includes(ch)) {
			depth++;
		} else if ('})>]'.includes(ch) && !(ch === '>' && prev === '=')) {
			depth = Math.max(0, depth - 1);
		}
		prev = ch;
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
/** Arrays synthesize their items, so the element type gets one extra hop —
 *  `rows: Row[]` is only useful once each Row is filled in. */
const SYNTH_MAX_DEPTH = 4;
/** How many synthesized values one prop may produce, so a deeply nested array
 *  of objects can't turn one gallery click into a thousand-node payload. */
const SYNTH_NODE_CAP = 50;
/** Items synthesized per array — enough for a list or table to look like a
 *  list or table, few enough to stay readable in the props panel. */
const SYNTH_ARRAY_ITEMS = 3;

/** Recursion state for a single prop's placeholder synthesis. */
interface SynthCtx {
	/** The component source, for local alias resolution. */
	readonly clean: string;
	/** Reaches one hop into imported declarations. */
	readonly resolve: TypeResolver | undefined;
	readonly depth: number;
	/** Depth ceiling for this path (raised on the array path). */
	readonly limit: number;
	/** Shared, mutable — decremented by every synthesized value. */
	readonly budget: { left: number };
	/** The member name this type belongs to; drives name-aware synthesis. */
	readonly name?: string;
	/** Position within a synthesized array, so items differ from each other. */
	readonly index?: number;
}

function ctxFor(clean: string, resolve: TypeResolver | undefined, depth: number, name?: string): SynthCtx {
	return { clean, resolve, depth, limit: MAX_DEPTH, budget: { left: SYNTH_NODE_CAP }, name };
}

/** `nodeName` / `node_name` → `Node Name`. */
function humanize(name: string): string {
	return name
		.replace(/[_-]+/g, ' ')
		.replace(/([a-z\d])([A-Z])/g, '$1 $2')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * A placeholder that looks like the value the prop actually holds, from its
 * NAME. `''`/`0`/`false` render as an empty component — "Example Title" and
 * `0.42` render as the thing the author designed.
 *
 * Order matters where names overlap: `nodeId` is an id, not a name, so the
 * id/url/date shapes are checked before the generic title|label|name one.
 */
export function synthesizePlaceholder(name: string | undefined, kind: 'string' | 'number' | 'boolean', index = 0): unknown {
	const n = (name ?? '').toLowerCase();
	const nth = index + 1;
	if (kind === 'boolean') {
		// Affirmative props read as "the interesting state is on".
		return /^(is|has|show|can)?_?(open|visible|enabled|active|selected|checked|expanded)$/.test(n);
	}
	if (kind === 'number') {
		// Vary with the index: synthesized list items are often keyed on a
		// number, and three identical ones make React warn about duplicate keys
		// — which reads as a broken component in the render sweep.
		if (/(count|total|length|size|index)$/.test(n)) {
			return SYNTH_ARRAY_ITEMS + index;
		}
		if (/(percent|pct|ratio|progress|opacity|rate)$/.test(n)) {
			// Stays inside [0, 1]: `opacity` is one of the names that lands here,
			// and a value above 1 is not a fraction any more.
			return Math.round((0.42 + index * 0.17) % 1 * 100) / 100;
		}
		if (/(width|height|radius|offset)$/.test(n)) {
			// merkle's `height` is a BLOCK height, not a pixel one, and
			// RecentMisses keys its list on `${m.height}-${m.recorded_at}`.
			// 320/321/322 is still a sane dimension either way.
			return 320 + index;
		}
		return 1 + index;
	}
	if (/(^|_)(id|key|uuid|slug)$/.test(n) || /[a-z](Id|Key|Uuid)$/.test(name ?? '')) {
		return `node-${nth}`;
	}
	if (/(href|url|src|link|image|avatar|logo)$/.test(n)) {
		return '#';
	}
	// `updatedAt` is camelCase, `updated_at` is snake — match both spellings
	// rather than a bare `at$`, which would also catch `format` and `chat`.
	if (/(_at|date|time|timestamp|since|until|ts)$/.test(n) || /(At|Date|Time)$/.test(name ?? '')) {
		// One day apart per item. A timestamp is the commonest thing a merkle
		// list is keyed or sorted on (`created_at`, `started_at`, `recorded_at`,
		// `ts`), and one shared instant makes three rows read as one. Computed
		// rather than table-driven so an array longer than three stays well-formed.
		return `2026-01-${String(1 + (index % 28)).padStart(2, '0')}T00:00:00Z`;
	}
	if (/(title|label|name|heading|caption|text|message|description|placeholder)$/.test(n)) {
		return `Example ${humanize(name ?? 'value')}${index ? ` ${nth}` : ''}`;
	}
	return index ? `text ${nth}` : 'text';
}

/** Split a union at depth 0: `A[] | null` → ['A[]', 'null']. A type with no
 *  top-level `|` comes back as a single element. */
function topLevelUnion(t: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	let prev = '';
	for (const ch of t) {
		if ('{(<['.includes(ch)) {
			depth++;
		} else if ('})>]'.includes(ch) && !(ch === '>' && prev === '=')) {
			depth = Math.max(0, depth - 1);
		}
		prev = ch;
		if (ch === '|' && depth === 0) {
			parts.push(current.trim());
			current = '';
		} else {
			current += ch;
		}
	}
	parts.push(current.trim());
	return parts.filter(Boolean);
}

/** The `T` of `T[]` / `Array<T>` / `ReadonlyArray<T>`. */
function elementType(t: string): string | undefined {
	const suffix = /^([\s\S]+)\[\]\s*$/.exec(t);
	if (suffix) {
		return suffix[1].trim();
	}
	const generic = /^(?:Readonly)?Array\s*<([\s\S]+)>\s*$/.exec(t);
	return generic ? generic[1].trim() : undefined;
}

/** Kind + JSON-safe placeholder (+ enum options) for a type expression. */
function typeOf(type: string, ctx: SynthCtx): { kind: PropKind; placeholder: unknown; options?: string[] } {
	const { clean, resolve, depth } = ctx;
	let t = type.trim();
	// `NodeOverview[] | null` is an ARRAY prop, but the array test only fires on
	// a type that ENDS in `[]`, so a nullable one used to fall through to `{}` —
	// and the component died on `.map is not a function`. Drop the null/undefined
	// branches; if one branch is left, that is the real type.
	const nonNull = topLevelUnion(t).filter(part => part !== 'null' && part !== 'undefined');
	if (nonNull.length === 1 && nonNull[0] !== t) {
		t = nonNull[0];
	}
	if (t.includes('=>')) {
		return { kind: 'function', placeholder: 'ƒ' };
	}
	if (COMPONENT_TYPE.test(t)) {
		return { kind: 'component', placeholder: 'ƒ' };
	}
	if (ELEMENT_TYPE.test(t)) {
		// Numbered inside an array for the same reason the scalars are: a
		// ReactNode member is text on the canvas, and three rows reading
		// "Sample" look like a component that rendered one row three times.
		// Index 0 keeps the bare word, so a top-level `children` is unchanged.
		return { kind: 'element', placeholder: ctx.index ? `Sample ${ctx.index + 1}` : 'Sample' };
	}
	// Literal union → enum. All top-level `|` branches must be quoted literals.
	if (/^['"]/.test(t)) {
		const options = t.split('|').map((p) => p.trim()).filter((p) => /^['"].*['"]$/.test(p)).map((p) => p.slice(1, -1));
		if (options.length) {
			// Walk the options across a synthesized array rather than repeating
			// the first: `TimeRange[]` came out as ['5m','5m','5m'], and a
			// dropdown keyed on its own option value showed one entry. Every
			// branch of a literal union is a valid value, so rotating is free.
			return { kind: 'enum', placeholder: options[(ctx.index ?? 0) % options.length], options };
		}
	}
	// Arrays before scalars — `number[]` must not match the `number` check.
	if (/\[\]\s*$/.test(t) || /^(Array|ReadonlyArray)\s*</.test(t)) {
		return { kind: 'array', placeholder: synthesizeArray(t, ctx) };
	}
	if (/^(Set|ReadonlySet)\s*</.test(t)) {
		// At the top level the schema's `set` kind tells the harness to revive it,
		// and the props panel shows the array. NESTED there is no schema — a Set
		// inside an array member arrived as a plain `[]` and merkle's
		// FilterPopover died on `g.selected.has is not a function` the moment the
		// popover opened. Below the top level it travels as a tagged object that
		// the harness knows how to turn back into a Set.
		return { kind: 'set', placeholder: ctx.depth > 0 ? { $set: [] } : [] };
	}
	if (/^(Map|ReadonlyMap|Record)\s*</.test(t)) {
		return { kind: 'json', placeholder: {} };
	}
	if (/^(string)\b/.test(t)) {
		return { kind: 'string', placeholder: spend(ctx, () => synthesizePlaceholder(ctx.name, 'string', ctx.index), '') };
	}
	if (/^(number)\b/.test(t)) {
		return { kind: 'number', placeholder: spend(ctx, () => synthesizePlaceholder(ctx.name, 'number', ctx.index), 0) };
	}
	if (/^(boolean|true|false)\b/.test(t)) {
		return { kind: 'boolean', placeholder: spend(ctx, () => synthesizePlaceholder(ctx.name, 'boolean', ctx.index), false) };
	}
	if (/^\{/.test(t)) {
		const body = braceBlock(t, t.indexOf('{'));
		return { kind: 'object', placeholder: body !== undefined && depth < ctx.limit ? nestedSkeleton(body, { ...ctx, depth: depth + 1 }) : {} };
	}
	// A union of more than one real branch. `AlertSeverity | 'all'` is neither a
	// pure literal union (it does not start with a quote) nor a single type, and
	// used to fall all the way through to `{}`. Take the first branch that
	// resolves to something real — a union's branches are interchangeable to the
	// component by construction, so any one of them is a valid value.
	//
	// Which branch is first rotates with the array index, for the same reason a
	// literal union rotates: merkle's `Annotation` is a five-arm discriminated
	// union, and taking arm one three times drew the same annotation three times
	// instead of the hline/vline/trendline the overlay is built to draw.
	if (nonNull.length > 1 && depth < ctx.limit) {
		// No depth hop. Picking an arm NARROWS a type, it does not nest inside one,
		// and charging for it cost merkle's `Annotation` its whole body: five arms
		// each needing one resolver hop, against a ceiling of three. Termination
		// does not rely on the counter — every arm is strictly shorter than the
		// union it came from.
		const start = (ctx.index ?? 0) % nonNull.length;
		for (let i = 0; i < nonNull.length; i++) {
			const each = typeOf(nonNull[(start + i) % nonNull.length], ctx);
			if (each.kind !== 'json') {
				return each;
			}
		}
	}
	// `keyof T` is a key of something — always a string, number or symbol, never
	// an object. `{}` here made merkle's DataTable index its rows by an object.
	if (/^keyof\s+\S/.test(t)) {
		return { kind: 'string', placeholder: spend(ctx, () => synthesizePlaceholder(ctx.name, 'string', ctx.index), '') };
	}
	// A bare identifier: a local alias, an imported type (one resolver hop), or
	// this component's own type PARAMETER. `TabItem<T>` is looked up as
	// `TabItem`: the argument is lost, which costs a nested member or two, and
	// is worth it against giving up on the whole type.
	const ident = /^([A-Z]\w*)\s*(?:<[\s\S]*>)?\s*$/.exec(t);
	if (ident) {
		// A type parameter is not declared anywhere to resolve — its CONSTRAINT is
		// the only thing known about it, and it is usually exactly right:
		// `Tabs<T extends string>` has `value: T`, which is a string, and merkle's
		// Tabs and RadioChipGroup both crashed rendering an object as a key.
		const param = new RegExp(`[<,]\\s*${ident[1]}\\s+extends\\s+([^,>]+)`).exec(clean);
		if (param && depth < ctx.limit) {
			return typeOf(param[1], { ...ctx, depth: depth + 1 });
		}
		// Newlines included, same as the resolver's copy: a union broken across
		// lines used to come back as its first arm alone.
		const local = new RegExp(`type\\s+${ident[1]}\\s*=\\s*([^;]{1,2000})(?:;|$)`).exec(clean);
		const aliased = local ? local[1].replace(/\s+/g, ' ').trim() : undefined;
		// A `{…}` alias is left to typeBody below: stopping at the first `;`
		// truncates an object literal mid-member, and braceBlock reads it whole.
		if (aliased && aliased !== t && !aliased.startsWith('{')) {
			return typeOf(aliased, ctx);
		}
		const localDecl = declarationOf(clean, ident[1]);
		if (localDecl && depth < ctx.limit) {
			const inner = { ...ctx, depth: depth + 1 };
			return { kind: 'object', placeholder: nestedSkeleton(withBases(localDecl.body, localDecl.bases, inner), inner) };
		}
		if (resolve && depth < ctx.limit) {
			const found = resolve(ident[1]);
			// Descend in the DECLARING file's context: its own local aliases and
			// its own imports, not the component's.
			const inner = { ...ctx, depth: depth + 1, clean: found?.source ?? clean, resolve: found?.nested ?? resolve };
			if (found?.alias) {
				return typeOf(found.alias, inner);
			}
			if (found?.body !== undefined) {
				return { kind: 'object', placeholder: nestedSkeleton(withBases(found.body, found.bases, inner), inner) };
			}
		}
	}
	return { kind: 'json', placeholder: {} };
}

/** Charge one node against the synthesis budget; past it, fall back to the
 *  zero-ish placeholder so a pathological type can't blow up the payload. */
function spend<T>(ctx: SynthCtx, synth: () => T, zero: T): T {
	if (ctx.budget.left <= 0) {
		return zero;
	}
	ctx.budget.left--;
	return synth();
}

/**
 * Three items of the element type, so a list/table/chart prop renders as one.
 * The element gets an extra depth hop (its own members are the point) and each
 * item carries its index, so synthesized strings and ids differ per row.
 */
function synthesizeArray(t: string, ctx: SynthCtx): unknown[] {
	const element = elementType(t);
	if (!element || ctx.depth >= SYNTH_MAX_DEPTH || ctx.budget.left <= 0) {
		return [];
	}
	const limit = Math.max(ctx.limit, SYNTH_MAX_DEPTH);
	const out: unknown[] = [];
	for (let i = 0; i < SYNTH_ARRAY_ITEMS && ctx.budget.left > 0; i++) {
		// Offset by the parent's position, so a nested array differs between the
		// items that hold it: three nodes each carrying the same three
		// `cluster_ids` reads as one node drawn three times. At the top level
		// ctx.index is undefined, so the ordinals stay 1, 2, 3.
		out.push(typeOf(element, { ...ctx, depth: ctx.depth + 1, limit, index: (ctx.index ?? 0) * SYNTH_ARRAY_ITEMS + i }).placeholder);
	}
	return out;
}

/**
 * A declaration's members plus every member it inherits, as one body.
 *
 * Bases come FIRST so the declaration's own members overwrite them — that is
 * what `interface X extends Y` means when both declare the same name, and
 * nestedSkeleton assigns in order. Bases are looked for locally before the
 * resolver is asked, because merkle declares AnnotationBase in the same file as
 * the five types that extend it. Bounded by `hops`: a base that extends itself
 * is a type error, but this file never assumes the input compiles.
 */
function withBases(body: string, bases: readonly string[] | undefined, ctx: SynthCtx, hops = 0): string {
	if (!bases || !bases.length || hops > 3) {
		return body;
	}
	const parts: string[] = [];
	for (const base of bases) {
		const local = declarationOf(ctx.clean, base);
		if (local) {
			parts.push(withBases(local.body, local.bases, ctx, hops + 1));
			continue;
		}
		const found = ctx.resolve?.(base);
		if (found?.body !== undefined) {
			parts.push(withBases(found.body, found.bases, { ...ctx, clean: found.source ?? ctx.clean, resolve: found.nested ?? ctx.resolve }, hops + 1));
		}
	}
	parts.push(body);
	return parts.join('\n');
}

/** Required members of a nested object type, as placeholder values. */
function nestedSkeleton(body: string, ctx: SynthCtx): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const member of splitMembers(body)) {
		const m = MEMBER.exec(member.trim());
		if (!m || m[2]) {
			continue;
		}
		const name = m[1].replace(/^['"]|['"]$/g, '');
		out[name] = typeOf(memberType(m), { ...ctx, name }).placeholder;
	}
	return out;
}

/**
 * Drop comments, keeping every line where it was.
 *
 * One left-to-right pass, because two regex passes cannot agree about who owns
 * a delimiter. The old pair — block comments first, line comments second — read
 * the `/*` inside this line
 *
 *     // …the /* envelope (snapshot-driven), so the math is identical…
 *
 * as the start of a block comment and deleted everything up to the next `*` `/`
 * anywhere in the file: 1 986 characters of merkle's Footprint.tsx, including
 * the `type FootprintLevel = 'me' | 'org' | 'superadmin'` its props depend on.
 * The parser then could not resolve `level`, fell back to the give-up value
 * `{}`, and the component died on `LEVEL_LOADER[level] is not a function`.
 * Measured across merkle: 57 of 441 source files (12.9 %) lost real code,
 * 62 684 characters in total (generator: scratchpad/ma/strip-damage.mjs).
 * The same fault ran the other way too — `'https://x'` had `//x` cut out of it.
 *
 * No regex-literal state is tracked, and none is needed: a regex cannot BEGIN
 * `//` (that is an empty regex) or `/*` (a quantifier with nothing to repeat),
 * so a comment opener is never ambiguous. A `/` inside a character class
 * (`/[/*]/`) would still fool it — as it fooled the old one, and as it does not
 * appear in any type declaration.
 */
export function stripComments(src: string): string {
	let out = '';
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const d = src[i + 1];
		if (c === '/' && d === '/') {
			// Up to but NOT including the newline: the parser's member regexes are
			// line-scoped, so losing a line break would join two declarations.
			while (i < src.length && src[i] !== '\n') { i++; }
		} else if (c === '/' && d === '*') {
			i += 2;
			while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
				if (src[i] === '\n') { out += '\n'; }
				i++;
			}
			i += 2;
		} else if (c === '\'' || c === '"' || c === '`') {
			// Kept verbatim. A template literal's `${…}` is not descended into, so a
			// backtick nested inside one ends it early — which costs nothing here,
			// because a type declaration never lives inside a template.
			out += c;
			i++;
			while (i < src.length && src[i] !== c) {
				if (src[i] === '\\') { out += src[i]; i++; }
				if (i < src.length) { out += src[i]; i++; }
			}
			if (i < src.length) { out += src[i]; i++; }
		} else {
			out += c;
			i++;
		}
	}
	return out;
}
