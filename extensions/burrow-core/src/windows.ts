/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, ExtensionContext, commands } from 'vscode';

// Pop out / dock (user request 2026-08-06; core half in patches/0016).
//
// Every Burrow tool surface is a webview editor, and several of them want a
// second monitor. The workbench already moves an editor into an auxiliary
// (floating) window; patch 0016 adds the per-editor way back. This module is
// the extension-side half: one pair of commands and one registry, so nine
// surfaces cost one line each instead of nine command pairs.
//
// The design leans on one workbench fact: `isAuxiliaryWindow` is bound on the
// *part-scoped* context key service, so an `editor/title` `when` clause can name
// it and it evaluates true only in the floating window's title bar. That is what
// lets Pop Out and Dock be static menu entries rather than a stateful toggle the
// extension host has to track. (It could not track it anyway:
// `WebviewPanel.viewColumn` cannot distinguish a floating editor from an
// ordinary split — see the patch entry.)
//
// Only Pop Out's BUTTON is contributed here. Dock's is contributed by the core
// action, because an extension-contributed `editor/title` item does not execute
// when clicked in an auxiliary window — measured, and true of the pre-existing
// `burrow.focus.toggle` button too. `burrow.window.dock` survives as a palette
// entry. The registry below is what core's `when` clause reads.
//
// Tool extensions reach the API via
//   extensions.getExtension('burrow.burrow-core')?.exports.windows

/** Context key holding every viewType that opted in; read by the two `editor/title` `when` clauses. */
const DETACHABLE_KEY = 'burrow.window.detachable';

const MOVE_TO_NEW_WINDOW = 'workbench.action.moveEditorToNewWindow';
const MOVE_TO_MAIN_WINDOW = 'workbench.action.moveEditorToMainWindow'; // patches/0016

export interface BurrowWindowsApi {
	/**
	 * Opt a webview panel viewType into the Pop Out / Dock title-bar buttons.
	 * Call once per surface at activation; re-registering is a no-op. Returns a
	 * Disposable that withdraws it (the buttons stop appearing; anything already
	 * floating stays where it is).
	 */
	detachable(viewType: string): Disposable;
}

export function createWindowsApi(context: ExtensionContext): BurrowWindowsApi {
	const detachableTypes = new Set<string>();

	const publish = () => void commands.executeCommand('setContext', DETACHABLE_KEY, [...detachableTypes]);

	context.subscriptions.push(
		// Neither command takes arguments. The workbench action resolves the
		// ACTIVE editor, which is exactly the one whose title bar hosts the
		// button — so no WebviewPanel reference ever crosses the extension
		// boundary and burrow-core never has to know who owns the surface.
		commands.registerCommand('burrow.window.popOut', () => commands.executeCommand(MOVE_TO_NEW_WINDOW)),
		// Kept as a palette entry only. Its title-bar button is contributed by the
		// core action instead — an extension-contributed `editor/title` item does
		// not fire when clicked in an auxiliary window (measured; see patches/0016).
		commands.registerCommand('burrow.window.dock', () => commands.executeCommand(MOVE_TO_MAIN_WINDOW)),
		new Disposable(() => {
			detachableTypes.clear();
			void publish();
		}),
	);

	publish();

	return {
		detachable: (viewType: string) => {
			detachableTypes.add(viewType);
			publish();
			return new Disposable(() => {
				detachableTypes.delete(viewType);
				publish();
			});
		},
	};
}
