/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the pure `go test` argv builder. command.ts imports
// only from discovery.ts (both vscode-free), so out/command.js is a clean
// CommonJS module. Run: `npm test` or `node test/command.test.js`.

'use strict';

const assert = require('node:assert');
const { buildRunArgs, buildListArgs, selectorRegex } = require('../out/command');

const cases = {
	'selectorRegex anchors an exact-match alternation': () => {
		assert.strictEqual(selectorRegex(['TestA', 'TestB']), '^(TestA|TestB)$');
	},
	'single test run: -json + anchored -run + package': () => {
		const args = buildRunArgs({ packagePath: './internal/ingest', kind: 'test', names: ['TestIngest'] });
		assert.deepStrictEqual(args, ['test', '-json', '-run', '^(TestIngest)$', './internal/ingest']);
	},
	'whole-package run: no -run when names are empty': () => {
		const args = buildRunArgs({ packagePath: '.', kind: 'test', names: [] });
		assert.deepStrictEqual(args, ['test', '-json', '.']);
	},
	'race toggle inserts -race after -json': () => {
		const args = buildRunArgs({ packagePath: '.', kind: 'test', names: ['TestA'], race: true });
		assert.deepStrictEqual(args, ['test', '-json', '-race', '-run', '^(TestA)$', '.']);
	},
	'count override defeats the test cache': () => {
		const args = buildRunArgs({ packagePath: '.', kind: 'test', names: ['TestA'], count: 1 });
		assert.deepStrictEqual(args, ['test', '-json', '-count', '1', '-run', '^(TestA)$', '.']);
	},
	'benchmark run: neutralizes -run and selects via -bench with -benchmem': () => {
		const args = buildRunArgs({ packagePath: './x', kind: 'benchmark', names: ['BenchmarkIngest'] });
		assert.deepStrictEqual(args, ['test', '-json', '-run', '^$', '-bench', '^(BenchmarkIngest)$', '-benchmem', './x']);
	},
	'benchmark with no names benches everything': () => {
		const args = buildRunArgs({ packagePath: './x', kind: 'benchmark', names: [] });
		assert.deepStrictEqual(args, ['test', '-json', '-run', '^$', '-bench', '.', '-benchmem', './x']);
	},
	'json can be disabled for a plain run': () => {
		const args = buildRunArgs({ packagePath: '.', kind: 'test', names: ['TestA'], json: false });
		assert.deepStrictEqual(args, ['test', '-run', '^(TestA)$', '.']);
	},
	'buildListArgs targets a package with a default pattern': () => {
		assert.deepStrictEqual(buildListArgs('./internal/ingest'), ['test', '-list', '.*', './internal/ingest']);
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
