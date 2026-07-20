/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the symbol-anchoring logic. symbols.ts imports nothing from
// 'vscode' (it consumes the structural shape of a DocumentSymbol), so out/symbols.js is a
// clean CommonJS module. Run: `npm test` or `node test/symbols.test.js`.

'use strict';

const assert = require('node:assert');
const { enclosingSymbolChain, symbolPath, symbolPathCandidates } = require('../out/symbols');

/** A SymbolNode literal: name + [startLine,startChar,endLine,endChar] + optional children. */
function sym(name, [sl, sc, el, ec], children) {
	return { name, range: { start: { line: sl, character: sc }, end: { line: el, character: ec } }, children };
}

// package `ingest`, one type Inserter (lines 10-40) with a method loop (lines 20-30),
// and a free function Run (lines 50-55).
const TREE = [
	sym('Inserter', [10, 0, 40, 1], [
		sym('(*Inserter).loop', [20, 0, 30, 1]),
	]),
	sym('Run', [50, 0, 55, 1]),
];

const cases = {
	'position inside a method returns the full outer→inner chain': () => {
		const chain = enclosingSymbolChain(TREE, { line: 25, character: 4 });
		assert.deepStrictEqual(chain.map(s => s.name), ['Inserter', '(*Inserter).loop']);
	},
	'position in the type but outside the method stops at the type': () => {
		const chain = enclosingSymbolChain(TREE, { line: 15, character: 2 });
		assert.deepStrictEqual(chain.map(s => s.name), ['Inserter']);
	},
	'position in a free function returns just it': () => {
		const chain = enclosingSymbolChain(TREE, { line: 52, character: 0 });
		assert.deepStrictEqual(chain.map(s => s.name), ['Run']);
	},
	'position enclosed by nothing returns an empty chain': () => {
		assert.deepStrictEqual(enclosingSymbolChain(TREE, { line: 5, character: 0 }), []);
	},
	'range boundaries are inclusive': () => {
		assert.strictEqual(enclosingSymbolChain(TREE, { line: 10, character: 0 }).length, 1);
		assert.strictEqual(enclosingSymbolChain(TREE, { line: 40, character: 1 }).length, 1);
	},
	'symbolPath joins the chain with the package prefix': () => {
		const chain = enclosingSymbolChain(TREE, { line: 25, character: 4 });
		assert.strictEqual(symbolPath(chain, 'ingest'), 'ingest.Inserter.(*Inserter).loop');
	},
	'symbolPath with an empty chain is just the package': () => {
		assert.strictEqual(symbolPath([], 'ingest'), 'ingest');
	},
	'symbolPath with no package is the bare dotted tail': () => {
		const chain = enclosingSymbolChain(TREE, { line: 52, character: 0 });
		assert.strictEqual(symbolPath(chain), 'Run');
	},
	'candidates fall outward innermost→package': () => {
		const chain = enclosingSymbolChain(TREE, { line: 25, character: 4 });
		assert.deepStrictEqual(symbolPathCandidates(chain, 'ingest'), [
			'ingest.Inserter.(*Inserter).loop',
			'ingest.Inserter',
			'ingest',
		]);
	},
	'candidates for an empty chain are just the package': () => {
		assert.deepStrictEqual(symbolPathCandidates([], 'ingest'), ['ingest']);
	},
	'the tightest enclosing sibling wins when ranges overlap': () => {
		const overlapping = [
			sym('Wide', [0, 0, 100, 0]),
			sym('Narrow', [10, 0, 20, 0]),
		];
		const chain = enclosingSymbolChain(overlapping, { line: 15, character: 0 });
		assert.deepStrictEqual(chain.map(s => s.name), ['Narrow']);
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
console.log(`\n${total - failed}/${total} passed`);
if (failed > 0) {
	process.exit(1);
}
