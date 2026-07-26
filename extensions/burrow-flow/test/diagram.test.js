/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Unit test for the pure wire-diagram renderer (out/diagram.js — no 'vscode').

'use strict';

const assert = require('node:assert');
const { layout, renderFlow, escapeHtml } = require('../out/diagram');

const flow = {
	method: 'GET',
	path: '/api/gadgets/{id}',
	file: 'router.go',
	line: 42,
	middleware: [{ label: 'middleware.JWT(…)', file: 'router.go', line: 242 }],
	nodes: [
		{ kind: 'handler', label: 'gadgets.GetGadget', file: 'gadgets/gadgets.go', line: 36, col: 6 },
		{ kind: 'store', label: 'PgxGadgetStore.Fetch', file: 'gadgets/gadgets.go', line: 21, col: 25 },
		{ kind: 'query', label: 'SELECT', file: 'gadgets/gadgets.go', line: 23, col: 9, sql: 'SELECT g.name FROM gadgets g JOIN gizmos z ON z.gadget_id = g.id WHERE g.id = $1', sqlKind: 'read', tables: ['gadgets', 'gizmos'] },
		{ kind: 'table', label: 'gadgets', file: 'migrations/001_init.sql' },
		{ kind: 'table', label: 'gizmos', file: 'migrations/002_gizmos.sql' },
	],
	edges: [[0, 1], [1, 2], [2, 3], [2, 4]],
	tables: ['gadgets', 'gizmos'],
	status: 'traced',
};

// Layout: handler col 0, store col 1, query col 2, tables in the last col.
const { placed } = layout(flow);
const colOf = idx => placed.find(p => p.idx === idx).x;
assert.ok(colOf(0) < colOf(1) && colOf(1) < colOf(2) && colOf(2) < colOf(3), 'columns advance left to right');
assert.strictEqual(colOf(3), colOf(4), 'tables share the last column');
assert.notStrictEqual(placed.find(p => p.idx === 3).y, placed.find(p => p.idx === 4).y, 'stacked tables do not overlap');

const html = renderFlow(flow);
assert.ok(html.includes('gadgets.GetGadget'), 'handler label rendered');
assert.ok(html.includes('data-file="gadgets/gadgets.go"'), 'nodes carry click targets');
assert.ok(html.includes('data-sql="SELECT g.name'), 'query node carries its SQL');
assert.ok(html.includes('data-table="gadgets"'), 'table node carries its name');
assert.ok(html.includes('middleware.JWT'), 'middleware chip rendered');
assert.ok((html.match(/<path d=/g) || []).length === flow.edges.length, 'one SVG path per edge');
assert.ok(html.includes('badge traced'), 'status badge rendered');

// Escaping: hostile labels must not break out of attributes.
assert.strictEqual(escapeHtml('<a "b">'), '&lt;a &quot;b&quot;&gt;');
const hostile = renderFlow({ ...flow, nodes: [{ kind: 'query', label: 'SELECT', sql: 'SELECT \'"<script>\' FROM x' }], edges: [], middleware: [] });
assert.ok(!hostile.includes('<script>\' FROM'), 'sql is escaped into attributes');

// A handler that calls no store method has no edges — and any producer writing
// JSON from a nil list sends `null`, not `[]`. flowscan did, for 16 of merkle's
// 235 routes, and iterating it threw before a single node was drawn: the whole
// diagram was lost to the routes that needed the least of it.
const bare = { ...flow, nodes: [{ kind: 'handler', label: 'health.Check', file: 'health.go', line: 12 }], edges: null };
const bareHtml = renderFlow(bare);
assert.ok(bareHtml.includes('health.Check'), 'a flow with null edges still renders its handler');
assert.ok(!bareHtml.includes('<path d='), 'and draws no edges');
assert.doesNotThrow(() => renderFlow({ ...flow, nodes: null, edges: null }), 'null nodes are survivable too');

console.log('diagram.test.js OK');
