/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit tests for the Browse list. webActions.ts imports nothing from
// 'vscode' — LSP code-action kinds are dotted strings — so out/webActions.js is a
// clean CommonJS module. Run: `npm test` or `node test/webActions.test.js`.

'use strict';

const assert = require('node:assert');
const { browseOffers, BROWSE_KINDS } = require('../out/webActions');

// Measured: the `source`-family actions a live gopls v0.20.0 offered on
// `type Rect struct {` in a real module. Grouping proved against invented kinds
// proves nothing.
const REAL_ACTIONS = [
	{ kind: 'source.doc', title: 'Browse documentation for type Rect' },
	{ kind: 'source.freesymbols', title: 'Browse free symbols' },
	{ kind: 'source.splitPackage', title: 'Split package "shapes"' },
	{ kind: 'source.toggleCompilerOptDetails', title: 'Show compiler optimization details for "shapes"' },
];

const cases = {
	'the two browsable actions gopls really offered are picked out': () => {
		const offers = browseOffers(REAL_ACTIONS);
		assert.deepStrictEqual(offers.map(o => o.label), ['Documentation', 'Free Symbols']);
	},

	'gopls own title becomes the detail line': () => {
		const offers = browseOffers(REAL_ACTIONS);
		assert.strictEqual(offers[0].detail, 'Browse documentation for type Rect',
			'"Browse documentation for type Rect" says more than "Documentation" does');
	},

	'the order is ours, not the providers': () => {
		// Reversed input, same output order — otherwise the list reshuffles between
		// two adjacent lines and the reader has to re-read it every time.
		const offers = browseOffers([...REAL_ACTIONS].reverse());
		assert.deepStrictEqual(offers.map(o => o.label), ['Documentation', 'Free Symbols']);
	},

	'assembly is offered where gopls offers it': () => {
		const offers = browseOffers([{ kind: 'source.assembly', title: 'Browse assembly for Rect.Area' }]);
		assert.deepStrictEqual(offers.map(o => o.label), ['Assembly']);
	},

	'actions that are not web views are left out': () => {
		// splitPackage and toggleCompilerOptDetails are in REAL_ACTIONS above and
		// must not appear: one rewrites files, the other toggles a decoration.
		const labels = browseOffers(REAL_ACTIONS).map(o => o.label);
		assert.ok(!labels.includes('Split package "shapes"'));
		assert.strictEqual(browseOffers([
			{ kind: 'refactor.extract.function', title: 'Extract function' },
			{ kind: 'quickfix', title: 'Use strings.ReplaceAll instead' },
			{ kind: 'source.organizeImports', title: 'Organize Imports' },
		]).length, 0);
	},

	'matching is on whole dotted segments': () => {
		// The bug a plain startsWith would introduce: `source.documentation` is a
		// different action that merely begins with `source.doc`.
		assert.strictEqual(browseOffers([{ kind: 'source.documentation', title: 'x' }]).length, 0);
		// A dotted child of a browse kind IS one, though.
		assert.strictEqual(browseOffers([{ kind: 'source.doc.package', title: 'x' }])[0].label, 'Documentation');
	},

	'an action with no kind is not a browse action': () => {
		assert.strictEqual(browseOffers([{ title: 'something' }]).length, 0);
		assert.strictEqual(browseOffers([]).length, 0);
	},

	'every declared kind is distinct and labelled': () => {
		const kinds = BROWSE_KINDS.map(k => k.kind);
		assert.strictEqual(new Set(kinds).size, kinds.length, 'a duplicated kind would list the same action twice');
		for (const k of BROWSE_KINDS) {
			assert.ok(k.label && k.detail, `${k.kind} needs both a label and a fallback detail`);
		}
	},
};

let failed = 0;
for (const [name, run] of Object.entries(cases)) {
	try {
		run();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failed++;
		console.error(`  ✗ ${name}\n    ${err.message}`);
	}
}
const total = Object.keys(cases).length;
console.log(`${total - failed}/${total} passed`);
process.exit(failed === 0 ? 0 : 1);
