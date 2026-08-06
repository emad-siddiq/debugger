/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Unit tests for the props-schema parser and its type resolver
// (out/propsSkeleton.js + out/typeResolver.js — neither imports 'vscode').
//
// These cover the SYNTH rung of the props ladder: the only rung that invents
// values rather than reporting ones somebody produced, and therefore the only
// one that can be wrong rather than merely absent. Every case here is one that
// made a real merkle component render its error branch.

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parsePropsSchema, stripComments } = require('../out/propsSkeleton');
const { makeTypeResolver } = require('../out/typeResolver');

// ---- stripComments ---------------------------------------------------------

// The one that cost the most: stripping block comments first and line comments
// second lets a `/*` sitting inside a `//` comment open a block that runs to
// the next `*/` anywhere in the file.
{
	const src = [
		'// the /* envelope is snapshot-driven',
		'// so the math is the same',
		"export type Level = 'me' | 'org';",
		'/* a real block comment */',
		'interface Props { level: Level; }',
	].join('\n');
	const clean = stripComments(src);
	assert.ok(clean.includes("export type Level = 'me' | 'org';"), 'a /* inside a line comment ate the code after it');
	assert.ok(clean.includes('interface Props'), 'the props interface was eaten');
	assert.ok(!clean.includes('envelope'), 'the line comment survived');
	assert.ok(!clean.includes('a real block comment'), 'the block comment survived');
}

// A `//` inside a string is not a comment. The old stripper cut `https://x`
// down to `'https:`, which broke the declaration it appeared in.
{
	const clean = stripComments("const u = 'https://example.com/x'; interface Props { a: string; }");
	assert.ok(clean.includes('https://example.com/x'), 'a URL in a string lost its path');
	assert.ok(clean.includes('interface Props'));
}

// Line structure is preserved: the parser's member regexes are line-scoped, so
// a swallowed newline would join two declarations into one.
{
	const src = 'a\n/* one\ntwo\nthree */\nb';
	assert.strictEqual(stripComments(src).split('\n').length, src.split('\n').length);
}

// ---- type parameters, keyof, mixed unions ----------------------------------

// `Tabs<T extends string>` has `value: T`. T is declared nowhere, so it used to
// become the give-up value `{}` — and merkle's Tabs rendered an object as a
// React key.
{
	const src = `
		interface TabsProps<T extends string> { value: T; label: string; }
		export function Tabs<T extends string>({ value, label }: TabsProps<T>) { return null; }
	`;
	const schema = parsePropsSchema(src, 'Tabs');
	const value = schema.specs.find(s => s.name === 'value');
	assert.strictEqual(value.kind, 'string', 'a type parameter should take its constraint');
	assert.strictEqual(typeof schema.skeleton.value, 'string');
}

// `keyof T` is a key — string, number or symbol, never an object.
{
	const schema = parsePropsSchema('interface DataTableProps { keyField: keyof Row; }', 'DataTable');
	assert.strictEqual(schema.specs[0].kind, 'string');
}

// `AlertSeverity | 'all'` is neither a pure literal union nor a single type.
// The first branch that resolves to something real wins.
{
	const src = `
		type AlertSeverity = 'info' | 'warn' | 'critical';
		interface BannerProps { severityFilter: AlertSeverity | 'all'; }
	`;
	const schema = parsePropsSchema(src, 'Banner');
	assert.strictEqual(schema.skeleton.severityFilter, 'info');
}

// A generic type REFERENCE resolves by name; the argument is dropped rather
// than the whole type given up on.
{
	const src = `
		interface TabItem { value: string; label: string; }
		interface TabsProps { items: TabItem<string>[]; }
	`;
	const schema = parsePropsSchema(src, 'Tabs');
	assert.strictEqual(schema.specs[0].kind, 'array');
	assert.ok(Object.keys(schema.skeleton.items[0]).length > 0, 'generic reference gave up and produced {}');
}

// ---- the resolver: aliased imports, declaring-file context, barrels --------

function fixture(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-props-'));
	for (const [rel, text] of Object.entries(files)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, text);
	}
	return root;
}

