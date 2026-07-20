/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the go-doc runner's result shaping. runner.ts's
// child_process dependency is injected as an ExecFileFn, so we exercise the
// success / non-zero-exit / bare-error paths with a fake — no real toolchain,
// no 'vscode'. Run: `npm test` (after a compile) or `node test/runner.test.js`.

'use strict';

const assert = require('node:assert');
const { runGoDoc } = require('../out/runner');

/** A fake exec that records its call and invokes the callback with fixed output. */
function fakeExec(error, stdout, stderr, sink) {
	return (file, args, options, cb) => {
		if (sink) {
			sink({ file, args, options });
		}
		cb(error, stdout, stderr);
	};
}

const cases = {
	'success: ok=true, stdout passed through, argv forwarded': async () => {
		const calls = [];
		const exec = fakeExec(null, 'package fmt // import "fmt"', '', c => calls.push(c));
		const result = await runGoDoc('go', ['doc', 'fmt'], '/work', exec);
		assert.deepStrictEqual(result, { ok: true, text: 'package fmt // import "fmt"' });
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].file, 'go');
		assert.deepStrictEqual(calls[0].args, ['doc', 'fmt']);
		assert.strictEqual(calls[0].options.cwd, '/work');
	},
	'failure: non-zero exit prefers trimmed stderr as the error': async () => {
		const exec = fakeExec(new Error('Command failed'), '', '  doc: no such package: nope\n');
		const result = await runGoDoc('go', ['doc', 'nope'], undefined, exec);
		assert.deepStrictEqual(result, { ok: false, text: '', error: 'doc: no such package: nope' });
	},
	'failure: falls back to the error message when stderr is empty': async () => {
		const exec = fakeExec(new Error('spawn go ENOENT'), '', '   ');
		const result = await runGoDoc('go', ['doc', 'fmt'], undefined, exec);
		assert.deepStrictEqual(result, { ok: false, text: '', error: 'spawn go ENOENT' });
	},
	'success: undefined stdout coerces to empty string': async () => {
		const exec = fakeExec(null, undefined, '');
		const result = await runGoDoc('go', ['doc', 'fmt'], undefined, exec);
		assert.deepStrictEqual(result, { ok: true, text: '' });
	},
};

(async () => {
	let failed = 0;
	for (const [name, fn] of Object.entries(cases)) {
		try {
			await fn();
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
})();
