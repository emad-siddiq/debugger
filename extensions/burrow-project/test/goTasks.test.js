/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit tests for the Go task argv builders and the problem matcher.
// goTasks.ts imports no 'vscode', so out/goTasks.js is a clean CommonJS module.
// Run: `npm test` or `node test/goTasks.test.js`.
//
// The output the matcher is tested against was CAPTURED from Go 1.23.4 before any
// of this was written — a module with a type error in a subpackage, an unused
// variable and an undefined call in the root package, and fourteen unused
// variables in a third. Nothing here is a fixture somebody imagined.

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
	ALL_PACKAGES,
	GO_PROBLEM_REGEXP,
	GO_TASK_SPECS,
	MATCHER_ROOTS,
	allMatcherNames,
	buildTaskArgs,
	goTaskSpec,
	lintPlan,
	matcherFor,
} = require('../out/goTasks');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// --- what Go really printed ------------------------------------------------

// `go build ./...` — note BOTH path spellings, in one run.
const GO_BUILD = `# example.com/matcher/sub
sub/deep.go:4:9: cannot use "no" (untyped string constant) as int value in return statement
# example.com/matcher
./bad.go:8:2: declared and not used: y
./bad.go:8:7: undefined: undefinedThing`;

// `go vet ./...` — prefixed, and one diagnostic per package.
const GO_VET = `# example.com/matcher/sub
vet: sub/deep.go:4:9: cannot use "no" (untyped string constant) as int value in return statement`;

// `go build ./many/` — the compiler gives up after ten.
const GO_MANY = `# example.com/matcher/many
many/many.go:4:6: declared and not used: v0
many/many.go:13:6: declared and not used: v9
many/many.go:13:6: too many errors`;

// `go test ./sub` — the failure banner must not become a diagnostic.
const GO_TEST = `# example.com/matcher/sub
sub/deep.go:4:9: cannot use "no" (untyped string constant) as int value in return statement
FAIL	example.com/matcher/sub [build failed]
FAIL`;

function matchAll(text, regexp) {
	const re = new RegExp(regexp);
	const hits = [];
	for (const line of text.split('\n')) {
		const m = re.exec(line);
		if (m) {
			hits.push({ file: m[1], line: Number(m[2]), column: Number(m[3]), message: m[4] });
		}
	}
	return hits;
}

