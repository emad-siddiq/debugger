/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit tests for the profiling argv builders and the "serving on"
// parser. profileArgs.ts imports neither 'vscode' nor 'child_process', so
// out/profileArgs.js is a clean CommonJS module.
// Run: `npm test` or `node test/profileArgs.test.js`.
//
// The strings the parser is tested against are the ones the Go 1.24 toolchain
// really printed, captured before any of this was written.

'use strict';

const assert = require('node:assert');
const {
	PROFILE_SPECS,
	buildPprofArgs,
	buildProfileArgs,
	buildTraceArgs,
	parseServingUrl,
	profileSpec,
	traceEnv,
} = require('../out/profileArgs');

const cases = {
	'a CPU profile suppresses ordinary tests': () => {
		const args = buildProfileArgs({ packagePath: './internal/ingest', kind: 'cpu', profilePath: '/tmp/p/cpu.prof' });
		// The failure this prevents: a CPU profile of a package whose tests are
		// slower than its benchmarks is a profile of the test suite.
		const runIndex = args.indexOf('-run');
		assert.ok(runIndex >= 0, 'benchmark runs must neutralise -run');
		assert.strictEqual(args[runIndex + 1], '^$');
		assert.ok(args.includes('-bench'));
		assert.strictEqual(args[args.indexOf('-bench') + 1], '.');
		assert.strictEqual(args[args.length - 1], './internal/ingest');
	},

	'each kind carries its own go test flag': () => {
		const flags = {
			cpu: '-cpuprofile', memory: '-memprofile', block: '-blockprofile',
			mutex: '-mutexprofile', trace: '-trace',
		};
		for (const [kind, flag] of Object.entries(flags)) {
			const args = buildProfileArgs({ packagePath: '.', kind, profilePath: `/tmp/p/${kind}` });
			assert.ok(args.includes(flag), `${kind} must pass ${flag}`);
			assert.strictEqual(args[args.indexOf(flag) + 1], `/tmp/p/${kind}`);
		}
	},

	'named benchmarks are selected exactly': () => {
		const args = buildProfileArgs({ packagePath: '.', kind: 'cpu', profilePath: '/tmp/p/cpu.prof', names: ['BenchmarkA', 'BenchmarkB'] });
		assert.strictEqual(args[args.indexOf('-bench') + 1], '^(BenchmarkA|BenchmarkB)$');
	},

	'profiling ordinary tests does NOT suppress them': () => {
		// The bug this catches: reusing the benchmark path for a test target adds
		// `-run '^$'`, so the run selects nothing, exits 0, and writes an empty
		// profile — success with no data, the least debuggable outcome.
		const args = buildProfileArgs({ packagePath: '.', kind: 'cpu', profilePath: '/tmp/p/cpu.prof', target: 'test', names: ['TestSlow'] });
		assert.ok(!args.includes('-bench'), 'a test profile must not run benchmarks');
		assert.strictEqual(args[args.indexOf('-run') + 1], '^(TestSlow)$');
	},

	'the compiled binary is kept for symbolisation': () => {
		const args = buildProfileArgs({ packagePath: '.', kind: 'cpu', profilePath: '/tmp/p/cpu.prof', binaryPath: '/tmp/p/profile.test' });
		assert.strictEqual(args[args.indexOf('-o') + 1], '/tmp/p/profile.test');
	},

	'a profiling run is never -json': () => {
		// The Testing API's event stream exists to record verdicts. A profiling run
		// has none, and -json would wrap the benchmark table the reader wants.
		const args = buildProfileArgs({ packagePath: '.', kind: 'cpu', profilePath: '/tmp/p/cpu.prof' });
		assert.ok(!args.includes('-json'));
	},

	'an unknown kind is refused rather than silently mis-flagged': () => {
		assert.throws(() => buildProfileArgs({ packagePath: '.', kind: 'quantum', profilePath: '/tmp/x' }), /unknown profile kind/);
	},

	'pprof is never allowed to open a browser': () => {
		const args = buildPprofArgs(41234, '/tmp/p/cpu.prof', '/tmp/p/profile.test');
		assert.ok(args.includes('-no_browser'),
			'without -no_browser the page also opens outside Burrow, which nobody asked for');
		assert.ok(args.includes('-http=127.0.0.1:41234'));
		// Binary before profile — pprof reads them positionally in that order.
		assert.deepStrictEqual(args.slice(-2), ['/tmp/p/profile.test', '/tmp/p/cpu.prof']);
	},

	'trace has no -no_browser flag, so the env carries the job': () => {
		// Measured: `go tool trace`'s entire flag set is -http, -pprof and -d.
		// Passing -no_browser would make it exit with a flag error.
		const args = buildTraceArgs(41235, '/tmp/p/go.trace');
		assert.ok(!args.includes('-no_browser'));
		assert.ok(args.includes('-http=127.0.0.1:41235'));
		// It does honour $BROWSER — also measured, with a script that recorded
		// being called with the URL.
		assert.strictEqual(traceEnv({ PATH: '/usr/bin' }).BROWSER, '/usr/bin/true');
		assert.strictEqual(traceEnv({ PATH: '/usr/bin' }).PATH, '/usr/bin', 'the rest of the environment survives');
	},

	'the real lines both tools print are parsed': () => {
		assert.strictEqual(
			parseServingUrl('Serving web UI on http://127.0.0.1:42102\n'),
			'http://127.0.0.1:42102');
		assert.strictEqual(
			parseServingUrl('2026/08/06 09:03:23 Opening browser. Trace viewer is listening on http://127.0.0.1:42103\n'),
			'http://127.0.0.1:42103');
	},

	'a port of zero is not an address': () => {
		// Measured, and the reason the caller must reserve a concrete port: given
		// `-http=127.0.0.1:0`, BOTH tools echo the `:0` back rather than reporting
		// the port they bound. Returning it would frame http://127.0.0.1:0, which
		// fails with nothing to read.
		assert.strictEqual(parseServingUrl('Serving web UI on http://127.0.0.1:0'), undefined);
	},

	'lines with no address yield undefined rather than a guess': () => {
		assert.strictEqual(parseServingUrl('Preparing trace for viewer...'), undefined);
		assert.strictEqual(parseServingUrl(''), undefined);
		assert.strictEqual(parseServingUrl('main.go:12: something failed'), undefined);
	},

	'every spec is complete and distinct': () => {
		const kinds = PROFILE_SPECS.map(s => s.kind);
		assert.strictEqual(new Set(kinds).size, kinds.length);
		const files = PROFILE_SPECS.map(s => s.file);
		assert.strictEqual(new Set(files).size, files.length,
			'two kinds sharing a file name would overwrite each other in the scratch dir');
		for (const spec of PROFILE_SPECS) {
			assert.ok(spec.label && spec.detail && spec.flag, `${spec.kind} is missing a field`);
			assert.strictEqual(profileSpec(spec.kind), spec);
		}
		assert.strictEqual(profileSpec('nope'), undefined);
	},

	'only the execution trace uses the trace viewer': () => {
		for (const spec of PROFILE_SPECS) {
			assert.strictEqual(spec.viewer, spec.kind === 'trace' ? 'trace' : 'pprof', `${spec.kind} viewer`);
		}
	},
};

let failed = 0;
for (const [name, run] of Object.entries(cases)) {
	try {
		run();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failed++;
		console.error(`  ✗ ${name}\n    ${err.message}`);
	}
}
const total = Object.keys(cases).length;
console.log(`${total - failed}/${total} passed`);
process.exit(failed === 0 ? 0 : 1);
