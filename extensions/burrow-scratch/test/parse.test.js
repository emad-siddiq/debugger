/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The per-language checks, which exist because 1,680 of 2,094 steps had nothing
// between them and a green tick but "the file is not empty" — a verdict one
// space satisfies.
//
// Every case here is a PAIR: the reference's own shape passes, and a specific
// way of being half-written fails. A check that cannot fail is the defect this
// whole feature is organised against; a check that fails on correct content is
// the same defect wearing the other hat, and merkle has 2,040 files' worth of
// the second risk (see the T2 sweep in the session report).
//
// NEGATIVE TEST, whole file: `out/parse.js` does not exist before this change,
// so this suite cannot be loaded against the previous build at all.
// Run: `npm test` (after a compile) or `node test/parse.test.js`.

'use strict';

const assert = require('node:assert');
const { langOf, parseFile, topLevelKeys } = require('../out/parse');

/** `ok` and `not ok`, with the message on failure so a break is readable. */
const good = (lang, name, text, keys = []) => {
	const v = parseFile(lang, name, text, keys);
	assert.ok(v.ok, `${name} should parse, but: ${v.message}`);
};
const bad = (lang, name, text, pattern, keys = []) => {
	const v = parseFile(lang, name, text, keys);
	assert.ok(!v.ok, `${name} should have failed`);
	assert.match(v.message, pattern, `message was: ${v.message}`);
};

