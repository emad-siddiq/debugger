/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit tests for the Refactor list's kind grouping. refactorKinds.ts
// imports nothing from 'vscode' — LSP code-action kinds are dotted strings — so
// out/refactorKinds.js is a clean CommonJS module. Run: `npm test` or
// `node test/refactorKinds.test.js`.

'use strict';

const assert = require('node:assert');
const { groupFor, GROUP_ORDER, OFFERED_KINDS } = require('../out/refactorKinds');

// gopls' actual code-action kinds, from its own doc/features/transformation.md,
// diagnostics.md and web.md. This is the vocabulary the list has to handle; a
// grouping proved against invented kinds proves nothing.
const GOPLS_KINDS = {
	'refactor.extract': 'Extract',
	'refactor.extract.function': 'Extract',
	'refactor.extract.method': 'Extract',
	'refactor.extract.variable': 'Extract',
	'refactor.extract.constant': 'Extract',
	'refactor.extract.toNewFile': 'Extract',
	'refactor.inline.call': 'Inline',
	'refactor.inline.variable': 'Inline',
	'refactor.rewrite.removeUnusedParam': 'Rewrite',
	'refactor.rewrite.moveParamLeft': 'Rewrite',
	'refactor.rewrite.moveParamRight': 'Rewrite',
	'refactor.rewrite.changeQuote': 'Rewrite',
	'refactor.rewrite.invertIf': 'Rewrite',
	'refactor.rewrite.splitLines': 'Rewrite',
	'refactor.rewrite.joinLines': 'Rewrite',
	'refactor.rewrite.fillStruct': 'Rewrite',
	'refactor.rewrite.fillSwitch': 'Rewrite',
	'refactor.rewrite.eliminateDotImport': 'Rewrite',
	'refactor.rewrite.addTags': 'Rewrite',
	'refactor.rewrite.removeTags': 'Rewrite',
	'source.addTest': 'Generate',
	'quickfix': 'Fix',
	'quickfix.stubMissingInterfaceMethods': 'Fix',
};

const cases = {
	'every gopls refactoring kind lands in a group': () => {
		for (const [kind, expected] of Object.entries(GOPLS_KINDS)) {
			assert.strictEqual(groupFor(kind), expected, `${kind} grouped wrong`);
		}
	},

	'the longest matching prefix wins': () => {
		// `refactor.extract.function` matches both `refactor` and
		// `refactor.extract`; grouping it under the broader one would scatter every
		// extract across two headings.
		assert.strictEqual(groupFor('refactor.extract.function'), 'Extract');
		assert.strictEqual(groupFor('refactor.inline.call'), 'Inline');
		// A kind with no more specific match still gets the general bucket.
		assert.strictEqual(groupFor('refactor.move'), 'Refactor');
	},

	'matching is on whole dotted segments, not raw prefixes': () => {
		// The bug a plain startsWith would introduce: a future
		// `refactor.extractAll` is not a member of `refactor.extract`.
		assert.strictEqual(groupFor('refactor.extractAll'), 'Refactor');
		assert.strictEqual(groupFor('quickfixup'), undefined);
		assert.strictEqual(groupFor('sourcemap'), undefined);
	},

	'actions that are not refactorings are left out': () => {
		// organizeImports already runs on save; listing it makes the list longer
		// without making it more useful.
		assert.strictEqual(groupFor('source.organizeImports'), undefined);
		assert.strictEqual(groupFor('source.fixAll'), undefined);
		// gopls' web views open a browser rather than editing anything.
		assert.strictEqual(groupFor('source.doc'), undefined);
		assert.strictEqual(groupFor('source.assembly'), undefined);
		assert.strictEqual(groupFor('source.freesymbols'), undefined);
	},

	'an absent or empty kind is not a group': () => {
		assert.strictEqual(groupFor(undefined), undefined);
		assert.strictEqual(groupFor(''), undefined);
	},

	'every offered kind has a heading, and every heading is ordered': () => {
		const groups = new Set(OFFERED_KINDS.map(k => k.group));
		assert.deepStrictEqual([...groups].sort(), [...GROUP_ORDER].sort(),
			'a group with no place in GROUP_ORDER would silently never render');
	},

	'the quick fixes that generate code are reachable': () => {
		// These are three of the code-generation rows IntelliJ is measured on, and
		// gopls delivers them as quick fixes rather than refactorings. Dropping
		// `quickfix` for a tidier taxonomy would lose all three.
		for (const kind of ['quickfix', 'quickfix.stubMissingInterfaceMethods']) {
			assert.strictEqual(groupFor(kind), 'Fix');
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
