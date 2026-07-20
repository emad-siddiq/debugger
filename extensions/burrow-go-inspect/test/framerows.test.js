/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Unit tests for the frame-row builder (task 05.2): runtime-frame folding and the
// project/foreign split. framerows.ts imports nothing from 'vscode'.

'use strict';

const assert = require('node:assert');
const { buildRows, packageOf, isProjectFrame } = require('../out/framerows');

const ROOT = '/work/app';
const f = (id, name, file, line, dir = ROOT) => ({ id, name, line, source: { name: file, path: `${dir}/${file}` } });
// A frame with no source path at all (dlv omits it for some runtime frames).
const nosrc = (id, name, line) => ({ id, name, line });

const cases = {
	'packageOf: stdlib, module path, and main': () => {
		assert.strictEqual(packageOf('sync.(*Mutex).Lock'), 'sync');
		assert.strictEqual(packageOf('github.com/x/y.(*T).M'), 'github.com/x/y');
		assert.strictEqual(packageOf('main.gauntlet'), 'main');
	},
	'a run of foreign frames folds into one row labelled by dominant package': () => {
		const rows = buildRows([
			f(1, 'main.gauntlet', 'gauntlet.go', 110),
			nosrc(2, 'runtime.gopark', 436),
			nosrc(3, 'runtime.goparkunlock', 441),
			nosrc(4, 'runtime.chanrecv', 583),
		], [ROOT], new Set());
		assert.strictEqual(rows.length, 2);
		assert.deepStrictEqual(rows[0], { type: 'frame', frameId: 1, func: 'main.gauntlet', location: 'gauntlet.go:110', foreign: false });
		// foldKey is the stack index of the run's first frame (1), not a frame id.
		assert.deepStrictEqual(rows[1], { type: 'fold', label: 'runtime', count: 3, foldKey: 1 });
	},
	'an expanded fold shows its frames instead': () => {
		const rows = buildRows([
			f(1, 'main.gauntlet', 'gauntlet.go', 110),
			nosrc(2, 'runtime.gopark', 436),
			nosrc(3, 'runtime.goparkunlock', 441),
		], [ROOT], new Set([1]));   // the run starts at stack index 1
		assert.strictEqual(rows.length, 3);
		assert.strictEqual(rows[1].type, 'frame');
		assert.strictEqual(rows[1].foreign, true);
	},
	'a run of one foreign frame is never folded': () => {
		const rows = buildRows([
			f(1, 'main.gauntlet', 'gauntlet.go', 110),
			nosrc(2, 'runtime.main', 267),
			f(3, 'main.main', 'main.go', 47),
		], [ROOT], new Set());
		assert.deepStrictEqual(rows.map(r => r.type), ['frame', 'frame', 'frame']);
	},
	'a module named like a domain is still project code when it lives under a root': () => {
		// The name heuristic would call `burrow/testdata` foreign because "burrow"
		// has no dot; the path says otherwise, and the path wins.
		const frame = f(1, 'burrow/testdata/debuggee.gauntlet', 'gauntlet.go', 110);
		assert.strictEqual(isProjectFrame(frame, [ROOT]), true);
	},
	'a frame outside every root is foreign even with a source path': () => {
		const frame = f(1, 'main.gauntlet', 'gauntlet.go', 110, '/usr/local/go/src/runtime');
		assert.strictEqual(isProjectFrame(frame, [ROOT]), false);
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
console.log(`\nframerows: ${total - failed}/${total} passed`);
if (failed > 0) {
	process.exit(1);
}
