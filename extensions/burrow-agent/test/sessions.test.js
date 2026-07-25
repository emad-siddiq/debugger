/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The session rail's state machine. sessions.ts takes its store structurally
// (get/update, i.e. vscode.Memento) rather than importing 'vscode', so the tabs
// can be driven here with a plain object standing in for workspaceState.
// Run: `npm test` (after a compile) or `node test/sessions.test.js`.

'use strict';

const assert = require('node:assert');
const { SessionStore, MAX_SESSIONS, titleFrom } = require('../out/sessions');

/** vscode.Memento, in eight lines. */
function memory(seed) {
	const data = seed ? { ...seed } : {};
	return {
		data,
		get: (key, fallback) => (key in data ? data[key] : fallback),
		update: (key, value) => { data[key] = value; return Promise.resolve(); },
	};
}

const cases = {
	'an empty workspace opens with one session to type into': () => {
		const store = new SessionStore(memory());
		assert.strictEqual(store.all.length, 1);
		assert.strictEqual(store.activeId, store.all[0].id);
	},
	'the first question becomes the tab title': () => {
		const store = new SessionStore(memory());
		store.append(store.activeId, { role: 'you', text: '  why is the dot\n misaligned at xs?  ' });
		assert.strictEqual(store.current.title, 'why is the dot misaligned at xs?');
	},
	'later questions do not rename the tab': () => {
		const store = new SessionStore(memory());
		store.append(store.activeId, { role: 'you', text: 'first' });
		store.append(store.activeId, { role: 'you', text: 'second' });
		assert.strictEqual(store.current.title, 'first');
	},
	'a long question is elided to one line': () => {
		const title = titleFrom('x'.repeat(120));
		assert.strictEqual(title.length, 48);
		assert.ok(title.endsWith('…'));
	},
	'switching tabs changes where turns land': () => {
		const store = new SessionStore(memory());
		const first = store.activeId;
		const second = store.create();
		store.append(second.id, { role: 'you', text: 'in the new one' });
		assert.strictEqual(store.all.find((s) => s.id === first).turns.length, 0);
		store.activate(first);
		assert.strictEqual(store.current.id, first);
	},
	'an answer can land in a session the user has already switched away from': () => {
		const store = new SessionStore(memory());
		const background = store.activeId;
		store.create();
		store.append(background, { role: 'agent', text: 'late answer' });
		assert.strictEqual(store.all.find((s) => s.id === background).turns[0].text, 'late answer');
	},
	'the cap is eight and the ninth is refused rather than evicting work': () => {
		const store = new SessionStore(memory());
		for (let i = 1; i < MAX_SESSIONS; i++) {
			assert.ok(store.create(), `create ${i}`);
		}
		assert.strictEqual(store.all.length, MAX_SESSIONS);
		assert.strictEqual(store.create(), undefined);
		assert.strictEqual(store.all.length, MAX_SESSIONS);
	},
	'closing the active tab activates a neighbour': () => {
		const store = new SessionStore(memory());
		const first = store.activeId;
		const second = store.create().id;
		store.close(second);
		assert.strictEqual(store.activeId, first);
		assert.strictEqual(store.all.length, 1);
	},
	'closing the last tab leaves an empty one, never zero': () => {
		const store = new SessionStore(memory());
		store.append(store.activeId, { role: 'you', text: 'something' });
		store.close(store.activeId);
		assert.strictEqual(store.all.length, 1);
		assert.strictEqual(store.current.turns.length, 0);
	},
	'sessions and the active tab survive a reload': () => {
		const backing = memory();
		const first = new SessionStore(backing);
		first.append(first.activeId, { role: 'you', text: 'remember me' });
		first.setResume(first.activeId, 'cli-abc');
		const second = first.create().id;

		const reopened = new SessionStore(memory(backing.data));
		assert.strictEqual(reopened.all.length, 2);
		assert.strictEqual(reopened.activeId, second);
		assert.strictEqual(reopened.all[0].turns[0].text, 'remember me');
		assert.strictEqual(reopened.all[0].resume, 'cli-abc', 'the resume token is what makes the tab a real conversation again');
	},
	'a corrupt stored session is dropped, not crashed on': () => {
		const store = new SessionStore(memory({ 'burrow.agent.sessions': { sessions: [{ nope: true }, null], activeId: 'gone' } }));
		assert.strictEqual(store.all.length, 1);
		assert.strictEqual(store.current.turns.length, 0);
	},
};

let failed = 0;
for (const [name, run] of Object.entries(cases)) {
	try {
		run();
		console.log(`  ok  ${name}`);
	} catch (err) {
		failed++;
		console.error(`FAIL  ${name}\n      ${err && err.message}`);
	}
}
console.log(`${Object.keys(cases).length - failed}/${Object.keys(cases).length} passed`);
process.exit(failed ? 1 : 0);
