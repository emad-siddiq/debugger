/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The journey surface (WO-86): where you are, what is reachable, and what a
// green step offers next.
//
// Every case here is a PAIR — the thing that has to be true, and the specific
// way the surface used to say something else. Two of them fail against the code
// this replaces rather than merely being absent from it:
//
//   * progress denominated in lines, where `percent(overallTally(…))` counted
//     steps and moved by the same amount for an 8-line migration and a
//     1,004-line dashboard;
//   * "next" being the next thing in the stage you are in, where `nextStep`
//     walks the whole plan from the top and wraps — so finishing a file in
//     stage 63 offered a migration from stage 2.
//
// Run: `npm test` (after a compile) or `node test/journey.test.js`.

'use strict';

const assert = require('node:assert');
const Module = require('node:module');

const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? {} : load.call(this, request, ...rest);
};

const { buildPlan } = require('../out/planModel');
const { emptyProgress, nextStep, setState } = require('../out/progressModel');
const journey = require('../out/journey');
const pages = require('../out/journeyPages');

const file = (path, text = '') => ({ path, text, bytes: Buffer.byteLength(text) });
const NOW = '2026-08-05T00:00:00.000Z';

let failures = 0;
let count = 0;
function test(name, fn) {
	count++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (error) {
		failures++;
		console.log(`  ✗ ${name}\n    ${error.message.split('\n').join('\n    ')}`);
	}
}

/** Two modules, each with its own manifest, plus a package that imports across.
 *  `svc` is Go, `web` is TypeScript — the two graphs the planner walks. */
const project = () => buildPlan([
	file('svc/go.mod', 'module example.com/app\n\ngo 1.25.0\n'),
	file('svc/lib/lib.go', 'package lib\n\nfunc Hello() string { return "hi" }\n'),
	file('svc/cmd/main.go', 'package main\n\nimport "example.com/app/lib"\n\nfunc main() { _ = lib.Hello() }\n'),
	file('web/package.json', '{"name":"web","dependencies":{"react":"^19.0.0"}}'),
	file('web/src/lib/format.ts', 'export function format(n) { return String(n); }\n'),
	file('web/src/ui/Badge.tsx', "import { format } from '../lib/format';\nexport function Badge() { return format(1); }\n"),
	file('web/docs/one.md', '# one\n'),
	file('web/docs/two.md', '# two\n'),
	file('web/docs/three.md', '# three\n'),
], { name: 'demo', reference: '/ref' });

// ---------------------------------------------------------------------------

console.log('journey.test.js');

test('stages are grouped into the modules a person names', () => {
	const plan = project();
	const groups = journey.modulesOf(plan);
	const ids = groups.map((g) => g.id);
	assert.ok(ids.includes('svc'), `no svc module in ${ids.join(', ')}`);
	assert.ok(ids.includes('web'), `no web module in ${ids.join(', ')}`);
	// Foundations holds two modules' root manifests; filing it under whichever
	// one owns its first step would be a lie told by an implementation detail.
	assert.ok(ids.includes('(foundations)'), `Foundations is not its own group: ${ids.join(', ')}`);
	const total = groups.reduce((n, g) => n + g.stages.length, 0);
	assert.strictEqual(total, plan.stages.length, 'every stage belongs to exactly one module');
});

test('progress is lines of the reference, not a count of files', () => {
	// Two files in one stage: one line, and ninety-nine. Settling the short one
	// is 1% of the work and half of the files, and the two must not agree.
	const plan = buildPlan([
		file('web/package.json', '{"name":"web"}'),
		file('web/src/lib/tiny.ts', 'export const a = 1;\n'),
		file('web/src/lib/huge.ts', `export const b = 1;\n${'// filler\n'.repeat(98)}`),
	], { name: 'web', reference: '/ref' });
	const ids = ['web/src/lib/tiny.ts', 'web/src/lib/huge.ts'];
	const done = setState(emptyProgress(NOW), 'web/src/lib/tiny.ts', 'done', NOW);
	const p = journey.lineProgress(plan, done, ids);
	assert.strictEqual(p.stepsDone, 1, 'one of the two files is written');
	assert.ok(p.percent <= 5, `one line of a hundred is not ${p.percent}% — that is the step count wearing a percent sign`);
	assert.ok(p.linesDone < p.lines / 10, `${p.linesDone} of ${p.lines} lines`);
});

