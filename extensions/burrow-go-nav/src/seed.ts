/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// seed.ts — what ⇧⌘F should put in the search box (plan 01 §3, WO-02).
//
// Imports nothing from 'vscode' so out/seed.js is a clean CommonJS module the
// unit test requires directly — same arrangement as query.ts.

/** The shape of a `vscode.Selection` this module actually needs. */
export interface SeedSelection {
	readonly isEmpty: boolean;
	readonly start: { readonly line: number };
	readonly end: { readonly line: number };
}

/** Longest selection we will seed with — past this it is prose, not a search
 *  term, and running a search over it produces noise rather than hits. */
export const MAX_SEED_LENGTH = 200;

/**
 * The search term a selection implies, or `undefined` when it implies none.
 *
 * Rejects multi-line selections: the search box is a single-line control, so a
 * seeded newline searches for something the user cannot see in the box.
 * `undefined` is not a failure — it means "let the stock command seed itself
 * from the find widget or the nearest word", which it already does well.
 */
export function seedFromSelection(selection: SeedSelection | undefined, selectedText: string): string | undefined {
	if (!selection || selection.isEmpty || selection.start.line !== selection.end.line) {
		return undefined;
	}
	const text = selectedText.trim();
	if (!text || text.length > MAX_SEED_LENGTH) {
		return undefined;
	}
	return text;
}
