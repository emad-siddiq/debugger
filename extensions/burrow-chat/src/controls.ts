/*---------------------------------------------------------------------------------------------
 *  Burrow: the Claude Code control surface — everything the chat panel can set on a run.
 *
 *  This module is PURE (no vscode import) so the argv/env mapping is unit-testable
 *  from plain node, the way packModel.ts is. Anything that touches the workbench —
 *  persistence, the chip publish, the quick-pick hub — lives in controlsStore.ts /
 *  controlsUi.ts.
 *
 *  Every turn is a fresh `claude` process (see session.ts), so every control is just
 *  argv or env at spawn time; nothing here needs the CLI's set_model /
 *  set_permission_mode control-requests.
 *
 *  Wire verified against claude 2.1.216 (`claude --help`):
 *    --effort <low|medium|high|xhigh|max>
 *    --permission-mode <manual|acceptEdits|plan|auto|dontAsk|bypassPermissions>
 *    --agent, --fallback-model, --max-budget-usd, --fork-session, -n/--name,
 *    --system-prompt, --append-system-prompt, --debug [filter], --debug-file
 *  Thinking has NO flag: the knobs are the MAX_THINKING_TOKENS and
 *  DISABLE_INTERLEAVED_THINKING environment variables.
 *--------------------------------------------------------------------------------------------*/

/** Whether the stdio approvals bridge asks the user, or auto-allows. */
export type PermissionPolicy = 'ask' | 'allowAll';

export type EffortLevel = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ThinkingLevel = 'auto' | 'off' | 'think' | 'megathink' | 'ultrathink';
/** 'approvals' is Burrow's own: follow the chat input's Approvals control, pass no flag. */
export type PermissionMode = 'approvals' | 'manual' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';

export interface ControlState {
	readonly effort: EffortLevel;
	readonly thinking: ThinkingLevel;
	readonly permissionMode: PermissionMode;
	/** `--agent`; '' = the CLI's own `agent` setting. */
	readonly agent: string;
	/** `--fallback-model`; comma-separated list allowed. */
	readonly fallbackModel: string;
	/** `--max-budget-usd`; 0 = uncapped. */
	readonly maxBudgetUsd: number;
	/** `-n/--name`; '' = unnamed. */
	readonly sessionName: string;
	/** `--fork-session` — one-shot, cleared once it has ridden a turn. */
	readonly forkNext: boolean;
	/** `--system-prompt`; '' = keep Claude Code's own default system prompt. */
	readonly systemPrompt: string;
	/** `--append-system-prompt`; '' = no append (DEFAULT_APPEND_SYSTEM_PROMPT is the setting default). */
	readonly appendSystemPrompt: string;
	/** `--debug`; '' = off, 'true' = unfiltered, anything else is the category filter. */
	readonly debug: string;
	/** `--debug-file`. */
	readonly debugFile: string;
	/** Raw extra flags, shell-split. The escape hatch for anything not modelled here. */
	readonly extraArgs: string;
}

/** What the participant has always appended; now the default value of a control. */
export const DEFAULT_APPEND_SYSTEM_PROMPT =
	'You are the assistant inside Burrow, a Go-focused IDE. Chat attachments arrive as workspace-relative paths ' +
	'(with 1-based line ranges for selections); read them with your tools before answering. A context_pack block ' +
	'lists the artifact the user is focused on and its immediate repo relationships as workspace-relative paths; ' +
	'treat it as a map — answer from it directly when it suffices, and open the listed files with your tools when ' +
	'you need contents.';

export const DEFAULT_CONTROLS: ControlState = {
	effort: 'default',
	thinking: 'auto',
	permissionMode: 'approvals',
	agent: '',
	fallbackModel: '',
	maxBudgetUsd: 0,
	sessionName: '',
	forkNext: false,
	systemPrompt: '',
	appendSystemPrompt: DEFAULT_APPEND_SYSTEM_PROMPT,
	debug: '',
	debugFile: '',
	extraArgs: '',
};

/** Budgets behind the thinking levels. `auto` sets nothing and lets the CLI decide. */
export const THINKING_TOKENS: Record<Exclude<ThinkingLevel, 'auto'>, number> = {
	off: 0,
	think: 4000,
	megathink: 10000,
	ultrathink: 31999,
};

export const EFFORT_LEVELS: readonly EffortLevel[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['auto', 'off', 'think', 'megathink', 'ultrathink'];
export const PERMISSION_MODES: readonly PermissionMode[] = ['approvals', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];

export const EFFORT_LABELS: Record<EffortLevel, string> = {
	default: 'Effort: default',
	low: 'Effort: low',
	medium: 'Effort: medium',
	high: 'Effort: high',
	xhigh: 'Effort: xhigh',
	max: 'Effort: max',
};

export const THINKING_LABELS: Record<ThinkingLevel, string> = {
	auto: 'Thinking: auto',
	off: 'Thinking: off',
	think: 'Thinking: think',
	megathink: 'Thinking: hard',
	ultrathink: 'Thinking: ultra',
};

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
	approvals: 'Approvals: chat',
	manual: 'Approvals: manual',
	acceptEdits: 'Approvals: edits',
	plan: 'Plan mode',
	auto: 'Approvals: auto',
	dontAsk: "Approvals: don't ask",
	bypassPermissions: 'Approvals: bypass',
};

