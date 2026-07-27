/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Where you are in the rebuild. The interesting cases are the ones that decide
// whether a week of typing survives: resuming, skipping, and the difference
// between a file you wrote and a file you copied.
// Run: `npm test` (after a compile) or `node test/progressModel.test.js`.

'use strict';

const assert = require('node:assert');
const {
	emptyProgress, isSettled, nextStep, order, overallTally, percent,
	recordCheck, resumeAt, setCurrent, setState, stageState, stageTally, stateOf,
} = require('../out/progressModel');

const T0 = '2026-07-27T10:00:00.000Z';
const T1 = '2026-07-27T11:00:00.000Z';

const step = (id, lines) => ({ id, stage: id.split('/')[0], title: id, kind: 'go', mode: 'write', lines, bytes: lines * 30, summary: '', declares: [], deps: [], depStages: [], checks: [] });

const plan = () => ({
	version: 1,
	name: 'app',
	reference: '/ref',
	stages: [
		{ id: 'a', title: 'a', blurb: '', cls: 'go', steps: ['a/one.go', 'a/two.go'], setup: [], checks: [], tools: [] },
		{ id: 'b', title: 'b', blurb: '', cls: 'go', steps: ['b/three.go'], setup: [], checks: [], tools: [] },
	],
	steps: { 'a/one.go': step('a/one.go', 10), 'a/two.go': step('a/two.go', 20), 'b/three.go': step('b/three.go', 70) },
	counts: { stages: 2, steps: 3, lines: 100 },
});

const cases = {
	'an untouched step is todo': () => {
		assert.strictEqual(stateOf(emptyProgress(T0), 'a/one.go'), 'todo');
	},
	'written and copied both settle the step': () => {
		assert.deepStrictEqual([isSettled('done'), isSettled('copied'), isSettled('writing'), isSettled('todo')], [true, true, false, false]);
	},
	'the plan order is stage order, then step order': () => {
		assert.deepStrictEqual(order(plan()), ['a/one.go', 'a/two.go', 'b/three.go']);
	},
	'next steps past what is finished': () => {
		const p = setState(emptyProgress(T0), 'a/one.go', 'done', T1);
		assert.strictEqual(nextStep(plan(), p), 'a/two.go');
	},
	'next wraps so a skipped file is not lost': () => {
		let p = emptyProgress(T0);
		p = setState(p, 'a/two.go', 'done', T1);
		p = setState(p, 'b/three.go', 'done', T1);
		assert.strictEqual(nextStep(plan(), p, 'a/two.go'), 'a/one.go');
	},
	'next is undefined when the project is rebuilt': () => {
		let p = emptyProgress(T0);
		for (const id of order(plan())) {
			p = setState(p, id, 'done', T1);
		}
		assert.strictEqual(nextStep(plan(), p), undefined);
	},
	'resume returns to the unfinished step you were on': () => {
		let p = setCurrent(emptyProgress(T0), 'a/two.go', T0);
		p = setState(p, 'a/one.go', 'done', T1);
		assert.strictEqual(resumeAt(plan(), p), 'a/two.go');
	},
	'resume moves on when the step you were on is finished': () => {
		let p = setCurrent(emptyProgress(T0), 'a/one.go', T0);
		p = setState(p, 'a/one.go', 'done', T1);
		assert.strictEqual(resumeAt(plan(), p), 'a/two.go');
	},
	'resume survives a step that left the plan': () => {
		const p = setCurrent(emptyProgress(T0), 'gone/old.go', T0);
		assert.strictEqual(resumeAt(plan(), p), 'a/one.go');
	},
	'a check verdict is recorded without changing the state': () => {
		const p = recordCheck(emptyProgress(T0), 'a/one.go', 'fail', T1);
		assert.strictEqual(p.steps['a/one.go'].checks, 'fail');
		assert.strictEqual(stateOf(p, 'a/one.go'), 'writing');
	},
	'a later state change keeps the check verdict': () => {
		let p = recordCheck(emptyProgress(T0), 'a/one.go', 'pass', T0);
		p = setState(p, 'a/one.go', 'done', T1);
		assert.deepStrictEqual([p.steps['a/one.go'].state, p.steps['a/one.go'].checks], ['done', 'pass']);
	},
	'copied files count as settled but not as lines written': () => {
		let p = setState(emptyProgress(T0), 'a/one.go', 'done', T1);
		p = setState(p, 'a/two.go', 'copied', T1);
		const tally = overallTally(plan(), p);
		assert.deepStrictEqual(
			{ done: tally.done, copied: tally.copied, settled: tally.settled, linesWritten: tally.linesWritten },
			{ done: 1, copied: 1, settled: 2, linesWritten: 10 },
		);
	},
	'a stage tallies only its own steps': () => {
		const p = setState(emptyProgress(T0), 'a/one.go', 'done', T1);
		assert.deepStrictEqual(
			[stageTally(plan(), p, 'a').settled, stageTally(plan(), p, 'a').total, stageTally(plan(), p, 'b').settled],
			[1, 2, 0],
		);
	},
	'stage state reads untouched, open, finished': () => {
		assert.deepStrictEqual(
			[stageState({ total: 3, settled: 0 }), stageState({ total: 3, settled: 1 }), stageState({ total: 3, settled: 3 })],
			['untouched', 'open', 'finished'],
		);
	},
	'percent never reads 100 until it is': () => {
		assert.strictEqual(percent({ total: 1000, settled: 999 }), 99);
		assert.strictEqual(percent({ total: 1000, settled: 1000 }), 100);
		assert.strictEqual(percent({ total: 0, settled: 0 }), 0);
	},
	'progress is a value, never mutated in place': () => {
		const before = emptyProgress(T0);
		const after = setState(before, 'a/one.go', 'done', T1);
		assert.strictEqual(stateOf(before, 'a/one.go'), 'todo');
		assert.strictEqual(stateOf(after, 'a/one.go'), 'done');
		assert.strictEqual(before.startedAt, after.startedAt);
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
