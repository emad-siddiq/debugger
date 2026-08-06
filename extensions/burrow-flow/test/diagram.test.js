/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Unit test for the pure wire-diagram renderer (out/diagram.js — no 'vscode').

'use strict';

const assert = require('node:assert');
const { defaultExpanded, layout, renderFlow, escapeHtml } = require('../out/diagram');

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
	edges: [
		// The call site (gadgets.go:37, inside GetGadget) is NOT the store box's
		// own position (gadgets.go:21, where Fetch is declared). That difference
		// is the point: the handler calls an interface method, so nothing in it
		// names PgxGadgetStore, and the call site is where both are visible.
		{ from: 0, to: 1, rel: 'calls', file: 'gadgets/gadgets.go', line: 37, col: 10 },
		{ from: 1, to: 2, rel: 'executes', file: 'gadgets/gadgets.go', line: 23, col: 9 },
		{ from: 2, to: 3, rel: 'reads', file: 'gadgets/gadgets.go', line: 23, col: 9 },
		{ from: 2, to: 4, rel: 'reads', file: 'gadgets/gadgets.go', line: 23, col: 9 },
	],
	tables: ['gadgets', 'gizmos'],
	status: 'traced',
};

// Everything expanded, which is what the old unconditional layout drew.
const all = new Set([0, 1, 2, 3, 4]);

// Layout: handler col 0, store col 1, query col 2, tables in the last col.
const { placed } = layout(flow, all);
const colOf = idx => placed.find(p => p.idx === idx).x;
assert.ok(colOf(0) < colOf(1) && colOf(1) < colOf(2) && colOf(2) < colOf(3), 'columns advance left to right');
assert.strictEqual(colOf(3), colOf(4), 'tables share the last column');
assert.notStrictEqual(placed.find(p => p.idx === 3).y, placed.find(p => p.idx === 4).y, 'stacked tables do not overlap');

