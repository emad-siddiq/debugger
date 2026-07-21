/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the pure pgAdmin provisioning generator. pgadminConfig.ts
// imports only the Dsn type (erased at runtime), so out/pgadminConfig.js is a clean
// CommonJS module we can require directly. Run: `npm test` (after a compile) or
// `node test/pgadminConfig.test.js`.

'use strict';

const assert = require('node:assert');
const { containerHost, pgAdminServers, pgAdminPassLine } = require('../out/pgadminConfig');

const loopback = {
	host: 'localhost', port: 5432, database: 'nodewatch',
	user: 'nodewatch', password: 'nodewatch', ssl: false,
	connectionString: 'postgres://nodewatch:nodewatch@localhost:5432/nodewatch',
};

const cases = {
	'containerHost rewrites loopback hosts to host.docker.internal': () => {
		assert.strictEqual(containerHost('localhost'), 'host.docker.internal');
		assert.strictEqual(containerHost('127.0.0.1'), 'host.docker.internal');
		assert.strictEqual(containerHost('::1'), 'host.docker.internal');
	},
	'containerHost passes a real host through unchanged': () => {
		assert.strictEqual(containerHost('nodewatch-db'), 'nodewatch-db');
		assert.strictEqual(containerHost('db.internal'), 'db.internal');
	},
	'pgAdminServers rewrites the host and fills the server record': () => {
		const parsed = JSON.parse(pgAdminServers(loopback));
		const s = parsed.Servers['1'];
		assert.strictEqual(s.Host, 'host.docker.internal');
		assert.strictEqual(s.Port, 5432);
		assert.strictEqual(s.MaintenanceDB, 'nodewatch');
		assert.strictEqual(s.Username, 'nodewatch');
		assert.strictEqual(s.SSLMode, 'prefer');
		assert.strictEqual(s.PassFile, '/pgpass');
		assert.strictEqual(s.Name, 'NodeWatch (merkle)');
	},
	'pgAdminServers uses SSLMode require when the dsn asked for TLS': () => {
		const s = JSON.parse(pgAdminServers({ ...loopback, ssl: true })).Servers['1'];
		assert.strictEqual(s.SSLMode, 'require');
	},
	'pgAdminServers defaults the username to postgres when absent': () => {
		const s = JSON.parse(pgAdminServers({ ...loopback, user: undefined })).Servers['1'];
		assert.strictEqual(s.Username, 'postgres');
	},
	'pgAdminServers never embeds the password (PassFile only)': () => {
		assert.ok(!pgAdminServers(loopback).includes('nodewatch:nodewatch'));
		assert.ok(!pgAdminServers(loopback).toLowerCase().includes('password'));
	},
	'pgAdminPassLine emits host:port:db:user:password with the rewritten host': () => {
		assert.strictEqual(pgAdminPassLine(loopback), 'host.docker.internal:5432:nodewatch:nodewatch:nodewatch\n');
	},
	'pgAdminPassLine tolerates an empty password and missing db/user': () => {
		assert.strictEqual(
			pgAdminPassLine({ ...loopback, database: '', user: undefined, password: undefined }),
			'host.docker.internal:5432:*:postgres:\n',
		);
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
	console.error('\n' + failed + ' pgadminConfig test(s) failed');
	process.exit(1);
}
console.log('\nAll ' + Object.keys(cases).length + ' pgadminConfig tests passed');
