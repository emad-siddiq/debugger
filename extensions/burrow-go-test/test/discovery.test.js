/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the pure test-discovery core. discovery.ts imports
// nothing from 'vscode', so out/discovery.js is a clean CommonJS module we
// require directly. Run: `npm test` (after a compile) or `node test/discovery.test.js`.

'use strict';

const assert = require('node:assert');
const { parseTestFunctions, parseTestList } = require('../out/discovery');

const SOURCE = [
	'package ingest',
	'',
	'import "testing"',
	'',
	'func TestIngest(t *testing.T) {}',
	'func Test(t *testing.T) {}',
	'func TestMain(m *testing.M) {}',            // entrypoint, not a test
	'func Testify(t *testing.T) {}',             // lowercase after Test → not a test
	'func BenchmarkIngest(b *testing.B) {}',
	'func FuzzParse(f *testing.F) {}',
	'func ExampleClient() {}',
	'func helper() {}',                          // not a test
	'func TestIngest(t *testing.T) {}',          // duplicate name → deduped
].join('\n');

const cases = {
	'parses the four kinds, skips TestMain/Testify/helper, dedupes': () => {
		const funcs = parseTestFunctions(SOURCE);
		assert.deepStrictEqual(funcs, [
			{ name: 'TestIngest', kind: 'test', line: 5 },
			{ name: 'Test', kind: 'test', line: 6 },
			{ name: 'BenchmarkIngest', kind: 'benchmark', line: 9 },
			{ name: 'FuzzParse', kind: 'fuzz', line: 10 },
			{ name: 'ExampleClient', kind: 'example', line: 11 },
		]);
	},
	'CRLF sources keep correct 1-based lines': () => {
		const funcs = parseTestFunctions('package p\r\n\r\nfunc TestA(t *testing.T) {}\r\n');
		assert.deepStrictEqual(funcs, [{ name: 'TestA', kind: 'test', line: 3 }]);
	},
	'empty / test-free source yields no functions': () => {
		assert.deepStrictEqual(parseTestFunctions('package p\n\nfunc main() {}\n'), []);
	},
	'parseTestList keeps names and drops go status rows': () => {
		const stdout = [
			'TestIngest',
			'BenchmarkIngest',
			'FuzzParse',
			'ExampleClient',
			'TestMain',                 // dropped: entrypoint
			'ok  \tgithub.com/x/ingest\t0.021s',
			'?   \tgithub.com/x/empty\t[no test files]',
		].join('\n');
		assert.deepStrictEqual(parseTestList(stdout), [
			'TestIngest',
			'BenchmarkIngest',
			'FuzzParse',
			'ExampleClient',
		]);
	},
	'parseTestList dedupes repeated names': () => {
		assert.deepStrictEqual(parseTestList('TestA\nTestA\nTestB\n'), ['TestA', 'TestB']);
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
