/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the pure gopls resolver. gopls.ts imports nothing
// from 'vscode', so out/gopls.js is a clean CommonJS module we can require
// directly — no test harness, no workbench. Run: `npm test` (after a compile)
// or `node test/gopls.test.js`.

'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { resolveGopls } = require('../out/gopls');

// A fake `exists` probe backed by an explicit set of "present" absolute paths,
// so tests never touch the real filesystem.
function existsFrom(present) {
	const set = new Set(present);
	return p => set.has(p);
}

const HOME = '/home/burrow';

const cases = {
	'BURROW_GOPLS_PATH wins over everything else': () => {
		const override = '/opt/burrow/tools/gopls';
		const resolved = resolveGopls(
			{ BURROW_GOPLS_PATH: override, GOBIN: '/gb', GOPATH: '/gp', PATH: '/usr/bin' },
			{ home: HOME, exists: existsFrom([override, '/gb/gopls', '/gp/bin/gopls', '/usr/bin/gopls']) },
		);
		assert.strictEqual(resolved, override);
	},
	'BURROW_GOPLS_PATH is skipped when the file does not exist': () => {
		const resolved = resolveGopls(
			{ BURROW_GOPLS_PATH: '/nope/gopls', GOBIN: '/gb' },
			{ home: HOME, exists: existsFrom(['/gb/gopls']) },
		);
		assert.strictEqual(resolved, '/gb/gopls');
	},
	'GOBIN/gopls resolves before GOPATH and PATH': () => {
		const resolved = resolveGopls(
			{ GOBIN: '/gb', GOPATH: '/gp', PATH: '/usr/bin' },
			{ home: HOME, exists: existsFrom(['/gb/gopls', '/gp/bin/gopls', '/usr/bin/gopls']) },
		);
		assert.strictEqual(resolved, path.join('/gb', 'gopls'));
	},
	'GOPATH/bin/gopls resolves when GOBIN is unset': () => {
		const resolved = resolveGopls(
			{ GOPATH: '/gp', PATH: '/usr/bin' },
			{ home: HOME, exists: existsFrom(['/gp/bin/gopls']) },
		);
		assert.strictEqual(resolved, path.join('/gp', 'bin', 'gopls'));
	},
	'defaults GOPATH to $HOME/go/bin when neither GOBIN nor GOPATH is set': () => {
		const resolved = resolveGopls(
			{ PATH: '/usr/bin' },
			{ home: HOME, exists: existsFrom([path.join(HOME, 'go', 'bin', 'gopls')]) },
		);
		assert.strictEqual(resolved, path.join(HOME, 'go', 'bin', 'gopls'));
	},
	'falls back to the first gopls on PATH': () => {
		const onPath = path.join('/usr/local/bin', 'gopls');
		const resolved = resolveGopls(
			{ PATH: ['/empty', '/usr/local/bin', '/usr/bin'].join(path.delimiter) },
			{ home: HOME, exists: existsFrom([onPath]) },
		);
		assert.strictEqual(resolved, onPath);
	},
	'returns undefined when gopls is absent everywhere': () => {
		const resolved = resolveGopls(
			{ GOBIN: '/gb', GOPATH: '/gp', PATH: '/usr/bin:/bin' },
			{ home: HOME, exists: existsFrom([]) },
		);
		assert.strictEqual(resolved, undefined);
	},
	'returns undefined with a wholly empty environment': () => {
		const resolved = resolveGopls({}, { home: HOME, exists: existsFrom([]) });
		assert.strictEqual(resolved, undefined);
	},
};

let failures = 0;
for (const [name, run] of Object.entries(cases)) {
	try {
		run();
		console.log(`ok   - ${name}`);
	} catch (err) {
		failures++;
		console.error(`FAIL - ${name}`);
		console.error(err && err.stack ? err.stack : err);
	}
}

if (failures > 0) {
	console.error(`\n${failures} failing`);
	process.exit(1);
}
console.log(`\n${Object.keys(cases).length} passing`);
