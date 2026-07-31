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
const { CYCLE_NOTE, DEFECT_NOTE, linkList, unlocksAll, whyNow } = require('../out/page');

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
 *  one, two interchangeable configs, and a Makefile nothing reads. */
const manifests = () => [
	file('backend/go.mod', 'module example.com/app\n\ngo 1.25.0\n'),
	file('backend/main.go', 'package main\n\nfunc main() {}\n'),
	file('web/package.json', '{"name":"web"}'),
	file('web/package-lock.json', '{"name":"web","lockfileVersion":3}'),
	file('web/tsconfig.json', '{\n\t"references": [{ "path": "./tsconfig.app.json" }]\n}\n'),
	file('web/tsconfig.app.json', '{ "compilerOptions": { "strict": true } }\n'),
	file('web/.vite.mockport.config.ts', "import base from './vite.config.ts';\nexport default base;\n"),
	file('web/eslint.config.js', 'export default [];\n'),
	file('web/playwright.config.ts', 'export default {};\n'),
	file('web/vite.config.ts', 'export default {};\n'),
	file('web/src/app.ts', 'export const app = 1;\n'),
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
		// It is only worth asserting because more than one step renders one.
		const foundations = plan.stages[0];
		const said = foundations.steps.map((id) => unlocksAll(plan, plan.steps[id])).filter(Boolean);
		assert.ok(said.length >= 3, `the fixture must exercise several: ${said.length}`);
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