// `import type { Panel as PanelType }` is USED as PanelType but DECLARED as
// Panel. Searching the declaring file for the local alias found nothing, and
// merkle's Panel, Dashboard, FullscreenPanel and QuickExpandOverlay all took
// the give-up value because of it.
{
	const root = fixture({
		'src/types.ts': 'export interface Panel { id: string; title: string; }',
		'src/panel/Panel.tsx': [
			"import type { Panel as PanelType } from '@/types';",
			'interface PanelProps { panel: PanelType; }',
			'export function Panel({ panel }: PanelProps) { return null; }',
		].join('\n'),
	});
	const abs = path.join(root, 'src/panel/Panel.tsx');
	const schema = parsePropsSchema(fs.readFileSync(abs, 'utf8'), 'Panel', makeTypeResolver(abs, root));
	assert.strictEqual(schema.specs[0].kind, 'object', 'an aliased import did not resolve');
	assert.deepStrictEqual(Object.keys(schema.skeleton.panel).sort(), ['id', 'title']);
}

// A body resolved out of another file has to be read in THAT file's context.
// `ValidatorGridRow.status: ValidatorStatus` is declared beside it, invisible
// from the component that imports only the row type.
{
	const root = fixture({
		'src/lib/grid.ts': [
			"export type ValidatorStatus = 'active' | 'jailed';",
			'export interface Row { address: string; status: ValidatorStatus; }',
		].join('\n'),
		'src/rows/Rows.tsx': [
			"import type { Row } from '@/lib/grid';",
			'export function Rows({ row }: { row: Row }) { return null; }',
		].join('\n'),
	});
	const abs = path.join(root, 'src/rows/Rows.tsx');
	const schema = parsePropsSchema(fs.readFileSync(abs, 'utf8'), 'Rows', makeTypeResolver(abs, root));
	assert.strictEqual(schema.skeleton.row.status, 'active', 'a nested type declared beside the declaration did not resolve');
}

// A re-export barrel: the file the import names does not declare the type, it
// forwards it. merkle routes most of its API types through `@/api/client`.
{
	const root = fixture({
		'src/lib/grid.ts': 'export interface Cohort { median: number; n: number; }',
		'src/api/client.ts': "export type { Cohort as CohortStats } from '@/lib/grid';",
		'src/band/Band.tsx': [
			"import type { CohortStats } from '@/api/client';",
			'interface BandProps { cohort: CohortStats | null; }',
			'export function Band({ cohort }: BandProps) { return null; }',
		].join('\n'),
	});
	const abs = path.join(root, 'src/band/Band.tsx');
	const schema = parsePropsSchema(fs.readFileSync(abs, 'utf8'), 'Band', makeTypeResolver(abs, root));
	assert.deepStrictEqual(Object.keys(schema.skeleton.cohort).sort(), ['median', 'n'], 'a re-export barrel was not followed');
}

// `export * from` too — the name is not listed, so every barrel has to be asked.
{
	const root = fixture({
		'src/lib/grid.ts': 'export interface Cohort { median: number; }',
		'src/api/client.ts': "export * from '@/lib/grid';",
		'src/band/Band.tsx': [
			"import type { Cohort } from '@/api/client';",
			'export function Band({ cohort }: { cohort: Cohort }) { return null; }',
		].join('\n'),
	});
	const abs = path.join(root, 'src/band/Band.tsx');
	const schema = parsePropsSchema(fs.readFileSync(abs, 'utf8'), 'Band', makeTypeResolver(abs, root));
	assert.deepStrictEqual(Object.keys(schema.skeleton.cohort), ['median'], 'export * was not followed');
}

// A barrel that re-exports itself must not hang.
{
	const root = fixture({
		'src/a.ts': "export * from '@/b';",
		'src/b.ts': "export * from '@/a';",
		'src/C.tsx': [
			"import type { Nope } from '@/a';",
			'export function C({ x }: { x: Nope }) { return null; }',
		].join('\n'),
	});
	const abs = path.join(root, 'src/C.tsx');
	const schema = parsePropsSchema(fs.readFileSync(abs, 'utf8'), 'C', makeTypeResolver(abs, root));
	assert.deepStrictEqual(schema.skeleton.x, {}, 'an unresolvable type should still give up, quietly');
}

