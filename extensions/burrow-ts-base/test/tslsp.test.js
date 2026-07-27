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
// What the PACKAGED app actually has: the package, without npm's .bin shim.
const MOD = path.join('node_modules', 'typescript-language-server', 'lib', 'cli.mjs');
const PROJECT = '/work/merkle/nodewatch/frontend';
const EXT = '/opt/burrow/extensions/burrow-ts-base';

const exe = (p) => ({ kind: 'executable', path: p });
const mod = (p) => ({ kind: 'module', path: p });

const cases = {
	'BURROW_TS_LSP_PATH wins over everything else': () => {
		const override = '/opt/tls/typescript-language-server';
		const resolved = resolveTsLsp(
			{ BURROW_TS_LSP_PATH: override, PATH: '/usr/bin' },
			{ binRoots: [PROJECT, EXT], exists: existsFrom([override, path.join(PROJECT, BIN), path.join(EXT, BIN), '/usr/bin/typescript-language-server']) },
		);
		assert.deepStrictEqual(resolved, exe(override));
	},
	'BURROW_TS_LSP_PATH is skipped when the file does not exist': () => {
		const resolved = resolveTsLsp(
			{ BURROW_TS_LSP_PATH: '/nope/tls' },
			{ binRoots: [PROJECT], exists: existsFrom([path.join(PROJECT, BIN)]) },
		);
		assert.deepStrictEqual(resolved, exe(path.join(PROJECT, BIN)));
	},
	'the project bin resolves before the bundled extension bin': () => {
		const resolved = resolveTsLsp(
			{},
			{ binRoots: [PROJECT, EXT], exists: existsFrom([path.join(PROJECT, BIN), path.join(EXT, BIN)]) },
		);
		assert.deepStrictEqual(resolved, exe(path.join(PROJECT, BIN)));
	},
	'falls back to the bundled extension bin when the project has none': () => {
		const resolved = resolveTsLsp(
			{},
			{ binRoots: [PROJECT, EXT], exists: existsFrom([path.join(EXT, BIN)]) },
		);
		assert.deepStrictEqual(resolved, exe(path.join(EXT, BIN)));
	},
	'falls back to PATH when no binRoot has the server': () => {
		const resolved = resolveTsLsp(
			{ PATH: ['/x', '/usr/local/bin'].join(path.delimiter) },
			{ binRoots: [PROJECT], exists: existsFrom(['/usr/local/bin/typescript-language-server']) },
		);
		assert.deepStrictEqual(resolved, exe(path.join('/usr/local/bin', 'typescript-language-server')));
	},
	'returns undefined when the server is nowhere': () => {
		const resolved = resolveTsLsp({ PATH: '/usr/bin' }, { binRoots: [PROJECT, EXT], exists: existsFrom([]) });
		assert.strictEqual(resolved, undefined);
	},
	// The bug: the bundle ships node_modules/<dep>/** and no .bin, so the
	// "turnkey" fallback was missing from every installed build.
	'finds the package entry point when the bundle has no .bin shim': () => {
		const resolved = resolveTsLsp({}, { binRoots: [PROJECT, EXT], exists: existsFrom([path.join(EXT, MOD)]) });
		assert.deepStrictEqual(resolved, mod(path.join(EXT, MOD)));
	},
	'a project shim still beats the bundled package entry': () => {
		const resolved = resolveTsLsp(
			{},
			{ binRoots: [PROJECT, EXT], exists: existsFrom([path.join(PROJECT, BIN), path.join(EXT, MOD), path.join(EXT, BIN)]) },
		);
		assert.deepStrictEqual(resolved, exe(path.join(PROJECT, BIN)));
	},
	"a project's own package entry beats the bundled one": () => {
		const resolved = resolveTsLsp(
			{},
			{ binRoots: [PROJECT, EXT], exists: existsFrom([path.join(PROJECT, MOD), path.join(EXT, MOD)]) },
		);
		assert.deepStrictEqual(resolved, mod(path.join(PROJECT, MOD)));
	},
	'an override pointing at a .mjs is launched as a module': () => {
		const override = '/opt/tls/lib/cli.mjs';
		const resolved = resolveTsLsp({ BURROW_TS_LSP_PATH: override }, { exists: existsFrom([override]) });
		assert.deepStrictEqual(resolved, mod(override));
	},
	'ignores empty binRoot entries and an empty PATH': () => {
		const resolved = resolveTsLsp({ PATH: '' }, { binRoots: ['', PROJECT], exists: existsFrom([path.join(PROJECT, BIN)]) });
		assert.deepStrictEqual(resolved, exe(path.join(PROJECT, BIN)));
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
