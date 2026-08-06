/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Escaping guard for the isolation harness. buildIsolateHtml returns one big
// template literal, so a stray backtick in a comment silently terminates it and
// the whole module fails to parse — which surfaces only as the sidecar refusing
// to boot. These checks catch it in a second instead.
// Run: node --test test/isolateHarness.test.mjs

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildIsolateHtml } from '../server/isolateHarness.js';
import { safeRoute } from '../server/inspectorPlugin.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'isolateHarness.js');

test('no stray backtick inside the emitted template literal', () => {
	const lines = fs.readFileSync(SRC, 'utf8').split('\n');
	const start = lines.findIndex((l) => l.includes('return `<!doctype html>'));
	assert.ok(start > 0, 'could not find the start of the template literal');
	const offenders = [];
	for (let i = start + 1; i < lines.length; i++) {
		if (!lines[i].includes('`')) {
			continue;
		}
		// The literal's own closing line is the only legal backtick.
		if (lines[i].trim() === '</html>`') {
			continue;
		}
		offenders.push(`${i + 1}: ${lines[i].trim()}`);
	}
	assert.deepStrictEqual(offenders, [], 'backticks inside the template literal terminate it early');
});

test('the emitted page and its module script both parse', () => {
	const html = buildIsolateHtml({ module: 'src/primitives/button/Button.tsx', export: 'Button', router: true });
	assert.ok(html.startsWith('<!doctype html>'));
	const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
	assert.ok(script, 'no module script in the emitted page');
	// Parse as a plain script, so drop the two things only a module may have:
	// the bare imports (they need the target's Vite graph) and import.meta.
	const body = script[1].replace(/^import .*$/gm, '').replace(/import\.meta/g, '({env:{}})');
	assert.doesNotThrow(() => new vm.Script(body), 'the emitted module script is not valid JS');
});

test('every control kind the panel dispatches on is implemented', () => {
	const html = buildIsolateHtml({ module: 'src/x/X.tsx' });
	for (const fn of ['toggleControl', 'enumControl', 'numberControl', 'stringControl', 'colorControl', 'jsonControl', 'stubControl']) {
		assert.ok(html.includes('function ' + fn), `missing ${fn}`);
	}
	// The invariant that keeps a half-typed JSON edit alive: controls repair
	// their own row instead of rebuilding the panel.
	assert.ok(html.includes('function refreshRowChrome'));
	assert.ok(html.includes('function replaceRow'));
});

// ---- route seeding (the third seam input) ----------------------------------
// A target with a providers shell owns its own Router, so the harness cannot
// choose the initial entry and navigates from inside the shell instead. These
// two paths emit different code, and only one of them was ever parsed before.

