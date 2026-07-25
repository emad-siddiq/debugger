/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// findEverywhere.ts — the ONE search entry point (plan 01 §3, WO-02).
//
// Burrow deleted the Command Center in WO-01, so the Search view is the only
// persistent search *bar* left. This file makes it the only search *doorway*
// too: `burrow.find.everywhere` (⇧⌘F) opens it focused, and two sibling
// commands render as Files · Symbols buttons in that view's own title bar, so
// the three modes read as one segmented control instead of three unrelated
// palettes the user has to remember keystrokes for.
//
// Files and Symbols deliberately delegate rather than reimplement — Quick Open
// and `burrow.nav.goToSymbol` are already the right surfaces; what was missing
// was a place that says so. Nothing here is Go-specific; it lives in
// burrow-go-nav because that extension already owns ⌥⌘O and the symbol index
// (plan 01 §3, WO-02's named files).

import { Disposable, commands, window } from 'vscode';
import { seedFromSelection } from './seed';

/** Register the three find commands. Disposed with the extension. */
export function registerFindCommands(): Disposable[] {
	return [
		commands.registerCommand('burrow.find.everywhere', findEverywhere),
		commands.registerCommand('burrow.find.files', () =>
			commands.executeCommand('workbench.action.quickOpen')),
		commands.registerCommand('burrow.find.symbols', () =>
			commands.executeCommand('burrow.nav.goToSymbol')),
	];
}

/**
 * Open the Search view, focused, on the best available query.
 *
 * With a selection we seed it and run the search immediately — ⇧⌘F on a
 * highlighted identifier should show hits, not an empty box that happens to
 * contain the right text. With no selection we hand off to the stock command,
 * which already seeds from the find widget or the nearest word and focuses the
 * input; re-implementing that would only make the two paths drift.
 */
async function findEverywhere(): Promise<void> {
	const editor = window.activeTextEditor;
	const seed = editor
		? seedFromSelection(editor.selection, editor.document.getText(editor.selection))
		: undefined;
	if (seed) {
		await commands.executeCommand('workbench.action.findInFiles', { query: seed, triggerSearch: true });
	} else {
		await commands.executeCommand('workbench.action.findInFiles');
	}
}
