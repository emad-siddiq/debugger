/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PanelSizer } from './layout';
import { AgentPanel } from './panel';
import { SessionStore } from './sessions';

// burrow-agent — the right-hand agent panel (docs/plans/03). Phase A was the
// panel, the CLI transport, sessions and the size states; phases B–E added the
// context envelope with its chips, the repo-memory rows, automatic insight
// cards, and proposals that arrive as diffs and only reach disk on Apply.
//
// It talks to the developer's own Claude Code CLI, spawned in the workspace, so
// their account is the only credential and the workspace's CLAUDE.md and skills
// are picked up by the CLI itself. Nothing here reaches the network directly,
// and nothing here writes to disk: the CLI runs in plan mode with the editing
// tools denied (src/protocol.ts), so "advisory" is enforced rather than
// promised. Close the panel and Burrow is exactly the IDE it was.

export function activate(context: vscode.ExtensionContext): void {
	const sessions = new SessionStore(context.workspaceState);
	const sizer = new PanelSizer();
	const panel = new AgentPanel(context, sessions, sizer);

	context.subscriptions.push(
		panel,
		vscode.window.registerWebviewViewProvider(AgentPanel.viewId, panel, {
			// The transcript survives being hidden; re-rendering it from state on
			// every reveal would also lose the scroll position mid-conversation.
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand('burrow.agent.toggle', () => panel.toggle()),
		vscode.commands.registerCommand('burrow.agent.newSession', () => panel.newSession()),
		vscode.commands.registerCommand('burrow.agent.cycleSize', () => sizer.cycle()),
		vscode.commands.registerCommand('burrow.agent.stop', () => panel.stop()),
		vscode.commands.registerCommand('burrow.agent.showContext', () => panel.showContextCommand()),
		vscode.commands.registerCommand('burrow.agent.explainSelection', () => panel.explainSelection()),
		vscode.commands.registerCommand('burrow.agent.toggleInsights', () => panel.toggleInsights()),
	);
}

export function deactivate(): void {
	// Child CLIs are disposed through the panel's subscription — nothing may
	// outlive the window.
}