const cases = {
	// --- JSON -----------------------------------------------------------------
	'JSON parses, and `{}` does not satisfy a manifest': () => {
		good('json', 'a.json', '{"name":"x","scripts":{"dev":"vite"}}', ['name', 'scripts']);
		// The hole one level up from the one this file closes: `{}` is valid JSON.
		bad('json', 'a.json', '{}', /no top-level "name", "scripts"/, ['name', 'scripts']);
		bad('json', 'a.json', '{"name":"x",}', /JSON/);
		// An array where the reference has an object.
		bad('json', 'a.json', '[]', /object at the top level/, ['name']);
	},

	'a tsconfig keeps its comments and its trailing comma': () => {
		// merkle carries eight JSONC files and a strict parse failed all eight on
		// content byte-identical to the reference.
		const text = '{\n\t// the app program\n\t"compilerOptions": {\n\t\t"strict": true, /* on */\n\t},\n\t"include": ["src"],\n}\n';
		good('jsonc', 'tsconfig.app.json', text, ['compilerOptions', 'include']);
		assert.deepStrictEqual(topLevelKeys('jsonc', text), ['compilerOptions', 'include']);
		// Tolerating comments is not tolerating everything.
		bad('jsonc', 'tsconfig.json', '{\n\t// note\n\t"include": [\n}\n', /JSON/);
	},

	// --- TypeScript -----------------------------------------------------------
	'TypeScript is parsed and NOT resolved': () => {
		good('tsx', 'Badge.tsx', "import { Thing } from './not-written-yet';\nexport const Badge = () => <b>{Thing}</b>;\n");
		good('ts', 'store.ts', 'export type T = { a: number };\nexport const t = { a: 1 } satisfies T;\n');
		good('js', 'run.mjs', "import fs from 'node:fs';\nexport const run = () => fs;\n");
		// An import of a file 600 steps away is the normal state of a step in this
		// plan. A type-checker would fail it; that is why one is not used.
		const v = parseFile('ts', 'x.ts', "import { nope } from './nope';\nexport const y = nope;\n");
		assert.ok(v.ok, v.message);
	},

	'a half-written component says where it stopped': () => {
		bad('tsx', 'Badge.tsx', 'export function Badge() {\n\treturn <div>\n}\n', /^Badge\.tsx:\d+:\d+: /);
		bad('ts', 'store.ts', 'export const a = {\n', /^store\.ts:\d+:\d+: /);
		// JSX in a `.ts` file is the mistake the two script kinds exist to catch.
		bad('ts', 'plain.ts', 'export const a = <div />;\n', /^plain\.ts:\d+:\d+: /);
	},

	// --- CSS ------------------------------------------------------------------
	'CSS is checked on what closes, and strings do not confuse it': () => {
		good('css', 'a.css', '@media (max-width: 40rem) {\n\t.x::after { content: "}"; }\n}\n');
		good('css', 'a.css', "/* } */\n.y { background: url('a)b.png'); }\n");
		bad('css', 'a.css', '.x {\n\tcolor: red;\n', /this \{ is never closed/);
		bad('css', 'a.css', '.x { color: red; }\n}\n', /a \} with no \{ open before it/);
		bad('css', 'a.css', '.x { content: "oops;\n}\n', /this " string is never closed/);
		bad('css', 'a.css', '/* note\n.x { color: red; }\n', /comment is never closed/);
	},

	// --- SQL ------------------------------------------------------------------
	'SQL knows dollar quoting, doubled quotes and its two comment forms': () => {
		good('sql', 'm.sql', "-- the nodes table\nCREATE TABLE nodes (id text primary key, note text default 'it''s fine');\n");
		good('sql', 'm.sql', 'CREATE FUNCTION f() RETURNS void AS $$\nBEGIN\n\t-- ( unbalanced inside the body\nEND;\n$$ LANGUAGE plpgsql;\n');
		good('sql', 'm.sql', "/* a note */\nINSERT INTO t VALUES ('a;b', 'c');\n");
		bad('sql', 'm.sql', 'CREATE FUNCTION f() RETURNS void AS $$\nBEGIN\nEND;\n', /this \$\$ quoted body is never closed/);
		bad('sql', 'm.sql', 'CREATE TABLE nodes (id text,\n', /this \( is never closed/);
		bad('sql', 'm.sql', "INSERT INTO t VALUES ('a);\n", /this ' string is never closed/);
	},

	// --- XML and SVG ----------------------------------------------------------
	'a diagram is checked on its tags': () => {
		good('xml', 'a.svg', '<?xml version="1.0"?>\n<!-- a note -->\n<svg xmlns="http://www.w3.org/2000/svg"><g><path d="M0 0"/></g></svg>\n');
		good('xml', 'a.html', '<html><head><meta charset="utf-8"><link rel="x"></head><body><br></body></html>\n');
		bad('xml', 'a.svg', '<svg><g><path d="M0 0"/></svg>\n', /this <g> is closed by a <\/svg>/);
		bad('xml', 'a.svg', '<svg><g></g>\n', /this <svg> is never closed/);
	},

	// --- YAML -----------------------------------------------------------------
	'YAML is checked on tabs and top-level keys, and says so on the row': () => {
		const compose = 'services:\n  db:\n    image: postgres:16\nvolumes:\n  data:\n';
		good('yaml', 'c.yml', compose, ['services', 'volumes']);
		assert.deepStrictEqual(topLevelKeys('yaml', compose), ['services', 'volumes']);
		// A multi-document manifest is one namespace for this question.
		good('yaml', 'k.yaml', 'apiVersion: v1\nkind: Namespace\n---\napiVersion: v1\nkind: Service\n', ['apiVersion', 'kind']);
		bad('yaml', 'c.yml', 'services:\n\tdb:\n', /a tab in the indentation/);
		bad('yaml', 'c.yml', 'services:\n  db:\n    image: postgres:16\n', /no top-level volumes:/, ['services', 'volumes']);
	},

	// --- routing --------------------------------------------------------------
	'a path lands on the language its ecosystem actually uses': () => {
		assert.strictEqual(langOf('frontend/package.json'), 'json');
		assert.strictEqual(langOf('frontend/tsconfig.app.json'), 'jsonc');
		// By NAME, not by directory: merkle keeps a set of these in a folder called
		// `vscode` with no dot, and a path rule missed all three.
		assert.strictEqual(langOf('infra/test/vscode/launch.json'), 'jsonc');
		assert.strictEqual(langOf('backend/.vscode/api.http'), undefined);
		assert.strictEqual(langOf('a/b.tsx'), 'tsx');
		assert.strictEqual(langOf('a/b.jsx'), 'tsx');
		assert.strictEqual(langOf('a/b.mjs'), 'js');
		assert.strictEqual(langOf('a/b.mts'), 'ts');
		assert.strictEqual(langOf('a/b.scss'), 'css');
		assert.strictEqual(langOf('a/b.svg'), 'xml');
		assert.strictEqual(langOf('a/b.yml'), 'yaml');
		// Nothing here can say anything true about these, and it says nothing.
		for (const p of ['Makefile', 'a/nginx.conf', 'a/x.service', 'a/README.md', 'a/main.go', 'a/x.sh']) {
			assert.strictEqual(langOf(p), undefined, `${p} should get no parse check`);
		}
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
