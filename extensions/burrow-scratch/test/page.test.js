/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The step page's dependency list. Two things it has to get right and used to
// get wrong: a dependency the plan put later is only an "import cycle" when it
// really is one, and the twelve-link cap must never be the reason you are not
// told about one.
// Run: `npm test` (after a compile) or `node test/page.test.js`.

'use strict';

const assert = require('node:assert');
const Module = require('node:module');

// page.ts imports `vscode` for the webview panel. Nothing exercised here touches
// it, and it is resolved lazily at call time, so an empty stub is enough to load
// the module outside the workbench.
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? {} : load.call(this, request, ...rest);
};

const { buildPlan } = require('../out/planModel');
const { emptyProgress, recordCheck, setState } = require('../out/progressModel');
const { CYCLE_NOTE, DEFECT_NOTE, ago, checksBlock, instruction, linkList, offerBlock, positionOf, rememberedRun, wereHere, unlocksAll, whyNow } = require('../out/page');

const file = (path, text = '') => ({ path, text, bytes: Buffer.byteLength(text) });

/** Two modules that import each other: no order satisfies both. */
const cyclic = () => [
	file('web/package.json', '{"name":"web"}'),
	file('web/src/a/one.ts', "import { two } from '../b/two';\nexport const one = two;\n"),
	file('web/src/b/two.ts', "import { one } from '../a/one';\nexport const two = one;\n"),
];

/** A leaf and its consumer, with the stages swapped afterwards so the consumer
 *  is planned first. Nothing cyclic about it — the order is simply wrong. */
const misordered = () => {
	const plan = buildPlan([
		file('web/package.json', '{"name":"web"}'),
		file('web/src/lib/format.ts', 'export function format(n) { return String(n); }\n'),
		file('web/src/ui/Badge.tsx', "import { format } from '../lib/format';\nexport function Badge() { return format(1); }\n"),
	], { name: 'web', reference: '/ref' });
	const stages = plan.stages.slice();
	const lib = stages.findIndex((s) => s.id === 'web/src/lib');
	const ui = stages.findIndex((s) => s.id === 'web/src/ui');
	[stages[lib], stages[ui]] = [stages[ui], stages[lib]];
	return { ...plan, stages };
};

/** A barrel with thirteen ordinary imports and, last of all, one that imports
 *  back through it — the shape of `frontend/src/primitives/index.ts`. */
const barrel = () => {
	const files = [file('web/package.json', '{"name":"web"}')];
	let imports = '';
	for (let i = 0; i < 13; i++) {
		files.push(file(`web/src/leaf${i}/L${i}.ts`, `export const L${i} = ${i};\n`));
		imports += `import { L${i} } from './leaf${i}/L${i}';\n`;
	}
	files.push(file('web/src/index.ts', `${imports}import { Z } from './z/Z';\nexport const all = [Z];\n`));
	files.push(file('web/src/z/Z.ts', "import { all } from '../index';\nexport const Z = all;\n"));
	return files;
};

/** One Foundations stage carrying every class WO-79 distinguishes: two module
 *  roots, a lockfile, a referenced config, a config referenced by an EARLIER
 *  one, two interchangeable configs, and a Makefile nothing reads.
 *
 *  The manifests NAME dependencies and the files beside them IMPORT those
 *  dependencies, because that is the only thing `unlocksAll` counts now. The
 *  older fixture named none and imported none, and still rendered an unlocks
 *  sentence on every manifest in it — which is precisely the defect. */
const manifests = () => [
	file('backend/go.mod', 'module example.com/app\n\ngo 1.25.0\n\nrequire github.com/go-chi/chi/v5 v5.2.1\n'),
	file('backend/main.go', 'package main\n\nimport (\n\t"net/http"\n\n\t"github.com/go-chi/chi/v5"\n)\n\nfunc main() { var _ http.Handler = chi.NewRouter() }\n'),
	file('web/package.json', '{"name":"web","dependencies":{"react":"^19.0.0"},"devDependencies":{"vite":"^8.0.0"}}'),
	file('web/package-lock.json', '{"name":"web","lockfileVersion":3}'),
	file('web/tsconfig.json', '{\n\t"references": [{ "path": "./tsconfig.app.json" }]\n}\n'),
	file('web/tsconfig.app.json', '{ "compilerOptions": { "strict": true } }\n'),
	file('web/.vite.mockport.config.ts', "import base from './vite.config.ts';\nexport default base;\n"),
	file('web/eslint.config.js', 'export default [];\n'),
	file('web/playwright.config.ts', 'export default {};\n'),
	file('web/vite.config.ts', "import { defineConfig } from 'vite';\nexport default defineConfig({});\n"),
	file('web/src/app.ts', "import { useState } from 'react';\nexport const app = useState;\n"),
	file('Makefile', 'run:\n\techo hi\n'),
];