const cases = {
	'the matcher reads both path spellings Go emits in one run': () => {
		// The bug this catches: a matcher written against a single sample. The root
		// package is reported as `./bad.go` and a subpackage as `sub/deep.go`; a
		// pattern that keeps the `./` resolves to a file that does not exist, and
		// half a project's errors silently never reach Problems.
		const hits = matchAll(GO_BUILD, GO_PROBLEM_REGEXP);
		assert.strictEqual(hits.length, 3, 'three diagnostics, no package headers');
		assert.deepStrictEqual(hits[0], {
			file: 'sub/deep.go', line: 4, column: 9,
			message: 'cannot use "no" (untyped string constant) as int value in return statement',
		});
		assert.strictEqual(hits[1].file, 'bad.go', 'the leading ./ must be consumed');
		assert.strictEqual(hits[2].file, 'bad.go');
	},

	'a package header line is never a diagnostic': () => {
		// `# example.com/matcher/sub` has no file:line and must not match. It would
		// under a pattern that does not require a .go path.
		for (const text of [GO_BUILD, GO_VET, GO_MANY, GO_TEST]) {
			for (const hit of matchAll(text, GO_PROBLEM_REGEXP)) {
				assert.ok(hit.file.endsWith('.go'), `matched a non-file: ${hit.file}`);
				assert.ok(!hit.file.startsWith('#'));
			}
		}
	},

	'go vet\'s prefix is not part of the path': () => {
		const hits = matchAll(GO_VET, GO_PROBLEM_REGEXP);
		assert.strictEqual(hits.length, 1);
		assert.strictEqual(hits[0].file, 'sub/deep.go', '`vet: sub/deep.go` names no file');
	},

	'"too many errors" is kept, deliberately': () => {
		// It is a diagnostic about the diagnostics: the compiler stopped at ten.
		// Filtering it would leave the reader believing the Problems list is
		// complete when it is not.
		const hits = matchAll(GO_MANY, GO_PROBLEM_REGEXP);
		assert.strictEqual(hits.length, 3);
		assert.strictEqual(hits[2].message, 'too many errors');
	},

	'go test\'s FAIL banner is not a diagnostic': () => {
		const hits = matchAll(GO_TEST, GO_PROBLEM_REGEXP);
		assert.strictEqual(hits.length, 1);
		assert.ok(!hits.some((h) => h.message.includes('build failed')));
	},

	'an absolute path survives the ./ strip': () => {
		// The failure this prevents: a looser `\\.?\\/?` strip eats the leading
		// slash, so /Users/x/main.go becomes a relative Users/x/main.go and
		// resolves under the workspace to nothing.
		const hits = matchAll('/Users/x/proj/main.go:3:1: undefined: foo', GO_PROBLEM_REGEXP);
		assert.strictEqual(hits.length, 1);
		assert.strictEqual(hits[0].file, '/Users/x/proj/main.go');
	},

	'the shipped manifest carries exactly this regexp': () => {
		// The regexp under test is a string in a JSON file, so the only test worth
		// having is one that reads what actually ships.
		const matchers = manifest.contributes.problemMatchers;
		assert.ok(Array.isArray(matchers) && matchers.length > 0, 'no problem matchers contributed');
		for (const m of matchers) {
			assert.strictEqual(m.pattern.regexp, GO_PROBLEM_REGEXP, `${m.name} drifted from the tested regexp`);
			assert.deepStrictEqual(
				[m.pattern.file, m.pattern.line, m.pattern.column, m.pattern.message], [1, 2, 3, 4],
				`${m.name} maps the capture groups differently`);
		}
	},

	'every module root detection can find has a matcher anchored at it': () => {
		// The failure this prevents, and it is silent: detection finds the module
		// under `backend/`, the task runs there, Go reports `sub/deep.go`, and a
		// matcher anchored at ${workspaceFolder} resolves it to a file that does
		// not exist. No error appears anywhere — the Problems view is just empty.
		const shipped = new Set(manifest.contributes.problemMatchers.map((m) => `$${m.name}`));
		for (const name of allMatcherNames()) {
			assert.ok(shipped.has(name), `${name} is returned by matcherFor but not contributed`);
		}
		assert.strictEqual(shipped.size, MATCHER_ROOTS.length, 'a matcher ships that nothing can select');
	},

	'a matcher is anchored at its own module root': () => {
		const byName = new Map(manifest.contributes.problemMatchers.map((m) => [`$${m.name}`, m]));
		assert.deepStrictEqual(byName.get('$go').fileLocation, ['relative', '${workspaceFolder}']);
		assert.deepStrictEqual(byName.get('$go-backend').fileLocation, ['relative', '${workspaceFolder}/backend']);
	},

	'matcherFor normalises the spellings detection can produce': () => {
		assert.strictEqual(matcherFor('.'), '$go');
		assert.strictEqual(matcherFor('backend'), '$go-backend');
		assert.strictEqual(matcherFor('./backend'), '$go-backend');
		assert.strictEqual(matcherFor('backend/'), '$go-backend');
		// Unrecognised roots fall back rather than naming a matcher nothing
		// contributes — an unknown name makes VS Code drop the matcher entirely.
		assert.strictEqual(matcherFor('services/api'), '$go');
	},

	'go mod tidy takes no package argument': () => {
		// Measured: Go 1.23 answers `go mod tidy ./...` with
		// "go: 'go mod tidy' accepts no arguments" and exits 1. The uniform
		// implementation — append `packages` for every kind — breaks the one task
		// whose entire job is to fix go.mod.
		assert.deepStrictEqual(buildTaskArgs('tidy'), ['mod', 'tidy']);
		assert.deepStrictEqual(buildTaskArgs('tidy', './internal/...'), ['mod', 'tidy']);
	},

	'the other tasks carry the package pattern last': () => {
		assert.deepStrictEqual(buildTaskArgs('build'), ['build', ALL_PACKAGES]);
		assert.deepStrictEqual(buildTaskArgs('test', './internal/ingest'), ['test', './internal/ingest']);
		assert.deepStrictEqual(buildTaskArgs('vet', '  '), ['vet', ALL_PACKAGES], 'blank is not a package pattern');
		assert.deepStrictEqual(buildTaskArgs('generate'), ['generate', ALL_PACKAGES]);
	},

	'an unknown task is refused rather than silently mis-run': () => {
		assert.throws(() => buildTaskArgs('deploy'), /unknown go task/);
		assert.strictEqual(goTaskSpec('deploy'), undefined);
	},

	'lint degrades to go vet, and says so': () => {
		const withTool = lintPlan('/Users/x/go/bin/staticcheck', './...');
		assert.strictEqual(withTool.tool, 'staticcheck');
		assert.strictEqual(withTool.degraded, undefined);

		const without = lintPlan(undefined, './...');
		assert.strictEqual(without.tool, 'go');
		assert.deepStrictEqual([...without.args], ['vet', './...']);
		assert.ok(without.degraded && /staticcheck is not installed/.test(without.degraded),
			'a host tool that is absent must be reported, not assumed');
		assert.ok(/go install/.test(without.degraded), 'and the reader must be told how to fix it');
	},

	'the task definition in the manifest matches the specs': () => {
		const def = manifest.contributes.taskDefinitions.find((d) => d.type === 'go');
		assert.ok(def, 'no `go` taskDefinition contributed');
		assert.deepStrictEqual(def.properties.task.enum.slice().sort(),
			GO_TASK_SPECS.map((s) => s.kind).slice().sort());
		assert.deepStrictEqual(def.required, ['task']);
	},

	'every spec is complete, and only the ones with file:line output get a matcher': () => {
		const labels = GO_TASK_SPECS.map((s) => s.label);
		assert.strictEqual(new Set(labels).size, labels.length);
		for (const spec of GO_TASK_SPECS) {
			assert.ok(spec.label && spec.detail, `${spec.kind} is missing a field`);
			assert.ok(['build', 'test', 'none'].includes(spec.group));
		}
		// `go mod tidy` reports `go.mod` problems in its own prose, never as
		// file:line:col — attaching the Go matcher to it would find nothing and
		// suggest it had looked.
		assert.strictEqual(goTaskSpec('tidy').diagnostic, false);
		assert.strictEqual(goTaskSpec('build').diagnostic, true);
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
