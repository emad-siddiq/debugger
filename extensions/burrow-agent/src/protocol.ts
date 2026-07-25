/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The Claude Code CLI's stream-json protocol, as data. Deliberately free of
// `vscode` and of `child_process` so the parts that are easy to get wrong — the
// argument vector, the environment scrub, and the line parser — can be unit
// tested by plain node (test/transport.test.js), which is how burrow-go-nav
// keeps `query.ts`/`seed.ts` honest.
//
// The CLI speaks line-delimited JSON in both directions. Observed event shapes
// (v2.1.216), and what this file does with each:
//   system/init          → the session_id to resume with later
//   stream_event         → content_block_delta text, for incremental rendering
//   assistant            → the completed text block(s) of a turn
//   result               → final text + total_cost_usd + usage + duration_ms
//   rate_limit_event     → utilization warnings, surfaced rather than hidden
//   system/hook_*        → the user's own hooks talking; not ours to render

/** One thing that happened on the wire, normalized for the panel. */
export type AgentEvent =
	| { readonly kind: 'session'; readonly id: string }
	| { readonly kind: 'delta'; readonly text: string }
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'result'; readonly text: string; readonly isError: boolean; readonly costUsd?: number; readonly durationMs?: number; readonly tokens?: number }
	| { readonly kind: 'rateLimit'; readonly status: string; readonly utilization: number };

export interface SpawnOptions {
	/** Resume token from a previous run of this session, if we have one. */
	readonly resume?: string;
	/** Model alias; empty/undefined = the CLI's own default. */
	readonly model?: string;
	/** Appended to the CLI's system prompt — see BURROW_SYSTEM_PREAMBLE. */
	readonly preamble: string;
}

/**
 * Everything the panel is, in one paragraph the model actually reads. Kept
 * short on purpose: the CLI already loads the workspace's own CLAUDE.md and
 * memory because it runs *inside* the workspace, and repeating that here would
 * only compete with it.
 */
export const BURROW_SYSTEM_PREAMBLE = [
	'You are answering inside Burrow, an IDE, in a side panel next to the developer\'s editor.',
	'Answers are read in a narrow column: lead with the answer, keep it short, and prefer a',
	'few sentences or bullets over an essay. Cite code as `path:line` so the IDE can link it.',
	'You are advisory here: never write, edit, or create files, and never run git — when a',
	'change is wanted, show the diff or the code and let the developer apply it.',
].join(' ');

/** The argument vector for one session's CLI child. */
export function buildArgs(options: SpawnOptions): string[] {
	const args = [
		'--print',
		'--input-format', 'stream-json',
		'--output-format', 'stream-json',
		'--include-partial-messages',
		// --verbose is not optional: stream-json in print mode refuses without it.
		'--verbose',
		// Advisory by default, and enforced twice — the mode the CLI runs in and
		// the tools it is denied. The panel never applies anything on its own.
		'--permission-mode', 'plan',
		'--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit',
		'--append-system-prompt', options.preamble,
	];
	if (options.resume) {
		args.push('--resume', options.resume);
	}
	if (options.model) {
		args.push('--model', options.model);
	}
	return args;
}

/**
 * The child's environment with every `ANTHROPIC_*` override removed. This is
 * the machine-enforced half of "your Claude Code account, nothing else": with
 * `ANTHROPIC_API_KEY` in the parent environment the CLI would silently bill an
 * API key instead of the account the developer logged in with, and the panel
 * would have no way to say so.
 */
export function scrubEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith('ANTHROPIC_')) {
			out[key] = value;
		}
	}
	return out;
}

/** One user turn, as the line the CLI expects on stdin. */
export function userMessageLine(text: string): string {
	return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
}

/**
 * One line of the CLI's stdout → an event, or undefined for the many lines that
 * are none of our business (hook chatter, tool traffic, unknown future types).
 * Never throws: a malformed line is silence, not a broken panel.
 */
export function parseEvent(line: string): AgentEvent | undefined {
	const trimmed = line.trim();
	if (!trimmed || trimmed[0] !== '{') {
		return undefined;
	}
	let msg: Record<string, unknown>;
	try {
		msg = JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	switch (msg.type) {
		case 'system':
			return msg.subtype === 'init' && typeof msg.session_id === 'string'
				? { kind: 'session', id: msg.session_id }
				: undefined;
		case 'stream_event':
			return deltaOf(msg.event);
		case 'assistant':
			return textOf(msg.message);
		case 'result': {
			const usage = asRecord(msg.usage);
			const tokens = num(usage?.input_tokens) + num(usage?.output_tokens);
			return {
				kind: 'result',
				text: typeof msg.result === 'string' ? msg.result : '',
				isError: msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype !== 'success'),
				costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
				durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : undefined,
				tokens: tokens || undefined,
			};
		}
		case 'rate_limit_event': {
			const info = asRecord(msg.rate_limit_info);
			return info && typeof info.status === 'string'
				? { kind: 'rateLimit', status: info.status, utilization: num(info.utilization) }
				: undefined;
		}
		default:
			return undefined;
	}
}

/** `stream_event` carries the SDK's raw streaming envelope; only text deltas
 *  matter to a panel that renders prose. */
function deltaOf(event: unknown): AgentEvent | undefined {
	const ev = asRecord(event);
	if (!ev || ev.type !== 'content_block_delta') {
		return undefined;
	}
	const delta = asRecord(ev.delta);
	return delta && delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text
		? { kind: 'delta', text: delta.text }
		: undefined;
}

/** A completed assistant message: its text blocks joined. Tool-use blocks are
 *  skipped — the panel shows what was said, not how it was found. */
function textOf(message: unknown): AgentEvent | undefined {
	const msg = asRecord(message);
	const content = msg?.content;
	if (!Array.isArray(content)) {
		return undefined;
	}
	const text = content
		.map((block) => asRecord(block))
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block!.text as string)
		.join('');
	return text ? { kind: 'text', text } : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function num(value: unknown): number {
	return typeof value === 'number' && isFinite(value) ? value : 0;
}