const cases = {
	'a real forward dependency and a cyclic one read differently': () => {
		const broken = misordered();
		const defect = linkList(broken, broken.steps['web/src/ui/Badge.tsx'].deps, '', 'web/src/ui/Badge.tsx');
		assert.ok(defect.includes(DEFECT_NOTE), `the mis-ordered pair must name the defect:\n${defect}`);
		assert.ok(!defect.includes(CYCLE_NOTE), 'and must not blame a cycle it does not have');

		const plan = buildPlan(cyclic(), { name: 'web', reference: '/ref' });
		const first = plan.stages.flatMap((s) => s.steps).find((id) => plan.steps[id].deps.length);
		const cycle = linkList(plan, plan.steps[first].deps, '', first);
		assert.ok(cycle.includes(CYCLE_NOTE), `a genuine cycle must say so:\n${cycle}`);
		assert.ok(!cycle.includes(DEFECT_NOTE), 'and must not be reported as an ordering defect');

		assert.notStrictEqual(CYCLE_NOTE, DEFECT_NOTE);
	},

	'a forward dependency past the twelfth link is shown anyway': () => {
		const plan = buildPlan(barrel(), { name: 'web', reference: '/ref' });
		const deps = plan.steps['web/src/index.ts'].deps;
		assert.strictEqual(deps.length, 14);
		assert.ok(deps.indexOf('web/src/z/Z.ts') >= 12, 'the case only bites past the cap');

		const html = linkList(plan, deps, '', 'web/src/index.ts');
		assert.ok(html.includes('data-goto="web/src/z/Z.ts"'), `the forward dependency must render:\n${html}`);
		// Twelve ordinary entries plus the forward one; the fourteenth is counted.
		assert.strictEqual((html.match(/data-goto=/g) ?? []).length, 13);
		assert.ok(html.includes('…and 1 more'), 'the rest are still counted, not dropped');
	},

	'a list with nothing out of order is capped exactly as before': () => {
		const plan = buildPlan(barrel(), { name: 'web', reference: '/ref' });
		const deps = plan.steps['web/src/index.ts'].deps;
		const html = linkList(plan, deps, '');   // no step id: nothing to classify
		assert.strictEqual((html.match(/data-goto=/g) ?? []).length, 12);
		assert.ok(html.includes('…and 2 more'));
		assert.ok(!html.includes(CYCLE_NOTE) && !html.includes(DEFECT_NOTE));
	},

	// WO-79 §2. A sentence that does not change when the file changes says
	// nothing about the file — ten of merkle's seventeen Foundations steps
	// rendered one identical string with one identical number, and two of them
	// rendered a false one.
	'no stage renders the same unlocks sentence twice': () => {
		const plan = buildPlan(manifests(), { name: 'app', reference: '/ref' });
		for (const stage of plan.stages) {
			const said = stage.steps.map((id) => unlocksAll(plan, plan.steps[id])).filter(Boolean);
			assert.strictEqual(new Set(said).size, said.length, `${stage.id} repeats a sentence:\n${said.join('\n')}`);
		}
		// It is only worth asserting because more than one step renders one. Counted
		// across the plan rather than inside Foundations: since R77 the lockfile is
		// planned where its install has something to lock, which is not this stage.
		const all = Object.values(plan.steps).map((s) => unlocksAll(plan, s)).filter(Boolean);
		assert.ok(all.length >= 3, `the fixture must exercise several: ${all.length}`);
		const foundations = plan.stages[0].steps.map((id) => unlocksAll(plan, plan.steps[id])).filter(Boolean);
		assert.ok(foundations.length >= 2, `Foundations renders ${foundations.length}`);
	},

	// A lockfile gained a third check when it moved out of Foundations, and the
	// sentence describing its checks did not move with it — caught by reading the
	// shipped page, which is exactly how the go.mod one was caught.
	'the instruction on a generated file names the checks that file actually has': () => {
		const plan = buildPlan(manifests(), { name: 'app', reference: '/ref' });
		const say = (id) => instruction(plan.steps[id], plan.stages.find((s) => s.id === plan.steps[id].stage)).replace(/<[^>]+>/g, '');
		const lock = plan.steps['web/package-lock.json'];
		assert.strictEqual(lock.checks.length, 3, 'the fixture must exercise a lockfile with all three');
		assert.match(say('web/package-lock.json'), /ask what it locked/);
		assert.doesNotMatch(say('web/package-lock.json'), /then look for the file\.$/);
		// …and go.mod keeps its own, which is a different set again.
		assert.match(say('backend/go.mod'), /declares the right module path/);
	},

	// WO-85 Phase 0. The sentence counted step ids by extension under a directory
	// prefix and called the number a fact about imports. This is the case it got
	// wrong on merkle, reduced to the two properties that produce it.
	//
	// NEGATIVE TEST — run against the pre-fix build it reports:
	//   ✗ a manifest that names no dependencies unlocks nothing
	//     Expected values to be strictly equal:
	//     + actual - expected
	//     + "Every bare import under <code>test/</code> — 1 modules' worth — resolves…"
	//     - ''
	'a manifest that names no dependencies unlocks nothing': () => {
		const plan = buildPlan([
			file('test/package.json', '{"name":"oracle","description":"Dependency-free."}'),
			file('test/ts/oracle.mjs', "import fs from 'node:fs';\nimport path from 'node:path';\nexport const run = () => [fs, path];\n"),
		], { name: 'test', reference: '/ref' });
		assert.strictEqual(unlocksAll(plan, plan.steps['test/package.json']), '',
			'a manifest with no dependency block cannot be what anything resolves through');
	},

	// The positive half: the count is importers, and the file that imports only
	// its neighbours is not one of them.
	'the unlocks count is files that import a named package, not files under a prefix': () => {
		const plan = buildPlan([
			file('web/package.json', '{"dependencies":{"react":"^19.0.0"}}'),
			file('web/src/a.tsx', "import React from 'react';\nexport const A = () => React;\n"),
			file('web/src/b.tsx', "import { A } from './a';\nexport const B = () => A;\n"),
			file('web/src/c.ts', "import fs from 'node:fs';\nexport const c = fs;\n"),
		], { name: 'web', reference: '/ref' });
		const said = unlocksAll(plan, plan.steps['web/package.json']).replace(/<[^>]+>/g, '');
		// One importer of three candidate files — the old count was three.
		assert.match(said, /^1 of the 3 files under web\/ imports a package this file names — react\.$/, said);
	},

	// And for a go.mod, where "named" means the module path OR a require. A file
	// importing only the standard library resolves nothing through it.
	'a go.mod counts the files that resolve through it, stdlib-only ones excluded': () => {
		const plan = buildPlan([
			file('svc/go.mod', 'module example.com/svc\n\ngo 1.24\n\nrequire (\n\tgithub.com/go-chi/chi/v5 v5.2.1\n)\n'),
			file('svc/main.go', 'package main\n\nimport "example.com/svc/app"\n\nfunc main() { app.New() }\n'),
			file('svc/app/app.go', 'package app\n\nimport "github.com/go-chi/chi/v5"\n\nfunc New() { chi.NewRouter() }\n'),
			file('svc/util/util.go', 'package util\n\nimport "fmt"\n\nfunc S() string { return fmt.Sprint(1) }\n'),
		], { name: 'svc', reference: '/ref' });
		const said = unlocksAll(plan, plan.steps['svc/go.mod']).replace(/<[^>]+>/g, '');
		assert.match(said, /^2 of the 3 Go files under svc\/ resolve an import through this file/, said);
		assert.match(said, /its own module path, or one of github\.com\/go-chi\/chi\/v5\.$/, said);
	},

	// WO-79 §1. The three derivable classes, and the honest placeholder.
	'a step with no dependencies says something true about itself': () => {
		const plan = buildPlan(manifests(), { name: 'app', reference: '/ref' });
		const say = (id) => whyNow(plan, plan.steps[id]).replace(/<[^>]+>/g, '');

		// Nothing anywhere still claims to be a leaf that can be written first.
		for (const id of Object.keys(plan.steps)) {
			if (!plan.steps[id].deps.length && !plan.steps[id].depStages.length) {
				assert.ok(!/This is a leaf/.test(say(id)), `${id} still calls itself a leaf`);
			}
		}
		assert.match(say('backend/go.mod'), /root of its own Go module/);
		// Named by a later step → say which.
		assert.match(say('web/tsconfig.app.json'), /web\/tsconfig\.json/);
		assert.match(say('web/vite.config.ts'), /web\/\.vite\.mockport\.config\.ts/);
		// Interchangeable neighbours → say so rather than inventing an order.
		assert.match(say('web/eslint.config.js'), /independent/);
		// WO-80 §2: the position a person had to argue for, now argued.
		assert.match(say('Makefile'), /a \*\*choice, not a constraint\*\*|choice, not a constraint/);
		assert.doesNotMatch(say('Makefile'), /nobody has written that judgement down/);
	},

	// Named by an EARLIER step. WO-80 §0a fixed both of merkle's real instances,
	// so this needs a deliberately mis-ordered plan — which is the honest shape
	// of the case anyway: the branch exists for a plan that got it wrong.
	'a step named by something the plan put FIRST says so, and says it is not a cycle': () => {
		const broken = misordered();
		const say = whyNow(broken, broken.steps['web/src/lib/format.ts']).replace(/<[^>]+>/g, '');
		assert.match(say, /put that one FIRST/);
		assert.match(say, /ordering defect, not a cycle/);
		assert.match(say, /web\/src\/ui\/Badge\.tsx/);
	},

	'the go.mod instruction describes the checks that actually run': () => {
		const plan = buildPlan([
			file('backend/go.mod', 'module example.com/app\n\ngo 1.25.0\n'),
			file('backend/models/node.go', 'package models\n\ntype Node struct{}\n'),
		], { name: 'app', reference: '/ref' });
		const step = plan.steps['backend/go.mod'];
		const say = instruction(step, plan.stages.find((s) => s.id === step.stage));
		// The command it teaches is still the whole one — you would really type both.
		assert.match(say, /go mod init example\.com\/app &amp;&amp; go mod tidy/);
		// …but the sentence about the VERDICT no longer promises one the step
		// cannot deliver. "looks for the file" was true; "runs the command" was
		// not, once `go mod tidy` moved to the stage that can earn it.
		assert.match(say, /declares the right module path/);
		assert.match(say, /filled in later/);
		assert.doesNotMatch(say, /the checks run the command and then look for the file/);
	},

	'a check that was never reached does not render as a check that failed': () => {
		const step = {
			id: 'backend/go.mod', checks: [
				{ kind: 'shell', label: 'first', cmd: 'false' },
				{ kind: 'exists', label: 'the file exists and is not empty' },
				{ kind: 'shell', label: 'third', cmd: 'true' },
			],
		};
		// Nothing has run: three idle circles, and no claim about any of them.
		const idle = checksBlock({ plan: {}, progress: {}, stepId: step.id }, step);
		assert.strictEqual((idle.match(/○/g) ?? []).length, 3);
		assert.doesNotMatch(idle, /never reached/);

		// One failed and stopped the run. The other two are NOT two more failures
		// — which is exactly how a real run of this got read as "both checks
		// didn't pass" when only one of them had an opinion.
		const run = { verdict: 'fail', results: [{ check: step.checks[0], verdict: 'fail', output: 'syntax error', durationMs: 1 }] };
		const stopped = checksBlock({ plan: {}, progress: {}, stepId: step.id, checks: run }, step);
		assert.strictEqual((stopped.match(/✕/g) ?? []).length, 1);
		assert.strictEqual((stopped.match(/○/g) ?? []).length, 0);
		assert.strictEqual((stopped.match(/class="skipped"/g) ?? []).length, 2);
		assert.match(stopped, /an earlier check failed/);

		// A run that merely could not answer is not a stop: everything still ran.
		const amber = { verdict: 'unavailable', results: step.checks.map((check) => ({ check, verdict: 'unavailable', output: '', durationMs: 1 })) };
		const all = checksBlock({ plan: {}, progress: {}, stepId: step.id, checks: amber }, step);
		assert.strictEqual((all.match(/class="skipped"/g) ?? []).length, 0);
		assert.strictEqual((all.match(/!/g) ?? []).length, 3);
	},

	'a shell check left unasked does not wear the skipped mark': () => {
		// The save-triggered run (R84) reports only the in-process kinds. Rendering
		// the shell row with the same `–` as one skipped after a failure would tell
		// a reader their save broke something below it.
		const step = {
			id: 'a.json', kind: 'manifest', mode: 'write', lines: 3, declares: [], deps: [], depStages: [],
			checks: [
				{ kind: 'exists', label: 'the file exists and is not empty' },
				{ kind: 'parse', label: 'it parses', lang: 'json' },
				{ kind: 'shell', label: 'it builds', cmd: 'go build ./...' },
			],
		};
		const partial = {
			partial: true, verdict: 'fail',
			results: [{ check: step.checks[0], verdict: 'pass', output: '', durationMs: 1 },
				{ check: step.checks[1], verdict: 'fail', output: 'a.json:2:1: unexpected }', durationMs: 1 }],
		};
		const html = checksBlock({ plan: {}, progress: {}, stepId: step.id, checks: partial }, step);
		assert.strictEqual((html.match(/class="skipped"/g) ?? []).length, 0,
			'nothing here was skipped — one thing was not asked for');
		assert.ok(/data-run="it builds"/.test(html), 'and the row it did not ask for offers to run itself');
		assert.ok(/2 of these run on save/.test(html), `the page must say which are which: ${html.slice(0, 300)}`);
	},

	'a failure that names a position is a place you can go': () => {
		assert.deepStrictEqual(positionOf("ui/Badge.tsx:3:1: '}' expected."), { file: 'ui/Badge.tsx', line: 3, column: 1 });
		assert.deepStrictEqual(positionOf('docs/one.md:14: differs from the reference.'), { file: 'docs/one.md', line: 14, column: 1 });
		// …and one that does not is left alone rather than pointed at line 1.
		assert.strictEqual(positionOf('ui/Badge.tsx: nothing exported here is called `Badge`.'), undefined);
		assert.strictEqual(positionOf('package.json declares no script named: dev'), undefined);

		const step = {
			id: 'ui/Badge.tsx', kind: 'tsx', mode: 'write', lines: 3, declares: [], deps: [], depStages: [],
			checks: [{ kind: 'parse', label: 'it parses', lang: 'tsx' }],
		};
		const run = { verdict: 'fail', results: [{ check: step.checks[0], verdict: 'fail', output: "ui/Badge.tsx:3:1: '}' expected.", durationMs: 1 }] };
		const html = checksBlock({ plan: {}, progress: {}, stepId: step.id, checks: run }, step);
		assert.ok(/data-at="ui\/Badge.tsx:3:1"/.test(html), `no link to the position: ${html}`);
	},

	'the offer appears only when every check actually passed': () => {
		const plan = buildPlan([
			file('web/package.json', '{"name":"web"}'),
			file('web/docs/one.md', '# one\n'),
			file('web/docs/two.md', '# two\n'),
		], { name: 'web', reference: '/ref' });
		const docs = plan.stages.find((s) => s.steps.some((id) => id.startsWith('web/docs/')));
		const step = plan.steps[docs.steps[0]];
		const progress = emptyProgress('2026-08-05T00:00:00.000Z');
		const green = { verdict: 'pass', results: step.checks.map((check) => ({ check, verdict: 'pass', output: '', durationMs: 1 })) };

		const offered = offerBlock(plan, progress, { plan, progress, stepId: step.id, checks: green }, step);
		assert.ok(/data-act="offer"/.test(offered), 'a green step offers the next one');
		assert.ok(/Nothing moves until you do/.test(offered), 'and says it will not move on its own');
		assert.ok(offered.includes(plan.steps[docs.steps[1]].title), 'the offer names the next file in this stage');

		// Nothing offered before a run, on a failure, or on a partial run — the last
		// is the one that matters: four free checks passing is not the step passing.
		assert.strictEqual(offerBlock(plan, progress, { plan, progress, stepId: step.id }, step), '');
		const failed = { verdict: 'fail', results: [{ check: step.checks[0], verdict: 'fail', output: 'no', durationMs: 1 }] };
		assert.strictEqual(offerBlock(plan, progress, { plan, progress, stepId: step.id, checks: failed }, step), '');
		assert.strictEqual(offerBlock(plan, progress, { plan, progress, stepId: step.id, checks: { ...green, partial: true } }, step), '',
			'a partial run must never offer to move on');
	},

	'a remembered verdict says it is remembered, and never offers to move on': () => {
		const plan = buildPlan([
			file('web/package.json', '{"name":"web"}'),
			file('web/docs/one.md', '# one\n'),
			file('web/docs/two.md', '# two\n'),
		], { name: 'web', reference: '/ref' });
		const docs = plan.stages.find((s) => s.steps.some((id) => id.startsWith('web/docs/')));
		const step = plan.steps[docs.steps[0]];
		let progress = emptyProgress('2026-08-05T00:00:00.000Z');
		progress = setState(progress, step.id, 'writing', '2026-08-05T09:00:00.000Z');
		progress = recordCheck(progress, step.id, 'pass', '2026-08-05T09:00:00.000Z',
			step.checks.map((c) => ({ label: c.label, verdict: 'pass', output: '' })));

		const run = rememberedRun(plan, progress, step.id);
		assert.ok(run, 'the last run comes back off disk');
		assert.strictEqual(run.results.length, step.checks.length);
		const state = { plan, progress, stepId: step.id, checks: run, remembered: true };
		const html = checksBlock(state, step);
		assert.ok(/From your last run/.test(html), `the rows must not look freshly run: ${html.slice(0, 200)}`);
		// The one that matters: a window reopened onto a green step must not invite
		// the reader onward from a check that last ran last night.
		assert.strictEqual(offerBlock(plan, progress, state, step), '',
			'a remembered pass is not a pass that just happened');
		assert.ok(/data-act="offer"/.test(offerBlock(plan, progress, { ...state, remembered: false }, step)),
			'…and the same run, freshly made, does offer');
	},

	'a re-plan that changed a step\'s checks drops the answers it no longer has': () => {
		const plan = buildPlan([
			file('web/package.json', '{"name":"web"}'),
			file('web/docs/one.md', '# one\n'),
		], { name: 'web', reference: '/ref' });
		const id = 'web/docs/one.md';
		const progress = recordCheck(emptyProgress('2026-08-05T00:00:00.000Z'), id, 'pass', '2026-08-05T09:00:00.000Z',
			[{ label: 'a check this step no longer has', verdict: 'pass', output: '' }]);
		assert.strictEqual(rememberedRun(plan, progress, id), undefined,
			'an old answer must not be painted onto a new question');
	},

	'you were here says where, when, and how far — in lines': () => {
		const plan = buildPlan([
			file('web/package.json', '{"name":"web"}'),
			file('web/src/lib/a.ts', 'export const a = 1;\n'),
			file('web/src/lib/b.ts', `export const b = 1;\n${'// filler\n'.repeat(98)}`),
		], { name: 'web', reference: '/ref' });
		const now = Date.parse('2026-08-05T12:00:00.000Z');
		let progress = setState(emptyProgress('2026-08-05T00:00:00.000Z'), 'web/src/lib/a.ts', 'done', '2026-08-05T11:00:00.000Z');
		progress = setState(progress, 'web/src/lib/b.ts', 'writing', '2026-08-05T11:30:00.000Z');
		const line = wereHere(plan, progress, 'web/src/lib/b.ts', now);
		assert.ok(/You were here 30 minutes ago/.test(line), line);
		assert.ok(/1 of 2 files/.test(line), line);
		assert.ok(/lines\)/.test(line), `progress is denominated in lines: ${line}`);
		// R87: no streak, no encouragement, no exclamation.
		assert.ok(!/!|streak|keep going|well done|nice/i.test(line), line);
	},

	'how long ago, in the words a person uses': () => {
		const now = Date.parse('2026-08-05T12:00:00.000Z');
		assert.strictEqual(ago('2026-08-05T11:59:40.000Z', now), 'a moment ago');
		assert.strictEqual(ago('2026-08-05T11:59:00.000Z', now), '1 minute ago');
		assert.strictEqual(ago('2026-08-05T11:00:00.000Z', now), '1 hour ago');
		assert.strictEqual(ago('2026-08-03T12:00:00.000Z', now), '2 days ago');
		assert.strictEqual(ago('not a date', now), 'earlier');
	},
};


let failed = 0;
for (const [name, run] of Object.entries(cases)) {
	try {
		run();
		console.log(`  ✓ ${name}`);
	} catch (error) {
		failed++;
		console.error(`  ✗ ${name}\n    ${error.message}`);
	}
}
console.log(`${Object.keys(cases).length - failed}/${Object.keys(cases).length} passed`);
process.exit(failed ? 1 : 0);