test('the shell path emits the route seeder and no MemoryRouter of its own', () => {
	const html = buildIsolateHtml({
		module: 'src/pages/NodeDashboard/node-dashboard/NodeDashboard.tsx',
		providers: 'src/burrow.isolate.tsx',
		router: false,
		routerDep: true,
		route: '/node/7',
	});
	assert.match(html, /useNavigate as __burrowUseNavigate/, 'the shell path still needs the router hooks');
	assert.match(html, /RouteSeed = \(props\) => \{/, 'no route seeder on the shell path');
	assert.doesNotMatch(html, /initialEntries: \[isoRoute\]/, 'a second Router nested inside the shell');
});

test('the seeder mounts inside Providers, not outside', () => {
	// Outside the shell it would be outside the shell's Router too, and
	// useNavigate would throw for want of a router context.
	const html = buildIsolateHtml({ module: 'src/x/X.tsx', routerDep: true, providers: 'src/burrow.isolate.tsx' });
	assert.match(html, /h\(Router, null, h\(Providers, null, h\(RouteSeed, null, h\(Comp/);
});

test('a target with no react-router gets no seeder at all', () => {
	const html = buildIsolateHtml({ module: 'src/x/X.tsx', router: false, routerDep: false });
	assert.doesNotMatch(html, /__burrowUseNavigate/);
	assert.match(html, /let RouteSeed = \(props\) => props\.children/, 'the identity seeder must still exist');
});

for (const [name, cfg] of [
	['shell', { module: 'src/x/X.tsx', providers: 'src/burrow.isolate.tsx', routerDep: true, route: '/node/7' }],
	['own router', { module: 'src/x/X.tsx', router: true, routerDep: true }],
]) {
	test(`the emitted script parses on the ${name} path`, () => {
		const script = /<script type="module">([\s\S]*?)<\/script>/.exec(buildIsolateHtml(cfg));
		const body = script[1].replace(/^import .*$/gm, '').replace(/import\.meta/g, '({env:{}})');
		assert.doesNotThrow(() => new vm.Script(body));
	});
}

test('safeRoute takes in-app paths and refuses anything that leaves the origin', () => {
	assert.strictEqual(safeRoute('/node/7'), '/node/7');
	assert.strictEqual(safeRoute('/validators/eth/0xabc?tab=perf'), '/validators/eth/0xabc?tab=perf');
	assert.strictEqual(safeRoute('/'), '/');
	for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'node/7', '', null, undefined, 42, '/a b', '/x'.padEnd(600, 'y')]) {
		assert.strictEqual(safeRoute(bad), null, `accepted ${JSON.stringify(bad)}`);
	}
});

test('patternFor mounts a concrete route through the pattern that captures it', () => {
	// The matcher lives inside the emitted script (it needs the harness's own
	// CFG), so lift it out and run it against a stub rather than duplicate it.
	const html = buildIsolateHtml({
		module: 'src/x/X.tsx',
		routerDep: true,
		routePatterns: ['/', '/fleet', '/node/:id', '/watch/alerts/node/:nodeId', '/validators/:chain/:address', '/watch/:section'],
	});
	const src = /const ROUTE_PATTERNS[\s\S]*?\n}\n/.exec(html);
	assert.ok(src, 'could not lift patternFor out of the emitted script');
	const ctx = { CFG: { routePatterns: ['/', '/fleet', '/node/:id', '/watch/alerts/node/:nodeId', '/validators/:chain/:address', '/watch/:section'] } };
	vm.createContext(ctx);
	vm.runInContext(src[0] + ';this.patternFor = patternFor;', ctx);
	const { patternFor } = ctx;
	assert.strictEqual(patternFor('/node/n1'), '/node/:id');
	assert.strictEqual(patternFor('/node/n1?tab=perf'), '/node/:id');
	assert.strictEqual(patternFor('/validators/eth/0xabc'), '/validators/:chain/:address');
	assert.strictEqual(patternFor('/fleet'), '/fleet');
	// Two patterns fit — the one with more literal segments is the real route.
	assert.strictEqual(patternFor('/watch/alerts/node/7'), '/watch/alerts/node/:nodeId');
	// Nothing declared fits: mount bare, exactly as before this existed.
	assert.strictEqual(patternFor('/nothing/like/this/at/all'), null);
	assert.strictEqual(patternFor('/'), '/');
});

test('deepStub replaces a function marker below the top level', () => {
	// materialize() reads the props schema, and the schema stops at the top
	// level — so a DataTable column's `render` and a FilterPopover group's
	// `onToggle` reached the component as the literal marker string and died on
	// first call. Lifted out of the emitted script and run in a vm, like
	// patternFor above, because it needs no harness state.
	const html = buildIsolateHtml({ module: 'src/x/X.tsx' });
	const src = /const isFnMarker[\s\S]*?\nconst deepStub[\s\S]*?\n}\n/.exec(html);
	assert.ok(src, 'could not lift deepStub out of the emitted script');
	const ctx = { console: { log() { } } };
	vm.createContext(ctx);
	vm.runInContext(src[0] + ';this.deepStub = deepStub;', ctx);
	const { deepStub } = ctx;

	const columns = deepStub([{ header: 'Name', render: 'ƒ' }, { header: 'Age', render: 'ƒ' }], 'columns', 1);
	assert.strictEqual(typeof columns[0].render, 'function');
	assert.strictEqual(typeof columns[1].render, 'function');
	assert.strictEqual(columns[0].header, 'Name', 'a real value beside the marker was rewritten');
	assert.notStrictEqual(columns[0].render, columns[1].render, 'both columns got one shared stub');
	assert.strictEqual(columns[0].render({}), null, 'the stub must return null, not undefined');

	// Three levels down, and through an array inside an object.
	const deep = deepStub({ groups: [{ actions: { onClear: 'ƒ' } }] }, 'p', 1);
	assert.strictEqual(typeof deep.groups[0].actions.onClear, 'function');

	// Values that are not markers come back untouched, and a class instance is
	// never rebuilt as a plain object.
	class Box { constructor() { this.n = 1; } }
	const box = new Box();
	assert.strictEqual(deepStub(box, 'b', 1), box);
	assert.strictEqual(deepStub('ƒoo', 's', 1), 'ƒoo', 'a word merely starting with the marker glyph is a string');
	assert.strictEqual(deepStub(null, 'n', 1), null);
	const set = new Set(['a']);
	assert.strictEqual(deepStub(set, 'set', 1), set);

	// Cycles cannot be reached through JSON-safe props, but the depth cap is
	// what makes that a guarantee rather than an assumption.
	let nest = { m: 'ƒ' };
	for (let i = 0; i < 12; i++) { nest = { down: nest }; }
	assert.doesNotThrow(() => deepStub(nest, 'deep', 1));
});
