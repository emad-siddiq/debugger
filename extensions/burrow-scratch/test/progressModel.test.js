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
	migrateProgress, recordCheck, recordConsulted, resumeAt, setCurrent, setState, stageState, stageTally, stateOf,
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
	// WO-79 §5. A stage cannot read green when its executable checks did not
	// execute. Every file written, one command that never answered.
	'a stage with an unproven step does not read finished': () => {
		const withShell = {
			...plan(),
			steps: {
				'a/one.go': { ...step('a/one.go', 10), checks: [{ kind: 'shell', label: 'builds', cmd: 'go build .' }] },
				'a/two.go': step('a/two.go', 10),
				'b/three.go': step('b/three.go', 10),
			},
		};
		let p = emptyProgress(T0);
		p = setState(p, 'a/one.go', 'done', T1);
		p = setState(p, 'a/two.go', 'done', T1);

		// Never run at all.
		assert.strictEqual(stageState(stageTally(withShell, p, 'a')), 'unproven');
		assert.strictEqual(stageTally(withShell, p, 'a').unproven, 1);

		// Ran and could not answer — the state that used to be written as `pass`.
		const unavailable = recordCheck(p, 'a/one.go', 'unavailable', T1);
		assert.strictEqual(stageState(stageTally(withShell, unavailable, 'a')), 'unproven');
		assert.strictEqual(unavailable.steps['a/one.go'].checks, 'unavailable');

		// Ran and passed.
		const passed = recordCheck(p, 'a/one.go', 'pass', T1);
		assert.strictEqual(stageState(stageTally(withShell, passed, 'a')), 'finished');
		assert.strictEqual(stageTally(withShell, passed, 'a').unproven, 0);

		// A step whose only claim is that the file exists is never unproven:
		// existing is the whole of what it says.
		let b = setState(emptyProgress(T0), 'b/three.go', 'done', T1);
		assert.strictEqual(stageState(stageTally(withShell, b, 'b')), 'finished');
	},

	'progress is a value, never mutated in place': () => {
		const before = emptyProgress(T0);
		const after = setState(before, 'a/one.go', 'done', T1);
		assert.strictEqual(stateOf(before, 'a/one.go'), 'todo');
		assert.strictEqual(stateOf(after, 'a/one.go'), 'done');
		assert.strictEqual(before.startedAt, after.startedAt);
	},

	'a version 1 progress file survives the format change intact': () => {
		// A scratch is somebody's evenings. Version 1 is migrated, never discarded,
		// and everything it could express comes through unchanged.
		const v1 = {
			version: 1,
			current: 'backend/go.mod',
			startedAt: T0,
			updatedAt: T1,
			steps: {
				'backend/go.mod': { state: 'done', at: T1, checks: 'pass' },
				'test/go.mod': { state: 'writing', at: T0, note: 'left half typed' },
			},
		};
		const migrated = migrateProgress(v1);
		assert.strictEqual(migrated.version, 2);
		assert.strictEqual(migrated.current, 'backend/go.mod');
		assert.strictEqual(migrated.startedAt, T0);
		assert.deepStrictEqual(migrated.steps, v1.steps, 'not one field of not one step is lost');
		assert.strictEqual(stateOf(migrated, 'backend/go.mod'), 'done');
		// …and it is idempotent, so a file already at 2 is not rewritten twice.
		assert.deepStrictEqual(migrateProgress(migrated), migrated);
		// Anything that is not a progress file is refused rather than half-read.
		assert.strictEqual(migrateProgress({ version: 9, steps: {} }), undefined);
		assert.strictEqual(migrateProgress(null), undefined);
		assert.strictEqual(migrateProgress({ version: 1 }), undefined);
	},

	'the last check run is remembered row by row': () => {
		// Reopening on a column of hollow circles reads as "nothing has ever run"
		// about a step whose checks all passed twenty minutes before you closed it.
		const results = [
			{ label: 'the file exists and is not empty', verdict: 'pass', output: '' },
			{ label: 'it parses', verdict: 'fail', output: 'a.json:2:1: unexpected }' },
		];
		const p = recordCheck(emptyProgress(T0), 'a.json', 'fail', T1, results);
		assert.deepStrictEqual(p.steps['a.json'].results, results);
		assert.strictEqual(p.steps['a.json'].checkedAt, T1, 'and when — a remembered tick has to say it is remembered');
		// A run recorded without results does not erase the ones already there.
		const again = recordCheck(p, 'a.json', 'pass', T1);
		assert.deepStrictEqual(again.steps['a.json'].results, results);
	},

	'opening the reference is recorded, and gates nothing': () => {
		const p = recordConsulted(emptyProgress(T0), 'a.json', T1);
		assert.strictEqual(p.steps['a.json'].consulted, true);
		assert.strictEqual(stateOf(p, 'a.json'), 'todo', 'looking is not working');
		// Sticky: having looked once is a fact, and un-looking is not a thing.
		const twice = recordConsulted(p, 'a.json', T1);
		assert.strictEqual(twice, p, 'no rewrite, no new timestamp');
		// It never touches the tally — R86 says it gates nothing and subtracts
		// from nothing, and a progress bar that docked you for reading would be
		// the product taking a view it has not earned.
		const done = setState(p, 'a.json', 'done', T1);
		assert.strictEqual(stateOf(done, 'a.json'), 'done');
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
