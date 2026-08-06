/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Unit test for the pure flows-model helpers. model.ts imports nothing from
// 'vscode', so out/model.js is require()-able directly. Run after a compile.

'use strict';

const assert = require('node:assert');
const { edgesOf, flowsOf, groupOf, groupFlows, handlerOf, hasRelations, railMessage, sharedMiddlewareDepth, unfollowedOf } = require('../out/model');

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

// Edges arrive in two shapes. Schema 2 writes objects carrying the relation and
// the call site; anything traced before it wrote a bare [from, to] pair. The old
// one is not hypothetical: the cached flows.json in this extension's storage is
// what the diagram is built from at activation, before anybody presses Refresh.
assert.deepStrictEqual(edgesOf(undefined), []);
assert.deepStrictEqual(edgesOf({ edges: null }), [], 'a nil Go slice marshals to null');
assert.deepStrictEqual(edgesOf({ edges: [] }), []);

const modern = { from: 0, to: 1, rel: 'calls', file: 'gadgets/gadgets.go', line: 37, col: 10 };
assert.deepStrictEqual(edgesOf({ edges: [modern] }), [modern], 'schema 2 passes straight through');

const old = edgesOf({ edges: [[0, 1], [1, 2]] });
assert.deepStrictEqual(old.map(e => [e.from, e.to]), [[0, 1], [1, 2]], 'a tuple still reads as an edge');
// The verb is left UNDEFINED rather than guessed. "calls" is wrong for every
// query→table edge, and a sentence the user cannot check is the defect this
// whole feature exists to remove — reintroducing it one layer down is worse
// than a bare curve.
assert.ok(old.every(e => e.rel === undefined), 'an old edge is never given an invented relation');
assert.ok(old.every(e => e.file === undefined), 'nor an invented call site');

assert.deepStrictEqual(edgesOf({ edges: [[0, 1], modern] }).map(e => e.rel), [undefined, 'calls'], 'mixed');

assert.strictEqual(hasRelations({ edges: [modern] }), true);
assert.strictEqual(hasRelations({ edges: [[0, 1]] }), false, 'an older trace has nothing to label');
assert.strictEqual(hasRelations({ edges: null }), false);

// The root router's stack is on every route, so it is not what anybody opened
// this route to see. It is exactly the longest common PREFIX, because chi
// inherits middleware outermost-first: what a route adds for itself is at the
// end. In merkle that folds 5–13 chips away on 134 of 235 routes.
const mws = (...labels) => ({ middleware: labels.map(label => ({ label })) });
assert.strictEqual(sharedMiddlewareDepth([
	mws('RequestID', 'Logging', 'JWT'),
	mws('RequestID', 'Logging', 'RateLimitIP'),
	mws('RequestID', 'Logging'),
]), 2, 'the common prefix, and no further');
assert.strictEqual(sharedMiddlewareDepth([mws('A', 'B'), mws('B', 'A')]), 0, 'order matters — a set would not do');
assert.strictEqual(sharedMiddlewareDepth([mws(), mws('A')]), 0, 'a route with none shares none');
assert.strictEqual(sharedMiddlewareDepth([mws('A', 'B')]), 0, 'one route establishes nothing as shared');
assert.strictEqual(sharedMiddlewareDepth([]), 0);
assert.strictEqual(sharedMiddlewareDepth([{}, {}]), 0, 'middleware is optional on a Flow');
// A prefix common to all of them is still all of them — the renderer, not this,
// decides to keep one chip visible.
assert.strictEqual(sharedMiddlewareDepth([mws('A', 'B'), mws('A', 'B')]), 2);

console.log('model.test.js OK');
