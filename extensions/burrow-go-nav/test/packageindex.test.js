/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the `go list -json` package index (task 16, WO-1).
// packageindex.ts imports only query.ts (both vscode-free), so out/packageindex.js
// is a clean CommonJS module. The real `go` runner is behind GoListRunner; here we
// inject a FAKE runner that returns canned stdout, proving the parse → index →
// resolve pipeline without a toolchain. Run: `node test/packageindex.test.js`.

'use strict';

const assert = require('node:assert');
const {
	splitJsonObjects,
	parseGoList,
	packageClauseFile,
	PackageIndex,
} = require('../out/packageindex');

// Two packages, pretty-printed and concatenated exactly as `go list -json` emits —
// no array wrapper, braces and quotes inside strings included on purpose.
const GO_LIST_STDOUT = `{
	"ImportPath": "example.com/app/urduwhisper",
	"Name": "urduwhisper",
	"Dir": "/ws/app/urduwhisper",
	"GoFiles": [
		"collator.go",
		"doc.go",
		"collator_test.go"
	]
}
{
	"ImportPath": "example.com/app/other",
	"Name": "other",
	"Dir": "/ws/app/other",
	"GoFiles": [
		"other.go"
	],
	"Note": "a brace } and a quote \\" live in this string"
}
{
	"ImportPath": "example.com/app/broken",
	"Dir": "/ws/app/broken"
}
`;

/** A fake GoListRunner returning canned stdout — the injectable seam under GoCli. */
class FakeRunner {
	constructor(stdout) { this.stdout = stdout; this.calls = []; }
	async list(args) { this.calls.push(args); return this.stdout; }
}

const cases = {
	'splitJsonObjects finds each top-level object, ignoring braces in strings': () => {
		const parts = splitJsonObjects(GO_LIST_STDOUT);
		assert.strictEqual(parts.length, 3);
		assert.ok(parts[1].includes('a brace } and a quote'));
	},
	'parseGoList normalizes fields and defaults missing GoFiles': () => {
		const pkgs = parseGoList(GO_LIST_STDOUT);
		assert.strictEqual(pkgs.length, 3);
		assert.deepStrictEqual(pkgs[0], {
			importPath: 'example.com/app/urduwhisper',
			name: 'urduwhisper',
			dir: '/ws/app/urduwhisper',
			goFiles: ['collator.go', 'doc.go', 'collator_test.go'],
		});
		// The third has no Name/GoFiles — name falls back to '', goFiles to [].
		assert.strictEqual(pkgs[2].name, '');
		assert.deepStrictEqual(pkgs[2].goFiles, []);
	},
	'parseGoList skips objects with no ImportPath or Dir': () => {
		const pkgs = parseGoList('{"Name":"x"}\n{"ImportPath":"a","Dir":"/d"}\n');
		assert.strictEqual(pkgs.length, 1);
		assert.strictEqual(pkgs[0].importPath, 'a');
	},
	'parseGoList tolerates junk between objects': () => {
		const pkgs = parseGoList('go: downloading …\n{"ImportPath":"a","Dir":"/d"}\n');
		assert.strictEqual(pkgs.length, 1);
	},
	'packageClauseFile prefers doc.go': () => {
		const pkgs = parseGoList(GO_LIST_STDOUT);
		assert.strictEqual(packageClauseFile(pkgs[0]), '/ws/app/urduwhisper/doc.go');
	},
	'packageClauseFile falls back to first non-test file': () => {
		assert.strictEqual(packageClauseFile({
			importPath: 'p', name: 'p', dir: '/d', goFiles: ['a_test.go', 'a.go'],
		}), '/d/a.go');
	},
	'packageClauseFile is undefined with no files': () => {
		assert.strictEqual(packageClauseFile({ importPath: 'p', name: 'p', dir: '/d', goFiles: [] }), undefined);
	},

	// --- PackageIndex lookups + resolution --------------------------------
	'index maps by dir and import path': () => {
		const idx = new PackageIndex(parseGoList(GO_LIST_STDOUT));
		assert.strictEqual(idx.size, 3);
		assert.strictEqual(idx.packageForDir('/ws/app/urduwhisper').name, 'urduwhisper');
		// trailing slash on the query dir still resolves.
		assert.strictEqual(idx.packageForDir('/ws/app/urduwhisper/').name, 'urduwhisper');
		assert.strictEqual(idx.packageForImportPath('example.com/app/other').name, 'other');
		assert.strictEqual(idx.packageForImportPath('nope'), undefined);
	},
	'resolveSimple ranks the exact name match first': () => {
		const idx = new PackageIndex(parseGoList(GO_LIST_STDOUT));
		const ranked = idx.resolveSimple('urduwhisper');
		assert.strictEqual(ranked[0].pkg.name, 'urduwhisper');
		assert.strictEqual(ranked[0].score, 100);
	},
	'resolveSimple substring matches multiple, exact-name first': () => {
		const idx = new PackageIndex(parseGoList(GO_LIST_STDOUT));
		// 'other' matches only `other`; a broad substring 'e' hits several.
		const ranked = idx.resolveSimple('other');
		assert.strictEqual(ranked.length, 1);
		assert.strictEqual(ranked[0].pkg.name, 'other');
	},
	'resolveImportPath matches a path suffix': () => {
		const idx = new PackageIndex(parseGoList(GO_LIST_STDOUT));
		const ranked = idx.resolveImportPath('app/other');
		assert.strictEqual(ranked[0].pkg.importPath, 'example.com/app/other');
		assert.strictEqual(ranked[0].score, 80);
	},

	// --- the injectable runner seam ---------------------------------------
	'a fake GoListRunner feeds parse → index end to end': async () => {
		const runner = new FakeRunner(GO_LIST_STDOUT);
		const stdout = await runner.list(['-json', './...']);
		const idx = new PackageIndex(parseGoList(stdout));
		assert.deepStrictEqual(runner.calls, [['-json', './...']]);
		assert.strictEqual(idx.resolveSimple('urduwhisper')[0].pkg.dir, '/ws/app/urduwhisper');
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
