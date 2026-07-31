/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The concept paragraphs. Mostly a grep, and it is the grep that matters: prose
// stays reusable only while nothing in it is about one project, and prose rots
// towards the example in front of the author. These assertions are the only
// thing standing between six paragraphs and a tutorial for one repository.
// Run: `npm test` (after a compile) or `node test/concepts.test.js`.

'use strict';

const assert = require('node:assert');
const { CONCEPTS, conceptOf, conceptFor } = require('../out/concepts');

/** Everything a paragraph must not know about. */
const PAROCHIAL = [
	/\bmerkle\b/i, /\bnodewatch\b/i, /\bburrow\b/i,
	/~\/Projects/, /\bfrontend\//, /\bbackend\//, /\binfra\//,
];

/** Reassurance. The voice is a project's own notes, not a tutorial's. */
const SOOTHING = [/\bsimply\b/i, /\bjust\s+(?:a|the|run|type)\b/i, /don't worry/i, /\bas you can see\b/i, /\beasy\b/i, /\bof course\b/i];

const cases = {
	'no paragraph is about any particular project': () => {
		for (const [id, concept] of Object.entries(CONCEPTS)) {
			for (const pattern of PAROCHIAL) {
				assert.ok(!pattern.test(concept.text), `${id} names ${pattern} — a concept paragraph that knows a project is not reusable`);
				assert.ok(!pattern.test(concept.order ?? ''), `${id}'s order argument names ${pattern}`);
			}
		}
	},

	'no paragraph reassures': () => {
		for (const [id, concept] of Object.entries(CONCEPTS)) {
			for (const pattern of SOOTHING) {
				assert.ok(!pattern.test(concept.text), `${id} says ${pattern} — it explains, it does not reassure`);
			}
		}
	},

	'every concept is reachable from a filename, and every filename lands somewhere': () => {
		const reached = new Set([
			'go.mod', 'package.json', 'package-lock.json', 'go.sum', 'yarn.lock', 'pnpm-lock.yaml',
			'tsconfig.json', 'tsconfig.app.json', 'Makefile', 'GNUmakefile',
			'docker-compose.yml', 'compose.yaml',
		].map((base) => conceptOf(`some/dir/${base}`)));
		assert.deepStrictEqual([...reached].filter((id) => id === undefined), [], 'every fixture filename resolves');
		for (const id of Object.keys(CONCEPTS)) {
			assert.ok(reached.has(id), `${id} is prose no filename reaches`);
		}
	},

	'a file that is not an instance of anything gets nothing': () => {
		for (const path of ['backend/main.go', 'web/src/App.tsx', 'README.md', 'migrations/001.sql', 'go.work']) {
			assert.strictEqual(conceptFor(path), undefined, `${path} should carry no concept`);
		}
	},

	'exactly the two positions the graph cannot argue carry an order argument': () => {
		const withOrder = Object.entries(CONCEPTS).filter(([, c]) => c.order).map(([id]) => id).sort();
		assert.deepStrictEqual(withOrder, ['compose-service', 'makefile']);
		// The other four are derivable and must NOT be authored over: a module
		// root comes first because its tree resolves through it, and a lockfile
		// follows its manifest because a command reads one to write the other.
		for (const id of ['go-module', 'npm-manifest', 'lockfile', 'tsconfig-references']) {
			assert.strictEqual(CONCEPTS[id].order, undefined, `${id}'s position is derivable — authoring it would let the two disagree`);
		}
	},

	'a paragraph is long enough to explain and short enough to read': () => {
		for (const [id, concept] of Object.entries(CONCEPTS)) {
			const words = concept.text.split(/\s+/).length;
			assert.ok(words >= 60 && words <= 120, `${id} is ${words} words — the band is 60–120`);
			assert.ok(!/\n/.test(concept.text), `${id} has a line break: one paragraph, no lists`);
		}
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
