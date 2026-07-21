/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the pure envFile parser + merge. envfile.ts imports
// nothing from 'vscode' or 'fs', so out/envfile.js is a clean CommonJS module we
// can require directly. Run: `npm test` (after a compile) or
// `node test/envfile.test.js`.

'use strict';

const assert = require('node:assert');
const { parseEnvFile, mergeEnv } = require('../out/envfile');

const cases = {
	'parses simple KEY=VALUE lines': () => {
		assert.deepStrictEqual(parseEnvFile('PORT=8080\nHOST=localhost'), {
			PORT: '8080',
			HOST: 'localhost',
		});
	},
	'skips blank lines and # comments': () => {
		const text = '# a comment\n\nPORT=8080\n   # indented comment\nHOST=localhost\n';
		assert.deepStrictEqual(parseEnvFile(text), { PORT: '8080', HOST: 'localhost' });
	},
	'tolerates a leading `export `': () => {
		assert.deepStrictEqual(parseEnvFile('export PORT=8080'), { PORT: '8080' });
	},
	'strips one layer of matching double or single quotes': () => {
		const text = 'A="quoted value"\nB=\'single\'\nC=bare';
		assert.deepStrictEqual(parseEnvFile(text), { A: 'quoted value', B: 'single', C: 'bare' });
	},
	'keeps an inner `=` in the value (splits on the first `=` only)': () => {
		assert.deepStrictEqual(parseEnvFile('DATABASE_URL=postgres://u:p@localhost:5432/db?sslmode=disable'), {
			DATABASE_URL: 'postgres://u:p@localhost:5432/db?sslmode=disable',
		});
	},
	'preserves an empty value (auth-off pattern)': () => {
		assert.deepStrictEqual(parseEnvFile('AUTH0_DOMAIN=\nAUTH0_AUDIENCE='), {
			AUTH0_DOMAIN: '',
			AUTH0_AUDIENCE: '',
		});
	},
	'ignores lines with no key or an invalid identifier': () => {
		const text = '=novalue\n123BAD=x\nGOOD=1\nno_equals_here';
		assert.deepStrictEqual(parseEnvFile(text), { GOOD: '1' });
	},
	'last assignment wins within a file (shell semantics)': () => {
		assert.deepStrictEqual(parseEnvFile('PORT=1\nPORT=2'), { PORT: '2' });
	},
	'mergeEnv: inline env wins over every file': () => {
		const fileA = { PORT: '1', DATABASE_URL: 'file' };
		const inline = { DATABASE_URL: 'inline' };
		assert.deepStrictEqual(mergeEnv([fileA], inline), { PORT: '1', DATABASE_URL: 'inline' });
	},
	'mergeEnv: later files win over earlier files': () => {
		assert.deepStrictEqual(mergeEnv([{ K: 'first' }, { K: 'second' }]), { K: 'second' });
	},
	'mergeEnv: no inline env leaves the file values intact': () => {
		assert.deepStrictEqual(mergeEnv([{ K: 'v' }]), { K: 'v' });
	},
	'mergeEnv: does not mutate its inputs': () => {
		const file = { K: 'v' };
		const inline = { J: 'w' };
		mergeEnv([file], inline);
		assert.deepStrictEqual(file, { K: 'v' });
		assert.deepStrictEqual(inline, { J: 'w' });
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
	console.error('\n' + failed + ' envfile test(s) failed');
	process.exit(1);
}
console.log('\nAll ' + Object.keys(cases).length + ' envfile tests passed');
