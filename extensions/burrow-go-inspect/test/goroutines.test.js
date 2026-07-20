/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Unit tests for the goroutine parser (task 05.2). goroutines.ts imports nothing
// from 'vscode', so out/goroutines.js is a clean CommonJS module. The fixtures are
// real dlv 1.25.2 thread names captured from the gauntlet's goroutine storm.

'use strict';

const assert = require('node:assert');
const { parseGoroutine, orderGoroutines, countByKind, goroutineLabel, matchesGoroutine } = require('../out/goroutines');

const t = (id, name) => ({ id, name });

const cases = {
	'current goroutine: the leading * and the Go id and func': () => {
		const g = parseGoroutine(t(1, '* [Go 1] main.gauntlet (Thread 11291594)'));
		assert.strictEqual(g.current, true);
		assert.strictEqual(g.goId, 1);
		assert.strictEqual(g.func, 'main.gauntlet');   // the "(Thread N)" tail is stripped
		assert.strictEqual(g.kind, 'current');
	},
	'mutex waiter classifies as user and is waiting on a mutex': () => {
		const g = parseGoroutine(t(7, '[Go 7] sync.(*Mutex).Lock'));
		assert.strictEqual(g.kind, 'user');
		assert.strictEqual(g.waiting, 'mutex');
	},
	'time.Sleep waiter reads as sleeping': () => {
		assert.strictEqual(parseGoroutine(t(9, '[Go 9] time.Sleep')).waiting, 'sleep');
	},
	'runtime.gopark is a system goroutine with no wait hint': () => {
		const g = parseGoroutine(t(2, '[Go 2] runtime.gopark'));
		assert.strictEqual(g.kind, 'system');
		assert.strictEqual(g.waiting, undefined);
	},
	'ordering: current first, then user by go id, then system': () => {
		const threads = [
			t(2, '[Go 2] runtime.gopark'),
			t(7, '[Go 7] sync.(*Mutex).Lock'),
			t(1, '* [Go 1] main.gauntlet (Thread 1)'),
			t(9, '[Go 9] time.Sleep'),
		];
		assert.deepStrictEqual(orderGoroutines(threads).map(g => g.goId), [1, 7, 9, 2]);
	},
	'counts split user (incl. current) from system': () => {
		const gs = orderGoroutines([
			t(1, '* [Go 1] main.gauntlet'),
			t(7, '[Go 7] sync.(*Mutex).Lock'),
			t(2, '[Go 2] runtime.gopark'),
		]);
		assert.deepStrictEqual(countByKind(gs), { user: 2, system: 1, total: 3 });
	},
	'label carries id, func and wait hint': () => {
		assert.strictEqual(goroutineLabel(parseGoroutine(t(7, '[Go 7] sync.(*Mutex).Lock'))), '[Go 7] sync.(*Mutex).Lock · mutex');
	},
	'a thread with no [Go n] still yields a usable row': () => {
		const g = parseGoroutine(t(42, 'Dummy'));
		assert.strictEqual(g.goId, undefined);
		assert.strictEqual(goroutineLabel(g), '[Thread 42] Dummy');
	},
	'filter matches on func and on go id': () => {
		const g = parseGoroutine(t(7, '[Go 7] sync.(*Mutex).Lock'));
		assert.strictEqual(matchesGoroutine(g, 'mutex'), true);
		assert.strictEqual(matchesGoroutine(g, '7'), true);
		assert.strictEqual(matchesGoroutine(g, 'time.Sleep'), false);
		assert.strictEqual(matchesGoroutine(g, ''), true);
	},
};

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
	try {
		fn();
		console.log(`ok   — ${name}`);
	} catch (err) {
		failed++;
		console.error(`FAIL — ${name}\n       ${err.message}`);
	}
}
const total = Object.keys(cases).length;
console.log(`\ngoroutines: ${total - failed}/${total} passed`);
if (failed > 0) {
	process.exit(1);
}
