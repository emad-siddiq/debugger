/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Unit test for the pure flows-model helpers. model.ts imports nothing from
// 'vscode', so out/model.js is require()-able directly. Run after a compile.

'use strict';

const assert = require('node:assert');
const { groupOf, groupFlows, handlerOf } = require('../out/model');

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

console.log('model.test.js OK');
