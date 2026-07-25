/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Command } from '../commandManager';

/**
 * Distraction-free reading: ensure the markdown file is showing as a rendered
 * preview, then enter Focus Mode.
 *
 * Burrow keeps exactly one Focus implementation (docs/plans/01 §5) — this
 * delegates to `burrow.focus.toggle` rather than calling `toggleZenMode`
 * itself, so ⌘K R and the ⛶ button land in the same state and single-Esc
 * leaves it. Falls back to the workbench command when burrow-core is absent,
 * which keeps ⌘K R working in a plain Code - OSS build of this extension.
 */
export class ReadZenCommand implements Command {
	public readonly id = 'markdown.readZen';

	public async execute(uri?: vscode.Uri) {
		if (uri) {
			// Invoked from a resource context menu (explorer / editor tab)
			await vscode.commands.executeCommand('vscode.openWith', uri, 'vscode.markdown.preview.editor');
		} else if (vscode.window.activeTextEditor) {
			await vscode.commands.executeCommand('reopenActiveEditorWith', 'vscode.markdown.preview.editor');
		}
		const focus = (await vscode.commands.getCommands(true)).includes('burrow.focus.toggle')
			? 'burrow.focus.toggle'
			: 'workbench.action.toggleZenMode';
		await vscode.commands.executeCommand(focus);
	}
}
