/*---------------------------------------------------------------------------------------------
 *  Burrow: the "Claude Controls" hub — everything the four chips don't carry.
 *
 *  Reached from the gear in the chat input's status slot (`chat/input/status`, the one
 *  chat-input menu extensions may contribute to) and from the command palette. Shows the
 *  live value of every control for the active chat tab and drills into a picker or an
 *  input box per control.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	ControlState, EFFORT_DETAILS, EFFORT_LABELS, EFFORT_LEVELS, PERMISSION_DETAILS, PERMISSION_LABELS,
	PERMISSION_MODES, THINKING_DETAILS, THINKING_LABELS, THINKING_LEVELS, EffortLevel, PermissionMode,
	ThinkingLevel, splitArgs,
} from './controls';
import { ControlsStore } from './controlsStore';

interface Row extends vscode.QuickPickItem {
	readonly run?: (state: ControlState) => Promise<Partial<ControlState> | undefined>;
}

export function registerControlsUi(store: ControlsStore, activeSessionKey: () => Promise<string | undefined>): vscode.Disposable {
	return vscode.commands.registerCommand('burrow.chat.controls.open', async () => {
		const key = await activeSessionKey();
		for (;;) {
			const state = store.resolve(key);
			const picked = await vscode.window.showQuickPick(rows(state, store), {
				title: 'Claude Controls',
				placeHolder: 'These apply to this chat; settings supply the defaults for new chats',
				matchOnDescription: true,
			});
			if (!picked) { return; }
			if (!picked.run) { continue; }
			const change = await picked.run(state);
			if (change) { store.update(key, s => ({ ...s, ...change })); }
			if (picked.label === RESET_LABEL) { store.reset(key); return; }
			if (picked.label === SETTINGS_LABEL) { return; }
		}
	});
}

const RESET_LABEL = '$(discard) Reset this chat to defaults';
const SETTINGS_LABEL = '$(gear) Open Burrow Chat settings';

function rows(state: ControlState, store: ControlsStore): Row[] {
	return [
		{ label: 'Model', kind: vscode.QuickPickItemKind.Separator } as Row,
		enumRow('$(symbol-event) Effort', state.effort, EFFORT_LEVELS, EFFORT_LABELS, EFFORT_DETAILS,
			'Reasoning effort (--effort)', v => ({ effort: v as EffortLevel })),
		enumRow('$(lightbulb) Thinking', state.thinking, THINKING_LEVELS, THINKING_LABELS, THINKING_DETAILS,
			'Extended-thinking budget (MAX_THINKING_TOKENS)', v => ({ thinking: v as ThinkingLevel })),
		textRow('$(debug-step-over) Fallback model', state.fallbackModel, 'none',
			'Tried when the primary model is overloaded (--fallback-model)',
			'Comma-separated aliases, e.g. sonnet,haiku', v => ({ fallbackModel: v })),

		{ label: 'Permissions', kind: vscode.QuickPickItemKind.Separator } as Row,
		enumRow('$(shield) Permission mode', state.permissionMode, PERMISSION_MODES, PERMISSION_LABELS, PERMISSION_DETAILS,
			'How tool permissions are decided (--permission-mode)', v => ({ permissionMode: v as PermissionMode })),
		{
			label: '$(person) Agent',
			description: state.agent || 'default',
			detail: 'Agent definition for this chat (--agent)',
			run: async () => {
				const agents = store.discoverAgents();
				const pick = await vscode.window.showQuickPick(
					[{ label: 'default', description: "Claude Code's own agent setting" }, ...agents.map(a => ({ label: a, description: 'From .claude/agents' }))],
					{ title: 'Agent' });
				return pick ? { agent: pick.label === 'default' ? '' : pick.label } : undefined;
			},
		},

		{ label: 'Session', kind: vscode.QuickPickItemKind.Separator } as Row,
		textRow('$(tag) Session name', state.sessionName, 'unnamed',
			'Display name for the CLI session (--name)', 'A short name', v => ({ sessionName: v })),
		{
			label: '$(git-branch) Fork on next message',
			description: state.forkNext ? 'on' : 'off',
			detail: 'Branch to a new session id instead of continuing this one (--fork-session)',
			run: async () => ({ forkNext: !state.forkNext }),
		},
		numberRow('$(credit-card) Spend cap', state.maxBudgetUsd,
			'Stop the run past this many dollars (--max-budget-usd)', v => ({ maxBudgetUsd: v })),

		{ label: 'Prompt', kind: vscode.QuickPickItemKind.Separator } as Row,
		textRow('$(note) System prompt override', state.systemPrompt, "Claude Code's own",
			'Replaces the default system prompt entirely (--system-prompt)', 'Leave empty to keep the default', v => ({ systemPrompt: v })),
		textRow('$(add) Appended system prompt', state.appendSystemPrompt, 'none',
			"Added to the default system prompt (--append-system-prompt) — Burrow's IDE briefing lives here",
			'Leave empty to append nothing', v => ({ appendSystemPrompt: v })),

		{ label: 'Diagnostics', kind: vscode.QuickPickItemKind.Separator } as Row,
		textRow('$(debug) Debug', state.debug, 'off',
			'CLI debug logging (--debug); "true" for everything, or a filter like api,hooks',
			'true, or a category filter such as api,!file', v => ({ debug: v })),
		textRow('$(file) Debug log file', state.debugFile, 'none',
			'Write CLI debug logs here (--debug-file)', 'Absolute path', v => ({ debugFile: v })),
		{
			label: '$(terminal) Extra CLI arguments',
			description: state.extraArgs || 'none',
			detail: 'Appended verbatim to every run — the escape hatch for flags not listed above',
			run: async () => {
				const value = await vscode.window.showInputBox({
					title: 'Extra CLI arguments',
					prompt: 'Passed straight to the claude CLI. Quoted strings are honoured; nothing is validated.',
					value: state.extraArgs,
					validateInput: raw => {
						const parts = splitArgs(raw);
						return parts.some(p => p === '--bare') ? '--bare severs the CLI\'s OAuth login — chat would stop working.' : undefined;
					},
				});
				return value === undefined ? undefined : { extraArgs: value };
			},
		},

		{ label: '', kind: vscode.QuickPickItemKind.Separator } as Row,
		{ label: RESET_LABEL, detail: 'Drop this chat\'s overrides and follow the settings again', run: async () => undefined },
		{
			label: SETTINGS_LABEL,
			detail: 'Change the defaults every new chat starts from',
			run: async () => {
				await vscode.commands.executeCommand('workbench.action.openSettings', 'burrow.chat');
				return undefined;
			},
		},
	];
}

function enumRow<T extends string>(
	label: string,
	current: T,
	values: readonly T[],
	labels: Record<T, string>,
	details: Record<T, string>,
	detail: string,
	apply: (value: string) => Partial<ControlState>,
): Row {
	return {
		label,
		description: current,
		detail,
		run: async () => {
			const pick = await vscode.window.showQuickPick(
				values.map(v => ({ label: labels[v], description: v === current ? 'current' : undefined, detail: details[v], value: v })),
				{ title: label.replace(/^\$\([^)]+\)\s*/, '') });
			return pick ? apply(pick.value) : undefined;
		},
	};
}