test('progress never reads 100% with something left, nor 0% with something done', () => {
	const plan = buildPlan([
		file('web/package.json', '{"name":"web"}'),
		file('web/src/lib/one.ts', 'export const a = 1;\n'),
		file('web/src/lib/big.ts', `export const b = 1;\n${'// filler\n'.repeat(4000)}`),
	], { name: 'web', reference: '/ref' });
	const ids = ['web/src/lib/one.ts', 'web/src/lib/big.ts'];
	const nearlyAll = setState(emptyProgress(NOW), 'web/src/lib/big.ts', 'done', NOW);
	assert.strictEqual(journey.lineProgress(plan, nearlyAll, ids).percent, 99, 'one file short must not round to 100');
	const barely = setState(emptyProgress(NOW), 'web/src/lib/one.ts', 'done', NOW);
	assert.strictEqual(journey.lineProgress(plan, barely, ids).percent, 1, 'a file written must not round to 0');
});

test('what comes next is the next thing HERE, not the oldest thing anywhere', () => {
	// The exact shape that broke: someone opened a late stage from the map,
	// worked down it, and finished its LAST file with one of its own still
	// unwritten. `nextStep` walks the plan from the top and wraps, so it answers
	// with the first unwritten file in the project — hundreds of stages behind
	// where the person is standing.
	const plan = project();
	const order = plan.stages.flatMap((s) => [...s.steps]);
	const docs = plan.stages.find((s) => s.steps.length >= 3 && s.steps.every((id) => plan.steps[id].mode === 'copy'));
	assert.ok(docs, 'the fixture has a three-file stage');
	const last = docs.steps[docs.steps.length - 1];
	let progress = emptyProgress(NOW);
	for (const id of docs.steps.slice(1)) {
		progress = setState(progress, id, 'copied', NOW);
	}
	progress = { ...progress, current: last };

	assert.strictEqual(journey.nextActionable(plan, progress, last), docs.steps[0],
		'the unwritten file in the stage you are standing in');
	// …and what it replaces, named rather than described.
	assert.strictEqual(nextStep(plan, progress, last), order[0],
		'the pre-fix answer really is the first step of the plan');
	assert.notStrictEqual(journey.nextActionable(plan, progress, last), order[0]);
});

test('a finished stage hands on to the next stage, not back to the top', () => {
	const plan = project();
	const first = plan.stages[0];
	let progress = emptyProgress(NOW);
	for (const id of first.steps) {
		progress = setState(progress, id, 'done', NOW);
	}
	progress = { ...progress, current: first.steps[first.steps.length - 1] };
	const next = journey.nextActionable(plan, progress, first.steps[first.steps.length - 1]);
	assert.ok(next, 'there is more of the plan to do');
	assert.notStrictEqual(plan.steps[next].stage, first.id, 'the stage is finished');
	const at = plan.stages.findIndex((s) => s.id === plan.steps[next].stage);
	assert.ok(at > 0, `offered a stage at index ${at}`);
});

test('a stage is blocked only while something it imports is unwritten', () => {
	const plan = project();
	// `svc/cmd` imports `svc/lib`; until lib is written, cmd is blocked.
	const cmd = plan.stages.find((s) => s.steps.some((id) => id.startsWith('svc/cmd')));
	const lib = plan.stages.find((s) => s.steps.some((id) => id.startsWith('svc/lib')));
	assert.ok(cmd && lib, 'the fixture has both packages');
	assert.strictEqual(journey.stageStatus(plan, emptyProgress(NOW), cmd.id), 'blocked');
	let progress = emptyProgress(NOW);
	for (const id of plan.stages[0].steps) {
		progress = setState(progress, id, 'done', NOW);
	}
	for (const id of lib.steps) {
		progress = setState(progress, id, 'done', NOW);
	}
	assert.strictEqual(journey.stageStatus(plan, progress, cmd.id), 'available',
		'everything it needs is written');
});

test('the stage you are on is the one that says so', () => {
	const plan = project();
	const stage = plan.stages[1];
	const progress = { ...emptyProgress(NOW), current: stage.steps[0] };
	assert.strictEqual(journey.stageStatus(plan, progress, stage.id), 'current');
});

