/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the pure typescript-language-server resolver. tslsp.ts
// imports nothing from 'vscode', so out/tslsp.js is a clean CommonJS module we can
// require directly. Run: `npm test` (after a compile) or `node test/tslsp.test.js`.

'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { resolveTsLsp } = require('../out/tslsp');

function existsFrom(present) {
	const set = new Set(present);
	return p => set.has(p);
}

const BIN = path.join('node_modules', '.bin', 'typescript-language-server');
const PROJECT = '/work/merkle/nodewatch/frontend';
const EXT = '/opt/burrow/extensions/burrow-ts-base';

const cases = {
	'BURROW_TS_LSP_PATH wins over everything else': () => {
		const override = '/opt/tls/typescript-language-server';
		const resolved = resolveTsLsp(
			{ BURROW_TS_LSP_PATH: override, PATH: '/usr/bin' },
			{ binRoots: [PROJECT, EXT], exists: existsFrom([override, path.join(PROJECT, BIN), path.join(EXT, BIN), '/usr/bin/typescript-language-server']) },
		);
		assert.strictEqual(resolved, override);
	},
	'BURROW_TS_LSP_PATH is skipped when the file does not exist': () => {
		const resolved = resolveTsLsp(
			{ BURROW_TS_LSP_PATH: '/nope/tls' },
			{ binRoots: [PROJECT], exists: existsFrom([path.join(PROJECT, BIN)]) },
		);
		assert.strictEqual(resolved, path.join(PROJECT, BIN));
	},
	'the project bin resolves before the bundled extension bin': () => {
		const resolved = resolveTsLsp(
			{},
			{ binRoots: [PROJECT, EXT], exists: existsFrom([path.join(PROJECT, BIN), path.join(EXT, BIN)]) },
		);
		assert.strictEqual(resolved, path.join(PROJECT, BIN));
	},
	'falls back to the bundled extension bin when the project has none': () => {
		const resolved = resolveTsLsp(
			{},
			{ binRoots: [PROJECT, EXT], exists: existsFrom([path.join(EXT, BIN)]) },
		);
		assert.strictEqual(resolved, path.join(EXT, BIN));
	},
	'falls back to PATH when no binRoot has the server': () => {
		const resolved = resolveTsLsp(
			{ PATH: ['/x', '/usr/local/bin'].join(path.delimiter) },
			{ binRoots: [PROJECT], exists: existsFrom(['/usr/local/bin/typescript-language-server']) },
		);
		assert.strictEqual(resolved, path.join('/usr/local/bin', 'typescript-language-server'));
	},
	'returns undefined when the server is nowhere': () => {
		const resolved = resolveTsLsp({ PATH: '/usr/bin' }, { binRoots: [PROJECT, EXT], exists: existsFrom([]) });
		assert.strictEqual(resolved, undefined);
	},
	'ignores empty binRoot entries and an empty PATH': () => {
		const resolved = resolveTsLsp({ PATH: '' }, { binRoots: ['', PROJECT], exists: existsFrom([path.join(PROJECT, BIN)]) });
		assert.strictEqual(resolved, path.join(PROJECT, BIN));
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
	console.error('\n' + failed + ' tslsp test(s) failed');
	process.exit(1);
}
console.log('\nAll ' + Object.keys(cases).length + ' tslsp tests passed');
