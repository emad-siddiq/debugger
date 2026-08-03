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
const { CYCLE_NOTE, DEFECT_NOTE, checksBlock, instruction, linkList, unlocksAll, whyNow } = require('../out/page');

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
