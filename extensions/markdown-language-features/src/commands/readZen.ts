/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Command } from '../commandManager';

/**
 * Distraction-free reading: ensure the markdown file is showing as a rendered
 * preview, then toggle the workbench's Zen Mode (full screen, centered layout —
 * tuned via burrow-core's zenMode.* configuration defaults). `Esc Esc` exits.
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
		await vscode.commands.executeCommand('workbench.action.toggleZenMode');
	}
}
