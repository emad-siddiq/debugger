/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The rules behind phases B–E, tested without a workbench: what may be sent
// (contextModel), which memory rows apply (memoryModel), how a proposed diff is
// read and applied (diffModel), and the insight cache and budget
// (insightsModel). Each of those files imports nothing from 'vscode' precisely
// so this can exist.
// Run: `npm test` (after a compile) or `node test/model.test.js`.

'use strict';

const assert = require('node:assert');
const { isDenied, bundleFor, bundleRole, render, withQuestion, estimateTokens, DENY_GLOBS } = require('../out/contextModel');
const { selectMemory, envNamesIn, section, rowsMentioning, indexTitles, contractReminders } = require('../out/memoryModel');
const { extractDiff, parseDiff, applyDiff, newFileContent } = require('../out/diffModel');
const { insightKey, Lru, HourlyBudget, insightPrompt } = require('../out/insightsModel');

const cases = {
	// ---- context: what may be sent -----------------------------------------
	'every secret shape on the deny list is refused': () => {
		for (const file of [
			'.env', '.env.local', 'frontend/.env.production',
			'infra/secrets/db.yaml', 'certs/server.pem', 'certs/server.key',
			'config/secrets.json', '.claude/settings.local.json',
			'node_modules/react/index.js', '.git/config',
		]) {
			assert.ok(isDenied(file), file);
		}
	},
	'ordinary source is not refused': () => {
		for (const file of ['src/App.tsx', 'backend/api/router.go', 'docs/environment.md', 'src/lib/keyboard.ts']) {
			assert.ok(!isDenied(file), file);
		}
	},
	'the deny list can be added to but the built-ins always apply': () => {
		const extra = [...DENY_GLOBS, '**/private/**'];
		assert.ok(isDenied('app/private/notes.md', extra));
		assert.ok(isDenied('.env', extra), 'built-ins survive the extension');
		assert.ok(!isDenied('app/private/notes.md'), 'and are not applied to everyone');
	},
	'a windows path is matched the same as a posix one': () => {
		assert.ok(isDenied('C:\\repo\\.env.local'));
	},

	'the page bundle finds the stylesheet, samples and tests beside a component': () => {
		const siblings = ['Badge.tsx', 'Badge.css', 'Badge.samples.ts', 'Badge.test.tsx', 'Other.tsx', 'index.ts'];
		assert.deepStrictEqual(bundleFor('src/ui/Badge.tsx', siblings), [
			'src/ui/Badge.css', 'src/ui/Badge.samples.ts', 'src/ui/Badge.test.tsx',
		]);
	},
	'a file with no family has no bundle, and a non-component never does': () => {
		assert.deepStrictEqual(bundleFor('src/ui/Badge.tsx', ['Badge.tsx']), []);
		assert.deepStrictEqual(bundleFor('backend/api/router.go', ['router.go', 'router.css']), []);
	},
	'each bundle member says what it is': () => {
		assert.strictEqual(bundleRole('a/Badge.css'), 'stylesheet');
		assert.strictEqual(bundleRole('a/Badge.samples.ts'), 'sample props');
		assert.strictEqual(bundleRole('a/Badge.test.tsx'), 'tests');
		assert.strictEqual(bundleRole('a/Badge.tsx'), 'source');
	},

	'layers are rendered cheapest-first, whatever order they arrive in': () => {
		const out = render([
			{ id: 'memory', label: 'Repo memory', body: 'm' },
			{ id: 'workspace', label: 'Workspace', body: 'w' },
			{ id: 'pages', label: 'Open pages', body: 'p' },
		], 12000);
		assert.deepStrictEqual(out.included, ['workspace', 'pages', 'memory']);
		assert.ok(out.text.indexOf('## Workspace') < out.text.indexOf('## Open pages'));
	},
	'an empty layer is not a heading': () => {
		const out = render([{ id: 'pages', label: 'Open pages', body: '   ' }], 12000);
		assert.strictEqual(out.text, '');
		assert.deepStrictEqual(out.included, []);
	},
	'what does not fit is named, not silently dropped': () => {
		const big = { id: 'memory', label: 'Repo memory', body: 'x'.repeat(4000) };
		const out = render([{ id: 'workspace', label: 'Workspace', body: 'small' }, big], 100);
		assert.deepStrictEqual(out.included, ['workspace']);
		assert.deepStrictEqual(out.dropped, ['memory']);
	},
	'the same layers render byte-for-byte the same twice (the insight cache depends on it)': () => {
		const layers = [{ id: 'pages', label: 'Open pages', body: '- a\n- b' }, { id: 'workspace', label: 'Workspace', body: 'w' }];
		assert.strictEqual(render(layers, 12000).text, render([...layers].reverse(), 12000).text);
	},
	'the question is sent with the envelope wrapped around it, or alone': () => {
		const withCtx = withQuestion('## Workspace\nmerkle', 'why?');
		assert.ok(withCtx.includes('<burrow-context>') && withCtx.trim().endsWith('why?'));
		assert.strictEqual(withQuestion('', 'why?'), 'why?');
	},
	'tokens are estimated, not counted': () => {
		assert.strictEqual(estimateTokens('12345678'), 2);
	},

	// ---- memory: which rows apply ------------------------------------------
	'repo meta, prefs and traps come along every time': () => {
		const picks = selectMemory('src/App.tsx', 'why is this misaligned?');
		assert.deepStrictEqual(picks[0], { file: 'repo.yaml', keys: ['meta', 'prefs', 'traps'], why: 'always' });
	},
	'a route file pulls the api rows that mention it': () => {
		const picks = selectMemory('backend/api/router.go', 'what does this do?');
		const api = picks.find((p) => p.file === 'api.yaml');
		assert.ok(api && api.mentioning.includes('router.go'));
	},
	'schema-adjacent files pull the tables and migrations': () => {
		assert.ok(selectMemory('backend/db/migrations/003_nodes.sql', 'x').some((p) => p.file === 'db.yaml'));
		assert.ok(selectMemory('backend/store/nodes.go', 'x').some((p) => p.file === 'db.yaml'));
	},
	'a stylesheet pulls the design tokens': () => {
		const design = selectMemory('src/ui/Badge.css', 'x').find((p) => p.file === 'design.yaml');
		assert.deepStrictEqual(design && design.keys, ['tokens']);
	},
	'asking what the repo is takes the whole of repo.yaml and nothing else': () => {
		const picks = selectMemory('src/App.tsx', 'What does this repo do?');
		assert.strictEqual(picks.length, 1);
		assert.deepStrictEqual(picks[0].keys, []);
	},
	'environment names are read out of the open file, all three dialects': () => {
		const source = 'os.Getenv("DB_URL") import.meta.env.VITE_API process.env.NODE_ENV os.Getenv("DB_URL")';
		assert.deepStrictEqual(envNamesIn(source), ['DB_URL', 'NODE_ENV', 'VITE_API']);
	},
	'a top-level section is the key line plus everything indented under it': () => {
		const yaml = 'meta:\n  updated_at: 2026-07-25\n  by: x\n\nprefs:\n  - a\ntraps:\n  - b\n';
		assert.strictEqual(section(yaml, 'meta'), 'meta:\n  updated_at: 2026-07-25\n  by: x');
		assert.strictEqual(section(yaml, 'prefs'), 'prefs:\n  - a');
		assert.strictEqual(section(yaml, 'nope'), undefined);
	},
	'a long list is narrowed to the rows that mention the file': () => {
		const rows = 'a: router.go\nb: other.go\nc: router.go\n';
		assert.strictEqual(rowsMentioning(rows, ['router.go']), 'a: router.go\nc: router.go');
		assert.strictEqual(rowsMentioning(rows, []), '');
	},
	'the memory index contributes its titles only': () => {
		assert.deepStrictEqual(indexTitles('# One\ntext\n## Two\n- **Three** — hook\n'), ['One', 'Two', 'Three — hook']);
	},
	'a change that touches the contract says which file owes a row': () => {
		assert.deepStrictEqual(contractReminders('+\trouter.Get("/api/nodes", h)'), ['`api.yaml` — this adds or changes a route']);
		assert.deepStrictEqual(contractReminders('+\turl := os.Getenv("DB_URL")'), ['`env.yaml` — this references an environment variable']);
		assert.deepStrictEqual(contractReminders('+CREATE TABLE nodes (id text);'), ['`db.yaml` — this changes the schema']);
		assert.deepStrictEqual(contractReminders('+  --badge-bg: red;'), ['`design.yaml` — this declares a design token']);
		assert.deepStrictEqual(contractReminders('+  const x = 1;'), []);
	},
	'a REMOVED line does not count as touching the contract': () => {
		assert.deepStrictEqual(contractReminders('-\trouter.Get("/api/nodes", h)'), []);
	},

	// ---- diffs: reading and applying ---------------------------------------
	'a fenced diff is found in an answer that explains itself first': () => {
		const answer = 'Here is the fix:\n\n```diff\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n```\nHope that helps.';
		assert.ok(extractDiff(answer).includes('@@ -1,1 +1,1 @@'));
	},
	'an unlabelled fence that IS a diff still counts': () => {
		const answer = '```\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n```';
		assert.ok(extractDiff(answer));
	},
	'an answer with no diff yields nothing': () => {
		assert.strictEqual(extractDiff('Just prose.\n\n```ts\nconst a = 1;\n```'), undefined);
	},
	'a diff parses into files and hunks': () => {
		const files = parseDiff('--- a/src/x.ts\n+++ b/src/x.ts\n@@ -2,3 +2,3 @@\n keep\n-old\n+new\n');
		assert.strictEqual(files.length, 1);
		assert.strictEqual(files[0].path, 'src/x.ts');
		assert.strictEqual(files[0].hunks.length, 1);
		assert.deepStrictEqual(files[0].hunks[0].before, ['keep', 'old']);
		assert.deepStrictEqual(files[0].hunks[0].after, ['keep', 'new']);
	},
	'two files in one diff are two files': () => {
		const files = parseDiff('--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+A\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-b\n+B\n');
		assert.deepStrictEqual(files.map((f) => f.path), ['a.ts', 'b.ts']);
	},
	'a hunk applies where the file actually says it, not where the header claims': () => {
		const original = 'one\ntwo\nthree\nfour\n';
		// The header points at line 1; the block is really at line 3.
		const result = applyDiff(original, [{ oldStart: 1, before: ['three'], after: ['THREE'] }]);
		assert.strictEqual(result.text, 'one\ntwo\nTHREE\nfour\n');
	},
	'two hunks in one file both land, with the drift between them accounted for': () => {
		const original = 'a\nb\nc\nd\n';
		const result = applyDiff(original, [
			{ oldStart: 1, before: ['a'], after: ['a', 'a2'] },
			{ oldStart: 3, before: ['c'], after: ['C'] },
		]);
		assert.strictEqual(result.text, 'a\na2\nb\nC\nd\n');
	},
	'a hunk that matches nothing is rejected rather than forced': () => {
		const result = applyDiff('one\ntwo\n', [{ oldStart: 1, before: ['gone'], after: ['x'] }]);
		assert.strictEqual(result.text, undefined);
		assert.deepStrictEqual(result.rejected, [1]);
	},
	'trailing whitespace differences do not reject a hunk': () => {
		const result = applyDiff('one   \ntwo\n', [{ oldStart: 1, before: ['one'], after: ['ONE'] }]);
		assert.strictEqual(result.text, 'ONE\ntwo\n');
	},
	'CRLF files stay CRLF': () => {
		const result = applyDiff('a\r\nb\r\n', [{ oldStart: 1, before: ['a'], after: ['A'] }]);
		assert.strictEqual(result.text, 'A\r\nb\r\n');
	},
	'a new file is its added lines': () => {
		const files = parseDiff('--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n');
		assert.strictEqual(files[0].isNew, true);
		assert.strictEqual(newFileContent(files[0]), 'one\ntwo');
	},

	// ---- insights: cache and budget ----------------------------------------
	'the same file, bytes and selection are the same card': () => {
		assert.strictEqual(insightKey('a.ts', 'x', '1-2'), insightKey('a.ts', 'x', '1-2'));
		assert.notStrictEqual(insightKey('a.ts', 'x', '1-2'), insightKey('a.ts', 'y', '1-2'));
		assert.notStrictEqual(insightKey('a.ts', 'x', '1-2'), insightKey('a.ts', 'x', '3-4'));
	},
	'the cache forgets the least recently used, and reading counts as use': () => {
		const lru = new Lru(2);
		lru.set('a', '1');
		lru.set('b', '2');
		lru.get('a');
		lru.set('c', '3');
		assert.strictEqual(lru.get('b'), undefined, 'b was the least recently used');
		assert.strictEqual(lru.get('a'), '1');
		assert.strictEqual(lru.size, 2);
	},
	'the cache round-trips through persistence oldest-first': () => {
		const lru = new Lru(3);
		lru.set('a', '1');
		lru.set('b', '2');
		assert.deepStrictEqual(lru.entries(), [['a', '1'], ['b', '2']]);
	},
	'the hourly budget rolls rather than resetting on the hour': () => {
		const budget = new HourlyBudget(2);
		const t = 1_000_000_000;
		assert.ok(budget.take(t));
		assert.ok(budget.take(t + 60_000));
		assert.ok(!budget.take(t + 120_000), 'two in the last hour is the limit');
		assert.ok(budget.take(t + 3_600_001), 'the first one has aged out');
		assert.strictEqual(budget.remaining(t + 3_600_001), 0);
	},
	'each insight prompt asks for three bullets and no preamble': () => {
		for (const kind of ['file', 'selection', 'bundle']) {
			assert.match(insightPrompt(kind), /three bullets/);
			assert.match(insightPrompt(kind), /no preamble/);
		}
		assert.match(insightPrompt('bundle'), /stylesheet/);
	},
};

let failed = 0;
for (const [name, run] of Object.entries(cases)) {
	try {
		run();
		console.log(`  ok  ${name}`);
	} catch (err) {
		failed++;
		console.error(`FAIL  ${name}\n      ${err && err.message}`);
	}
}
console.log(`${Object.keys(cases).length - failed}/${Object.keys(cases).length} passed`);
process.exit(failed ? 1 : 0);
