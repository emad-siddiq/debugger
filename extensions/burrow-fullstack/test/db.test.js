/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the pure Full Stack DB helpers. db.ts imports nothing
// from 'vscode', so out/db.js is a clean CommonJS module we can require directly.
// Run: `npm test` (after a compile) or `node test/db.test.js`.

'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { composeUpArgs, composeStopArgs, resolveComposeFile } = require('../out/db');

const cases = {
	'composeUpArgs brings the service up detached and waits for its healthcheck': () => {
		assert.deepStrictEqual(
			composeUpArgs('/work/infra/docker-compose.yml', 'nodewatch-db'),
			['compose', '-f', '/work/infra/docker-compose.yml', 'up', '-d', '--wait', 'nodewatch-db'],
		);
	},
	'composeStopArgs stops just the named service': () => {
		assert.deepStrictEqual(
			composeStopArgs('/work/infra/docker-compose.yml', 'nodewatch-db'),
			['compose', '-f', '/work/infra/docker-compose.yml', 'stop', 'nodewatch-db'],
		);
	},
	'resolveComposeFile joins a relative path onto the workspace root': () => {
		assert.strictEqual(
			resolveComposeFile('infra/docker-compose.yml', '/work/merkle'),
			path.join('/work/merkle', 'infra/docker-compose.yml'),
		);
	},
	'resolveComposeFile leaves an absolute path untouched': () => {
		assert.strictEqual(resolveComposeFile('/abs/compose.yml', '/work/merkle'), '/abs/compose.yml');
	},
	'resolveComposeFile tolerates a missing workspace root': () => {
		assert.strictEqual(resolveComposeFile('infra/docker-compose.yml', undefined), 'infra/docker-compose.yml');
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
	console.error('\n' + failed + ' db test(s) failed');
	process.exit(1);
}
console.log('\nAll ' + Object.keys(cases).length + ' db tests passed');
