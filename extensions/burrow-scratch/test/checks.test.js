/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The check vocabulary. The rule the whole feature rests on is that a check must
// be able to FAIL — and WO-79 found the two ways it could report a pass instead:
// a command that exits 0 with nothing to work on, and a command that could not
// reach the network reported as the same red as a syntax error.
//
// Real shells, real files, in a temp directory. A test that stubs `exec` would
// not have caught either of these, because both are about what a real command
// actually prints.
// Run: `npm test` (after a compile) or `node test/checks.test.js`.

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCheck, runChecks, summarize } = require('../out/checks');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-checks-'));
fs.mkdirSync(path.join(root, 'mod'), { recursive: true });

const cases = {
	'a command that exits 0 with nothing to work on is not a pass': async () => {
		const check = {
			kind: 'shell', label: 'generated', cmd: 'exit 0', cwd: 'mod',
			needs: { dir: 'mod', match: '.go', why: 'there are no Go files here yet.' },
		};
		const empty = await runCheck(root, 'mod/go.mod', check);
		assert.strictEqual(empty.verdict, 'unavailable');
		assert.strictEqual(empty.reason, 'too-early');
		assert.match(empty.output, /no Go files/);

		// The same command, once its input exists.
		fs.writeFileSync(path.join(root, 'mod', 'main.go'), 'package main\n');
		const ready = await runCheck(root, 'mod/go.mod', check);
		assert.strictEqual(ready.verdict, 'pass');
	},

	'a network failure is not the same red as a syntax error': async () => {
		const offline = await runCheck(root, undefined, {
			kind: 'shell', label: 'tidy',
			cmd: 'echo "go: module lookup disabled: dial tcp: lookup proxy.golang.org: no such host" 1>&2; exit 1',
		});
		assert.strictEqual(offline.verdict, 'unavailable');
		assert.strictEqual(offline.reason, 'offline');
		assert.match(summarize({ results: [offline], verdict: 'unavailable' }), /needs the network/);

		// …and a real failure still fails, with its own words.
		const broken = await runCheck(root, undefined, {
			kind: 'shell', label: 'build', cmd: 'echo "syntax error: unexpected }" 1>&2; exit 2',
		});
		assert.strictEqual(broken.verdict, 'fail');
		assert.strictEqual(broken.reason, undefined);
	},

	'a missing tool is still a missing tool, and says so': async () => {
		const missing = await runCheck(root, undefined, {
			kind: 'shell', label: 'gofmt', cmd: 'burrow-no-such-command-79',
		});
		assert.strictEqual(missing.verdict, 'unavailable');
		assert.strictEqual(missing.reason, 'no-tool');
		assert.match(summarize({ results: [missing], verdict: 'unavailable' }), /not on PATH/);
	},

	'a check whose directory does not exist yet is too-early, not a blank fail': async () => {
		// Empty-start scratches have no directories until a step is reached, and
		// exec with a nonexistent cwd used to produce `fail` with EMPTY output —
		// a red verdict with no words, about the learner's code, wrong twice.
		const result = await runCheck(root, undefined, {
			kind: 'shell', label: 'builds', cmd: 'true', cwd: 'not/there/yet',
		});
		assert.strictEqual(result.verdict, 'unavailable');
		assert.strictEqual(result.reason, 'too-early');
		assert.match(result.output, /not\/there\/yet/);
	},

	'a run is only a pass when every check answered': async () => {
		fs.writeFileSync(path.join(root, 'file.txt'), 'x');
		const run = await runChecks(root, 'file.txt', [
			{ kind: 'exists', label: 'the file exists and is not empty' },
			{ kind: 'shell', label: 'tool', cmd: 'burrow-no-such-command-79' },
		]);
		assert.strictEqual(run.verdict, 'unavailable');
		assert.strictEqual(run.results[0].verdict, 'pass');
	},
};

(async () => {
	let failed = 0;
	for (const [name, run] of Object.entries(cases)) {
		try {
			await run();
			console.log(`  ✓ ${name}`);
		} catch (error) {
			failed++;
			console.error(`  ✗ ${name}\n    ${error.message}`);
		}
	}
	fs.rmSync(root, { recursive: true, force: true });
	console.log(`${Object.keys(cases).length - failed}/${Object.keys(cases).length} passed`);
	process.exit(failed ? 1 : 0);
})();