export const EFFORT_DETAILS: Record<EffortLevel, string> = {
	default: "Whatever your Claude Code is configured to use",
	low: 'Fastest, least reasoning',
	medium: 'Balanced',
	high: 'More reasoning per turn',
	xhigh: 'Substantially more reasoning',
	max: 'Maximum reasoning, slowest',
};

export const THINKING_DETAILS: Record<ThinkingLevel, string> = {
	auto: 'Let Claude Code decide the thinking budget',
	off: 'No extended thinking (MAX_THINKING_TOKENS=0)',
	think: '4,000 thinking tokens',
	megathink: '10,000 thinking tokens',
	ultrathink: '31,999 thinking tokens',
};

export const PERMISSION_DETAILS: Record<PermissionMode, string> = {
	approvals: "Follow the chat input's Approvals control",
	manual: 'Ask in chat before every tool use',
	acceptEdits: 'Auto-accept file edits; ask for everything else',
	plan: 'Read-only analysis — no edits, no commands',
	auto: "Claude Code's auto mode classifier decides",
	dontAsk: 'Never ask; proceed without approvals',
	bypassPermissions: 'Bypass all permission checks',
};

/**
 * How a permission mode drives the stdio approvals bridge. Modes that still want a
 * human in the loop stay 'ask' so `can_use_tool` keeps surfacing as a chat
 * confirmation; the two that mean "stop asking" auto-allow.
 */
export function policyFor(mode: PermissionMode, chatPermissionLevel: string | undefined): PermissionPolicy {
	switch (mode) {
		case 'dontAsk':
		case 'bypassPermissions':
			return 'allowAll';
		case 'approvals':
			return chatPermissionLevel === 'autoApprove' || chatPermissionLevel === 'autopilot' ? 'allowAll' : 'ask';
		default:
			return 'ask';
	}
}

export interface TurnWire {
	/** Control-derived argv, appended after the fixed protocol flags. */
	readonly args: string[];
	/** Environment overlay applied on top of the inherited (scrubbed) env. */
	readonly env: Record<string, string>;
}

/**
 * The whole control surface as argv + env. `model` is the chat input's model picker
 * (a CLI alias such as 'opus'), which is not part of the per-session control state.
 */
export function buildTurn(state: ControlState, model?: string): TurnWire {
	const args: string[] = [];
	const env: Record<string, string> = {};

	if (model) { args.push('--model', model); }
	if (state.permissionMode !== 'approvals') { args.push('--permission-mode', state.permissionMode); }
	if (state.effort !== 'default') { args.push('--effort', state.effort); }
	if (state.agent.trim()) { args.push('--agent', state.agent.trim()); }
	if (state.fallbackModel.trim()) { args.push('--fallback-model', state.fallbackModel.trim()); }
	if (state.maxBudgetUsd > 0) { args.push('--max-budget-usd', String(state.maxBudgetUsd)); }
	if (state.sessionName.trim()) { args.push('--name', state.sessionName.trim()); }
	if (state.forkNext) { args.push('--fork-session'); }
	if (state.systemPrompt.trim()) { args.push('--system-prompt', state.systemPrompt.trim()); }
	if (state.appendSystemPrompt.trim()) { args.push('--append-system-prompt', state.appendSystemPrompt.trim()); }
	if (state.debug.trim()) {
		args.push('--debug');
		if (state.debug.trim() !== 'true') { args.push(state.debug.trim()); }
	}
	if (state.debugFile.trim()) { args.push('--debug-file', state.debugFile.trim()); }
	args.push(...splitArgs(state.extraArgs));

	if (state.thinking !== 'auto') {
		env['MAX_THINKING_TOKENS'] = String(THINKING_TOKENS[state.thinking]);
		if (state.thinking === 'off') { env['DISABLE_INTERLEAVED_THINKING'] = '1'; }
	}

	return { args, env };
}

/**
 * Split a raw flag string the way a shell would, honouring single and double quotes.
 * Deliberately minimal: no expansion, no escapes beyond `\"` inside double quotes.
 */
export function splitArgs(raw: string): string[] {
	const out: string[] = [];
	let cur = '';
	let quote: '"' | '\'' | undefined;
	let started = false;
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (quote) {
			if (c === quote) { quote = undefined; }
			else if (c === '\\' && quote === '"' && i + 1 < raw.length) { cur += raw[++i]; }
			else { cur += c; }
			continue;
		}
		if (c === '"' || c === '\'') { quote = c; started = true; continue; }
		if (/\s/.test(c)) {
			if (started) { out.push(cur); cur = ''; started = false; }
			continue;
		}
		cur += c;
		started = true;
	}
	if (started) { out.push(cur); }
	return out;
}

// --- chip groups -------------------------------------------------------------------------------

