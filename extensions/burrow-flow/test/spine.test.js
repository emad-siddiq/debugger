/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// spine.test.js — burrow-flow finds its Go stack the way everything else does.
//
// Two jobs. The first half is ordinary unit testing of `src/spine.ts`. The second
// half is a CONTRACT TEST: it requires `burrow-project`'s compiled descriptor and
// asserts the two duplicated copies agree.
//
// WHY A CONTRACT TEST RATHER THAN AN IMPORT. WO-72's precedent says duplicate
// rather than import, because an extension that cannot work until a SIBLING has
// activated has a new way to fail. That reasoning is about runtime coupling and it
// still holds. But this duplication also spans a serialized file format —
// `.burrow/flow.json`, written here and read there — and duplication across a
// format drifts silently, with a capability reporting the wrong state forever as
// the symptom. A test-only require has no runtime coupling at all, and turns that
// drift into a red test.
//
// The red case: change GO_SEARCH_ORDER in one file, run this, watch it fail.
// Demonstrated 2026-07-30 by reordering `backend` and `server` — see the report.
//
// Run: `npm test` or `node test/spine.test.js`.

'use strict';

const assert = require('node:assert');
const path = require('node:path');
const spine = require('../out/spine');

// The sibling's compiled output. Test-only: nothing at runtime reaches across.
const DESCRIPTOR = path.join(__dirname, '..', '..', 'burrow-project', 'out', 'descriptor.js');
const descriptor = require(DESCRIPTOR);

/** A `Tree` over a literal map of path → contents. */
function fake(files) {
	return {
		exists: (rel) => Object.prototype.hasOwnProperty.call(files, rel),
		read: (rel) => files[rel],
	};
}