test('the copy steps of a stage are what one action brings in', () => {
	const plan = project();
	const docs = plan.stages.find((s) => s.steps.some((id) => id.startsWith('web/docs/')));
	const copies = journey.copySteps(plan, docs.id);
	assert.strictEqual(copies.length, 3, `three documents, got ${copies.length}`);
	assert.ok(copies.every((id) => plan.steps[id].mode === 'copy'), 'and nothing that is typed');
});

// --- the two pages -------------------------------------------------------

test('the front door states the plan it just built, and nothing it did not measure', () => {
	const plan = project();
	const html = pages.frontDoorHtml(plan, '');
	const lines = plan.stages.flatMap((s) => [...s.steps]).reduce((n, id) => n + plan.steps[id].lines, 0);
	assert.ok(html.includes(lines.toLocaleString()), `the line total ${lines} is not on the page`);
	assert.ok(html.includes(`${plan.stages.length} stages`), 'the stage count is not on the page');
	assert.ok(html.includes(String(plan.counts.steps)), 'the file count is not on the page');
	// Cited as a fact about the checks, never promised as an outcome.
	assert.ok(/are among the checks/.test(html), 'the build claim must be attributed to the checks');
	assert.ok(!/you will|guarantee|master|learn to/i.test(html), `the front door promises something: ${html.slice(0, 200)}`);
});

test('a stage entry names what needs it, from the graph and not from a phrasebook', () => {
	const plan = project();
	const lib = plan.stages.find((s) => s.steps.some((id) => id.startsWith('svc/lib')));
	const html = pages.stagePageHtml(plan, emptyProgress(NOW), lib.id, '');
	const readers = pages.stageDependents(plan, lib.id);
	assert.ok(readers.length >= 1, 'svc/cmd imports svc/lib');
	assert.ok(html.includes(`${readers.length} later stage`), `the count of stages that import it is missing`);
	// A leaf says so rather than being handed the same sentence with a zero in it.
	const docs = plan.stages.find((s) => s.steps.some((id) => id.startsWith('web/docs/')));
	const leaf = pages.stagePageHtml(plan, emptyProgress(NOW), docs.id, '');
	assert.ok(/leaf of the graph/.test(leaf), 'a stage nothing imports must not render a sentence about zero stages');
	assert.ok(!/0 later stage/.test(leaf), 'and certainly not "0 later stages import"');
});

test('a stage entry says what it builds in kinds, not in a count of files', () => {
	const plan = project();
	const docs = plan.stages.find((s) => s.steps.some((id) => id.startsWith('web/docs/')));
	assert.strictEqual(pages.composition(plan, docs.steps), '3 documents');
	const mixed = pages.composition(plan, ['web/src/ui/Badge.tsx', 'web/src/lib/format.ts']);
	assert.ok(/React component/.test(mixed) && /TypeScript file/.test(mixed), mixed);
});

test('a stage with one copy step gets no bulk action — one press is not theatre', () => {
	const plan = buildPlan([
		file('web/package.json', '{"name":"web"}'),
		file('web/docs/only.md', '# only\n'),
		file('web/src/lib/a.ts', 'export const a = 1;\n'),
	], { name: 'web', reference: '/ref' });
	const docs = plan.stages.find((s) => s.steps.some((id) => id.startsWith('web/docs/')));
	const html = pages.stagePageHtml(plan, emptyProgress(NOW), docs.id, '');
	assert.ok(!/data-act="materialize"/.test(html), 'a single copy step does not need a bulk action');
});

test('a bulk copy still reports every file on its own', () => {
	const results = [
		{ id: 'docs/a.md', verdict: 'pass', output: '' },
		{ id: 'docs/b.md', verdict: 'fail', output: 'docs/b.md:3: differs from the reference.' },
		{ id: 'docs/c.md', verdict: 'pass', output: '' },
	];
	const html = pages.copyReport(results);
	assert.ok(/3 files copied/.test(html), html.slice(0, 200));
	assert.ok(/2 byte-identical/.test(html), 'the count that passed');
	assert.ok(/<strong>1 not<\/strong>/.test(html), 'and the count that did not, said out loud');
	// The failure is first, and it is a link — a bulk action whose verdict became
	// bulk with it is the thing R83 must not become.
	assert.ok(html.indexOf('docs/b.md') < html.indexOf('docs/a.md'), 'failures first');
	assert.ok(/data-goto="docs\/b.md"/.test(html), 'and reachable');
	assert.strictEqual(pages.copyReport([]), '', 'nothing copied renders nothing');
});

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
