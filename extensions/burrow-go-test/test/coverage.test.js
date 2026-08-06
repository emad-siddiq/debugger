/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit tests for the pure cover-profile reader. coverage.ts imports
// nothing from 'vscode' and nothing from 'fs', so out/coverage.js is a clean
// CommonJS module we can require directly. Run: `npm test` (after a compile) or
// `node test/coverage.test.js`.
//
// The last case builds a throwaway Go module, runs a real `go test
// -coverprofile` and parses what Go wrote. A parser proved only against a
// fixture I typed is a parser proved against my idea of the format.

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
	parseCoverProfile,
	coverageTotals,
	parseModulePath,
	relativeToModule,
} = require('../out/coverage');
const { buildRunArgs } = require('../out/command');

const cases = {
	'a profile parses into blocks with their statement counts': () => {
		const profile = parseCoverProfile([
			'mode: set',
			'github.com/org/mod/pkg/a.go:12.34,15.2 3 1',
			'github.com/org/mod/pkg/a.go:17.2,18.16 1 0',
			'',
		].join('\n'));
		assert.strictEqual(profile.mode, 'set');
		const blocks = profile.files.get('github.com/org/mod/pkg/a.go');
		assert.strictEqual(blocks.length, 2);
		assert.deepStrictEqual(blocks[0], {
			startLine: 12, startCol: 34, endLine: 15, endCol: 2, numStmt: 3, count: 1,
		});
	},

	'repeated blocks are summed, not overwritten': () => {
		// go test emits a block per test binary; a package tested in two passes
		// repeats every block. Keeping the last one reports a covered line as
		// uncovered whenever the final binary happened not to reach it.
		const profile = parseCoverProfile([
			'mode: count',
			'm/a.go:1.1,2.2 1 4',
			'm/a.go:1.1,2.2 1 0',
		].join('\n'));
		assert.strictEqual(profile.files.get('m/a.go')[0].count, 4);
	},

	'totals count statements, the unit `go tool cover` counts': () => {
		const blocks = [
			{ startLine: 1, startCol: 1, endLine: 9, endCol: 1, numStmt: 10, count: 1 },
			{ startLine: 11, startCol: 1, endLine: 11, endCol: 9, numStmt: 1, count: 0 },
		];
		assert.deepStrictEqual(coverageTotals(blocks), { covered: 10, total: 11 });
		// Counting BLOCKS instead would call this 50%, and disagree with the
		// percentage `go test -cover` prints in the same terminal.
		assert.notStrictEqual(10 / 11, 1 / 2);
	},

	'a file name with a colon in it still parses': () => {
		const profile = parseCoverProfile('m/weird:name/a.go:1.1,2.2 1 1');
		assert.ok(profile.files.has('m/weird:name/a.go'), 'the coordinates anchor at the end, not the first colon');
	},

	'unparseable lines are skipped rather than thrown on': () => {
		const profile = parseCoverProfile('mode: set\nnot a block at all\nm/a.go:1.1,2.2 1 1');
		assert.strictEqual(profile.files.size, 1);
	},

	'a module path is read off go.mod, quoted or not': () => {
		assert.strictEqual(parseModulePath('module github.com/org/mod\n\ngo 1.24\n'), 'github.com/org/mod');
		assert.strictEqual(parseModulePath('module "github.com/org/mod"\n'), 'github.com/org/mod');
		assert.strictEqual(parseModulePath('go 1.24\n'), undefined);
	},

	'only files inside the module map to a path on disk': () => {
		assert.strictEqual(relativeToModule('github.com/org/mod/pkg/a.go', 'github.com/org/mod'), 'pkg/a.go');
		assert.strictEqual(
			relativeToModule('github.com/other/dep/x.go', 'github.com/org/mod'),
			undefined,
			"a dependency's coverage is a fact about its tests, not about yours",
		);
		// A near-miss prefix must not match: mod vs modtools.
		assert.strictEqual(relativeToModule('github.com/org/modtools/a.go', 'github.com/org/mod'), undefined);
	},

	'a profile cannot climb out of the module root': () => {
		assert.strictEqual(relativeToModule('m/../../etc/passwd', 'm'), undefined);
	},

	'-coverprofile only appears when a profile was asked for': () => {
		const plain = buildRunArgs({ packagePath: './pkg', kind: 'test', names: ['TestA'] });
		assert.ok(!plain.includes('-coverprofile'), 'an ordinary run must not pay for coverage');
		const covered = buildRunArgs({
			packagePath: './pkg', kind: 'test', names: ['TestA'], coverProfile: '/tmp/p.out',
		});
		const at = covered.indexOf('-coverprofile');
		assert.ok(at > 0);
		assert.strictEqual(covered[at + 1], '/tmp/p.out');
		assert.strictEqual(covered[covered.length - 1], './pkg', 'the package spec stays last');
	},

	// -- the case that proves the format, not my reading of it -----------------
	'a real `go test -coverprofile` parses, and its totals match `go tool cover`': () => {
		let goBin;
		try {
			goBin = execFileSync('which', ['go'], { encoding: 'utf8' }).trim();
		} catch {
			console.log('  ⚠ SKIPPED — no `go` on PATH; this case asserts Go\'s own output format.');
			return;
		}
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-cover-test-'));
		try {
			fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/covertest\n\ngo 1.21\n');
			fs.writeFileSync(path.join(dir, 'lib.go'), [
				'package covertest',
				'',
				'func Reached(n int) int {',
				'\tif n > 0 {',
				'\t\treturn n * 2',
				'\t}',
				'\treturn 0',
				'}',
				'',
				'func NeverCalled() string {',
				'\ts := "unreached"',
				'\treturn s',
				'}',
				'',
			].join('\n'));
			fs.writeFileSync(path.join(dir, 'lib_test.go'), [
				'package covertest',
				'',
				'import "testing"',
				'',
				'func TestReached(t *testing.T) {',
				'\tif Reached(2) != 4 {',
				'\t\tt.Fatal("bad")',
				'\t}',
				'}',
				'',
			].join('\n'));

			const profilePath = path.join(dir, 'profile.out');
			const args = buildRunArgs({ packagePath: './...', kind: 'test', coverProfile: profilePath });
			execFileSync(goBin, args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

			const profile = parseCoverProfile(fs.readFileSync(profilePath, 'utf8'));
			assert.ok(profile.mode, 'go writes a mode line');
			assert.strictEqual(profile.files.size, 1, 'one source file carried statements');

			const [[name, blocks]] = [...profile.files];
			assert.strictEqual(relativeToModule(name, 'example.com/covertest'), 'lib.go');

			const { covered, total } = coverageTotals(blocks);
			assert.ok(total > covered, 'NeverCalled must show as uncovered statements');
			assert.ok(covered > 0, 'Reached must show as covered statements');

			// The real assertion: our percentage is the one Go itself reports.
			const funcReport = execFileSync(goBin, ['tool', 'cover', '-func', profilePath], {
				cwd: dir, encoding: 'utf8',
			});
			const goTotal = Number(/total:\s+\(statements\)\s+([\d.]+)%/.exec(funcReport)[1]);
			const ours = Math.round((covered / total) * 1000) / 10;
			assert.strictEqual(
				ours, goTotal,
				`ours ${ours}% vs \`go tool cover -func\` ${goTotal}% — counting blocks instead of statements diverges here`,
			);
			console.log(`      (real profile: ${covered}/${total} statements = ${ours}%, matching go tool cover)`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
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