// ---- synthesized collections ----------------------------------------------

// Three items of a list must be distinct, because a list component keys its
// rows on a member of the item. Seven of the render sweep's seventeen failures
// were React key warnings from three identical rows.
{
	const src = `
		type Severity = 'info' | 'warn' | 'critical';
		interface Row { id: string; created_at: string; severity: Severity; height: number; }
		export function Rows({ rows }: { rows: Row[] }) { return null; }
	`;
	const { rows } = parsePropsSchema(src, 'Rows').skeleton;
	assert.strictEqual(rows.length, 3);
	for (const member of ['id', 'created_at', 'severity', 'height']) {
		const seen = new Set(rows.map(r => r[member]));
		assert.strictEqual(seen.size, 3, `every row got the same ${member}: ${[...seen].join(', ')}`);
	}
	// A rotated enum still takes real branches, and a varied timestamp is still
	// a timestamp — distinctness must not cost well-formedness.
	assert.ok(rows.every(r => ['info', 'warn', 'critical'].includes(r.severity)));
	assert.ok(rows.every(r => !Number.isNaN(Date.parse(r.created_at))));
	// A ratio stays inside [0, 1] however far the index runs.
	const many = parsePropsSchema('interface PProps { bars: { opacity: number }[]; }', 'P').skeleton.bars;
	assert.ok(many.every(b => b.opacity >= 0 && b.opacity <= 1), JSON.stringify(many));
}

// A scalar prop is at index 0 and must be unchanged by all of the above — the
// rotation exists for lists, and a top-level enum still reads as its first arm.
{
	const src = `
		type Severity = 'info' | 'warn';
		interface PProps { severity: Severity; created_at: string; children: React.ReactNode; }
	`;
	const s = parsePropsSchema(src, 'P').skeleton;
	assert.strictEqual(s.severity, 'info');
	assert.strictEqual(s.created_at, '2026-01-01T00:00:00Z');
	assert.strictEqual(s.children, 'Sample');
}

// A union alias broken across lines. merkle writes every wide union this way,
// and reading only its first line cost `TimeRange` four arms — and cost
// `Annotation` its entire body, because one arm is not a union and resolving
// it needed a hop the truncation had already spent.
{
	const src = `
		type TimeRange =
			| '5m'
			| '1h'
			| '24h';
		interface PProps { range: TimeRange; ranges: TimeRange[]; }
	`;
	const s = parsePropsSchema(src, 'P').skeleton;
	assert.strictEqual(s.range, '5m');
	assert.deepStrictEqual(s.ranges, ['5m', '1h', '24h'], 'a multi-line union alias lost its arms');
}

// A discriminated union of named object types renders its arms, not arm one
// three times.
{
	const root = fixture({
		'src/types.ts': [
			'export interface HLine { type: "hline"; v: number; }',
			'export interface VLine { type: "vline"; ts: number; }',
			'export type Annotation =',
			'  | HLine',
			'  | VLine;',
		].join('\n'),
		'src/o/Overlay.tsx': [
			"import type { Annotation } from '@/types';",
			'export function Overlay({ items }: { items: Annotation[] }) { return null; }',
		].join('\n'),
	});
	const abs = path.join(root, 'src/o/Overlay.tsx');
	const items = parsePropsSchema(fs.readFileSync(abs, 'utf8'), 'Overlay', makeTypeResolver(abs, root)).skeleton.items;
	assert.deepStrictEqual(items.map(i => i.type), ['hline', 'vline', 'hline'], JSON.stringify(items));
	assert.strictEqual(typeof items[0].v, 'number', 'the arm resolved to a name but not to a body');
	assert.strictEqual(typeof items[1].ts, 'number');
}

// A `{…}` alias is read whole. Stopping at the first `;` would truncate it
// mid-member, which is why the alias branch hands it to the brace reader.
{
	const s = parsePropsSchema('type Scale = {\n width: number;\n height: number;\n};\ninterface PProps { scale: Scale; }', 'P').skeleton;
	assert.deepStrictEqual(Object.keys(s.scale).sort(), ['height', 'width']);
}

