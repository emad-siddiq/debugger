/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, commands, window, version as vscodeVersion } from 'vscode';
import { BurrowToolsApi, createToolsApi } from './tools';
import { BurrowWindowsApi, createWindowsApi } from './windows';

// burrow-core is the first built-in extension (layer 4 of the fork strategy).
// For task 01 it exists only to prove the built-in path: it compiles in the
// product build, activates on startup, and contributes one visible command.
// Later Burrow services (selection follow, oracle, shared UI) land here or in
// sibling burrow-* extensions.

/** burrow-core's cross-extension API surface (reach via `extensions.getExtension('burrow.burrow-core')?.exports`). */
export interface BurrowCoreApi {
	/** Tool-surface isolation registry — see ./tools.ts (docs/plans/02 §6). */
	readonly tools: BurrowToolsApi;
	/** Pop out / dock registry for tool surfaces — see ./windows.ts (patches/0016). */
	readonly windows: BurrowWindowsApi;
}

export function activate(context: ExtensionContext): BurrowCoreApi {
	context.subscriptions.push(
		commands.registerCommand('burrow.about', () => {
			const ext = context.extension.packageJSON.version;
			void window.showInformationMessage(
				`Burrow — Go IDE · burrow-core ${ext} · editor base ${vscodeVersion}`,
			);
		}),
		// Focus Mode = tuned Zen Mode (docs/plans/01 §4). One named command so every
		// surface (editor title bar, tool webviews, keybinding) drives the same toggle
		// and Esc exits via the same path. State is workbench-owned; we only toggle it.
		commands.registerCommand('burrow.focus.toggle', () =>
			commands.executeCommand('workbench.action.toggleZenMode'),
		),
		// The one exit (docs/plans/01 §4, WO-04). A webview iframe swallows Esc
		// before the workbench ever sees it, so every Burrow webview posts the
		// keystroke back to its extension host and lands here instead of each
		// tool inventing its own way out. Unconditional by design: the workbench
		// command tests the zen context itself and is a no-op outside Focus Mode,
		// so callers never have to know which mode they are in.
		commands.registerCommand('burrow.focus.exit', () =>
			commands.executeCommand('workbench.action.exitZenMode'),
		),
	);
	return { tools: createToolsApi(context), windows: createWindowsApi(context) };
}

export function deactivate(): void {
	// nothing yet
}
