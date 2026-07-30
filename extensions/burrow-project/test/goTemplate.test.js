/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The Go scaffold's contents, and the house rule that governs them (WO-71 §2).
// goTemplate.ts imports nothing from 'vscode' or 'fs', so out/goTemplate.js is a
// plain CommonJS module. Run: `npm test` or `node test/goTemplate.test.js`.

'use strict';

const assert = require('node:assert');
const { goScaffold, postgresAddition, seedSql, DEFAULT_PORT } = require('../out/goTemplate');

const plain = goScaffold({ name: 'myservice', postgres: false });
const withDb = goScaffold({ name: 'myservice', postgres: true });
const at = (files, p) => files.find((f) => f.path === p);
const paths = (files) => files.map((f) => f.path);

const cases = {
	// ── THE HOUSE RULE, as a test rather than a promise ──────────────────────
	//
	// "Write the file, don't own it." No generated file may mention Burrow, and
	// .gitignore is the single exception — it names `.burrow/` in order to IGNORE
	// it, which is what makes the directory gitignorable as §1 requires.
	'no generated file mentions Burrow, except .gitignore ignoring it': () => {
		for (const file of [...withDb, seedSql()]) {
			const hits = file.content.split('\n')
				.map((line, i) => ({ line, i: i + 1 }))
				.filter(({ line }) => /burrow/i.test(line));
			if (file.path === '.gitignore') {
				assert.deepStrictEqual(hits.map((h) => h.line.trim()), ['.burrow/'],
					'.gitignore may name .burrow/ and nothing else about Burrow');
				continue;
			}
			assert.deepStrictEqual(hits, [],
				`${file.path} mentions Burrow at line(s) ${hits.map((h) => h.i).join(', ')} — the template is wrong, not the rule`);
		}
	},
	'no generated file references a Burrow command or the .burrow directory': () => {
		for (const file of [...withDb, seedSql()]) {
			if (file.path === '.gitignore') { continue; }
			assert.ok(!/\.burrow\b/.test(file.content), `${file.path} references .burrow/`);
			assert.ok(!/burrow\.[a-z]+\./i.test(file.content), `${file.path} references a burrow.* command id`);
		}
	},

	// ── the gate's precondition: nothing Burrow writes is load-bearing ───────
	'the build command is the language\'s own, not a Burrow wrapper': () => {
		const readme = at(withDb, 'README.md').content;
		assert.match(readme, /go build \.\/\.\.\./);
		assert.match(readme, /go run \./);
		assert.ok(!/burrow/i.test(readme));
	},
	'go.mod has no requires, so `go build` needs no network': () => {
		const goMod = at(plain, 'go.mod').content;
		assert.match(goMod, /^module example\.com\/myservice$/m);
		assert.match(goMod, /^go 1\.\d+$/m);
		assert.ok(!/require/.test(goMod), 'a require block would make a first build need the network');
	},

	// ── contents §3 requires ─────────────────────────────────────────────────
	'the plain scaffold is a module, a service, a gitignore and a readme': () => {
		assert.deepStrictEqual(paths(plain).sort(), ['.gitignore', 'README.md', 'go.mod', 'main.go']);
	},
	'the Postgres scaffold adds compose, .env and a committed example': () => {
		assert.deepStrictEqual(paths(withDb).sort(),
			['.env', '.env.example', '.gitignore', 'README.md', 'compose.yaml', 'go.mod', 'main.go']);
	},
	'main.go serves one real route on the default port': () => {
		const main = at(plain, 'main.go').content;
		assert.match(main, /mux\.HandleFunc\("GET \/api\/hello", hello\)/);
		assert.match(main, /http\.ListenAndServe/);
		assert.match(main, new RegExp(`return "${DEFAULT_PORT}"`));
	},
	'main.go compiles in principle: every import is used': () => {
		const main = at(plain, 'main.go').content;
		const imports = /import \(([\s\S]*?)\n\)/.exec(main)[1]
			.split('\n').map((l) => l.trim().replace(/"/g, '')).filter(Boolean);
		const body = main.slice(main.indexOf('func main'));
		for (const imp of imports) {
			const pkg = imp.split('/').pop();
			assert.ok(new RegExp(`\\b${pkg}\\.`).test(body), `${imp} is imported but never used`);
		}
	},

	// ── the breakpoint line, which F5 has to stop on ─────────────────────────
	//
	// Computed from the content rather than hard-coded, because a hard-coded line
	// number is a line-anchored reference and the fork's own invariant forbids
	// them. WO-61 spent a day on a line number that had not moved; this one
	// cannot move without the assertion following it.
	'main.go reports the first executable line of the handler': () => {
		const main = at(plain, 'main.go');
		assert.ok(main.breakpointLine > 0, 'no breakpoint line reported');
		const line = main.content.split('\n')[main.breakpointLine - 1];
		assert.match(line, /name := r\.URL\.Query\(\)\.Get\("name"\)/);
		// and it must be INSIDE the handler, not its signature
		const signature = main.content.split('\n').findIndex((l) => /^func hello\(/.test(l)) + 1;
		assert.ok(main.breakpointLine > signature,
			`line ${main.breakpointLine} is not inside hello() (signature at ${signature})`);
	},

	// ── compose and env agree with each other ────────────────────────────────
	'compose and .env name the same database': () => {
		const compose = at(withDb, 'compose.yaml').content;
		const env = at(withDb, '.env').content;
		assert.match(compose, /POSTGRES_DB: myservice/);
		assert.match(env, /DATABASE_URL=postgres:\/\/myservice:myservice@localhost:5432\/myservice/);
	},
	'compose has a healthcheck, so `up --wait` can mean something': () => {
		assert.match(at(withDb, 'compose.yaml').content, /healthcheck:[\s\S]*pg_isready/);
	},
	'the seed runs from the initdb mount and is idempotent': () => {
		const compose = at(withDb, 'compose.yaml').content;
		assert.match(compose, /docker-entrypoint-initdb\.d/);
		const sql = seedSql();
		assert.strictEqual(sql.path, 'db/init/001_init.sql');
		assert.match(sql.content, /create table if not exists/);
		assert.match(sql.content, /on conflict do nothing/);
	},
	'.gitignore excludes .env but not .env.example': () => {
		const ignore = at(withDb, '.gitignore').content;
		const lines = ignore.split('\n').map((l) => l.trim());
		assert.ok(lines.includes('.env'), '.env must be ignored — it holds a real DSN');
		assert.ok(!lines.includes('.env.example'), '.env.example is the committed template');
	},

	// ── template corruption (WO-72 §0.3) ────────────────────────────────────
	//
	// A backtick in prose inside a template literal ends it early. Three times now:
	// isolateHarness.js, walkView.ts, goTemplate.ts. The compiler catches it
	// DETERMINISTICALLY — TS1005, every time — so it is not a missed defect, and a
	// lint that re-derives what tsc already proves is a heuristic fighting every
	// apostrophe in every comment. I tried; it false-positived on "the env var's
	// NAME" and I threw it away.
	//
	// The residual risk the compiler does NOT cover is a split that still parses:
	// literal + accidentally-valid code + literal, which compiles and quietly emits
	// mangled content. THAT is what these assert. Every generated file is checked
	// for the fingerprints of a split — an unsubstituted `${`, a stray delimiter, a
	// comment marker from this source leaking into output.
	'no generated file carries the fingerprints of a split template literal': () => {
		for (const file of [...withDb, seedSql()]) {
			// compose.yaml legitimately carries `${POSTGRES_PORT:-5432}` — that is
			// COMPOSE's variable syntax, not an unsubstituted JS one. Allow exactly
			// the variables the template means to emit and nothing else.
			const stray = [...file.content.matchAll(/\$\{([^}]*)\}/g)]
				.map((m) => m[1])
				.filter((v) => !/^POSTGRES_PORT:-\d+$/.test(v));
			assert.deepStrictEqual(stray, [],
				`${file.path} has an unsubstituted \${...} — a literal was split and re-opened`);
			// No TypeScript-keyword sniffing: Go shares `func`, `const` and `return`,
			// so that check flagged main.go on its own correct output. `${` and a JS
			// comment delimiter are the two fingerprints no generated file here can
			// produce legitimately.
			assert.ok(!file.content.includes('*/') && !file.content.includes('/**'),
				`${file.path} contains a JS comment delimiter from this module`);
		}
	},
	'every template emits non-empty content and ends with a newline': () => {
		for (const file of [...withDb, seedSql()]) {
			assert.ok(file.content.length > 0, `${file.path} is empty`);
			assert.ok(file.content.endsWith('\n'), `${file.path} does not end with a newline`);
		}
	},

	// ── both Postgres paths exist (§3) ───────────────────────────────────────
	'adding Postgres afterwards yields the same files as asking at create time': () => {
		const added = paths(postgresAddition('myservice')).sort();
		const atCreate = paths(withDb).filter((p) => !paths(plain).includes(p)).sort();
		assert.deepStrictEqual(added, atCreate,
			'the two paths must produce the same project, or one of them is second-class');
	},
};

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
	try {
		fn();
		console.log('  ok  ' + name);
	} catch (err) {
		failed++;
		console.error('FAIL  ' + name + '\n      ' + (err && err.message));
	}
}
if (failed) {
	console.error('\n' + failed + ' goTemplate test(s) failed');
	process.exit(1);
}
console.log('\nAll ' + Object.keys(cases).length + ' goTemplate tests passed');