function textRow(
	label: string,
	current: string,
	empty: string,
	detail: string,
	prompt: string,
	apply: (value: string) => Partial<ControlState>,
): Row {
	return {
		label,
		description: current ? truncate(current) : empty,
		detail,
		run: async () => {
			const value = await vscode.window.showInputBox({
				title: label.replace(/^\$\([^)]+\)\s*/, ''),
				prompt,
				value: current,
			});
			return value === undefined ? undefined : apply(value);
		},
	};
}

function numberRow(label: string, current: number, detail: string, apply: (value: number) => Partial<ControlState>): Row {
	return {
		label,
		description: current > 0 ? `$${current}` : 'uncapped',
		detail,
		run: async () => {
			const value = await vscode.window.showInputBox({
				title: label.replace(/^\$\([^)]+\)\s*/, ''),
				prompt: 'Dollars. 0 or empty for no cap.',
				value: current ? String(current) : '',
				validateInput: raw => (!raw.trim() || (Number.isFinite(Number(raw)) && Number(raw) >= 0)) ? undefined : 'Enter a non-negative number',
			});
			if (value === undefined) { return undefined; }
			return apply(value.trim() ? Number(value) : 0);
		},
	};
}

function truncate(s: string): string {
	return s.length > 48 ? s.slice(0, 48) + '…' : s;
}
