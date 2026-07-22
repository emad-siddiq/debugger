/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the workspace DATABASE_URL discovery (launch.json
// env blocks + envFiles). Uses a throwaway temp workspace on disk — the module
// reads real files. Run: `npm test` (after a compile) or `node test/workspaceDsn.test.js`.

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stripJsonComments, parseEnvFileForKey, findWorkspaceDatabaseUrl } = require('../out/workspaceDsn');

function makeWorkspace(launchJson, files = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-db-ws-'));
	if (launchJson !== undefined) {
		fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
		fs.writeFileSync(path.join(dir, '.vscode', 'launch.json'), launchJson);
	}
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(dir, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
	}
	return dir;
}

const cases = {
	'strips // and /* */ comments and trailing commas, not inside strings': () => {
		const src = '{\n// line\n"a": "http://x", /* block */ "b": [1, 2,],\n}';
		assert.deepStrictEqual(JSON.parse(stripJsonComments(src)), { a: 'http://x', b: [1, 2] });
	},
	'parseEnvFileForKey handles export, quotes and comments': () => {
		const text = '# comment\nexport FOO="bar"\nDATABASE_URL=\'postgres://u:p@h:5/d\'\n';
		assert.strictEqual(parseEnvFileForKey(text, 'DATABASE_URL'), 'postgres://u:p@h:5/d');
		assert.strictEqual(parseEnvFileForKey(text, 'MISSING'), undefined);
	},
	'finds an inline env DATABASE_URL (with JSONC comments)': () => {
		const ws = makeWorkspace(`{
			// NodeWatch debug configs
			"version": "0.2.0",
			"configurations": [
				{ "name": "backend", "type": "go", "env": { "DATABASE_URL": "postgres://a@localhost:5432/x" } },
			],
		}`);
		assert.strictEqual(findWorkspaceDatabaseUrl(ws), 'postgres://a@localhost:5432/x');
	},
	'falls back to an envFile with ${workspaceFolder}': () => {
		const ws = makeWorkspace(
			'{"configurations": [{ "name": "b", "envFile": "${workspaceFolder}/infra/test/env/backend.env" }]}',
			{ 'infra/test/env/backend.env': 'PORT=8080\nDATABASE_URL=postgres://env@localhost:5432/file\n' },
		);
		assert.strictEqual(findWorkspaceDatabaseUrl(ws), 'postgres://env@localhost:5432/file');
	},
	'inline env wins over an earlier config\'s envFile': () => {
		const ws = makeWorkspace(
			`{"configurations": [
				{ "name": "a", "envFile": "\${workspaceFolder}/a.env" },
				{ "name": "b", "env": { "DATABASE_URL": "postgres://inline@localhost/db" } }
			]}`,
			{ 'a.env': 'DATABASE_URL=postgres://file@localhost/db\n' },
		);
		assert.strictEqual(findWorkspaceDatabaseUrl(ws), 'postgres://inline@localhost/db');
	},
	'missing launch.json / folder → undefined': () => {
		assert.strictEqual(findWorkspaceDatabaseUrl(makeWorkspace(undefined)), undefined);
		assert.strictEqual(findWorkspaceDatabaseUrl(undefined), undefined);
		assert.strictEqual(findWorkspaceDatabaseUrl(makeWorkspace('{not json')), undefined);
	},
};

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
	try {
		fn();
		console.log(`ok   — ${name}`);
	} catch (err) {
		failed++;
		console.error(`FAIL — ${name}\n${err && err.stack}`);
	}
}
console.log(`\n${Object.keys(cases).length - failed}/${Object.keys(cases).length} passed`);
process.exit(failed ? 1 : 0);
