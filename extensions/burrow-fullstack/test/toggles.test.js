/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Unit test for the Debug Config toggle engine (out/toggles.js — no 'vscode').

'use strict';

const assert = require('node:assert');
const { DEFAULT_MANIFEST, parseManifest, effectiveState, envPatch, activeProcesses } = require('../out/toggles');

// The built-in manifest carries the nodewatch mapping.
const ids = DEFAULT_MANIFEST.toggles.map(t => t.id);
assert.deepStrictEqual(ids, ['skipAuth', 'seedMode', 'readOnly', 'debugEmit']);

// Defaults: skip-auth on, everything else off.
const defaults = effectiveState(DEFAULT_MANIFEST, {});
assert.deepStrictEqual(defaults, { skipAuth: true, seedMode: false, readOnly: false, debugEmit: false });

// Stored state overrides defaults.
const stored = effectiveState(DEFAULT_MANIFEST, { skipAuth: false, seedMode: true });
assert.strictEqual(stored.skipAuth, false);
assert.strictEqual(stored.seedMode, true);

// Env patch: ON toggles set vars; OFF toggles map their vars to undefined so
// the resolver deletes them even when a launch config sets them.
const onPatch = envPatch(DEFAULT_MANIFEST, defaults);
assert.strictEqual(onPatch.NODEWATCH_DEV_NO_AUTH, '1');
assert.strictEqual(onPatch.NODEWATCH_SIGNUP_MODE, 'open');
assert.strictEqual(onPatch.NODEWATCH_READ_ONLY, undefined);
assert.ok('NODEWATCH_READ_ONLY' in onPatch, 'off toggle still claims its var');

const offPatch = envPatch(DEFAULT_MANIFEST, { ...defaults, skipAuth: false });
assert.strictEqual(offPatch.NODEWATCH_DEV_NO_AUTH, undefined);
assert.ok('NODEWATCH_DEV_NO_AUTH' in offPatch);

// Seed processes appear only while their toggle is on, with the emitter contract.
assert.deepStrictEqual(activeProcesses(DEFAULT_MANIFEST, defaults), []);
const seeding = activeProcesses(DEFAULT_MANIFEST, { ...defaults, seedMode: true });
assert.deepStrictEqual(seeding.map(p => p.name), ['eth-emitter', 'sol-emitter']);
assert.strictEqual(seeding[0].env.API_KEY, 'test-key-eth');
assert.strictEqual(seeding[0].cwd, 'emitters');

// Project manifest parsing: valid shape passes, junk fails loudly.
const custom = parseManifest(JSON.stringify({ toggles: [{ id: 'x', label: 'X', env: { FOO: '1' } }] }));
assert.strictEqual(custom.toggles.length, 1);
assert.throws(() => parseManifest('{}'), /toggles/);
assert.throws(() => parseManifest(JSON.stringify({ toggles: [{ label: 'no id' }] })), /id/);

console.log('toggles.test.js OK');
