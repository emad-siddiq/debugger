/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the results-grid layer: type-aware cell formatting,
// row capping, and the async run-SELECT flow against a FAKE QueryClient. grid.ts
// imports only types from query.ts, so out/grid.js has no runtime driver need.

'use strict';

const assert = require('node:assert');
const { formatCell, toGrid, runSelect, MAX_GRID_ROWS } = require('../out/grid');

/** A QueryClient stand-in returning a fixed result. */
function fakeClient(result) {
	return {
		async query() { return result; },
		async end() { },
	};
}

const cases = {
	'NULL is not an empty string': () => {
		assert.deepStrictEqual(formatCell(null), { text: 'NULL', kind: 'null' });
		assert.deepStrictEqual(formatCell(undefined), { text: 'NULL', kind: 'null' });
		assert.deepStrictEqual(formatCell(''), { text: '', kind: 'string' });
	},
	'booleans, numbers and bigints classify distinctly': () => {
		assert.deepStrictEqual(formatCell(true), { text: 'true', kind: 'bool' });
		assert.deepStrictEqual(formatCell(42), { text: '42', kind: 'number' });
		assert.deepStrictEqual(formatCell(9007199254740993n), { text: '9007199254740993', kind: 'number' });
	},
	'dates render as ISO': () => {
		assert.deepStrictEqual(formatCell(new Date('2026-07-18T00:00:00.000Z')), { text: '2026-07-18T00:00:00.000Z', kind: 'date' });
	},
	'json/array values render as compact JSON': () => {
		assert.deepStrictEqual(formatCell({ a: 1 }), { text: '{"a":1}', kind: 'json' });
		assert.deepStrictEqual(formatCell([1, 2]), { text: '[1,2]', kind: 'json' });
	},
	'bytea renders as \\x hex': () => {
		assert.deepStrictEqual(formatCell(Uint8Array.from([0xde, 0xad])), { text: '\\xdead', kind: 'bytes' });
	},
	'toGrid emits cells in field order': () => {
		const grid = toGrid({
			fields: [{ name: 'id', dataTypeID: 23 }, { name: 'name', dataTypeID: 25 }],
			rows: [{ name: 'eth-1', id: 1 }, { name: null, id: 2 }],
		});
		assert.deepStrictEqual(grid, {
			columns: ['id', 'name'],
			rows: [
				[{ text: '1', kind: 'number' }, { text: 'eth-1', kind: 'string' }],
				[{ text: '2', kind: 'number' }, { text: 'NULL', kind: 'null' }],
			],
			rowCount: 2,
			truncated: false,
		});
	},
	'toGrid caps rows and flags truncation': () => {
		const rows = Array.from({ length: 5 }, (_v, i) => ({ n: i }));
		const grid = toGrid({ fields: [{ name: 'n', dataTypeID: 23 }], rows }, 3);
		assert.strictEqual(grid.rows.length, 3);
		assert.strictEqual(grid.rowCount, 5);
		assert.strictEqual(grid.truncated, true);
	},
	'MAX_GRID_ROWS is a sane default ceiling': () => {
		assert.strictEqual(typeof MAX_GRID_ROWS, 'number');
		assert.ok(MAX_GRID_ROWS >= 100);
	},
	'runSelect turns a client result into a grid': async () => {
		const grid = await runSelect(fakeClient({
			fields: [{ name: 'ok', dataTypeID: 16 }],
			rows: [{ ok: true }],
		}), 'SELECT true AS ok');
		assert.deepStrictEqual(grid.columns, ['ok']);
		assert.deepStrictEqual(grid.rows, [[{ text: 'true', kind: 'bool' }]]);
	},
};

(async () => {
	let failed = 0;
	for (const [name, fn] of Object.entries(cases)) {
		try {
			await fn();
			console.log(`ok   — ${name}`);
		} catch (err) {
			failed++;
			console.error(`FAIL — ${name}\n       ${err.message}`);
		}
	}
	const total = Object.keys(cases).length;
	console.log(`\n${total - failed}/${total} passed`);
	if (failed > 0) {
		process.exit(1);
	}
})();
