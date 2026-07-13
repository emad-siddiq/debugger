/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, commands, window, version as vscodeVersion } from 'vscode';

// burrow-core is the first built-in extension (layer 4 of the fork strategy).
// For task 01 it exists only to prove the built-in path: it compiles in the
// product build, activates on startup, and contributes one visible command.
// Later Burrow services (selection follow, oracle, shared UI) land here or in
// sibling burrow-* extensions.

export function activate(context: ExtensionContext): void {
	context.subscriptions.push(
		commands.registerCommand('burrow.about', () => {
			const ext = context.extension.packageJSON.version;
			void window.showInformationMessage(
				`Burrow — Go IDE · burrow-core ${ext} · editor base ${vscodeVersion}`,
			);
		}),
	);
}

export function deactivate(): void {
	// nothing yet
}
