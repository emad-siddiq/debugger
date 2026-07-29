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
const { CYCLE_NOTE, DEFECT_NOTE, linkList } = require('../out/page');

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

	'a list with nothing out of order is capped exactly as before': () => {
		const plan = buildPlan(barrel(), { name: 'web', reference: '/ref' });
		const deps = plan.steps['web/src/index.ts'].deps;
		const html = linkList(plan, deps, '');   // no step id: nothing to classify
		assert.strictEqual((html.match(/data-goto=/g) ?? []).length, 12);
		assert.ok(html.includes('…and 2 more'));
		assert.ok(!html.includes(CYCLE_NOTE) && !html.includes(DEFECT_NOTE));
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
