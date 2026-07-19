/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the "copy as Go literal" renderer (value pane, WO-5).
// literal.ts imports only from summary.ts (both vscode-free), so out/literal.js is
// a clean CommonJS module we require directly. Run: `npm test` (after a compile)
// or `node test/literal.test.js`.

'use strict';

const assert = require('node:assert');
const { toGoLiteral } = require('../out/literal');

/** A DAP Variable with sensible defaults; override per case. */
function v(over) {
	return Object.assign({ name: 'x', value: '', type: '', variablesReference: 0 }, over);
}

const cases = {
	'nil pointer copies as nil': () => {
		assert.strictEqual(toGoLiteral(v({ value: 'nil', type: '*main.User' })), 'nil');
	},
	'already-quoted string passes through unchanged': () => {
		assert.strictEqual(toGoLiteral(v({ value: '"leaf"', type: 'string' })), '"leaf"');
	},
	'unquoted string gets quoted': () => {
		assert.strictEqual(toGoLiteral(v({ value: 'leaf', type: 'string' })), '"leaf"');
	},
	'string with a quote inside is JSON-escaped': () => {
		assert.strictEqual(toGoLiteral(v({ value: 'a"b', type: 'string' })), '"a\\"b"');
	},
	'int copies verbatim, trimmed': () => {
		assert.strictEqual(toGoLiteral(v({ value: ' 42 ', type: 'int' })), '42');
	},
	'bool copies verbatim': () => {
		assert.strictEqual(toGoLiteral(v({ value: 'true', type: 'bool' })), 'true');
	},
	'struct falls back to dlv value string, trimmed': () => {
		const value = 'main.Leaf {Name: "leaf", Value: 42}';
		assert.strictEqual(toGoLiteral(v({ value: `  ${value}  `, type: 'main.Leaf', variablesReference: 4 })), value);
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