export interface ControlChipItem {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
}

export interface ControlChipGroup {
	readonly id: string;
	/** The chip's live label — what the user reads without opening it. */
	readonly label: string;
	/** The same state in as few characters as possible, for a narrow chat panel. */
	readonly shortLabel: string;
	readonly tooltip: string;
	readonly selected: string;
	readonly items: ControlChipItem[];
}

export const CHIP_GROUP_IDS = ['effort', 'thinking', 'permissionMode', 'agent'] as const;
export type ChipGroupId = typeof CHIP_GROUP_IDS[number];

/** The four chips under the chat input, rendered from the state of one chat tab. */
export function chipGroups(state: ControlState, agents: readonly string[]): ControlChipGroup[] {
	return [
		{
			id: 'effort',
			label: EFFORT_LABELS[state.effort],
			shortLabel: state.effort,
			tooltip: 'Reasoning effort for this chat (--effort)',
			selected: state.effort,
			items: EFFORT_LEVELS.map(l => ({ id: l, label: EFFORT_LABELS[l], description: EFFORT_DETAILS[l] })),
		},
		{
			id: 'thinking',
			label: THINKING_LABELS[state.thinking],
			shortLabel: THINKING_LABELS[state.thinking].replace('Thinking: ', ''),
			tooltip: 'Extended-thinking budget for this chat (MAX_THINKING_TOKENS)',
			selected: state.thinking,
			items: THINKING_LEVELS.map(l => ({ id: l, label: THINKING_LABELS[l], description: THINKING_DETAILS[l] })),
		},
		{
			id: 'permissionMode',
			label: PERMISSION_LABELS[state.permissionMode],
			shortLabel: PERMISSION_LABELS[state.permissionMode].replace('Approvals: ', ''),
			tooltip: 'How tool permissions are decided for this chat (--permission-mode)',
			selected: state.permissionMode,
			items: PERMISSION_MODES.map(m => ({ id: m, label: PERMISSION_LABELS[m], description: PERMISSION_DETAILS[m] })),
		},
		{
			id: 'agent',
			label: state.agent ? `Agent: ${state.agent}` : 'Agent: default',
			shortLabel: state.agent || 'default',
			tooltip: 'Which agent definition runs this chat (--agent)',
			selected: state.agent,
			items: [
				{ id: '', label: 'Agent: default', description: "Claude Code's own agent setting" },
				...agents.map(a => ({ id: a, label: `Agent: ${a}`, description: 'From .claude/agents' })),
			],
		},
	];
}

/** Apply a chip pick. Unknown group ids and values are ignored. */
export function withChipPick(state: ControlState, groupId: string, itemId: string): ControlState {
	switch (groupId) {
		case 'effort':
			return EFFORT_LEVELS.includes(itemId as EffortLevel) ? { ...state, effort: itemId as EffortLevel } : state;
		case 'thinking':
			return THINKING_LEVELS.includes(itemId as ThinkingLevel) ? { ...state, thinking: itemId as ThinkingLevel } : state;
		case 'permissionMode':
			return PERMISSION_MODES.includes(itemId as PermissionMode) ? { ...state, permissionMode: itemId as PermissionMode } : state;
		case 'agent':
			return { ...state, agent: itemId };
		default:
			return state;
	}
}

// --- usage footer ------------------------------------------------------------------------------

export interface TurnUsage {
	readonly costUsd?: number;
	readonly durationMs?: number;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
}

/** Pull the cost/usage numbers out of a CLI `result` event. Absent fields stay undefined. */
export function usageOfResult(ev: any): TurnUsage | undefined {
	if (!ev || typeof ev !== 'object') { return undefined; }
	const u = ev.usage ?? {};
	const usage: TurnUsage = {
		costUsd: numberOr(ev.total_cost_usd),
		durationMs: numberOr(ev.duration_ms),
		inputTokens: numberOr(u.input_tokens),
		outputTokens: numberOr(u.output_tokens),
		cacheReadTokens: numberOr(u.cache_read_input_tokens),
		cacheWriteTokens: numberOr(u.cache_creation_input_tokens),
	};
	return Object.values(usage).some(v => v !== undefined) ? usage : undefined;
}

/** One-line footer, or '' when there is nothing worth showing. */
export function renderUsage(usage: TurnUsage | undefined): string {
	if (!usage) { return ''; }
	const bits: string[] = [];
	if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
		bits.push(`${compact(usage.inputTokens ?? 0)} in / ${compact(usage.outputTokens ?? 0)} out`);
	}
	const cached = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
	if (cached > 0) { bits.push(`${compact(cached)} cached`); }
	if (usage.costUsd !== undefined) { bits.push(`$${usage.costUsd.toFixed(usage.costUsd < 0.01 ? 4 : 2)}`); }
	if (usage.durationMs !== undefined) { bits.push(`${(usage.durationMs / 1000).toFixed(1)}s`); }
	return bits.join(' · ');
}

function compact(n: number): string {
	if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
	if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}k`; }
	return String(n);
}

function numberOr(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
