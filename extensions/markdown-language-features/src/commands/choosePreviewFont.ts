/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Command } from '../commandManager';

interface FontQuickPickItem extends vscode.QuickPickItem {
	readonly fontFamily?: string;
	readonly isCustom?: boolean;
	readonly isReset?: boolean;
}

/**
 * Curated system-font stacks for the markdown preview — no bundled font files,
 * each stack resolves to a good face on macOS / Windows / Linux.
 */
const fontPresets: ReadonlyArray<FontQuickPickItem> = [
	{
		label: vscode.l10n.t("Sans"),
		description: 'SF Pro · Segoe UI · system-ui',
		fontFamily: "-apple-system, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif",
	},
	{
		label: vscode.l10n.t("Serif"),
		description: 'Charter · Iowan Old Style · Georgia',
		fontFamily: "Charter, 'Iowan Old Style', Georgia, 'Times New Roman', serif",
	},
	{
		label: vscode.l10n.t("Humanist"),
		description: 'Seravek · Gill Sans Nova · Ubuntu · Verdana',
		fontFamily: "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, Verdana, sans-serif",
	},
];

export class ChoosePreviewFontCommand implements Command {
	public readonly id = 'markdown.choosePreviewFont';

	public async execute() {
		const config = vscode.workspace.getConfiguration('markdown');
		const current = config.get<string>('preview.fontFamily');

		const items: FontQuickPickItem[] = [
			...fontPresets.map(preset => ({
				...preset,
				picked: preset.fontFamily === current,
			})),
			{ label: vscode.l10n.t("Custom…"), description: vscode.l10n.t("Enter a font family"), isCustom: true },
			{ label: vscode.l10n.t("Reset to Default"), isReset: true },
		];

		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: vscode.l10n.t("Choose the markdown preview font"),
		});
		if (!picked) {
			return;
		}

		let fontFamily = picked.fontFamily;
		if (picked.isCustom) {
			fontFamily = await vscode.window.showInputBox({
				prompt: vscode.l10n.t("Font family for the markdown preview (CSS font-family value)"),
				value: current,
			});
			if (!fontFamily) {
				return;
			}
		}

		await config.update('preview.fontFamily', picked.isReset ? undefined : fontFamily, vscode.ConfigurationTarget.Global);
	}
}
