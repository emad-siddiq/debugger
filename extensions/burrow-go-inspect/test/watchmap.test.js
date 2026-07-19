/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the DAP evaluate → DapVariable mapping (Watch, WO-7).
// watchmap.ts imports only from summary.ts (both vscode-free), so out/watchmap.js is
// a clean CommonJS module. Run: `npm test` or `node test/watchmap.test.js`.

'use strict';

const assert = require('node:assert');
const { watchVariableFrom } = require('../out/watchmap');

const cases = {
	'maps a scalar evaluate body to a named DapVariable': () => {
		const v = watchVariableFrom('total', { result: '28', type: 'int', variablesReference: 0 });
		assert.deepStrictEqual(v, { name: 'total', value: '28', type: 'int', variablesReference: 0, namedVariables: undefined, indexedVariables: undefined, evaluateName: 'total' });
	},
	'carries child counts through for composites': () => {
		const v = watchVariableFrom('cfg', { result: 'main.Outer {…}', type: 'main.Outer', variablesReference: 7, namedVariables: 2 });
		assert.strictEqual(v.variablesReference, 7);
		assert.strictEqual(v.namedVariables, 2);
		assert.strictEqual(v.evaluateName, 'cfg');
	},
	'defaults a missing variablesReference to 0': () => {
		assert.strictEqual(watchVariableFrom('x', { result: 'true', type: 'bool' }).variablesReference, 0);
	},
	'undefined body (invalid-in-frame) maps to undefined': () => {
		assert.strictEqual(watchVariableFrom('nope', undefined), undefined);
	},
	'body without a string result maps to undefined': () => {
		assert.strictEqual(watchVariableFrom('nope', { type: 'int', variablesReference: 0 }), undefined);
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
