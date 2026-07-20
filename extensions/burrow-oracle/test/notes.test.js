/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the per-workspace note store + resolver. notes.ts imports nothing
// from 'vscode'; persistence goes through the NoteStorage interface that vscode.Memento
// satisfies, so we drive the store with an in-memory FAKE Memento (no globals stubbed — the
// injectable-dependency pattern from CLAUDE.md). Run: `npm test` or `node test/notes.test.js`.

'use strict';

const assert = require('node:assert');
const { NoteStore, noteKeyFor, toExcerpt, NOTES_STORAGE_KEY } = require('../out/notes');

/** An in-memory vscode.Memento stand-in — the exact get/update shape the store needs. */
function fakeMemento(seed) {
	const map = new Map(seed ? Object.entries(seed) : []);
	return {
		store: map,
		get(key, dflt) {
			return map.has(key) ? map.get(key) : dflt;
		},
		update(key, value) {
			map.set(key, value);
			return Promise.resolve();
		},
	};
}

const cases = {
	'put persists a symbol-anchored note and all() reads it back': async () => {
		const mem = fakeMemento();
		const store = new NoteStore(mem);
		const note = await store.put({ file: 'ingest/handler.go', symbol: 'ingest.HandleIngest', excerpt: 'func HandleIngest', text: 'entry point', createdAt: 1 });
		assert.strictEqual(note.key, 'ingest/handler.go::ingest.HandleIngest');
		assert.deepStrictEqual(store.all(), [note]);
		// It really landed in the backing store under the expected key.
		assert.strictEqual(mem.store.get(NOTES_STORAGE_KEY).length, 1);
	},
	're-noting the same symbol overwrites, never duplicates': async () => {
		const store = new NoteStore(fakeMemento());
		await store.put({ file: 'a.go', symbol: 'p.Foo', excerpt: 'x', text: 'first', createdAt: 1 });
		await store.put({ file: 'a.go', symbol: 'p.Foo', excerpt: 'x', text: 'second', createdAt: 2 });
		const all = store.all();
		assert.strictEqual(all.length, 1);
		assert.strictEqual(all[0].text, 'second');
	},
	'resolve matches the innermost candidate first': async () => {
		const store = new NoteStore(fakeMemento());
		await store.put({ file: 'a.go', symbol: 'p', excerpt: '', text: 'package note', createdAt: 1 });
		await store.put({ file: 'a.go', symbol: 'p.Inserter.loop', excerpt: '', text: 'method note', createdAt: 2 });
		const hit = store.resolve('a.go', ['p.Inserter.loop', 'p.Inserter', 'p']);
		assert.strictEqual(hit.text, 'method note');
	},
	'resolve falls outward to the package note when nothing tighter has one': async () => {
		const store = new NoteStore(fakeMemento());
		await store.put({ file: 'a.go', symbol: 'p', excerpt: '', text: 'package note', createdAt: 1 });
		const hit = store.resolve('a.go', ['p.Inserter.loop', 'p.Inserter', 'p']);
		assert.strictEqual(hit.text, 'package note');
	},
	'resolve is scoped to the file': async () => {
		const store = new NoteStore(fakeMemento());
		await store.put({ file: 'a.go', symbol: 'p.Foo', excerpt: '', text: 'in a', createdAt: 1 });
		assert.strictEqual(store.resolve('b.go', ['p.Foo']), undefined);
	},
	'resolve falls back to an excerpt-anchored note when no symbol matches': async () => {
		const store = new NoteStore(fakeMemento());
		await store.put({ file: 'a.go', symbol: '', excerpt: 'magic constant 7', text: 'why 7', createdAt: 1 });
		const hit = store.resolve('a.go', [], 'magic constant 7');
		assert.strictEqual(hit.text, 'why 7');
	},
	'remove deletes by key and reports it': async () => {
		const store = new NoteStore(fakeMemento());
		const note = await store.put({ file: 'a.go', symbol: 'p.Foo', excerpt: '', text: 't', createdAt: 1 });
		assert.strictEqual(await store.remove(note.key), true);
		assert.deepStrictEqual(store.all(), []);
		assert.strictEqual(await store.remove(note.key), false);
	},
	'noteKeyFor is symbol-anchored when a symbol is present': () => {
		assert.strictEqual(noteKeyFor('a.go', 'p.Foo', 'anything'), 'a.go::p.Foo');
	},
	'noteKeyFor hashes the excerpt when no symbol is present, stably': () => {
		const k1 = noteKeyFor('a.go', '', 'const timeout = 7');
		const k2 = noteKeyFor('a.go', '', 'const timeout = 7');
		assert.strictEqual(k1, k2);
		assert.notStrictEqual(k1, noteKeyFor('a.go', '', 'const timeout = 8'));
		assert.ok(k1.startsWith('a.go::#'));
	},
	'toExcerpt collapses whitespace and caps length': () => {
		assert.strictEqual(toExcerpt('  func\t Foo(\n)  {}  '), 'func Foo( ) {}');
		const long = toExcerpt('x'.repeat(500));
		assert.ok(long.length <= 200);
		assert.ok(long.endsWith('…'));
	},
};

let failed = 0;
(async () => {
	for (const [name, fn] of Object.entries(cases)) {
		try {
			await fn();
			console.log(`ok   — ${name}`);
		} catch (err) {
			failed++;
			console.error(`FAIL — ${name}\n       ${err.message}`);
		}
	}
	const total = Object.keys(cases).length;
	console.log(`\n${total - failed}/${total} passed`);
	if (failed > 0) {
		process.exit(1);
	}
})();
