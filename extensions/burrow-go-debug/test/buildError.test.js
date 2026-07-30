/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// A build failure inside a debug session must not be silent (WO-74 §3).
//
// dlv binds its DAP port BEFORE it builds, so a compile error arrives on dlv's own
// stream after the banner — on a channel nobody has open. The session then starts,
// fails and ends with no message: exactly what `alertmanager` produced, and why two
// runs disagreed about whether a session had existed.
//
// `buildError` extracts the compiler's complaint from that stream. It has to be
// SPECIFIC: it fires a modal error dialog, so a false positive on ordinary program
// output is worse than a missed error.
// Run: `npm test` or `node test/buildError.test.js`.

'use strict';

const assert = require('node:assert');
const { buildError } = require('../out/buildOutput');

const cases = {
	// ── the ones that must fire ──────────────────────────────────────────────
	'a compile error with file, line and column': () => {
		const out = buildError('# github.com/x/y\n./main.go:12:6: undefined: foo\n');
		assert.match(out, /main\.go:12:6: undefined: foo/);
	},
	'the alertmanager case: pointing dlv at a module root with no main': () => {
		assert.match(buildError('no Go files in /Users/x/alertmanager\n'), /no Go files/);
	},
	'a module that cannot be resolved at all': () => {
		assert.match(buildError('go: cannot find main module; see "go help modules"\n'), /cannot find main module/);
	},
	'a missing dependency': () => {
		assert.match(buildError('no required module provides package github.com/x/y\n'), /no required module provides/);
	},
	'a package that exists but is not runnable': () => {
		assert.match(buildError('go: cannot run non-main package: chi is not a main package\n'), /not a main package/);
	},
	'the first lines only — a Go build error cascades': () => {
		const noisy = ['# m', './a.go:1:1: x', './b.go:2:2: y', './c.go:3:3: z', './d.go:4:4: w', './e.go:5:5: v'].join('\n');
		assert.strictEqual(buildError(noisy).split('\n').length, 4, 'four lines is a message; twenty is a wall');
	},

	// ── the ones that must NOT fire, because this opens a dialog ─────────────
	'ordinary program output is not a build error': () => {
		assert.strictEqual(buildError('listening on http://localhost:8080\n'), undefined);
		assert.strictEqual(buildError('2026/07/30 09:00:00 request served in 4ms\n'), undefined);
	},
	'the dlv banner is not a build error': () => {
		assert.strictEqual(buildError('DAP server listening at: 127.0.0.1:54321\n'), undefined);
	},
	'a log line that merely mentions a .go file is not a build error': () => {
		// No `line:col:` — this is a stack trace or a log, not a diagnostic.
		assert.strictEqual(buildError('handler registered in main.go\n'), undefined);
	},
	'empty and whitespace yield nothing': () => {
		assert.strictEqual(buildError(''), undefined);
		assert.strictEqual(buildError('\n\n  \n'), undefined);
	},
	'a Go panic is not reported as a build error': () => {
		// It is a real failure but the debugger surfaces it as a stop; claiming the
		// BUILD failed would send someone to fix the wrong thing.
		assert.strictEqual(buildError('panic: runtime error: index out of range [3]\n'), undefined);
	},
};

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
	try {
		fn();
		console.log('  ok  ' + name);
	} catch (err) {
		failed++;
		console.error('FAIL  ' + name + '\n      ' + (err && err.message));
	}
}
if (failed) {
	console.error('\n' + failed + ' buildError test(s) failed');
	process.exit(1);
}
console.log('\nAll ' + Object.keys(cases).length + ' buildError tests passed');
