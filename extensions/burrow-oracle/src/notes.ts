/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// notes.ts — the pure note model + store for the Codebase Oracle (architecture task 08,
// task 4: "note index + resolver"). A note anchors to a file + symbol path (never a line —
// stack invariant) and is persisted per-workspace. Persistence goes through a minimal
// {@link NoteStorage} interface that vscode.Memento satisfies structurally, so the store
// carries zero 'vscode' import and the tests drive it with an in-memory fake Memento —
// exactly the "make the dependency injectable, don't stub globals" rule from CLAUDE.md.

/** A single Oracle note attached to a symbol (or, absent one, a file excerpt). */
export interface Note {
	/** Stable identity: `${file}::${anchor}` — see {@link noteKeyFor}. */
	readonly key: string;
	/** Workspace-relative file the note was taken in. */
	readonly file: string;
	/** Dotted symbol path the note anchors to; empty when no symbol enclosed the cursor. */
	readonly symbol: string;
	/** The highlighted source excerpt at capture time (trimmed + capped). */
	readonly excerpt: string;
	/** The note body the author typed. */
	readonly text: string;
	/** Epoch millis the note was created/last replaced. */
	readonly createdAt: number;
}

/**
 * The persistence surface the store needs — a strict subset of vscode.Memento, so
 * `context.workspaceState` is passable directly while tests supply a plain-object fake.
 */
export interface NoteStorage {
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown): Thenable<void>;
}

/** Memento key under which the whole note array lives. */
export const NOTES_STORAGE_KEY = 'burrow.oracle.notes';

/** Longest excerpt we keep — enough to identify the code, not a second copy of the file. */
const EXCERPT_CAP = 200;

/**
 * Compute a note's stable key. When a symbol is known the key is symbol-anchored
 * (`file::symbol`) so it survives edits to the surrounding code; with no symbol it falls
 * back to a hash of the excerpt so distinct highlights in the same file don't collide.
 */
export function noteKeyFor(file: string, symbol: string, excerpt: string): string {
	const anchor = symbol ? symbol : `#${hash(excerpt)}`;
	return `${file}::${anchor}`;
}

/** Trim and cap a raw selection down to a storable excerpt. */
export function toExcerpt(raw: string): string {
	const collapsed = raw.replace(/\s+/g, ' ').trim();
	return collapsed.length > EXCERPT_CAP ? collapsed.slice(0, EXCERPT_CAP - 1) + '…' : collapsed;
}

/** A small, stable djb2 hash rendered hex — for excerpt-anchored keys only. */
function hash(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) {
		h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

/** The persisted per-workspace note store, resolving highlights to notes on read. */
export class NoteStore {
	constructor(private readonly storage: NoteStorage) { }

	/** Every stored note, in insertion order. */
	all(): Note[] {
		return this.storage.get<Note[]>(NOTES_STORAGE_KEY, []);
	}

	/**
	 * Persist a note, replacing any existing note with the same key (a re-note of the
	 * same symbol overwrites rather than duplicates). Returns the note actually stored.
	 */
	async put(fields: { file: string; symbol: string; excerpt: string; text: string; createdAt?: number }): Promise<Note> {
		const note: Note = {
			key: noteKeyFor(fields.file, fields.symbol, fields.excerpt),
			file: fields.file,
			symbol: fields.symbol,
			excerpt: fields.excerpt,
			text: fields.text,
			createdAt: fields.createdAt ?? Date.now(),
		};
		const next = this.all().filter(n => n.key !== note.key);
		next.push(note);
		await this.storage.update(NOTES_STORAGE_KEY, next);
		return note;
	}

	/** Delete a note by key; returns whether one was removed. */
	async remove(key: string): Promise<boolean> {
		const current = this.all();
		const next = current.filter(n => n.key !== key);
		if (next.length === current.length) {
			return false;
		}
		await this.storage.update(NOTES_STORAGE_KEY, next);
		return true;
	}

	/**
	 * Resolve the note for a highlight: try each candidate symbol path (innermost first,
	 * falling outward — see {@link module:symbols.symbolPathCandidates}) within `file`,
	 * returning the first match. Excerpt-anchored notes are matched last, by excerpt.
	 */
	resolve(file: string, candidates: readonly string[], excerpt?: string): Note | undefined {
		const inFile = this.all().filter(n => n.file === file);
		for (const candidate of candidates) {
			const match = inFile.find(n => n.symbol === candidate);
			if (match) {
				return match;
			}
		}
		if (excerpt) {
			const key = noteKeyFor(file, '', excerpt);
			return inFile.find(n => n.key === key);
		}
		return undefined;
	}
}
