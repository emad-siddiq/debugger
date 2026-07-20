/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit tests for the type-matcher registry (task 06.1). registry.ts
// imports nothing from 'vscode', so out/registry.js is a clean CommonJS module.
// Run: `npm test` (after a compile) or `node test/registry.test.js`.

'use strict';

const assert = require('node:assert');
const {
	isByteSlice,
	hexdumpVisualizer,
	registerVisualizer,
	matchVisualizers,
	bestVisualizer,
	hasVisualizer,
} = require('../out/registry');

const cases = {
	'isByteSlice matches []byte and []uint8, nothing else': () => {
		assert.strictEqual(isByteSlice('[]byte'), true);
		assert.strictEqual(isByteSlice('[]uint8'), true);
		assert.strictEqual(isByteSlice('[]int'), false);
		assert.strictEqual(isByteSlice(undefined), false);
	},
	'the byte viewer matches on summary kind bytes': () => {
		assert.strictEqual(hexdumpVisualizer.matches({ kind: 'bytes' }), true);
	},
	'the byte viewer matches on raw []uint8 type when no kind is known': () => {
		assert.strictEqual(hexdumpVisualizer.matches({ type: '[]uint8' }), true);
	},
	'the byte viewer does not match a plain slice': () => {
		assert.strictEqual(hexdumpVisualizer.matches({ type: '[]int', kind: 'slice' }), false);
	},
	'bestVisualizer returns the byte viewer for a []byte value': () => {
		const d = bestVisualizer({ type: '[]byte' });
		assert.ok(d);
		assert.strictEqual(d.id, 'burrow.viz.hexdump');
		assert.strictEqual(d.label, 'Hex / ASCII');
	},
	'hasVisualizer is false for an unhandled type': () => {
		assert.strictEqual(hasVisualizer({ type: 'time.Time', kind: 'time' }), false);
	},
	'matchVisualizers returns matches highest-priority first': () => {
		// Register a higher-priority fake for []byte and confirm it sorts ahead of
		// the built-in byte viewer, without duplicating the built-in.
		registerVisualizer({ id: 'test.fake.hi', label: 'Fake', priority: 200, matches: v => v.type === '[]byte' });
		const ids = matchVisualizers({ type: '[]byte' }).map(d => d.id);
		assert.deepStrictEqual(ids, ['test.fake.hi', 'burrow.viz.hexdump']);
		assert.strictEqual(bestVisualizer({ type: '[]byte' }).id, 'test.fake.hi');
	},
	'registerVisualizer is idempotent by id (replace, not duplicate)': () => {
		registerVisualizer({ id: 'test.dup', label: 'A', priority: 10, matches: () => true });
		registerVisualizer({ id: 'test.dup', label: 'B', priority: 10, matches: () => true });
		const dups = matchVisualizers({ type: 'anything' }).filter(d => d.id === 'test.dup');
		assert.strictEqual(dups.length, 1);
		assert.strictEqual(dups[0].label, 'B');
	},
};

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
	try {
		fn();
		console.log(`ok   — ${name}`);
	} catch (err) {
		failed++;
		console.error(`FAIL — ${name}\n       ${err.message}`);
	}
}
const total = Object.keys(cases).length;
console.log(`\nregistry: ${total - failed}/${total} passed`);
if (failed > 0) {
	process.exit(1);
}
