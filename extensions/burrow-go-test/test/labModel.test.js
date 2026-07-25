/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// What the Test Lab shows and in what order. labModel.ts imports nothing from
// 'vscode', so out/labModel.js is a plain CommonJS module.
// Run: `npm test` (after a compile) or `node test/labModel.test.js`.

'use strict';

const assert = require('node:assert');
const { buildSuite, buildRun, wantGot, failedNames, verdict } = require('../out/labModel');

const result = (name, status, durationMs = 1, output = '') => ({ name, status, durationMs, output });

const cases = {
	'failures come first, then skips, then passes': () => {
		const suite = buildSuite('./pkg', 'pkg', [
			result('TestB', 'pass'), result('TestC', 'skip'), result('TestA', 'fail'), result('TestD', 'pass'),
		]);
		assert.deepStrictEqual(suite.tests.map((t) => t.name), ['TestA', 'TestC', 'TestB', 'TestD']);
	},
	'a suite counts what it holds': () => {
		const suite = buildSuite('./pkg', 'pkg', [
			result('A', 'fail', 10), result('B', 'pass', 5), result('C', 'skip', 0), result('D', 'pass', 15),
		]);
		assert.deepStrictEqual(
			{ failed: suite.failed, passed: suite.passed, skipped: suite.skipped, durationMs: suite.durationMs },
			{ failed: 1, passed: 2, skipped: 1, durationMs: 30 },
		);
	},
	'suites with failures sort above green ones': () => {
		const green = buildSuite('./a', 'a', [result('A', 'pass')]);
		const red = buildSuite('./b', 'b', [result('B', 'fail')]);
		assert.deepStrictEqual(buildRun([green, red], false).suites.map((s) => s.label), ['b', 'a']);
	},
	'a run rolls up its suites': () => {
		const run = buildRun([
			buildSuite('./a', 'a', [result('A', 'pass', 10)]),
			buildSuite('./b', 'b', [result('B', 'fail', 20), result('C', 'skip', 0)]),
		], true);
		assert.strictEqual(run.failed, 1);
		assert.strictEqual(run.passed, 1);
		assert.strictEqual(run.skipped, 1);
		assert.strictEqual(run.durationMs, 30);
		assert.strictEqual(run.race, true);
	},

	'got/want on one line is extracted': () => {
		assert.deepStrictEqual(wantGot('    foo_test.go:12: got 3, want 4'), { got: '3', want: '4' });
	},
	'want/got in the other order is extracted': () => {
		assert.deepStrictEqual(wantGot('want: alpha, got: beta'), { want: 'alpha', got: 'beta' });
	},
	'expected/got (testify style) is extracted': () => {
		assert.deepStrictEqual(wantGot('Error: expected "a", but got "b"'), { want: '"a"', got: '"b"' });
	},
	'output with no comparison yields nothing rather than a guess': () => {
		assert.deepStrictEqual(wantGot('panic: runtime error: index out of range [3]'), {});
		assert.deepStrictEqual(wantGot(''), {});
	},
	'a comparison of equal values is not a diff': () => {
		assert.deepStrictEqual(wantGot('got 4, want 4'), {});
	},
	'an extracted value is clipped, never unbounded': () => {
		const { got } = wantGot(`got ${'x'.repeat(900)}, want y`);
		assert.ok(got.length <= 401 && got.endsWith('…'));
	},
	'the extraction lands on the test that carries it': () => {
		const suite = buildSuite('./pkg', 'pkg', [result('A', 'fail', 1, 'a_test.go:9: got 1, want 2')]);
		assert.deepStrictEqual({ want: suite.tests[0].want, got: suite.tests[0].got }, { want: '2', got: '1' });
	},

	're-run failed names exactly the failures': () => {
		const run = buildRun([buildSuite('./a', 'a', [result('A', 'fail'), result('B', 'pass'), result('C', 'fail')])], false);
		assert.deepStrictEqual(failedNames(run).sort(), ['A', 'C']);
	},
	'the verdict leads with failures and always ends with the clock': () => {
		const red = buildRun([buildSuite('./a', 'a', [result('A', 'fail', 1200), result('B', 'pass', 300)])], false);
		assert.match(verdict(red), /^1 failed · 1 passed · 1\.50s$/);
		const green = buildRun([buildSuite('./a', 'a', [result('B', 'pass', 500)])], false);
		assert.match(verdict(green), /^1 passed · 0\.50s$/);
	},
	'a build failure says so instead of reporting zero passes': () => {
		assert.strictEqual(verdict(buildRun([], false, 'undefined: Foo')), 'build failed');
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
