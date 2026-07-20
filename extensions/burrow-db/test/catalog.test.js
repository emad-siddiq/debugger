/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the catalog layer: schema-tree folding, identifier
// quoting, and the async introspection flow driven by a FAKE QueryClient (no
// live database, no 'pg'). catalog.ts imports only types from query.ts, so
// out/catalog.js has no runtime dependency on a driver.

'use strict';

const assert = require('node:assert');
const { buildSchemaTree, classifyTableType, quoteIdent, buildPreviewSql, loadSchemaTree, LIST_TABLES_SQL } = require('../out/catalog');

/** A QueryClient stand-in that returns canned rows and records the SQL it saw. */
function fakeClient(rows) {
	const seen = [];
	return {
		seen,
		async query(text) {
			seen.push(text);
			return { fields: [], rows };
		},
		async end() { },
	};
}

const cases = {
	'classifies table / view / matview': () => {
		assert.strictEqual(classifyTableType('BASE TABLE'), 'table');
		assert.strictEqual(classifyTableType('VIEW'), 'view');
		assert.strictEqual(classifyTableType('MATERIALIZED VIEW'), 'matview');
	},
	'groups rows by schema, preserving order': () => {
		const tree = buildSchemaTree([
			{ table_schema: 'public', table_name: 'nodes', table_type: 'BASE TABLE' },
			{ table_schema: 'public', table_name: 'node_view', table_type: 'VIEW' },
			{ table_schema: 'metrics', table_name: 'samples', table_type: 'BASE TABLE' },
		]);
		assert.deepStrictEqual(tree, [
			{ schema: 'public', tables: [
				{ schema: 'public', name: 'nodes', kind: 'table' },
				{ schema: 'public', name: 'node_view', kind: 'view' },
			] },
			{ schema: 'metrics', tables: [
				{ schema: 'metrics', name: 'samples', kind: 'table' },
			] },
		]);
	},
	'skips rows with a missing schema or name': () => {
		const tree = buildSchemaTree([
			{ table_schema: 'public', table_name: 'ok', table_type: 'BASE TABLE' },
			{ table_schema: '', table_name: 'x', table_type: 'BASE TABLE' },
			{ table_schema: 'public', table_type: 'BASE TABLE' },
		]);
		assert.strictEqual(tree.length, 1);
		assert.strictEqual(tree[0].tables.length, 1);
	},
	'quotes identifiers and escapes embedded quotes': () => {
		assert.strictEqual(quoteIdent('nodes'), '"nodes"');
		assert.strictEqual(quoteIdent('weird"name'), '"weird""name"');
	},
	'buildPreviewSql quotes both parts and clamps the limit': () => {
		assert.strictEqual(buildPreviewSql('metrics', 'samples', 50), 'SELECT * FROM "metrics"."samples" LIMIT 50');
		assert.strictEqual(buildPreviewSql('public', 'nodes'), 'SELECT * FROM "public"."nodes" LIMIT 100');
		assert.strictEqual(buildPreviewSql('s', 't', 0), 'SELECT * FROM "s"."t" LIMIT 1');
	},
	'preview SQL of an injection-style name stays a single quoted identifier': () => {
		const sql = buildPreviewSql('public', 'x"; DROP TABLE users; --', 10);
		assert.strictEqual(sql, 'SELECT * FROM "public"."x""; DROP TABLE users; --" LIMIT 10');
	},
	'loadSchemaTree runs the introspection query against the client': async () => {
		const client = fakeClient([
			{ table_schema: 'public', table_name: 'nodes', table_type: 'BASE TABLE' },
		]);
		const tree = await loadSchemaTree(client);
		assert.strictEqual(client.seen[0], LIST_TABLES_SQL);
		assert.deepStrictEqual(tree, [
			{ schema: 'public', tables: [{ schema: 'public', name: 'nodes', kind: 'table' }] },
		]);
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
