/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// refactor.ts — one list of every refactoring available where the cursor is.
//
// Burrow's architecture set contains exactly one sentence about refactoring, and
// it is a deferral: 16-code-navigation.md's out-of-scope list says "Editing/
// refactoring from the palette (rename, move) — task for gopls code actions, not
// navigation." Read literally that is right, and it left the fork with no
// refactoring surface at all.
//
// But gopls implements nearly the whole IntelliJ list already — extract
// function/method/variable, extract to new file, inline call, inline variable,
// remove unused parameter, move parameter left/right, fill struct, fill switch,
// invert if, split/join lines, add/remove struct tags, stub missing interface
// methods, create missing declaration, add test for function. Every one of them
// arrives as a code action, which means every one of them is behind a lightbulb
// the reader has to notice, on a line they have to be standing on, with no way to
// ask "what can I do to this?"
//
// So this is not a re-implementation of anything. It is a door: run the code
// action provider over the selection, keep the refactoring kinds, and show them
// in one list on one key. The refactorings are gopls'; the discoverability is the
// part that was missing.
//
// Deliberately NOT filtered to Go. It reads through the workbench's own provider,
// so it works wherever a provider does — the TypeScript half of this fork
// included.

import {
	CodeAction,
	QuickPickItem,
	Range,
	WorkspaceEdit,
	commands,
	window,
	workspace,
} from 'vscode';
import { GROUP_ORDER, groupFor } from './refactorKinds';

/** The command id, bound to ⌃T — IntelliJ's "Refactor This". */
export const REFACTOR_COMMAND = 'burrow.refactor.here';

interface ActionItem extends QuickPickItem {
	readonly action: CodeAction;
}

/** Registers the command; returns the disposable for the caller to track. */
export function registerRefactorCommand() {
	return commands.registerCommand(REFACTOR_COMMAND, refactorHere);
}

async function refactorHere(): Promise<void> {
	const editor = window.activeTextEditor;
	if (!editor) {
		void window.showInformationMessage('Refactor: no active editor.');
		return;
	}

	// An empty selection is the common case — the cursor sits in an identifier and
	// the reader wants what applies to it. Providers key off the range, so a
	// zero-width one at the cursor is exactly the right question to ask.
	const range: Range = editor.selection.isEmpty
		? new Range(editor.selection.active, editor.selection.active)
		: new Range(editor.selection.start, editor.selection.end);

	const actions = await commands.executeCommand<CodeAction[]>(
		'vscode.executeCodeActionProvider',
		editor.document.uri,
		range,
	) ?? [];

	const items: ActionItem[] = [];
	const seen = new Set<string>();
	for (const group of GROUP_ORDER) {
		for (const action of actions) {
			if (groupFor(action.kind?.value) !== group) {
				continue;
			}
			// A provider can offer the same title under two kinds; the first grouping
			// wins so the list has no duplicate rows.
			if (seen.has(action.title)) {
				continue;
			}
			seen.add(action.title);
			items.push({
				label: action.title,
				description: group,
				detail: action.disabled?.reason ? `$(circle-slash) ${action.disabled.reason}` : undefined,
				action,
			});
		}
	}

	if (items.length === 0) {
		// Say which of the two it is. "Nothing available" over a selection that a
		// reader believes is extractable is the moment a tool loses their trust.
		const anyProvider = actions.length > 0;
		void window.showInformationMessage(
			anyProvider
				? 'Nothing to refactor here — the actions available at this position are not refactorings.'
				: 'Nothing to refactor here. Try selecting a whole statement or expression.',
		);
		return;
	}

	const chosen = await window.showQuickPick(items, {
		title: 'Refactor',
		placeHolder: `${items.length} available at the cursor`,
		matchOnDescription: true,
	});
	if (!chosen) {
		return;
	}
	if (chosen.action.disabled) {
		void window.showInformationMessage(chosen.action.disabled.reason);
		return;
	}
	await apply(chosen.action);
}

/**
 * Applies a chosen action: its edit first, then its command.
 *
 * Order matters and the API does not enforce it — an action may carry both, and
 * gopls' extract actions in particular resolve to a command that computes the
 * edit. Running the command first would apply an edit against a document the
 * action's own edit has not yet touched.
 */
async function apply(action: CodeAction): Promise<void> {
	const edit: WorkspaceEdit | undefined = action.edit;
	if (edit) {
		const ok = await workspace.applyEdit(edit);
		if (!ok) {
			void window.showWarningMessage(`"${action.title}" could not be applied to the document.`);
			return;
		}
	}
	if (action.command) {
		await commands.executeCommand(action.command.command, ...(action.command.arguments ?? []));
	}
}