const html = renderFlow(flow, all, 0);
assert.ok(html.includes('gadgets.GetGadget'), 'handler label rendered');
assert.ok(html.includes('data-file="gadgets/gadgets.go"'), 'nodes carry click targets');
assert.ok(html.includes('data-sql="SELECT g.name'), 'query node carries its SQL');
assert.ok(html.includes('data-table="gadgets"'), 'table node carries its name');
assert.ok(html.includes('middleware.JWT'), 'middleware chip rendered');
assert.ok((html.match(/class="edge /g) || []).length === flow.edges.length, 'one drawn curve per edge');
assert.ok(html.includes('badge traced'), 'status badge rendered');

// ── The curves say what they mean ──────────────────────────────────────────
// An edge used to be two integers, so every curve claimed the same thing and a
// reader had to open the code to find out which.
const pills = html.match(/<div class="rel (\w+)"/g) || [];
assert.strictEqual(pills.length, flow.edges.length, 'one verb per curve, always on');
assert.deepStrictEqual(
	pills.map(p => p.match(/rel (\w+)/)[1]),
	['calls', 'executes', 'reads', 'reads'],
	'each curve carries its own relation, not one generalisation over all of them',
);
assert.ok(html.includes('marker-end="url(#a-calls)"'), 'and an arrowhead, so direction is visible');
assert.ok(/<path class="edgehit"[^>]*data-file="gadgets\/gadgets\.go" data-line="37"/.test(html),
	'the curve is clickable and lands on the CALL, not on either box');
assert.ok(/<div class="rel calls" style="[^"]*" data-file="gadgets\/gadgets\.go" data-line="37"/.test(html),
	'the verb is the same click target as the curve under it');
// The store BOX still points at the declaration — the two are different lines,
// and conflating them is what made the curve unreadable.
assert.ok(/<div class="node store[^>]*data-line="21"/.test(html), 'the box keeps the declaration');
assert.ok(html.includes('gadgets.GetGadget calls PgxGadgetStore.Fetch'), 'hover spells the relation out');
assert.ok(html.includes('Click: open gadgets/gadgets.go:37'), 'and says where clicking lands');

// A write is drawn differently from a read, per table — one statement can do
// both, and Node.SQLKind is a single verdict for the whole statement.
const mixed = renderFlow({
	...flow,
	nodes: [
		{ kind: 'handler', label: 'gadgets.AuditGadgets', file: 'gadgets/gadgets.go', line: 47 },
		{ kind: 'query', label: 'INSERT', file: 'gadgets/gadgets.go', line: 49, sql: 'INSERT INTO gadget_audit SELECT id FROM gadgets', sqlKind: 'write', tables: ['gadget_audit', 'gadgets'] },
		{ kind: 'table', label: 'gadget_audit' },
		{ kind: 'table', label: 'gadgets' },
	],
	edges: [
		{ from: 0, to: 1, rel: 'executes', file: 'gadgets/gadgets.go', line: 49 },
		{ from: 1, to: 2, rel: 'writes', file: 'gadgets/gadgets.go', line: 49 },
		{ from: 1, to: 3, rel: 'reads', file: 'gadgets/gadgets.go', line: 49 },
	],
}, new Set([0, 1, 2, 3]), 0);
assert.ok(mixed.includes('>writes<') && mixed.includes('>reads<'),
	'one statement, two tables, two verbs');

// ── The middleware row ─────────────────────────────────────────────────────
// merkle's root stack is 13 chips repeated on 134 of 235 routes, which is most
// of the header and says nothing about the route you opened.
const chained = {
	...flow,
	middleware: [
		{ label: 'middleware.RequestID', file: 'app.go', line: 392 },
		{ label: 'middleware.Logging', file: 'app.go', line: 394 },
		// An if/else-if/else picking ONE of these. The walk takes every arm
		// because a route in an arm is still a route; middleware is not like
		// that, and all three were being drawn as if they stacked.
		{ label: 'cors.New(…).Handler', file: 'app.go', line: 399, branch: 1, arm: 1 },
		{ label: 'cors.AllowAll(…).Handler', file: 'app.go', line: 411, branch: 1, arm: 2 },
		{ label: 'cors.New(…).Handler', file: 'app.go', line: 417, branch: 1, arm: 3 },
		{ label: 'middleware.RequireOrgRole(…)', file: 'oncall/routes.go', line: 23 },
	],
};
const folded = renderFlow(chained, all, 5);
assert.ok(folded.includes('<details class="mwrow"'), 'the shared stack folds');
assert.ok(folded.includes('>5 shared<'), 'and says how many it folded');
assert.ok(/<summary[^>]*>(?:(?!<\/summary>)[\s\S])*RequireOrgRole/.test(folded),
	'what this route adds for itself stays in view');
assert.ok(/class="chips shared"[\s\S]*middleware.RequestID/.test(folded),
	'the shared ones are still there, one click away');

// A conditional arm is a CHOICE, not a link in the chain.
const conds = folded.match(/<span class="chip cond"/g) || [];
assert.strictEqual(conds.length, 3, 'every arm of the if/else is marked');
assert.ok(folded.includes('one of 3 alternatives here, and at most one of them runs'),
	'and says so in words a reader can act on');
assert.ok(!/class="chip cond"[^>]*>[^<]*RequestID/.test(folded),
	'an unconditional Use is never marked — it always runs');

// Nothing shared, or nothing to fold: the flat row, exactly as before.
assert.ok(renderFlow(chained, all, 0).includes('class="chiprow"'), 'no shared prefix means no fold');
assert.ok(!renderFlow(chained, all, 0).includes('<details'), 'and no disclosure to open');
// Folding ALL of them would leave a count and no sign of what it counted.
const allShared = renderFlow(chained, all, 6);
assert.ok(/<summary[^>]*>(?:(?!<\/summary>)[\s\S])*RequireOrgRole/.test(allShared),
	'the last chip is always kept in view');
assert.ok(allShared.includes('>5 shared<'), 'so the fold stops one short');

// ── An older trace ────────────────────────────────────────────────────────
// The cached flows.json in extension storage is what the diagram is built from
// at activation. A pre-schema-2 one has no verbs, and inventing them would put
// a sentence on screen the user cannot check — the exact defect being removed.
const legacy = renderFlow({ ...flow, edges: [[0, 1], [1, 2], [2, 3], [2, 4]] }, all, 0);
assert.strictEqual((legacy.match(/class="edge /g) || []).length, 4, 'old edges still draw');
assert.strictEqual((legacy.match(/<div class="rel /g) || []).length, 0, 'with no invented verb');
assert.ok(legacy.includes('trace made before Burrow labelled them'), 'and the page says why they are bare');
assert.ok(!html.includes('trace made before'), 'a current trace says nothing about it');

// Escaping: hostile labels must not break out of attributes.
assert.strictEqual(escapeHtml('<a "b">'), '&lt;a &quot;b&quot;&gt;');
const hostileFlow = { ...flow, nodes: [{ kind: 'query', label: 'SELECT', sql: 'SELECT \'"<script>\' FROM x' }], edges: [], middleware: [] };
const hostile = renderFlow(hostileFlow, defaultExpanded(hostileFlow), 0);
assert.ok(!hostile.includes('<script>\' FROM'), 'sql is escaped into attributes');

// A handler that calls no store method has no edges — and any producer writing
// JSON from a nil list sends `null`, not `[]`. flowscan did, for 16 of merkle's
// 235 routes, and iterating it threw before a single node was drawn: the whole
// diagram was lost to the routes that needed the least of it.
const bare = { ...flow, nodes: [{ kind: 'handler', label: 'health.Check', file: 'health.go', line: 12 }], edges: null };
const bareHtml = renderFlow(bare, defaultExpanded(bare), 0);
assert.ok(bareHtml.includes('health.Check'), 'a flow with null edges still renders its handler');
assert.ok(!bareHtml.includes('class="edge '), 'and draws no edges');
assert.ok(!bareHtml.includes('class="rel '), 'and no verbs');
assert.ok(!bareHtml.includes('trace made before'), 'a route with no edges is not an older trace');
const empty = { ...flow, nodes: null, edges: null };
assert.doesNotThrow(() => renderFlow(empty, defaultExpanded(empty), 0), 'null nodes are survivable too');

// ── One hop deep, then a chevron ───────────────────────────────────────────
// merkle's widest route is 45 boxes. Drawn all at once it is a picture nobody
// reads, labelled or not, so the default is the handler and one level under it.
assert.deepStrictEqual([...defaultExpanded(flow)], [0], 'only the parentless root starts open');

const collapsed = layout(flow, defaultExpanded(flow));
assert.deepStrictEqual(collapsed.placed.map(p => p.idx), [0, 1], 'the handler and its direct children');
assert.strictEqual(collapsed.edges.length, 1, 'and only the curve between them');
assert.strictEqual(collapsed.placed.find(p => p.idx === 0).hidden, 0, 'an expanded box hides nothing');
assert.strictEqual(collapsed.placed.find(p => p.idx === 1).hidden, 1, 'the store has one hop under it');

const collapsedHtml = renderFlow(flow, defaultExpanded(flow), 0);
assert.ok(/<button class="chev" data-node="1"[^>]*>▸(&#8202;|\s)1<\/button>/.test(collapsedHtml),
	'the chevron counts what is hidden');
assert.ok(!/data-node="0"/.test(collapsedHtml), 'and is absent where there is nothing to reveal');
assert.strictEqual((collapsedHtml.match(/<div class="rel /g) || []).length, 1, 'only drawn curves get a verb');

// Expanding one box reveals exactly that box's children — not the whole tree.
const oneMore = layout(flow, new Set([0, 1]));
assert.deepStrictEqual(oneMore.placed.map(p => p.idx), [0, 1, 2], 'the query appears');
assert.strictEqual(oneMore.placed.find(p => p.idx === 2).hidden, 2, 'its two tables are still behind a chevron');
assert.ok(oneMore.width > collapsed.width, 'the canvas grows with the column it gained');

// The chevron is its own target, so the box body still opens its source — which
// is what the help sheet promises about every box.
assert.ok(/<div class="node store[^>]*data-file="gadgets\/gadgets\.go"/.test(collapsedHtml),
	'a box with a chevron is still a link to its source');

console.log('diagram.test.js OK');
