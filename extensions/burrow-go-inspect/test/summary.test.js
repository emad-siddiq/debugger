/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the Go value summary registry. summary.ts imports
// nothing from 'vscode', so out/summary.js is a clean CommonJS module we can
// require directly — no test harness, no workbench. Run: `npm test` (after a
// compile) or `node test/summary.test.js`.

'use strict';

const assert = require('node:assert');
const { summarize, briefFromChildren } = require('../out/summary');

/** A DAP Variable with sensible defaults; override per case. */
function v(over) {
	return Object.assign({ name: 'x', value: '', type: '', variablesReference: 0 }, over);
}

const cases = {
	'nil pointer reads as nil': () => {
		const s = summarize(v({ value: 'nil', type: '*main.User' }));
		assert.deepStrictEqual(s, { text: 'nil', expandable: false, kind: 'nil' });
	},
	'duration: seconds compose h/m/s': () => {
		assert.strictEqual(summarize(v({ value: '180000000000', type: 'time.Duration' })).text, '3m0s');
	},
	'duration: milliseconds': () => {
		assert.strictEqual(summarize(v({ value: '250000000', type: 'time.Duration' })).text, '250ms');
	},
	'duration: fractional micros': () => {
		assert.strictEqual(summarize(v({ value: '1500', type: 'time.Duration' })).text, '1.5µs');
	},
	'time.Time classifies as time, passes value through': () => {
		const s = summarize(v({ value: '2026-07-09 14:03:11', type: 'time.Time', variablesReference: 3 }));
		assert.strictEqual(s.kind, 'time');
		assert.strictEqual(s.text, '2026-07-09 14:03:11');
	},
	'error passes the message through': () => {
		const s = summarize(v({ value: 'conn refused', type: 'error' }));
		assert.strictEqual(s.kind, 'error');
		assert.strictEqual(s.text, 'conn refused');
	},
	'pointer base is *T <addr>, expandable': () => {
		const s = summarize(v({ value: '0xc00009c018', type: '*main.User', variablesReference: 5 }));
		assert.deepStrictEqual(s, { text: '*main.User 0xc00009c018', expandable: true, kind: 'pointer' });
	},
	// dlv sends `namedVariables: 1` for every map — that is its lone `len()`
	// metadata row, not the key count, which arrives as `indexedVariables`.
	// Reading named here rendered a 10,000-key map as "(1)" (WO-9 defect 2).
	'map counts keys from indexedVariables, ignoring dlv\'s namedVariables: 1': () => {
		const s = summarize(v({ value: '(loaded 64/10000) map[string]main.Node [...]', type: 'map[string]main.Node', variablesReference: 6, namedVariables: 1, indexedVariables: 10000 }));
		assert.strictEqual(s.text, 'map[string]main.Node (10000)');
		assert.strictEqual(s.kind, 'map');
	},
	'map falls back to a parenthesized count in the value': () => {
		const s = summarize(v({ value: 'map[string]int (17)', type: 'map[string]int', variablesReference: 6 }));
		assert.strictEqual(s.text, 'map[string]int (17)');
	},
	'[]uint8 renders as []byte len=N': () => {
		const s = summarize(v({ value: '[]uint8 len: 4, cap: 8', type: '[]uint8', variablesReference: 7, indexedVariables: 4 }));
		assert.strictEqual(s.text, '[]byte len=4');
		assert.strictEqual(s.kind, 'bytes');
	},
	'slice: len from indexedVariables, cap parsed from value, element dump dropped': () => {
		const s = summarize(v({ value: '[]int len: 5, cap: 8, [2,3,5,7,11]', type: '[]int', variablesReference: 8, indexedVariables: 5 }));
		assert.strictEqual(s.text, '[]int len=5 cap=8');
		assert.strictEqual(s.kind, 'slice');
	},
	'slice: len+cap both parsed from value when DAP counts absent': () => {
		const s = summarize(v({ value: '[]int len: 5, cap: 8', type: '[]int', variablesReference: 8 }));
		assert.strictEqual(s.text, '[]int len=5 cap=8');
	},
	'array length is already in the type': () => {
		const s = summarize(v({ value: '[3]int [1,2,3]', type: '[3]int', variablesReference: 9 }));
		assert.strictEqual(s.text, '[3]int');
		assert.strictEqual(s.kind, 'array');
	},
	'chan classifies as chan': () => {
		assert.strictEqual(summarize(v({ value: 'chan int 0xc000074060', type: 'chan int', variablesReference: 10 })).kind, 'chan');
	},
	'string passes dlv-quoted value through': () => {
		const s = summarize(v({ value: '"hello"', type: 'string' }));
		assert.deepStrictEqual(s, { text: '"hello"', expandable: false, kind: 'string' });
	},
	'bool is a scalar': () => {
		assert.deepStrictEqual(summarize(v({ value: 'true', type: 'bool' })), { text: 'true', expandable: false, kind: 'bool' });
	},
	'int is a number scalar': () => {
		assert.deepStrictEqual(summarize(v({ value: '42', type: 'int' })), { text: '42', expandable: false, kind: 'number' });
	},
	'float64 is a number scalar': () => {
		assert.strictEqual(summarize(v({ value: '0.973', type: 'float64' })).kind, 'number');
	},
	'struct condenses to its field body': () => {
		const s = summarize(v({ value: 'main.User {Id: 42, Name: "neo"}', type: 'main.User', variablesReference: 11 }));
		assert.strictEqual(s.text, '{Id: 42, Name: "neo"}');
		assert.strictEqual(s.kind, 'struct');
		assert.strictEqual(s.expandable, true);
	},
	'struct with no inline body falls back to type {…}': () => {
		const s = summarize(v({ value: 'main.User', type: 'main.User', variablesReference: 11 }));
		assert.strictEqual(s.text, 'main.User {…}');
	},
	'briefFromChildren caps at 3 fields with an ellipsis': () => {
		const b = briefFromChildren([
			{ name: 'Id', value: '42' },
			{ name: 'Name', value: '"neo"' },
			{ name: 'Age', value: '30' },
			{ name: 'X', value: '1' },
		]);
		assert.strictEqual(b, '{Id: 42, Name: "neo", Age: 30, …}');
	},
	'briefFromChildren of nothing is {}': () => {
		assert.strictEqual(briefFromChildren([]), '{}');
	},
	'long values are truncated to <= 80 with an ellipsis': () => {
		const long = 'x'.repeat(200);
		const s = summarize(v({ value: long, type: 'string' }));
		assert.ok(s.text.length <= 80, `expected <= 80, got ${s.text.length}`);
		assert.ok(s.text.endsWith('…'));
	},
};

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
	try {
		fn();
		console.log(`ok   — ${name}`);
	} catch (err) {
		failed++;
		console.error(`FAIL — ${name}\n       ${err.message}`);
	}
}

const total = Object.keys(cases).length;
console.log(`\n${total - failed}/${total} passed`);
if (failed > 0) {
	process.exit(1);
}
