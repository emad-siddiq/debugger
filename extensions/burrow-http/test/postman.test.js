/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the Postman → .http converter. The converted text is
// round-tripped through the real parser (parseHttpFile) so the two dialects are
// proven compatible. Run: `npm test` (after a compile) or `node test/postman.test.js`.

'use strict';

const assert = require('node:assert');
const { convertPostmanCollection } = require('../out/postman');
const { parseHttpFile } = require('../out/httpFile');

const collection = {
	info: { name: 'NodeWatch' },
	item: [
		{
			name: 'Nodes',
			item: [
				{
					name: 'GET /api/nodes',
					request: {
						method: 'GET',
						url: { raw: '{{baseUrl}}/api/nodes' },
						header: [{ key: 'X-Org-Id', value: '{{orgId}}' }],
					},
				},
				{
					name: 'POST /api/nodes',
					request: {
						method: 'POST',
						url: '{{baseUrl}}/api/nodes',
						header: [
							{ key: 'Content-Type', value: 'application/json' },
							{ key: 'X-Skip', value: 'nope', disabled: true },
						],
						body: { mode: 'raw', raw: '{ "name": "n1" }' },
					},
				},
			],
		},
		{ name: 'Health', item: [{ name: 'healthz', request: { method: 'GET', url: '{{baseUrl}}/healthz' } }] },
	],
};

const environment = {
	name: 'local',
	values: [
		{ key: 'baseUrl', value: 'http://localhost:8080', enabled: true },
		{ key: 'nodeId', value: '' },
		{ key: 'off', value: 'x', enabled: false },
	],
};

const cases = {
	'converts folders, requests, headers, bodies, env vars': () => {
		const text = convertPostmanCollection(collection, environment);
		const parsed = parseHttpFile(text);
		assert.deepStrictEqual(parsed.variables, [['baseUrl', 'http://localhost:8080'], ['nodeId', '']]);
		assert.strictEqual(parsed.requests.length, 3);
		const [get, post, health] = parsed.requests;
		assert.strictEqual(get.method, 'GET');
		assert.strictEqual(get.url, '{{baseUrl}}/api/nodes');
		assert.deepStrictEqual(get.headers, [['X-Org-Id', '{{orgId}}']]);
		assert.deepStrictEqual(post.headers, [['Content-Type', 'application/json']]); // disabled header dropped
		assert.strictEqual(post.body.trim(), '{ "name": "n1" }');
		assert.strictEqual(health.url, '{{baseUrl}}/healthz');
	},
	'no environment → no @vars, still parses': () => {
		const parsed = parseHttpFile(convertPostmanCollection(collection));
		assert.deepStrictEqual(parsed.variables, []);
		assert.strictEqual(parsed.requests.length, 3);
	},
	'rejects a non-collection': () => {
		assert.throws(() => convertPostmanCollection({ nope: true }), /Not a Postman collection/);
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
