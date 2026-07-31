/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Unit test for the pure flows-model helpers. model.ts imports nothing from
// 'vscode', so out/model.js is require()-able directly. Run after a compile.

'use strict';

const assert = require('node:assert');
const { flowsOf, groupOf, groupFlows, handlerOf, railMessage, unfollowedOf } = require('../out/model');

assert.strictEqual(groupOf('/api/validators/chains'), 'validators');
assert.strictEqual(groupOf('/api/nodes'), 'nodes');
assert.strictEqual(groupOf('/healthz'), '(public)');
assert.strictEqual(groupOf('/api/share/{token}/verify'), 'share');

const flows = [
	{ method: 'GET', path: '/api/nodes', file: 'router.go', line: 1, nodes: [{ kind: 'handler', label: 'nodes.ListNodes' }], edges: [], status: 'traced' },
	{ method: 'POST', path: '/api/nodes', file: 'router.go', line: 2, nodes: [], edges: [], status: 'unknown' },
	{ method: 'GET', path: '/healthz', file: 'router.go', line: 3, nodes: [], edges: [], status: 'traced' },
];
const groups = groupFlows(flows);
assert.deepStrictEqual([...groups.keys()], ['nodes', '(public)']);
assert.strictEqual(groups.get('nodes').length, 2);
assert.strictEqual(handlerOf(flows[0]).label, 'nodes.ListNodes');
assert.strictEqual(handlerOf(flows[1]), undefined);

// `"flows": null` — a nil Go slice, which is what flowscan emits for every
// repository it found nothing in. `doc?.flows.length` throws on it, and it did:
// silently, inside the refresh handler, for the whole of a zero-route run.
assert.deepStrictEqual(flowsOf(undefined), []);
assert.deepStrictEqual(flowsOf({ flows: null }), [], 'null is the case that mattered');
assert.deepStrictEqual(flowsOf({ flows: [] }), []);
assert.strictEqual(flowsOf({ flows }).length, 3);

// A router flowscan RECOGNISED and could not follow (WO-77). The count is not a
// route count — we do not know how many routes are behind one — so the sentence
// has to make a floor read like a floor.
assert.strictEqual(railMessage(2, []), undefined, 'nothing to say means no chrome');
assert.strictEqual(unfollowedOf(undefined).length, 0);
assert.strictEqual(unfollowedOf({ coverage: {} }).length, 0);

const one = railMessage(13, [{ file: 'api/api.go', line: 171, reason: 'handed in from elsewhere' }]);
assert.match(one, /13 routes traced/);
assert.match(one, /1 router that could not be followed/);
assert.match(one, /there may be more/, 'the count is a floor and must read like one');
assert.match(one, /api\/api\.go:171 — handed in from elsewhere/, '"somewhere" is not actionable');
assert.ok(!/\(\+/.test(one), 'no "+N more" when there is only one');

const two = railMessage(13, [
	{ file: 'api/api.go', line: 171, reason: 'handed in from elsewhere' },
	{ file: 'app/app.go', line: 522, reason: 'WithPrefix' },
]);
assert.match(two, /2 routers that could not be followed/);
assert.match(two, /\(\+1 more\)/);

assert.match(railMessage(1, [{ file: 'a.go', line: 1, reason: 'r' }]), /1 route traced/, 'singular');

console.log('model.test.js OK');