const cases = {
	// ── finding the module ────────────────────────────────────────────────────
	'a go.mod at the root is a Go stack — no router.go required': () => {
		// The requirement this replaces: `<root>/go.mod` AND `<root>/router.go`.
		// Only merkle's own backend has a file by that name, so the commonest shape
		// in Go — one module, at the root — was undetectable.
		const stack = spine.goStack(fake({ 'go.mod': 'module example.com/x\n' }), undefined);
		assert.deepStrictEqual(stack, { root: '.', from: 'detected' });
	},
	'the scaffold shape: main.go beside go.mod, no router anywhere': () => {
		const stack = spine.goStack(fake({ 'go.mod': 'module x\n', 'main.go': 'package main\n' }), undefined);
		assert.strictEqual(stack.root, '.');
	},
	'backend/go.mod still works — merkle is the compatibility case': () => {
		const stack = spine.goStack(fake({ 'backend/go.mod': 'module merkle/backend\n' }), undefined);
		assert.deepStrictEqual(stack, { root: 'backend', from: 'detected' });
	},
	'the root wins over a subdirectory': () => {
		const stack = spine.goStack(fake({ 'go.mod': 'm\n', 'backend/go.mod': 'm\n' }), undefined);
		assert.strictEqual(stack.root, '.');
	},
	'server/, api/, cmd/, src/ and service/ are all searched': () => {
		for (const dir of ['server', 'api', 'cmd', 'src', 'service']) {
			const stack = spine.goStack(fake({ [`${dir}/go.mod`]: 'm\n' }), undefined);
			assert.strictEqual(stack && stack.root, dir, dir);
		}
	},
	'a folder with no go.mod anywhere is not a Go stack': () => {
		assert.strictEqual(spine.goStack(fake({ 'package.json': '{}' }), undefined), undefined);
	},
	'MERKLE_ROOT is not consulted': () => {
		// The site it replaced took precedence over the folder the user had open,
		// so an exported variable could redirect the API rail at another repository.
		process.env.MERKLE_ROOT = '/Users/somebody/merkle';
		try {
			assert.strictEqual(spine.goStack(fake({}), undefined), undefined);
		} finally {
			delete process.env.MERKLE_ROOT;
		}
	},
	'a source string that mentions MERKLE_ROOT does not exist any more': () => {
		const fs = require('node:fs');
		const src = fs.readFileSync(path.join(__dirname, '..', 'out', 'project.js'), 'utf8');
		assert.ok(!/process\.env\[?['"]MERKLE_ROOT/.test(src), 'MERKLE_ROOT is read somewhere in project.js');
	},

	// ── the descriptor overrules detection ────────────────────────────────────
	'a Go stack recorded in .burrow/project.json wins over the tree': () => {
		const tree = fake({
			'go.mod': 'm\n',
			'services/orders/go.mod': 'm\n',
			'.burrow/project.json': JSON.stringify({ stacks: [{ id: 'go', root: 'services/orders' }] }),
		});
		assert.deepStrictEqual(spine.goStack(tree, undefined), { root: 'services/orders', from: 'descriptor' });
	},
	'a declared root that does not exist falls back to detection': () => {
		// Declaration is an override sheet, not a manifest: a stale entry must not
		// take the rail down.
		const tree = fake({ 'go.mod': 'm\n', '.burrow/project.json': JSON.stringify({ stacks: [{ id: 'go', root: 'gone' }] }) });
		assert.deepStrictEqual(spine.goStack(tree, undefined), { root: '.', from: 'detected' });
	},
	'a corrupt descriptor falls back to detection rather than throwing': () => {
		const tree = fake({ 'go.mod': 'm\n', '.burrow/project.json': '{ not json' });
		assert.strictEqual(spine.goStack(tree, undefined).root, '.');
	},
	'an explicit setting beats both': () => {
		assert.deepStrictEqual(spine.goStack(fake({ 'go.mod': 'm\n' }), 'elsewhere'), { root: 'elsewhere', from: 'setting' });
	},

	// ── the oracle app name ───────────────────────────────────────────────────
	'the oracle app name comes from the project, not the string "nodewatch"': () => {
		assert.strictEqual(spine.oracleAppName(JSON.stringify({ name: 'orders' }), 'checkout'), 'orders');
		assert.strictEqual(spine.oracleAppName(undefined, 'checkout'), 'checkout');
		assert.strictEqual(spine.oracleAppName('{ broken', 'checkout'), 'checkout');
	},

	// ── the message when there is nothing ─────────────────────────────────────
	'the no-backend message names where it looked': () => {
		const msg = spine.noBackendMessage('chi');
		assert.match(msg, /chi/);
		assert.match(msg, /backend\/, server\/, api\/, cmd\/, src\/, service\//);
		assert.match(msg, /\.burrow\/project\.json/);
		// The old text told everyone to create `backend/go.mod`, which is merkle's
		// layout and wrong advice for a module at the root.
		assert.ok(!/open a project with backend\/go\.mod/.test(msg));
	},
	'a module root belongs in a sentence: "." is not a directory name a user reads': () => {
		// "No routes found in ." reads as a typo, and did.
		assert.strictEqual(spine.whereIs('.'), 'this module');
		assert.strictEqual(spine.whereIs(''), 'this module');
		assert.strictEqual(spine.whereIs('backend'), 'backend');
	},
	'with no folder open it says so instead of naming undefined': () => {
		assert.match(spine.noBackendMessage(undefined), /No folder is open/);
	},

	// ── flow state: the three the surface has to tell apart ───────────────────
	'not tried: no file at all': () => {
		assert.strictEqual(spine.parseFlowState(undefined), undefined);
		assert.strictEqual(descriptor.parseFlowRun(undefined), undefined);
	},
	'tried and found routes': () => {
		const text = spine.serializeFlowState({
			version: spine.FLOW_STATE_VERSION, ranAt: '2026-07-30T00:00:00.000Z',
			backend: 'backend', routes: 235, traced: 209, partial: 26, unknown: 0,
		});
		assert.strictEqual(spine.parseFlowState(text).routes, 235);
		assert.strictEqual(descriptor.parseFlowRun(text).traced, 209);
	},
	'tried and found NONE — the state that had nowhere to live': () => {
		const text = spine.serializeFlowState({
			version: spine.FLOW_STATE_VERSION, ranAt: '2026-07-30T00:00:00.000Z',
			backend: '.', routes: 0, traced: 0, partial: 0, unknown: 0,
		});
		const parsed = spine.parseFlowState(text);
		assert.notStrictEqual(parsed, undefined, 'a measured zero must survive the round trip');
		assert.strictEqual(parsed.routes, 0);
		assert.strictEqual(descriptor.parseFlowRun(text).routes, 0);
	},
	'a corrupt or future-version state file reads as "not tried"': () => {
		assert.strictEqual(spine.parseFlowState('{ broken'), undefined);
		assert.strictEqual(spine.parseFlowState(JSON.stringify({ version: 99, routes: 3 })), undefined);
		assert.strictEqual(descriptor.parseFlowRun(JSON.stringify({ version: 99, routes: 3 })), undefined);
	},
	'no payloads in the state file': () => {
		// Counts, a directory and a revision. flows.json keeps the routes, handlers
		// and SQL in the extension's own storage; none of it belongs in a file that
		// sits in the user's project directory.
		const text = spine.serializeFlowState({
			version: spine.FLOW_STATE_VERSION, ranAt: 'now', backend: '.', rev: 'abc123',
			routes: 1, traced: 1, partial: 0, unknown: 0,
		});
		const keys = Object.keys(JSON.parse(text)).sort();
		assert.deepStrictEqual(keys, ['backend', 'partial', 'ranAt', 'rev', 'routes', 'traced', 'unknown', 'version']);
	},

	// ── flowscan's silent degradation ─────────────────────────────────────────
	'a degraded run is counted, not ignored': () => {
		// flowscan exits ZERO when packages fail to type-check and prints the count
		// to stderr, so a run working with incomplete type information looks exactly
		// like a clean one. (It does not always change the answer — see spine.ts —
		// but it is the only warning the surface gets when it does.)
		assert.strictEqual(spine.loadErrorCount('flowscan: 45 load error(s), first: x.go:15:1: needs go1.25\n'), 45);
		assert.strictEqual(spine.loadErrorCount('flowscan: 235 flows (209 traced, 26 partial, 0 unknown)\n'), 0);
		assert.strictEqual(spine.loadErrorCount(''), 0);
	},

	// ── the capability the three states feed ──────────────────────────────────
	'the flow capability reports all three states distinctly': () => {
		const go = { id: 'go', root: 'backend', build: 'go build ./...', run: 'go run .', entries: [] };
		const project = { name: 'p', stacks: [go], services: [], declared: [] };
		const flowOf = (run) => descriptor.capabilities(project, run).find((c) => c.id === 'flow');

		const notTried = flowOf(undefined);
		assert.strictEqual(notTried.state, 'unknown');
		assert.match(notTried.why, /run "API Flows: Refresh Flows"/);

		const found = flowOf({ routes: 235, traced: 209, partial: 26, unknown: 0 });
		assert.strictEqual(found.state, 'live');
		assert.match(found.why, /235 routes/);

		const none = flowOf({ routes: 0, traced: 0, partial: 0, unknown: 0 });
		assert.strictEqual(none.state, 'inert');
		assert.match(none.why, /found no routes/);
		assert.match(none.why, /NewRouter\(\)\/NewMux\(\)/);

		// Three distinct states, and three distinct sentences.
		assert.strictEqual(new Set([notTried.state, found.state, none.state]).size, 3);
		assert.strictEqual(new Set([notTried.why, found.why, none.why]).size, 3);
	},
	'"found none" and "no Go stack" are both inert but never say the same thing': () => {
		const withGo = { name: 'p', stacks: [{ id: 'go', root: '.', build: 'b', run: 'r', entries: [] }], services: [], declared: [] };
		const withoutGo = { name: 'p', stacks: [], services: [], declared: [] };
		const a = descriptor.capabilities(withGo, { routes: 0, traced: 0, partial: 0, unknown: 0 }).find((c) => c.id === 'flow');
		const b = descriptor.capabilities(withoutGo, undefined).find((c) => c.id === 'flow');
		assert.strictEqual(a.state, 'inert');
		assert.strictEqual(b.state, 'inert');
		assert.notStrictEqual(a.why, b.why);
	},
	'a degraded trace says so in the capability': () => {
		const project = { name: 'p', stacks: [{ id: 'go', root: '.', build: 'b', run: 'r', entries: [] }], services: [], declared: [] };
		const cap = descriptor.capabilities(project, { routes: 235, traced: 6, partial: 229, unknown: 0, loadErrors: 45 })
			.find((c) => c.id === 'flow');
		assert.match(cap.why, /45 package\(s\) failed to type-check/);
		assert.match(cap.why, /incomplete/);
	},

	// ── the contract itself ───────────────────────────────────────────────────
	'CONTRACT: the two copies search the same directories in the same order': () => {
		// burrow-project's list is the subdirectories; spine's leads with the root.
		assert.deepStrictEqual(
			spine.GO_SEARCH_ORDER.slice(),
			['.', 'backend', 'server', 'api', 'cmd', 'src', 'service'],
		);
		// Detection through burrow-project's own `detect` must land on the same
		// directory as spine's `goStack`, for every directory either one searches.
		for (const dir of spine.GO_SEARCH_ORDER) {
			const rel = dir === '.' ? 'go.mod' : `${dir}/go.mod`;
			const files = { [rel]: 'module m\n' };
			const tree = {
				exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
				read: (p) => files[p],
				dirs: () => [],
				files: () => [],
			};
			const viaProject = descriptor.detect(tree, 'p').stacks[0];
			const viaSpine = spine.goStack(tree, undefined);
			assert.ok(viaProject, `burrow-project found no stack for ${rel}`);
			assert.strictEqual(viaSpine.root, viaProject.root, `disagreement on ${rel}`);
		}
	},
	'CONTRACT: both name the same descriptor and state files': () => {
		assert.strictEqual(spine.DESCRIPTOR_PATH, descriptor.DESCRIPTOR_PATH);
		assert.strictEqual(spine.FLOW_STATE_PATH, descriptor.FLOW_STATE_PATH);
		assert.strictEqual(spine.FLOW_STATE_VERSION, descriptor.FLOW_STATE_VERSION);
	},
	'CONTRACT: every field this writes is a field the reader keeps': () => {
		const written = {
			version: spine.FLOW_STATE_VERSION, ranAt: '2026-07-30T00:00:00.000Z', backend: 'backend',
			rev: 'deadbee', routes: 235, traced: 209, partial: 26, unknown: 0, loadErrors: 45,
		};
		const read = descriptor.parseFlowRun(spine.serializeFlowState(written));
		for (const key of ['routes', 'traced', 'partial', 'unknown', 'ranAt', 'loadErrors']) {
			assert.strictEqual(read[key], written[key], `the reader lost ${key}`);
		}
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
	console.error('\n' + failed + ' spine test(s) failed');
	process.exit(1);
}
console.log('\nAll ' + Object.keys(cases).length + ' spine tests passed');
