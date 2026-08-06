/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit tests for the scheme bar's item model and run argv.
// schemeBar.ts imports no 'vscode'. Run: `node test/schemeBar.test.js`.

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
	DOCTOR_COMMAND, PICK_COMMAND, RACE_COMMAND, RUN_COMMAND, STOP_COMMAND,
	barItems, debugConfiguration, runArgs, targetText,
} = require('../out/schemeBar');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const HEALTHY = { text: 'go 1.24 · gopls ok · dlv ok', healthy: true, missing: [] };
const BROKEN = { text: 'dlv missing', healthy: false, missing: ['dlv'] };
const ROOT_MAIN = { id: '.', label: 'liveproj', kind: 'binary', path: '.' };
const CMD_MAIN = { id: 'cmd/alertmanager', label: 'alertmanager', kind: 'binary', path: 'cmd/alertmanager' };

const byId = (state) => new Map(barItems(state).map((i) => [i.id, i]));

const cases = {
	'go run targets the PROGRAM, never the module root': () => {
		// WO-72, measured on alertmanager: the go.mod is at the root and the
		// binaries are cmd/alertmanager and cmd/amtool. `go run .` at that root
		// builds nothing, and the failure names a package the reader never chose.
		assert.deepStrictEqual(runArgs(CMD_MAIN, false), ['run', './cmd/alertmanager']);
		assert.deepStrictEqual(runArgs(ROOT_MAIN, false), ['run', '.']);
	},

	'a bare relative path is spelled ./x': () => {
		// Without the prefix `go run` reads `cmd/alertmanager` as an IMPORT PATH and
		// goes looking for it in the module cache, which fails with a message about
		// a module that does not exist.
		assert.deepStrictEqual(runArgs({ ...CMD_MAIN, path: 'cmd/alertmanager' }, false), ['run', './cmd/alertmanager']);
		assert.deepStrictEqual(runArgs({ ...CMD_MAIN, path: './cmd/x' }, false), ['run', './cmd/x']);
		assert.deepStrictEqual(runArgs({ ...CMD_MAIN, path: '/abs/cmd/x' }, false), ['run', '/abs/cmd/x']);
	},

	'the race flag lands before the package, where go accepts it': () => {
		assert.deepStrictEqual(runArgs(CMD_MAIN, true), ['run', '-race', './cmd/alertmanager']);
		const args = runArgs(CMD_MAIN, true);
		assert.ok(args.indexOf('-race') < args.length - 1, 'a flag after the package is an argument to the program');
	},

	'zero, one and many targets read as three different things': () => {
		assert.match(targetText({ targetCount: 0, race: false, running: false, toolchain: HEALTHY }), /no program/);
		assert.match(targetText({ targetCount: 2, race: false, running: false, toolchain: HEALTHY }), /choose a program/);
		assert.match(targetText({ target: CMD_MAIN, targetCount: 2, race: false, running: false, toolchain: HEALTHY }), /alertmanager/);
	},

	'a library gets no Run button, and a reason instead of a dead one': () => {
		// The failure this prevents: a greyed play button on a module with no main
		// invites a click that can only fail. Absent + an explaining segment does not.
		const items = byId({ targetCount: 0, race: false, running: false, toolchain: HEALTHY });
		assert.strictEqual(items.get('run').visible, false);
		assert.strictEqual(items.get('debug').visible, false);
		assert.strictEqual(items.get('target').visible, true);
		assert.strictEqual(items.get('target').command, undefined, 'nothing to pick from, so nothing to click');
		assert.match(items.get('target').tooltip, /library/);
	},

	'a missing tool hides Run rather than letting it fail': () => {
		const items = byId({ target: CMD_MAIN, targetCount: 1, race: false, running: false, toolchain: BROKEN });
		assert.strictEqual(items.get('run').visible, false);
		assert.strictEqual(items.get('toolchain').visible, true);
		assert.strictEqual(items.get('toolchain').warning, true);
		assert.match(items.get('toolchain').text, /\$\(warning\)/);
		assert.match(items.get('toolchain').tooltip, /dlv/);
	},

	'the toolchain segment is present even when everything is fine': () => {
		// It is the one item that must never disappear: its job is to be the place
		// you look, which only works if it is always the same place.
		const items = byId({ target: CMD_MAIN, targetCount: 1, race: false, running: false, toolchain: HEALTHY });
		assert.strictEqual(items.get('toolchain').visible, true);
		assert.strictEqual(items.get('toolchain').warning, false);
		assert.strictEqual(items.get('toolchain').text, HEALTHY.text);
	},

	'Run and Stop are never both there': () => {
		const idle = byId({ target: CMD_MAIN, targetCount: 1, race: false, running: false, toolchain: HEALTHY });
		assert.strictEqual(idle.get('run').visible, true);
		assert.strictEqual(idle.get('stop').visible, false);

		const busy = byId({ target: CMD_MAIN, targetCount: 1, race: false, running: true, toolchain: HEALTHY });
		assert.strictEqual(busy.get('run').visible, false);
		assert.strictEqual(busy.get('debug').visible, false);
		assert.strictEqual(busy.get('stop').visible, true);
	},

	'the race toggle shows its state, not its action': () => {
		const off = byId({ target: CMD_MAIN, targetCount: 1, race: false, running: false, toolchain: HEALTHY });
		const on = byId({ target: CMD_MAIN, targetCount: 1, race: true, running: false, toolchain: HEALTHY });
		assert.strictEqual(off.get('race').text, 'race');
		assert.match(on.get('race').text, /\$\(check\) race/);
		assert.match(off.get('race').tooltip, /off/);
		assert.match(on.get('race').tooltip, /ON/);
	},

	'the Run tooltip is the command that will run': () => {
		const on = byId({ target: CMD_MAIN, targetCount: 1, race: true, running: false, toolchain: HEALTHY });
		assert.strictEqual(on.get('run').tooltip, 'go run -race cmd/alertmanager');
	},

	'the debug configuration is the `go` type burrow-go-debug owns': () => {
		const config = debugConfiguration(CMD_MAIN, false, '/w/cmd/alertmanager', '/w');
		assert.strictEqual(config.type, 'go');
		assert.strictEqual(config.request, 'launch');
		assert.strictEqual(config.mode, 'debug');
		assert.strictEqual(config.program, '/w/cmd/alertmanager', 'the program, not the module root');
		assert.strictEqual(config.cwd, '/w', 'go build must see the go.mod, so cwd is the MODULE root');
		assert.strictEqual(config.buildFlags, undefined);
		assert.strictEqual(debugConfiguration(CMD_MAIN, true, '/w/cmd/x', '/w').buildFlags, '-race');
	},

	'every command a bar item names is contributed': () => {
		// A status bar item whose command does not exist looks identical to one that
		// works, right up until the click does nothing at all.
		const contributed = new Set(manifest.contributes.commands.map((c) => c.command));
		const states = [
			{ targetCount: 0, race: false, running: false, toolchain: HEALTHY },
			{ target: CMD_MAIN, targetCount: 2, race: true, running: false, toolchain: HEALTHY },
			{ target: CMD_MAIN, targetCount: 1, race: false, running: true, toolchain: BROKEN },
		];
		for (const state of states) {
			for (const item of barItems(state)) {
				if (item.command) {
					assert.ok(contributed.has(item.command), `${item.command} is not in package.json`);
				}
			}
		}
		for (const c of [RUN_COMMAND, STOP_COMMAND, PICK_COMMAND, RACE_COMMAND, DOCTOR_COMMAND]) {
			assert.ok(contributed.has(c), `${c} is not contributed`);
		}
	},
};

let failed = 0;
for (const [name, run] of Object.entries(cases)) {
	try {
		run();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failed++;
		console.error(`  ✗ ${name}\n    ${err.message}`);
	}
}
const total = Object.keys(cases).length;
console.log(`${total - failed}/${total} passed`);
process.exit(failed === 0 ? 0 : 1);