// A function member written as method shorthand. `valueToY(v: number): number`
// has no `:` after the name, so it was not a member at all and merkle's
// AnnotationOverlay got a `scale` object with none of its four methods on it.
{
	const src = `
		interface Scale { valueToY(v: number): number; width: number; render?(): void; }
		interface OverlayProps { scale: Scale; }
	`;
	const s = parsePropsSchema(src, 'Overlay').skeleton;
	assert.strictEqual(s.scale.valueToY, 'ƒ', JSON.stringify(s.scale));
	assert.strictEqual(s.scale.width, 320, 'the ordinary member beside it was lost');
	assert.ok(!('render' in s.scale), 'an optional member is not synthesized');
}

// A Set below the top level travels tagged. The harness reads the schema, and
// the schema stops at the top level — so a nested Set arrived as a plain array
// and merkle's FilterPopover died on `g.selected.has is not a function`.
{
	const s = parsePropsSchema('interface PProps { picked: Set<string>; groups: { selected: Set<string> }[]; }', 'P').skeleton;
	assert.deepStrictEqual(s.picked, [], 'a top-level Set is carried by its schema kind and must not change shape');
	assert.deepStrictEqual(s.groups[0].selected, { $set: [] }, JSON.stringify(s.groups[0]));
}

// ---- inherited members -----------------------------------------------------

// `interface HLine extends AnnotationBase` inherits id, color and created_at,
// and AnnotationOverlay keys its list on that inherited `id`. The heritage
// clause used to be swallowed by the declaration regex and thrown away.
{
	const src = `
		interface Base { id: string; color: string; }
		interface HLine extends Base { type: 'hline'; v: number; }
		interface OverlayProps { items: HLine[]; }
	`;
	const items = parsePropsSchema(src, 'Overlay').skeleton.items;
	assert.deepStrictEqual(Object.keys(items[0]).sort(), ['color', 'id', 'type', 'v'], JSON.stringify(items[0]));
	assert.strictEqual(items[0].id, 'node-1');
	assert.notStrictEqual(items[1].id, items[0].id, 'the inherited key is the one the list is keyed on');
}

// Own members win over inherited ones with the same name, which is what
// `extends` means, and a base declared in another file resolves too.
{
	const root = fixture({
		'src/base.ts': 'export interface Base { kind: string; shared: number; }',
		'src/w/Widget.tsx': [
			"import type { Base } from '@/base';",
			"interface Row extends Base { kind: 'row'; }",
			'export function Widget({ row }: { row: Row }) { return null; }',
		].join('\n'),
	});
	const abs = path.join(root, 'src/w/Widget.tsx');
	const row = parsePropsSchema(fs.readFileSync(abs, 'utf8'), 'Widget', makeTypeResolver(abs, root)).skeleton.row;
	assert.strictEqual(row.kind, 'row', 'the base overwrote the declaration that extends it');
	assert.strictEqual(typeof row.shared, 'number', 'an imported base was not resolved');
}

// A DOM heritage clause is deliberately NOT followed. 12 of merkle's 22
// `extends` clauses are `Omit<HTMLAttributes<…>, 'className'>`, whose members
// are optional attributes no component reads.
{
	const src = "interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'className'>, Flags { tone: string; }\ninterface Flags { invalid: boolean; }";
	const s = parsePropsSchema(src, 'Badge').skeleton;
	assert.ok(!('dir' in s) && !('slot' in s), 'DOM attributes leaked into the skeleton');
	assert.strictEqual(s.tone, 'text');
	assert.strictEqual(typeof s.invalid, 'boolean', 'a plain base beside the DOM one was dropped with it');
}

// A nested array is offset by its parent's position, so three rows do not each
// carry the same three children.
{
	const src = 'interface PProps { rows: { tags: string[] }[]; }';
	const rows = parsePropsSchema(src, 'P').skeleton.rows;
	assert.strictEqual(rows.length, 3);
	assert.ok(rows[0].tags.length > 0, 'the nested array is past the depth ceiling');
	assert.notDeepStrictEqual(rows[0].tags, rows[1].tags, 'every row got the same children');
}

console.log('propsSkeleton.test.js: ok');
