/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the pure `go test -json` event parser. events.ts
// imports nothing from 'vscode', so out/events.js is a clean CommonJS module.
// Run: `npm test` or `node test/events.test.js`.

'use strict';

const assert = require('node:assert');
const { parseTestJsonLine, summarizeEvents } = require('../out/events');

/** A minimal but realistic `go test -json` transcript for one pass + one fail. */
const TRANSCRIPT = [
	'{"Action":"run","Package":"x","Test":"TestPass"}',
	'{"Action":"output","Package":"x","Test":"TestPass","Output":"=== RUN   TestPass\\n"}',
	'{"Action":"pass","Package":"x","Test":"TestPass","Elapsed":0.012}',
	'{"Action":"run","Package":"x","Test":"TestFail"}',
	'{"Action":"output","Package":"x","Test":"TestFail","Output":"    got 3, want 4\\n"}',
	'{"Action":"fail","Package":"x","Test":"TestFail","Elapsed":0.2}',
	'{"Action":"skip","Package":"x","Test":"TestSkip","Elapsed":0}',
	'{"Action":"fail","Package":"x","Elapsed":0.25}',      // package-level, ignored
];

const cases = {
	'parseTestJsonLine returns the event for a JSON line': () => {
		const event = parseTestJsonLine('{"Action":"pass","Test":"TestA","Elapsed":0.5}');
		assert.deepStrictEqual(event, { Action: 'pass', Test: 'TestA', Elapsed: 0.5 });
	},
	'parseTestJsonLine ignores blank / non-JSON / malformed lines': () => {
		assert.strictEqual(parseTestJsonLine(''), undefined);
		assert.strictEqual(parseTestJsonLine('PASS'), undefined);
		assert.strictEqual(parseTestJsonLine('{not json'), undefined);
		assert.strictEqual(parseTestJsonLine('{"Package":"x"}'), undefined); // no Action
	},
	'summarizeEvents rolls each test to a terminal status + duration + output': () => {
		const events = TRANSCRIPT.map(parseTestJsonLine).filter(Boolean);
		const summary = summarizeEvents(events);
		assert.deepStrictEqual(summary.get('TestPass'), {
			name: 'TestPass',
			status: 'pass',
			durationMs: 12,
			output: '=== RUN   TestPass\n',
		});
		assert.deepStrictEqual(summary.get('TestFail'), {
			name: 'TestFail',
			status: 'fail',
			durationMs: 200,
			output: '    got 3, want 4\n',
		});
		assert.strictEqual(summary.get('TestSkip').status, 'skip');
	},
	'summarizeEvents ignores package-scoped events (no Test)': () => {
		const summary = summarizeEvents(TRANSCRIPT.map(parseTestJsonLine).filter(Boolean));
		assert.strictEqual(summary.size, 3); // Pass, Fail, Skip — not the package fail
	},
	'summarizeEvents keeps subtest results under their slash-qualified name': () => {
		const events = [
			{ Action: 'output', Test: 'TestT/case_a', Output: 'x' },
			{ Action: 'pass', Test: 'TestT/case_a', Elapsed: 0.001 },
			{ Action: 'pass', Test: 'TestT', Elapsed: 0.002 },
		];
		const summary = summarizeEvents(events);
		assert.strictEqual(summary.get('TestT/case_a').status, 'pass');
		assert.strictEqual(summary.get('TestT').status, 'pass');
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
