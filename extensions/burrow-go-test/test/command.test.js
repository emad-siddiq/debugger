/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the pure `go test` argv builder. command.ts imports
// only from discovery.ts (both vscode-free), so out/command.js is a clean
// CommonJS module. Run: `npm test` or `node test/command.test.js`.

'use strict';

const assert = require('node:assert');
const { buildRunArgs, buildListArgs, buildTestBinaryArgs, selectorRegex } = require('../out/command');

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

	// -- the compiled test binary's flags, which are NOT `go test`'s -----------
	'the test binary selects with -test.run, not -run': () => {
		const args = buildTestBinaryArgs({ kind: 'test', names: ['TestIngest'] });
		assert.deepStrictEqual(args, ['-test.run', '^(TestIngest)$', '-test.v']);
		// The bug this exists to prevent: a test binary given `-run` exits with
		// "flag provided but not defined: -run", so under dlv the session starts
		// and vanishes before any breakpoint — which reads as a broken debugger
		// rather than as a wrong flag.
		assert.ok(!args.includes('-run'), '-run is go test\'s flag; the test binary refuses it');
	},

	'a benchmark neutralises -test.run and selects with -test.bench': () => {
		assert.deepStrictEqual(
			buildTestBinaryArgs({ kind: 'benchmark', names: ['BenchmarkIngest'] }),
			['-test.run', '^$', '-test.bench', '^(BenchmarkIngest)$', '-test.benchmem', '-test.v'],
		);
	},

	'a whole-package debug run still asks for verbose output': () => {
		// Without -test.v a debug session's console is empty, and "not reached
		// yet" looks exactly like "did not run".
		assert.deepStrictEqual(buildTestBinaryArgs({ kind: 'test' }), ['-test.v']);
		assert.deepStrictEqual(
			buildTestBinaryArgs({ kind: 'benchmark' }),
			['-test.run', '^$', '-test.bench', '.', '-test.benchmem', '-test.v'],
		);
	},

	'the two argv builders never produce each other\'s flags': () => {
		const goTest = buildRunArgs({ packagePath: './pkg', kind: 'test', names: ['TestA'] });
		const binary = buildTestBinaryArgs({ kind: 'test', names: ['TestA'] });
		assert.ok(goTest.includes('-run') && !goTest.some(a => a.startsWith('-test.')));
		assert.ok(binary.includes('-test.run') && !binary.includes('-run'));
		assert.ok(!binary.includes('./pkg'), 'the package is chosen by dlv\'s program, not by an argument');
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
