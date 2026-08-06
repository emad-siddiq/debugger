/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// browse.ts — the door onto gopls' web views. One key asks "what can I read
// about this?", the same way ⌃T asks "what can I do to this?".
//
// Running the chosen action sends gopls a `workspace/executeCommand`, which makes
// gopls answer with `window/showDocument` — intercepted in burrow-go-base and
// routed into the panel next door. Nothing here opens anything itself; that
// separation is what lets the lightbulb path and this path land in the same place.

import {
	CodeAction,
	QuickPickItem,
	Range,
	commands,
	window,
} from 'vscode';
import { browseOffers } from './webActions';

/**
 * The command id, bound to ⇧F1 — IntelliJ's "External Documentation", next to
 * ⇧⌘0's offline reader.
 *
 * It was ⌥⌘D first, which was wrong and only showed up in the running app:
 * burrow-core already binds `cmd+alt+d` to `burrow.agent.toggle` with **no
 * `when` clause**, so it wins in every context and this command's binding was
 * registered, listed in the default-keybindings dump, and never once reachable.
 * A grep for `"alt+cmd+d"` finds nothing — core spells it `cmd+alt+d` — which is
 * exactly why the check that caught it was pressing the key rather than reading
 * a manifest.
 */
export const BROWSE_COMMAND = 'burrow.goDocs.browse';

interface OfferItem extends QuickPickItem {
	/** The action to run, or undefined for a row that is listed but not available. */
	readonly action: CodeAction | undefined;
}

/** Registers the command; returns the disposable for the caller to track. */
export function registerBrowseCommand() {
	return commands.registerCommand(BROWSE_COMMAND, browseHere);
}

async function browseHere(): Promise<void> {
	const editor = window.activeTextEditor;
	if (!editor) {
		void window.showInformationMessage('Browse: no active editor.');
		return;
	}

	// An empty selection is the common case — the cursor is in an identifier and
	// the reader wants to read about it. `source.freesymbols` is the exception: it
	// describes a *region*, so it only appears when something is selected, and the
	// list says so rather than leaving it mysteriously absent.
	const range: Range = editor.selection.isEmpty
		? new Range(editor.selection.active, editor.selection.active)
		: new Range(editor.selection.start, editor.selection.end);

	const actions = await commands.executeCommand<CodeAction[]>(
		'vscode.executeCodeActionProvider',
		editor.document.uri,
		range,
	) ?? [];

	// Flatten to plain strings for the pure module: a CodeActionKind is an object,
	// and webActions.ts stays importable by the standalone tests.
	const offers = browseOffers(actions.map(a => ({ kind: a.kind?.value, title: a.title })));
	if (offers.length === 0) {
		void window.showInformationMessage(
			actions.length > 0
				? 'Nothing to browse here — gopls offers no documentation view at this position.'
				: 'Nothing to browse here. Put the cursor on a package, type or function.',
		);
		return;
	}

	const items: OfferItem[] = offers.map(offer => ({
		label: offer.label,
		description: offer.detail,
		action: actions[offer.index],
	}));
	if (editor.selection.isEmpty && !offers.some(o => o.label === 'Free Symbols')) {
		// Grey-with-a-reason rather than a shorter list: a reader who has heard of
		// free symbols should be told why they cannot see them here, not left to
		// wonder whether Burrow has the feature at all.
		items.push({
			label: '$(circle-slash) Free Symbols',
			description: 'Select a region first — it describes what a selection uses from outside it',
			action: undefined,
		});
	}

	const chosen = await window.showQuickPick(items, {
		title: 'Browse',
		placeHolder: 'gopls renders these itself; they open in a Burrow panel',
		matchOnDescription: true,
	});
	if (!chosen) {
		return;
	}
	if (!chosen.action) {
		void window.showInformationMessage(chosen.description ?? 'Not available here.');
		return;
	}
	const command = chosen.action.command;
	if (!command) {
		// gopls' web actions are commands, not edits. One that arrives without a
		// command has nothing to run, and saying so beats a silent no-op.
		void window.showWarningMessage(`"${chosen.action.title}" carries no command to run.`);
		return;
	}
	await commands.executeCommand(command.command, ...(command.arguments ?? []));
}
