/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Pure-logic tests for the isolation trio's close cascade.
// Run: node --test extensions/burrow-frontend-debugger/test/trio.test.js
// (requires a prior compile: out/trioLogic.js — `npm run compile` in the extension).

const { test } = require('node:test');
const assert = require('node:assert');
const { decideTrio } = require('../out/trioLogic.js');

const ALL = { tsx: true, css: true, preview: true };
const NONE = { tsx: false, css: false, preview: false };
const cols = (...c) => new Set(c);

test('nothing vanished → idle', () => {
	assert.strictEqual(decideTrio(ALL, ALL, [], cols()), 'idle');
	// A tab opening elsewhere is not our business.
	assert.strictEqual(decideTrio(ALL, ALL, [], cols(4)), 'idle');
});

test('a member genuinely closed → teardown', () => {
	// User closed the source in column 1; nothing opened to take its place.
	assert.strictEqual(decideTrio(ALL, { ...ALL, tsx: false }, [1], cols()), 'teardown');
	assert.strictEqual(decideTrio(ALL, { ...ALL, css: false }, [2], cols()), 'teardown');
	assert.strictEqual(decideTrio(ALL, { ...ALL, preview: false }, [3], cols()), 'teardown');
});

test('a preview tab swapped for another file → replaced, not a close', () => {
	// Explorer single-click: the source tab closes in column 1 and the new file
	// opens in the same column. Closing the trio here would be the worst
	// regression this feature can ship.
	assert.strictEqual(decideTrio(ALL, { ...ALL, tsx: false }, [1], cols(1)), 'replaced');
});

test('a close in one column is not excused by an open in another', () => {
	assert.strictEqual(decideTrio(ALL, { ...ALL, tsx: false }, [1], cols(3)), 'teardown');
	// Mixed: the CSS was replaced but the source really went — still a teardown.
	assert.strictEqual(decideTrio(ALL, { tsx: false, css: false, preview: true }, [1, 2], cols(2)), 'teardown');
});

test('an unknown column fails safe toward the cascade', () => {
	assert.strictEqual(decideTrio(ALL, { ...ALL, tsx: false }, [undefined], cols(undefined)), 'teardown');
});

test('the whole trio already gone (Close All, shutdown) → gone, close nothing', () => {
	assert.strictEqual(decideTrio(ALL, NONE, [1, 2, 3], cols()), 'gone');
});

test('a member that was never open cannot vanish', () => {
	// No colocated stylesheet: css was false in the baseline too.
	const pair = { tsx: true, css: false, preview: true };
	assert.strictEqual(decideTrio(pair, pair, [], cols()), 'idle');
	assert.strictEqual(decideTrio(pair, { ...pair, preview: false }, [3], cols()), 'teardown');
});

test('a settled baseline of nothing never cascades', () => {
	// After a teardown the baseline is all-false; stray events must be inert.
	assert.strictEqual(decideTrio(NONE, NONE, [1], cols()), 'idle');
});

// ---- the trio's geometry ---------------------------------------------------
// The column-numbering contract: every shape must number the trio the way
// stage.ts `trioColumns` claims, because the two are one decision written twice.
// `columnsOf` walks the group tree depth-first, left to right — the same order
// the workbench assigns view columns in.

const { trioLayoutTree } = require('../out/trioLogic.js');

/** The view columns a layout tree produces, in tree order. */
function columnsOf(tree) {
	let next = 1;
	const walk = (groups) => groups.flatMap((g) => (g.groups ? walk(g.groups) : [next++]));
	return walk(tree.groups);
}

test('stacked (the default) nests the source over its stylesheet', () => {
	const tree = trioLayoutTree(true, false, 'stacked');
	// Two top-level halves; the developer's half holds the nested pair.
	assert.strictEqual(tree.groups.length, 2);
	assert.strictEqual(tree.groups[0].groups.length, 2);
	assert.deepStrictEqual(columnsOf(tree), [1, 2, 3]);
});

test('sideBySide flattens the pair into two columns beside the canvas', () => {
	const tree = trioLayoutTree(true, false, 'sideBySide');
	assert.strictEqual(tree.groups.length, 3);
	assert.ok(tree.groups.every((g) => !g.groups), 'no nesting: the divider must be vertical');
	// The canvas keeps its half either way.
	assert.strictEqual(tree.groups[2].size, 0.5);
	assert.deepStrictEqual(columnsOf(tree), [1, 2, 3]);
});

test('the split only applies when there IS a stylesheet', () => {
	assert.deepStrictEqual(trioLayoutTree(false, false, 'sideBySide'), trioLayoutTree(false, false, 'stacked'));
	assert.deepStrictEqual(trioLayoutTree(false, true, 'sideBySide'), trioLayoutTree(false, true, 'stacked'));
});

test('the stage keeps the canvas in column one under both splits', () => {
	for (const split of ['stacked', 'sideBySide']) {
		const tree = trioLayoutTree(true, true, split);
		assert.strictEqual(tree.groups[0].size, 0.62, `${split}: the canvas leads`);
		assert.ok(!tree.groups[0].groups, `${split}: the canvas is never the nested group`);
		// tsx = 2, css = 3 (stage.ts trioColumns), in both shapes.
		assert.deepStrictEqual(columnsOf(tree), [1, 2, 3]);
	}
});

test('every shape is three groups wide when there is a stylesheet, two without', () => {
	for (const stage of [false, true]) {
		for (const split of ['stacked', 'sideBySide']) {
			assert.strictEqual(columnsOf(trioLayoutTree(true, stage, split)).length, 3);
			assert.strictEqual(columnsOf(trioLayoutTree(false, stage, split)).length, 2);
		}
	}
});
