/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the ⇧⌘F search seed (plan 01 §3, WO-02). seed.ts
// imports nothing from 'vscode', so out/seed.js is a clean CommonJS module we
// require directly. Run: `npm test` (after a compile) or `node test/seed.test.js`.

'use strict';

const assert = require('node:assert');
const { seedFromSelection, MAX_SEED_LENGTH } = require('../out/seed');

/** A one-line selection from `line`. */
const oneLine = (line = 4) => ({ isEmpty: false, start: { line }, end: { line } });

const cases = {
	'a one-line selection is the search term': () => {
		assert.strictEqual(seedFromSelection(oneLine(), 'seedFromSelection'), 'seedFromSelection');
	},
	'surrounding whitespace is trimmed': () => {
		assert.strictEqual(seedFromSelection(oneLine(), '  Collator\t'), 'Collator');
	},
	'no selection seeds nothing': () => {
		assert.strictEqual(seedFromSelection(undefined, ''), undefined);
	},
	'an empty (caret) selection seeds nothing': () => {
		assert.strictEqual(seedFromSelection({ isEmpty: true, start: { line: 1 }, end: { line: 1 } }, ''), undefined);
	},
	'a whitespace-only selection seeds nothing': () => {
		assert.strictEqual(seedFromSelection(oneLine(), '   \t '), undefined);
	},
	'a multi-line selection seeds nothing (the box is single-line)': () => {
		const multi = { isEmpty: false, start: { line: 4 }, end: { line: 9 } };
		assert.strictEqual(seedFromSelection(multi, 'func Foo() {\n\treturn\n}'), undefined);
	},
	'a selection at the length limit still seeds': () => {
		const text = 'x'.repeat(MAX_SEED_LENGTH);
		assert.strictEqual(seedFromSelection(oneLine(), text), text);
	},
	'a selection past the length limit is prose, not a term': () => {
		assert.strictEqual(seedFromSelection(oneLine(), 'x'.repeat(MAX_SEED_LENGTH + 1)), undefined);
	},
	'trimming is applied before the length check': () => {
		const text = 'x'.repeat(MAX_SEED_LENGTH);
		assert.strictEqual(seedFromSelection(oneLine(), `  ${text}  `), text);
	},
};

let failed = 0;
for (const [name, run] of Object.entries(cases)) {
	try {
		run();
		console.log(`  ok  ${name}`);
	} catch (err) {
		failed++;
		console.error(`FAIL  ${name}\n      ${err && err.message}`);
	}
}
console.log(`${Object.keys(cases).length - failed}/${Object.keys(cases).length} passed`);
process.exit(failed ? 1 : 0);
