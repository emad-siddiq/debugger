/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The check vocabulary. The rule the whole feature rests on is that a check must
// be able to FAIL — and WO-79 found the two ways it could report a pass instead:
// a command that exits 0 with nothing to work on, and a command that could not
// reach the network reported as the same red as a syntax error.
//
// Real shells, real files, in a temp directory. A test that stubs `exec` would
// not have caught either of these, because both are about what a real command
// actually prints.
// Run: `npm test` (after a compile) or `node test/checks.test.js`.

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCheck, runChecks, summarize } = require('../out/checks');
const { buildPlan } = require('../out/planModel');

/** The check the PLAN emits, not a copy of it. A test that retypes the command
 *  proves the test's command works. */
const checkOf = (files, stepId, match) =>
	buildPlan(files.map((f) => ({ path: f[0], text: f[1], bytes: Buffer.byteLength(f[1]) })), { name: 'x', reference: '/ref' })
		.steps[stepId].checks.find((c) => match.test(c.label));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-checks-'));
fs.mkdirSync(path.join(root, 'mod'), { recursive: true });

const cases = {
	'a command that exits 0 with nothing to work on is not a pass': async () => {
		const check = {
			kind: 'shell', label: 'generated', cmd: 'exit 0', cwd: 'mod',
			needs: { dir: 'mod', match: '.go', why: 'there are no Go files here yet.' },
		};
		const empty = await runCheck(root, 'mod/go.mod', check);
		assert.strictEqual(empty.verdict, 'unavailable');
		assert.strictEqual(empty.reason, 'too-early');
		assert.match(empty.output, /no Go files/);

		// The same command, once its input exists.
		fs.writeFileSync(path.join(root, 'mod', 'main.go'), 'package main\n');
		const ready = await runCheck(root, 'mod/go.mod', check);
		assert.strictEqual(ready.verdict, 'pass');
	},

	'a network failure is not the same red as a syntax error': async () => {
		const offline = await runCheck(root, undefined, {
			kind: 'shell', label: 'tidy',
			cmd: 'echo "go: module lookup disabled: dial tcp: lookup proxy.golang.org: no such host" 1>&2; exit 1',
		});
		assert.strictEqual(offline.verdict, 'unavailable');
		assert.strictEqual(offline.reason, 'offline');
		assert.match(summarize({ results: [offline], verdict: 'unavailable' }), /needs the network/);

		// …and a real failure still fails, with its own words.
		const broken = await runCheck(root, undefined, {
			kind: 'shell', label: 'build', cmd: 'echo "syntax error: unexpected }" 1>&2; exit 2',
		});
		assert.strictEqual(broken.verdict, 'fail');
		assert.strictEqual(broken.reason, undefined);
	},

	'a missing tool is still a missing tool, and says so': async () => {
		const missing = await runCheck(root, undefined, {
			kind: 'shell', label: 'gofmt', cmd: 'burrow-no-such-command-79',
		});
		assert.strictEqual(missing.verdict, 'unavailable');
		assert.strictEqual(missing.reason, 'no-tool');
		assert.match(summarize({ results: [missing], verdict: 'unavailable' }), /not on PATH/);
	},

	'a check whose directory does not exist yet is too-early, not a blank fail': async () => {
		// Empty-start scratches have no directories until a step is reached, and
		// exec with a nonexistent cwd used to produce `fail` with EMPTY output —
		// a red verdict with no words, about the learner's code, wrong twice.
		const result = await runCheck(root, undefined, {
			kind: 'shell', label: 'builds', cmd: 'true', cwd: 'not/there/yet',
		});
		assert.strictEqual(result.verdict, 'unavailable');
		assert.strictEqual(result.reason, 'too-early');
		assert.match(result.output, /not\/there\/yet/);
	},

	'an empty file is reported as empty, never as missing': async () => {
		// Opening a hand-written step CREATES the file, so `empty` is the normal
		// starting state and `missing` is nearly unreachable. Saying "missing or
		// empty" to someone whose `ls` shows the file reads as a broken checker,
		// and it cost a real reader a trip to a terminal to disprove.
		const step = 'frontend/package.json';
		fs.mkdirSync(path.join(root, 'frontend'), { recursive: true });
		fs.writeFileSync(path.join(root, step), '');
		const empty = await runCheck(root, step, { kind: 'exists', label: 'the file exists and is not empty' });
		assert.strictEqual(empty.verdict, 'fail');
		assert.match(empty.output, /there but empty/);
		assert.doesNotMatch(empty.output, /missing|does not exist/);
		// And it names the gesture that fixes the commonest cause: unsaved buffer.
		assert.match(empty.output, /save it/i);

		const gone = await runCheck(root, 'frontend/nope.json', { kind: 'exists', label: 'exists' });
		assert.strictEqual(gone.verdict, 'fail');
		assert.match(gone.output, /does not exist yet/);
	},

	'an empty file passes when the reference leaves it empty': async () => {
		// The other half of the message above: `empty` is normally an unfinished
		// step, but merkle has a zero-byte file and for THAT step empty is the
		// finished article. The plan says which, from the reference's byte count.
		fs.writeFileSync(path.join(root, 'placeholder.md'), '');
		const allowed = await runCheck(root, 'placeholder.md', { kind: 'exists', label: 'the file exists', mayBeEmpty: true });
		assert.strictEqual(allowed.verdict, 'pass');
		assert.strictEqual(allowed.output, '');

		// The negative: without the flag, the same file still fails. A blanket
		// "empty is fine" would delete the only check 1,467 written steps have.
		const strict = await runCheck(root, 'placeholder.md', { kind: 'exists', label: 'the file exists and is not empty' });
		assert.strictEqual(strict.verdict, 'fail');

		// …and `mayBeEmpty` is about empty, not about absent.
		const gone = await runCheck(root, 'nowhere.md', { kind: 'exists', label: 'the file exists', mayBeEmpty: true });
		assert.strictEqual(gone.verdict, 'fail');
		assert.match(gone.output, /does not exist yet/);
	},

	'the Go check parses the file and does not judge its whitespace': async () => {
		// Valid Go that gofmt would reformat. Four of merkle's own files are like
		// this, and the old `gofmt -e -l` check failed every one of them — i.e. it
		// failed steps whose content was byte-identical to the reference.
		const dirty = 'mod/dirty.go';
		fs.writeFileSync(path.join(root, dirty), 'package mod\nfunc Dirty(){}\n');
		const ok = await runCheck(root, dirty, { kind: 'shell', label: 'it parses', cmd: `gofmt -e "${dirty}" > /dev/null` });
		assert.strictEqual(ok.verdict, 'pass');

		// The negative, and the failure that actually matters: a syntax error is
		// still red, and says where it stopped rather than just naming the file.
		const broken = 'mod/broken.go';
		fs.writeFileSync(path.join(root, broken), 'package mod\nfunc Broken( {\n');
		const bad = await runCheck(root, broken, { kind: 'shell', label: 'it parses', cmd: `gofmt -e "${broken}" > /dev/null` });
		assert.strictEqual(bad.verdict, 'fail');
		assert.match(bad.output, /broken\.go:2:/);
	},

	'a run is only a pass when every check answered': async () => {
		fs.writeFileSync(path.join(root, 'file.txt'), 'x');
		const run = await runChecks(root, 'file.txt', [
			{ kind: 'exists', label: 'the file exists and is not empty' },
			{ kind: 'shell', label: 'tool', cmd: 'burrow-no-such-command-79' },
		]);
		assert.strictEqual(run.verdict, 'unavailable');
		assert.strictEqual(run.results[0].verdict, 'pass');
	},

	'the module-line check reads the module path and ignores the go directive': async () => {
		// The go.mod a learner gets from `go mod init` on THIS machine: two lines,
		// and a `go` version that is whatever toolchain ran it. The reference may
		// well declare a newer one — merkle says `go 1.25.0` against a local
		// go1.24.1 — and that is not a difference the learner can close.
		const dir = path.join(root, 'mod');
		const cmd = 'grep -Fqx "module example.com/app" go.mod'
			+ ' || { echo "go.mod declares: $(head -1 go.mod)"; echo "expected:      module example.com/app"; exit 1; }';
		fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/app\n\ngo 1.24.1\n');
		const ok = await runCheck(root, 'mod/go.mod', { kind: 'shell', label: 'declares', cmd, cwd: 'mod' });
		assert.strictEqual(ok.verdict, 'pass');

		// A bare `go mod init` infers a path from the folder name. It succeeds, it
		// is wrong, and this is the only check that notices — with words, not a
		// silent -q failure.
		fs.writeFileSync(path.join(dir, 'go.mod'), 'module mod\n\ngo 1.24.1\n');
		const wrong = await runCheck(root, 'mod/go.mod', { kind: 'shell', label: 'declares', cmd, cwd: 'mod' });
		assert.strictEqual(wrong.verdict, 'fail');
		assert.match(wrong.output, /go\.mod declares: module mod/);
		assert.match(wrong.output, /expected: +module example\.com\/app/);

		// -F, so a `.` in the module path is a dot; -x, so a longer path that
		// merely starts with this one is not a pass.
		fs.writeFileSync(path.join(dir, 'go.mod'), 'module exampleXcom/app\n');
		assert.strictEqual((await runCheck(root, 'mod/go.mod', { kind: 'shell', label: 'declares', cmd, cwd: 'mod' })).verdict, 'fail');
		fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/app/v2\n');
		assert.strictEqual((await runCheck(root, 'mod/go.mod', { kind: 'shell', label: 'declares', cmd, cwd: 'mod' })).verdict, 'fail');
		fs.rmSync(path.join(dir, 'go.mod'));
	},

	// WO-85 Phase 1. The `scripts` block is the half of a manifest a person
	// decides, and until now the whole verdict on it was that the file was not
	// empty — which `{"name":"npm"}` satisfies.
	//
	// NEGATIVE TEST against pre-fix code: `checkOf` returns `undefined` there,
	// because the plan emitted no such check to run.
	'the scripts check reads the scripts block and names what is missing': async () => {
		const reference = '{"name":"npm","scripts":{"dev":"vite","build":"vite build"}}';
		const check = checkOf([['npm/package.json', reference]], 'npm/package.json', /scripts/);
		const dir = path.join(root, 'npm');
		fs.mkdirSync(dir, { recursive: true });
		const write = (text) => fs.writeFileSync(path.join(dir, 'package.json'), text);

		// T2 — byte-identical to the reference, green.
		write(reference);
		assert.strictEqual((await runCheck(root, 'npm/package.json', check)).verdict, 'pass');

		// A manifest with no scripts at all: red, and it says which ones.
		write('{"name":"npm"}');
		const bare = await runCheck(root, 'npm/package.json', check);
		assert.strictEqual(bare.verdict, 'fail');
		assert.match(bare.output, /declares no script named: dev, build/);
		// The check it is standing beside passes on that same file — which is the
		// whole reason this one had to exist.
		assert.strictEqual((await runCheck(root, 'npm/package.json', { kind: 'exists', label: 'e' })).verdict, 'pass');

		// One missing out of two is still red, and names only the missing one.
		write('{"scripts":{"dev":"vite"}}');
		const partial = await runCheck(root, 'npm/package.json', check);
		assert.strictEqual(partial.verdict, 'fail');
		assert.match(partial.output, /no script named: build$/m);
	},

	// R77. `npm install` beside a manifest with an empty dependency block exits 0
	// and writes a lockfile with nothing in it: the command-succeeded check and
	// the file-exists check both go green on a file that locks nothing.
	'a lockfile is checked on what it locks, not on existing': async () => {
		const manifest = '{"name":"npm","dependencies":{"left-pad":"^1.3.0"}}';
		const check = checkOf([['npm/package.json', manifest], ['npm/package-lock.json', '{}']], 'npm/package-lock.json', /locks every package/);
		const dir = path.join(root, 'npm');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'package.json'), manifest);

		// What `npm install` writes when there is nothing to install — four lines,
		// and every check the step used to carry passes on it.
		fs.writeFileSync(path.join(dir, 'package-lock.json'),
			'{\n  "name": "npm",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "npm"\n    }\n  }\n}\n');
		assert.strictEqual((await runCheck(root, 'npm/package-lock.json', { kind: 'exists', label: 'e' })).verdict, 'pass');
		const empty = await runCheck(root, 'npm/package-lock.json', check);
		assert.strictEqual(empty.verdict, 'fail');
		assert.match(empty.output, /1 named by package\.json, 0 locked\. Not locked: left-pad/);

		// …and the same check on a lockfile that did lock it.
		fs.writeFileSync(path.join(dir, 'package-lock.json'),
			'{"name":"npm","lockfileVersion":3,"packages":{"":{"name":"npm"},"node_modules/left-pad":{"version":"1.3.0"}}}');
		const locked = await runCheck(root, 'npm/package-lock.json', check);
		assert.strictEqual(locked.verdict, 'pass');
		assert.match(locked.output, /1 packages named, all 1 locked/);
	},

	'a run that stops at a failure leaves the rest with no result at all': async () => {
		// The distinction the page has to draw: these checks did not fail, they
		// were never reached. Reported here as "fewer results than checks", which
		// is what `checksBlock` reads to render them as skipped rather than idle.
		const run = await runChecks(root, 'file.txt', [
			{ kind: 'shell', label: 'first', cmd: 'echo "syntax error" 1>&2; exit 2' },
			{ kind: 'shell', label: 'second', cmd: 'true' },
			{ kind: 'shell', label: 'third', cmd: 'true' },
		]);
		assert.strictEqual(run.verdict, 'fail');
		assert.strictEqual(run.results.length, 1);
		assert.strictEqual(run.results[0].check.label, 'first');
	},
};

(async () => {
	let failed = 0;
	for (const [name, run] of Object.entries(cases)) {
		try {
			await run();
			console.log(`  ✓ ${name}`);
		} catch (error) {
			failed++;
			console.error(`  ✗ ${name}\n    ${error.message}`);
		}
	}
	fs.rmSync(root, { recursive: true, force: true });
	console.log(`${Object.keys(cases).length - failed}/${Object.keys(cases).length} passed`);
	process.exit(failed ? 1 : 0);
})();
