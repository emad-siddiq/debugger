/*---------------------------------------------------------------------------------------------
 *  Burrow Chat — Claude Code behind the stock chat panel.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ControlsStore } from './controlsStore';
import { registerControlsUi } from './controlsUi';
import { ClaudeModelProvider } from './modelProvider';
import { BurrowChatParticipant } from './participant';

export function activate(context: vscode.ExtensionContext): void {
	const controls = new ControlsStore(context);
	context.subscriptions.push(...controls.register());
	const participant = new BurrowChatParticipant(context, controls);
	context.subscriptions.push(participant.register());
	context.subscriptions.push(registerControlsUi(controls, () => activeSessionKey(participant)));
	// Seed the chat-input chips; without the core chip host this is a no-op.
	void controls.publish();
	// Vendor id 'copilot' is this fork's "first-party model provider" slot: the
	// renderer hard-codes the default-model vendor (languageModels.ts
	// COPILOT_VENDOR_ID) in its descriptor, picker and ext-host default lookups.
	// Any other id would need core patches in five places for zero user-visible
	// difference — the id never renders, the displayName does.
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('copilot', new ClaudeModelProvider()));

	// The picker renders a "sign in" placeholder until some request resolves the
	// vendor's models — which otherwise first happens on the first chat submit.
	// Resolving eagerly makes the models live at boot; the list is static, so
	// this spawns nothing and touches no network.
	void vscode.lm.selectChatModels({ vendor: 'copilot' }).then(undefined, () => { /* picker stays lazy */ });

	context.subscriptions.push(vscode.commands.registerCommand('burrow.chat.explainSelection', () => openChatWithSelection('/explain this selection')));
	context.subscriptions.push(vscode.commands.registerCommand('burrow.chat.fixSelection', () => openChatWithSelection('/fix this selection')));
}

/**
 * Which chat tab the controls hub should edit. The core chip host knows the focused
 * chat widget's session resource; without it (or before the first message) fall back to
 * the last tab the participant served.
 */
async function activeSessionKey(participant: BurrowChatParticipant): Promise<string | undefined> {
	try {
		const key = await vscode.commands.executeCommand<string | undefined>('burrow.chat.controls.activeSession');
		if (key) { return key; }
	} catch {
		// no core chip host in this build
	}
	return participant.lastSessionKey();
}

async function openChatWithSelection(query: string): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		await vscode.commands.executeCommand('workbench.action.chat.open', { query, mode: 'agent' });
		return;
	}
	const selection = editor.selection;
	const range = selection.isEmpty ? undefined : {
		startLineNumber: selection.start.line + 1,
		startColumn: selection.start.character + 1,
		endLineNumber: selection.end.line + 1,
		endColumn: selection.end.character + 1,
	};
	await vscode.commands.executeCommand('workbench.action.chat.open', {
		query,
		mode: 'agent',
		attachFiles: [range ? { uri: editor.document.uri, range } : editor.document.uri],
	});
}
