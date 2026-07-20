/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the `go list -json ./...` stream parser + tree builder.
// golist.ts imports nothing from 'vscode', so out/golist.js is a clean CommonJS module we
// require directly. Run: `npm test` (after a compile) or `node test/golist.test.js`.

'use strict';

const assert = require('node:assert');
const { parseGoList, buildPackageTree } = require('../out/golist');

// A realistic concatenated stream: pretty-printed objects back-to-back (not an array),
// with braces + quotes INSIDE a Doc string to exercise the string-aware splitter.
const STREAM = `{
	"ImportPath": "example.com/demo",
	"Name": "main",
	"Doc": "Package main wires { the app } together, see \\"README\\".",
	"Module": { "Path": "example.com/demo", "Main": true },
	"Dir": "/repo",
	"Imports": ["example.com/demo/ingest"]
}
{
	"ImportPath": "example.com/demo/ingest",
	"Name": "ingest",
	"Doc": "Package ingest handles inbound metrics. It backpressures.",
	"Module": { "Path": "example.com/demo", "Main": true },
	"Dir": "/repo/ingest"
}
{
	"ImportPath": "example.com/demo/ingest/store",
	"Name": "store",
	"Module": { "Path": "example.com/demo", "Main": true },
	"Dir": "/repo/ingest/store"
}
{
	"ImportPath": "fmt",
	"Name": "fmt",
	"Standard": true,
	"Dir": "/usr/local/go/src/fmt"
}`;

const cases = {
	'parses each concatenated object in the stream': () => {
		const pkgs = parseGoList(STREAM);
		assert.strictEqual(pkgs.length, 4);
		assert.deepStrictEqual(pkgs.map(p => p.ImportPath), [
			'example.com/demo',
			'example.com/demo/ingest',
			'example.com/demo/ingest/store',
			'fmt',
		]);
	},
	'braces and escaped quotes inside Doc do not fool the splitter': () => {
		const pkgs = parseGoList(STREAM);
		assert.strictEqual(pkgs[0].Doc, 'Package main wires { the app } together, see "README".');
	},
	'empty / whitespace input yields no packages': () => {
		assert.deepStrictEqual(parseGoList('   \n  '), []);
	},
	'a malformed object is skipped, valid neighbours survive': () => {
		const pkgs = parseGoList('{ not json }{ "ImportPath": "a/b" }');
		assert.deepStrictEqual(pkgs.map(p => p.ImportPath), ['a/b']);
	},
	'objects without an ImportPath are dropped': () => {
		assert.deepStrictEqual(parseGoList('{ "Name": "x" }'), []);
	},
	'tree is rooted at the main module and excludes stdlib by default': () => {
		const tree = buildPackageTree(parseGoList(STREAM));
		assert.strictEqual(tree.path, 'example.com/demo');
		assert.ok(tree.pkg, 'root itself is the main package');
		assert.strictEqual(tree.pkg.Name, 'main');
		// fmt (Standard) must not appear anywhere.
		assert.deepStrictEqual(tree.children.map(c => c.name), ['ingest']);
	},
	'nested packages nest under their parent segment': () => {
		const tree = buildPackageTree(parseGoList(STREAM));
		const ingest = tree.children.find(c => c.name === 'ingest');
		assert.strictEqual(ingest.path, 'example.com/demo/ingest');
		assert.strictEqual(ingest.pkg.Name, 'ingest');
		assert.deepStrictEqual(ingest.children.map(c => c.name), ['store']);
		assert.strictEqual(ingest.children[0].pkg.Name, 'store');
	},
	'children are sorted by name': () => {
		const stream = '{ "ImportPath": "m", "Module": { "Path": "m", "Main": true }, "Dir": "/m" }'
			+ '{ "ImportPath": "m/zebra", "Module": { "Path": "m", "Main": true } }'
			+ '{ "ImportPath": "m/alpha", "Module": { "Path": "m", "Main": true } }';
		const tree = buildPackageTree(parseGoList(stream));
		assert.deepStrictEqual(tree.children.map(c => c.name), ['alpha', 'zebra']);
	},
	'mainModuleOnly:false keeps stdlib/foreign packages under their own roots': () => {
		const tree = buildPackageTree(parseGoList(STREAM), { moduleRoot: 'example.com/demo', mainModuleOnly: false });
		const names = tree.children.map(c => c.name);
		assert.ok(names.includes('ingest'));
		assert.ok(names.includes('fmt'), 'fmt kept when mainModuleOnly is off');
	},
	'interior path segments with no package are structural, not clickable': () => {
		// A package at m/a/b/c with none at m/a or m/a/b: interior nodes carry no pkg.
		const stream = '{ "ImportPath": "m", "Module": { "Path": "m", "Main": true } }'
			+ '{ "ImportPath": "m/a/b/c", "Module": { "Path": "m", "Main": true } }';
		const tree = buildPackageTree(parseGoList(stream));
		const a = tree.children.find(c => c.name === 'a');
		assert.strictEqual(a.pkg, undefined);
		const b = a.children.find(c => c.name === 'b');
		assert.strictEqual(b.pkg, undefined);
		assert.ok(b.children.find(c => c.name === 'c').pkg);
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
