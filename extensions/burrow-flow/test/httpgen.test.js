/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Unit test for the Route Runner generator (out/httpgen.js — no 'vscode').

'use strict';

const assert = require('node:assert');
const {
	parseContractFence, parseFields, bodySkeleton, typeForRoute, pathParams,
	extractOverrides, generateHttp, OVERRIDES_START, OVERRIDES_END,
} = require('../out/httpgen');
const { parseSeedProfile } = require('../out/seedProfile');

// Contract fence parsing — the oracle's `name<mark>type` token forms.
const digestMd = [
	'# header',
	'```routes',
	'GET /x → y  [z]',
	'```',
	'```contract',
	'Node: id:string name:string protocol:string created_at:time.Time monitor_config?map[string]any validator_chain?*string',
	'FieldDefinition: id:int64 node_id:string unit*string importance:float64',
	'```',
].join('\n');
const contract = parseContractFence(digestMd);
assert.deepStrictEqual([...contract.keys()], ['Node', 'FieldDefinition']);

const fields = parseFields(contract.get('FieldDefinition'));
assert.deepStrictEqual(fields.map(f => [f.name, f.optional, f.nullable, f.type]), [
	['id', false, false, 'int64'],
	['node_id', false, false, 'string'],
	['unit', false, true, 'string'],
	['importance', false, false, 'float64'],
]);

// Body skeleton: required fields only, server-set dropped, JSON stays valid.
const body = bodySkeleton(contract.get('Node'));
const parsed = JSON.parse(body.replace('{{id}}', '1'));
assert.deepStrictEqual(Object.keys(parsed), ['name', 'protocol']);

assert.strictEqual(typeForRoute('/api/nodes', contract.keys()), 'Node');
assert.strictEqual(typeForRoute('/api/nodes/{id}', contract.keys()), 'Node');
assert.strictEqual(typeForRoute('/healthz', contract.keys()), undefined);
assert.deepStrictEqual(pathParams('/api/nodes/{id}/fields/{key}'), ['id', 'key']);

// Generation + override survival.
const flows = [
	{
		method: 'GET', path: '/api/nodes', file: 'router.go', line: 341, status: 'traced',
		middleware: [{ label: 'middleware.JWT(…)' }], tables: ['nodes'],
		nodes: [{ kind: 'handler', label: 'nodes.ListNodes', file: 'nodes/nodes.go', line: 68 }], edges: [],
	},
	{
		method: 'POST', path: '/api/nodes', file: 'router.go', line: 342, status: 'traced',
		middleware: [{ label: 'middleware.JWT(…)' }],
		nodes: [{ kind: 'handler', label: 'nodes.CreateNode', file: 'nodes/nodes.go', line: 140 }], edges: [],
	},
	{
		method: 'POST', path: '/api/v1/ingest', file: 'router.go', line: 220, status: 'traced',
		middleware: [{ label: 'middleware.APIKey(…)' }],
		nodes: [{ kind: 'handler', label: 'ingest.Ingest', file: 'ingest/ingest.go', line: 10 }], edges: [],
	},
	{
		method: 'GET', path: '/api/nodes/{id}', file: 'router.go', line: 350, status: 'traced',
		middleware: [{ label: 'middleware.JWT(…)' }],
		nodes: [{ kind: 'handler', label: 'nodes.GetNode', file: 'nodes/nodes.go', line: 200 }], edges: [],
	},
];

const first = generateHttp({ flows, contract, baseUrl: 'http://localhost:8080', authOn: false, rev: 'abc123' });
assert.ok(first.includes('@baseUrl = http://localhost:8080'), 'baseUrl seeded');
assert.ok(first.includes('@id = 1'), 'path param seeded');
assert.ok(first.includes('GET {{baseUrl}}/api/nodes/{{id}}'), 'params interpolate');
assert.ok(!first.includes('Authorization:'), 'no auth header when skip-auth is on');
assert.ok(first.includes('"name": "name"'), 'POST body skeleton from contract');
assert.ok(first.includes('API-key/HMAC'), 'ingest route flagged');

// User edits an override, then regenerates with auth on.
const edited = first.replace('@baseUrl = http://localhost:8080', '@baseUrl = http://localhost:9999');
const second = generateHttp({ flows, contract, baseUrl: 'http://localhost:8080', authOn: true, rev: 'def456', existing: edited });
assert.ok(second.includes('@baseUrl = http://localhost:9999'), 'edited override survives regeneration');
assert.ok(!second.includes('@baseUrl = http://localhost:8080'), 'default does not duplicate the edited var');
assert.ok(second.includes('@bearer = '), 'bearer var seeded when auth on');
assert.ok(second.includes('Authorization: Bearer {{bearer}}'), 'JWT routes get the auth header');
assert.ok(!second.split('### POST /api/v1/ingest')[1].split('###')[0].includes('Authorization:'), 'non-JWT ingest route gets no bearer header');
assert.deepStrictEqual(extractOverrides(second).filter(l => l.startsWith('@baseUrl')), ['@baseUrl = http://localhost:9999']);
assert.ok(second.indexOf(OVERRIDES_START) < second.indexOf(OVERRIDES_END));

// ── seed profile ───────────────────────────────────────────────────────────
// A malformed or version-less profile must degrade to "no profile", never throw.
assert.strictEqual(parseSeedProfile('{ not json'), undefined, 'malformed JSON → undefined');
assert.strictEqual(parseSeedProfile('{"version":2}'), undefined, 'unknown version → undefined');
assert.deepStrictEqual(parseSeedProfile('{"version":1}'), {
	version: 1, params: {}, fields: {}, types: {}, db: undefined,
}, 'a bare profile parses to empty maps');

const seed = parseSeedProfile(JSON.stringify({
	version: 1,
	params: { id: 'f752b1c8-9bde-4ae1-b199-1c460ffd10fd', chain: 'cosmoshub', bogus: 7 },
	fields: { name: 'fleet-wide', protocol: 'solana', monitor_mode: 'push' },
	types: { Node: { name: 'eth-mainnet-01', protocol: 'ethereum' }, Nope: 'not-an-object' },
}));
assert.deepStrictEqual(Object.keys(seed.params), ['id', 'chain'], 'non-string params dropped');
assert.deepStrictEqual(Object.keys(seed.types), ['Node'], 'non-object type entries dropped');

// Per-type beats global; global covers what the type does not name.
assert.ok(bodySkeleton(contract.get('Node'), seed, 'Node').includes('"name": "eth-mainnet-01"'), 'types wins');
assert.ok(bodySkeleton(contract.get('Node'), seed).includes('"name": "fleet-wide"'), 'fields used without a type');

// Generation with a profile: seeded path params + seeded body values.
const seeded = generateHttp({ flows, contract, baseUrl: 'http://localhost:8080', authOn: false, rev: 'abc123', seed });
assert.ok(seeded.includes('@id = f752b1c8-9bde-4ae1-b199-1c460ffd10fd'), 'path param takes the seeded id');
assert.ok(seeded.includes('"name": "eth-mainnet-01"'), 'body takes the seeded value');
assert.ok(JSON.parse(seeded.split('Content-Type: application/json')[1].split('\n\n')[1].split('\n###')[0]), 'seeded body is valid JSON');

// No profile → byte-identical to what the generator always emitted.
assert.strictEqual(
	generateHttp({ flows, contract, baseUrl: 'http://localhost:8080', authOn: false, rev: 'abc123', seed: undefined }),
	first,
	'no profile → output unchanged');

console.log('httpgen.test.js OK');
