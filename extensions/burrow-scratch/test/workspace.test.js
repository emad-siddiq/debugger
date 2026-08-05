/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The scratch folder on disk. The load-bearing assertion is the FIRST one: a
// fresh scratch contains the plan, the progress and an index — and NOT the
// shape of the project. 478 pre-created directories answered "what does this
// project look like" before the first keystroke, which is the one question a
// from-scratch rebuild exists to make you answer yourself.
// Run: `npm test` (after a compile) or `node test/workspace.test.js`.

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureFile, materialize, materializeCopies, readProgress } = require('../out/workspace');
const { buildPlan } = require('../out/planModel');

const file = (p, text = '') => ({ path: p, text, bytes: Buffer.byteLength(text) });
const plan = () => buildPlan([
	file('backend/go.mod', 'module example.com/app\n\ngo 1.25.0\n'),
	file('backend/models/node.go', 'package models\n\ntype Node struct{}\n'),
	file('web/package.json', '{"name":"web"}'),
	file('web/src/main.ts', 'export const main = 1;\n'),
], { name: 'app', reference: '/ref' });

const T0 = '2026-08-01T10:00:00.000Z';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-scratch-test-'));

const cases = {
	'a fresh scratch is progress files only — no source directories': () => {
		const root = tmp();
		materialize(root, plan(), T0);
		const entries = fs.readdirSync(root).sort();
		assert.deepStrictEqual(entries, ['.burrow-scratch', '.gitignore', 'SCRATCH.md'],
			`the project's shape leaked into a fresh scratch: ${entries.join(', ')}`);
		fs.rmSync(root, { recursive: true, force: true });
	},

	're-materializing keeps the progress': () => {
		const root = tmp();
		const p = plan();
		materialize(root, p, T0);
		const progress = readProgress(root, T0);
		const marked = { ...progress, steps: { 'web/package.json': { state: 'done', at: T0 } } };
		fs.writeFileSync(path.join(root, '.burrow-scratch', 'progress.json'), JSON.stringify(marked));
		const survived = materialize(root, p, T0);
		assert.strictEqual(survived.steps['web/package.json'].state, 'done');
		fs.rmSync(root, { recursive: true, force: true });
	},

	'ensureFile creates the directory exactly when a step is reached': () => {
		const root = tmp();
		materialize(root, plan(), T0);
		assert.ok(!fs.existsSync(path.join(root, 'web')), 'not before');
		const abs = ensureFile(root, 'web/src/main.ts', 'write');
		assert.ok(fs.existsSync(abs), 'the file, after');
		assert.strictEqual(fs.readFileSync(abs, 'utf8'), '', 'and it is empty — nothing pre-typed');
		fs.rmSync(root, { recursive: true, force: true });
	},

	'ensureFile makes the directory but never the file for a generate step': () => {
		const root = tmp();
		materialize(root, plan(), T0);
		const abs = ensureFile(root, 'backend/go.mod', 'generate');
		assert.ok(fs.existsSync(path.dirname(abs)), 'the directory the command runs in');
		assert.ok(!fs.existsSync(abs), 'but not the file — go mod init refuses to overwrite one');
		fs.rmSync(root, { recursive: true, force: true });
	},

	'a stage of documents comes in with one action': () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-bulk-'));
		const reference = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-ref-'));
		fs.mkdirSync(path.join(reference, 'docs'), { recursive: true });
		for (const name of ['one.md', 'two.md', 'three.md']) {
			fs.writeFileSync(path.join(reference, 'docs', name), `# ${name}\n`);
		}
		const ids = ['docs/one.md', 'docs/two.md', 'docs/three.md'];
		const written = materializeCopies(root, reference, ids);
		assert.deepStrictEqual([...written], ids);
		for (const id of ids) {
			assert.strictEqual(fs.readFileSync(path.join(root, id), 'utf8'),
				fs.readFileSync(path.join(reference, id), 'utf8'), `${id} is not byte-identical`);
		}
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(reference, { recursive: true, force: true });
	},

	'a reference that has moved writes NOTHING, and says which files it wanted': () => {
		// The half-populated scratch is the failure mode worth designing against:
		// a bulk action that gets through two hundred files and stops leaves no way
		// to tell which half came from where. Everything is stat'd first.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-bulk-'));
		const reference = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-ref-'));
		fs.mkdirSync(path.join(reference, 'docs'), { recursive: true });
		fs.writeFileSync(path.join(reference, 'docs', 'one.md'), '# one\n');
		const ids = ['docs/one.md', 'docs/gone.md', 'docs/also-gone.md'];
		assert.throws(() => materializeCopies(root, reference, ids), (error) => {
			assert.ok(/2 of 3 are no longer in the reference/.test(error.message), error.message);
			assert.ok(/docs\/gone.md/.test(error.message), 'and names them');
			return true;
		});
		assert.ok(!fs.existsSync(path.join(root, 'docs', 'one.md')),
			'the one file it COULD have copied must not be there — no partial writes');
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(reference, { recursive: true, force: true });
	},
};

let failed = 0;
for (const [name, run] of Object.entries(cases)) {
	try {
		run();
		console.log(`  ✓ ${name}`);
	} catch (error) {
		failed++;
		console.error(`  ✗ ${name}\n    ${error.message}`);
	}
}
console.log(`${Object.keys(cases).length - failed}/${Object.keys(cases).length} passed`);
process.exit(failed ? 1 : 0);
