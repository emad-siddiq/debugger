/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the qualified-symbol query grammar (task 16, WO-1).
// query.ts imports nothing from 'vscode', so out/query.js is a clean CommonJS
// module we require directly — no test harness, no workbench. Run: `npm test`
// (after a compile) or `node test/query.test.js`.

'use strict';

const assert = require('node:assert');
const {
	parseQuery,
	targetSymbol,
	parentContainer,
	matchSimplePackage,
	matchImportPath,
	matchSymbol,
	findPackageClauseLine,
} = require('../out/query');

const cases = {
	'bare symbol has no qualifier and is kind bare': () => {
		assert.deepStrictEqual(parseQuery('collator'), {
			raw: 'collator', symbolPath: ['collator'], kind: 'bare',
		});
	},
	'pkg.Symbol splits into qualifier + symbol': () => {
		assert.deepStrictEqual(parseQuery('urduwhisper.collator'), {
			raw: 'urduwhisper.collator', pkgQualifier: 'urduwhisper', symbolPath: ['collator'], kind: 'qualified',
		});
	},
	'pkg.Type.Method keeps the whole symbol path': () => {
		const q = parseQuery('urduwhisper.Collator.Reset');
		assert.strictEqual(q.pkgQualifier, 'urduwhisper');
		assert.deepStrictEqual(q.symbolPath, ['Collator', 'Reset']);
		assert.strictEqual(q.kind, 'qualified');
	},
	'trailing dot makes pkg. a package target': () => {
		assert.deepStrictEqual(parseQuery('urduwhisper.'), {
			raw: 'urduwhisper.', pkgQualifier: 'urduwhisper', symbolPath: [], kind: 'package',
		});
	},
	'import-path qualifier splits at the dot after the last slash': () => {
		assert.deepStrictEqual(parseQuery('text/collate.Collator'), {
			raw: 'text/collate.Collator', importPathQualifier: 'text/collate', symbolPath: ['Collator'], kind: 'qualified',
		});
	},
	'import path with no symbol is a package target': () => {
		assert.deepStrictEqual(parseQuery('text/collate'), {
			raw: 'text/collate', importPathQualifier: 'text/collate', symbolPath: [], kind: 'package',
		});
	},
	'dotted import path keeps dots left of the last-slash dot': () => {
		const q = parseQuery('gopkg.in/yaml.v2.Marshal');
		assert.strictEqual(q.importPathQualifier, 'gopkg.in/yaml');
		assert.deepStrictEqual(q.symbolPath, ['v2', 'Marshal']);
	},
	'whitespace is trimmed': () => {
		assert.strictEqual(parseQuery('  pkg.Sym  ').raw, 'pkg.Sym');
	},
	'empty input is an empty bare query': () => {
		assert.deepStrictEqual(parseQuery('   '), { raw: '', symbolPath: [], kind: 'bare' });
	},
	'double dots collapse (no empty segments)': () => {
		assert.deepStrictEqual(parseQuery('pkg..Sym').symbolPath, ['Sym']);
	},
	'targetSymbol is the deepest segment': () => {
		assert.strictEqual(targetSymbol(parseQuery('pkg.A.B.C')), 'C');
		assert.strictEqual(targetSymbol(parseQuery('bare')), 'bare');
		assert.strictEqual(targetSymbol(parseQuery('pkg.')), '');
	},
	'parentContainer is the segment above the target, else undefined': () => {
		assert.strictEqual(parentContainer(parseQuery('pkg.Collator.Reset')), 'Collator');
		assert.strictEqual(parentContainer(parseQuery('pkg.Reset')), undefined);
		assert.strictEqual(parentContainer(parseQuery('bare')), undefined);
	},

	// --- matchSimplePackage: name / last-segment ranking -------------------
	'simple package: exact case-sensitive name wins': () => {
		assert.strictEqual(matchSimplePackage('collate', 'collate', 'text/collate'), 100);
	},
	'simple package: case-insensitive name below exact': () => {
		assert.strictEqual(matchSimplePackage('Collate', 'collate', 'text/collate'), 90);
	},
	'simple package: last import-path segment match': () => {
		// name differs from path tail; qualifier matches the tail exactly.
		assert.strictEqual(matchSimplePackage('collate', 'coll', 'golang.org/x/text/collate'), 80);
	},
	'simple package: prefix beats substring beats no-match': () => {
		assert.strictEqual(matchSimplePackage('coll', 'collate', 'text/collate'), 60);
		assert.strictEqual(matchSimplePackage('lat', 'collate', 'text/collate'), 40);
		assert.strictEqual(matchSimplePackage('zzz', 'collate', 'text/collate'), -1);
	},

	// --- matchImportPath: full-path ranking --------------------------------
	'import path: exact wins, suffix next, substring last': () => {
		assert.strictEqual(matchImportPath('text/collate', 'text/collate'), 100);
		assert.strictEqual(matchImportPath('x/text/collate', 'x/text/collate'), 100);
		assert.strictEqual(matchImportPath('text/collate', 'golang.org/x/text/collate'), 80);
		assert.strictEqual(matchImportPath('collate', 'golang.org/x/text/collate'), 80);
		assert.strictEqual(matchImportPath('text', 'golang.org/x/text/collate'), 40);
		assert.strictEqual(matchImportPath('nope', 'golang.org/x/text/collate'), -1);
	},

	// --- matchSymbol: exact/case/prefix/substring --------------------------
	'symbol: exact case-sensitive over ci over prefix over substring': () => {
		assert.strictEqual(matchSymbol('Reset', 'Reset'), 100);
		assert.strictEqual(matchSymbol('reset', 'Reset'), 90);
		assert.strictEqual(matchSymbol('Res', 'Reset'), 70);
		assert.strictEqual(matchSymbol('ese', 'Reset'), 40);
		assert.strictEqual(matchSymbol('xyz', 'Reset'), -1);
		assert.strictEqual(matchSymbol('', 'Reset'), 0);
	},

	// --- findPackageClauseLine: skip preamble/comments ---------------------
	'package clause: found after a license block comment and blank lines': () => {
		const src = '/*\n * license\n */\n\n// build note\npackage collate\n\nimport "x"\n';
		assert.strictEqual(findPackageClauseLine(src), 5);
	},
	'package clause: first line': () => {
		assert.strictEqual(findPackageClauseLine('package main\n\nfunc main() {}\n'), 0);
	},
	'package clause: single-line block comment then clause': () => {
		assert.strictEqual(findPackageClauseLine('/* pkg */\npackage x\n'), 1);
	},
	'package clause: none found falls back to 0': () => {
		assert.strictEqual(findPackageClauseLine('// just a comment\n'), 0);
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
