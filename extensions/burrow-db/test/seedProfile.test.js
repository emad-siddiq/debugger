/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Unit test for the seed-profile loader (out/seedProfile.js — no 'vscode'),
// plus the parity check that keeps it identical to its burrow-flow twin.

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseSeedProfile, loadSeedProfile, SEED_PROFILE_REL } = require('../out/seedProfile');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

// ── parsing ────────────────────────────────────────────────────────────────
ok(parseSeedProfile('nonsense') === undefined, 'malformed JSON → undefined');
ok(parseSeedProfile('[]') === undefined, 'a non-object → undefined');
ok(parseSeedProfile('{"version":"1"}') === undefined, 'a string version → undefined');
ok(parseSeedProfile('{"version":1}').params && parseSeedProfile('{"version":1}').types, 'a bare profile still has empty maps');

const profile = parseSeedProfile(JSON.stringify({
	version: 1,
	params: { id: 'abc' },
	fields: { name: 'eth-mainnet-01' },
	types: { Node: { protocol: 'ethereum' } },
	db: {
		tables: { node_metrics: { queries: [{ label: 'Last 24h', sql: 'SELECT 1' }] } },
		seedActions: [
			{ label: 'Backfill', sqlFile: 'infra/test/mock/backfill.sql' },
			{ label: 'Ingest', command: 'bash test/mock/seed.sh', cwd: 'infra' },
		],
	},
}));
ok(profile.db.tables.node_metrics.queries[0].label === 'Last 24h', 'table queries survive parsing');
ok(profile.db.seedActions.length === 2, 'both seed actions survive parsing');
ok(profile.db.seedActions[1].cwd === 'infra', 'an action keeps its cwd');

// ── discovery ──────────────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-seed-'));
ok(loadSeedProfile(root) === undefined, 'no profile → undefined (every consumer keeps its old behaviour)');

fs.mkdirSync(path.join(root, path.dirname(SEED_PROFILE_REL)), { recursive: true });
fs.writeFileSync(path.join(root, SEED_PROFILE_REL), JSON.stringify({ version: 1, fields: { name: 'convention' } }));
ok(loadSeedProfile(root).fields.name === 'convention', 'the convention path is found');

const override = path.join(root, 'custom.json');
fs.writeFileSync(override, JSON.stringify({ version: 1, fields: { name: 'override' } }));
ok(loadSeedProfile(root, 'custom.json').fields.name === 'override', 'a relative setting wins over the convention');
ok(loadSeedProfile(root, override).fields.name === 'override', 'an absolute setting wins too');
ok(loadSeedProfile(root, 'missing.json').fields.name === 'convention', 'a missing setting path falls back to the convention');

fs.writeFileSync(path.join(root, SEED_PROFILE_REL), '{ truncated');
ok(loadSeedProfile(root) === undefined, 'a corrupt profile degrades to none rather than throwing');
fs.rmSync(root, { recursive: true, force: true });

// ── twin parity ────────────────────────────────────────────────────────────
// The two extensions are decoupled by design (neither may import the other),
// so this file is a deliberate copy of burrow-flow's. Only the header comment
// may differ — the code must not drift.
const strip = (src) => src.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n');
const mine = fs.readFileSync(path.join(__dirname, '..', 'src', 'seedProfile.ts'), 'utf8');
const twin = fs.readFileSync(path.join(__dirname, '..', '..', 'burrow-flow', 'src', 'seedProfile.ts'), 'utf8');
assert.strictEqual(strip(mine), strip(twin), 'burrow-db and burrow-flow seedProfile.ts have drifted — keep the twins identical');
passed++;

console.log(`seedProfile.test.js OK — ${passed}/${passed} passed`);
