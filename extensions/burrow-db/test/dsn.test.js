/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the connection-string layer. dsn.ts imports nothing
// from 'vscode' or 'pg', so out/dsn.js is a clean CommonJS module we require
// directly. Run: `npm test` (after a compile) or `node test/dsn.test.js`.

'use strict';

const assert = require('node:assert');
const { parsePostgresUrl, pickConnectionString, redactPassword, describeDsn } = require('../out/dsn');

const cases = {
	'parses a full postgres:// url': () => {
		const dsn = parsePostgresUrl('postgres://neo:trinity@db.example.com:6543/nodewatch');
		assert.deepStrictEqual(dsn, {
			host: 'db.example.com',
			port: 6543,
			database: 'nodewatch',
			user: 'neo',
			password: 'trinity',
			ssl: false,
			connectionString: 'postgres://neo:trinity@db.example.com:6543/nodewatch',
		});
	},
	'accepts the postgresql:// alias': () => {
		assert.strictEqual(parsePostgresUrl('postgresql://localhost/app').database, 'app');
	},
	'applies libpq defaults for missing port and database': () => {
		const dsn = parsePostgresUrl('postgres://localhost');
		assert.strictEqual(dsn.port, 5432);
		assert.strictEqual(dsn.database, 'postgres');
		assert.strictEqual(dsn.user, undefined);
	},
	'decodes percent-encoded user and password': () => {
		const dsn = parsePostgresUrl('postgres://us%40er:p%40ss@h/d');
		assert.strictEqual(dsn.user, 'us@er');
		assert.strictEqual(dsn.password, 'p@ss');
	},
	'sslmode=require enables ssl': () => {
		assert.strictEqual(parsePostgresUrl('postgres://h/d?sslmode=require').ssl, true);
	},
	'sslmode=disable leaves ssl off': () => {
		assert.strictEqual(parsePostgresUrl('postgres://h/d?sslmode=disable').ssl, false);
	},
	'ssl=true enables ssl': () => {
		assert.strictEqual(parsePostgresUrl('postgres://h/d?ssl=true').ssl, true);
	},
	'rejects a non-postgres url': () => {
		assert.throws(() => parsePostgresUrl('mysql://h/d'), /Postgres connection URL/);
	},
	'setting wins over env': () => {
		assert.strictEqual(pickConnectionString({ setting: 'postgres://a/s', env: 'postgres://b/e' }), 'postgres://a/s');
	},
	'falls back to env when setting is blank': () => {
		assert.strictEqual(pickConnectionString({ setting: '   ', env: 'postgres://b/e' }), 'postgres://b/e');
	},
	'returns undefined when neither is set': () => {
		assert.strictEqual(pickConnectionString({}), undefined);
	},
	'redacts the password for display': () => {
		assert.strictEqual(redactPassword('postgres://neo:trinity@h:5432/d'), 'postgres://neo:***@h:5432/d');
	},
	'redaction leaves a password-free url alone': () => {
		assert.strictEqual(redactPassword('postgres://neo@h/d'), 'postgres://neo@h/d');
	},
	'describeDsn is a password-free label': () => {
		const dsn = parsePostgresUrl('postgres://neo:trinity@h:5432/nodewatch');
		assert.strictEqual(describeDsn(dsn), 'neo@h:5432/nodewatch');
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
