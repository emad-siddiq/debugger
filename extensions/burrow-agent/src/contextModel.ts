/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The context envelope's rules, without the workbench (docs/plans/03 §3, §7).
// What a layer contains is collected in context.ts; what may be sent, in what
// order, and where the budget runs out is decided here — so the safety rules
// are testable rather than asserted.

/** One thing the agent is told, and one chip in the panel. */
export interface Layer {
	readonly id: string;
	/** The chip's label. */
	readonly label: string;
	/** Markdown, without the heading — `render` writes that. */
	readonly body: string;
}

/**
 * Never read, never sent, never patched. Applied when the envelope is built AND
 * again before any diff is applied (diff.ts), because the two paths reach files
 * by different routes and a rule enforced once is a rule that will be missed.
 */
export const DENY_GLOBS: readonly string[] = [
	'**/.env*',
	'**/infra/secrets/**',
	'**/*.pem',
	'**/*.key',
	'**/secret*',
	'**/.claude/settings.local.json',
	'**/node_modules/**',
	'**/.git/**',
];

/** Layer order: cheapest and most general first, so a small budget still says
 *  what repo this is and what is open before it runs out. */
export const LAYER_ORDER: readonly string[] = [
	'workspace', 'pages', 'bundle', 'surface', 'selection', 'debug', 'data', 'memory',
];

/** Rough token count. Four characters per token is wrong in the third decimal
 *  and right enough to keep an envelope under a budget. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Does this path match one of the deny globs? Paths are compared with forward
 *  slashes, so a Windows path must be normalized before it gets here. */
export function isDenied(filePath: string, globs: readonly string[] = DENY_GLOBS): boolean {
	const path = filePath.replace(/\\/g, '/');
	return globs.some((glob) => globToRegExp(glob).test(path));
}

/** `**` spans separators, `*` does not, `?` is one character. Everything else
 *  is literal — these are our own globs, not a user-facing pattern language. */
function globToRegExp(glob: string): RegExp {
	let out = '';
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === '*') {
			if (glob[i + 1] === '*') {
				out += '.*';
				i++;
				if (glob[i + 1] === '/') {
					i++;
				}
			} else {
				out += '[^/]*';
			}
		} else if (ch === '?') {
			out += '[^/]';
		} else {
			out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp(`^${out}$`);
}

/**
 * The page bundle: the files that belong to the one the developer is looking
 * at. Open `Badge.tsx` and the agent should see `Badge.css` and `Badge.test.tsx`
 * without being told they exist — that pair is the whole point of the layer.
 * `siblings` is the directory listing; returns paths, source first.
 */
export function bundleFor(activeFile: string, siblings: readonly string[]): string[] {
	const slash = activeFile.lastIndexOf('/');
	const dir = slash < 0 ? '' : activeFile.slice(0, slash + 1);
	const base = activeFile.slice(slash + 1);
	const stem = base.replace(/\.[jt]sx?$/, '');
	if (stem === base) {
		return [];
	}
	const wanted = new Set([
		`${stem}.css`, `${stem}.module.css`, `${stem}.scss`,
		`${stem}.samples.ts`, `${stem}.samples.tsx`, `${stem}.samples.js`, `${stem}.samples.jsx`,
		`${stem}.test.ts`, `${stem}.test.tsx`, `${stem}.test.js`, `${stem}.test.jsx`,
		`${stem}_test.go`,
	]);
	return siblings.filter((name) => wanted.has(name)).sort().map((name) => dir + name);
}

/** What a bundle member is, for the one-line label beside it. */
export function bundleRole(file: string): string {
	if (/\.(css|scss)$/.test(file)) {
		return 'stylesheet';
	}
	if (/\.samples\.[jt]sx?$/.test(file)) {
		return 'sample props';
	}
	if (/(\.test\.[jt]sx?|_test\.go)$/.test(file)) {
		return 'tests';
	}
	return 'source';
}

export interface Envelope {
	/** The markdown the model receives — empty when everything was dropped. */
	readonly text: string;
	readonly included: readonly string[];
	/** Layers the budget could not fit, named so the panel can say so. */
	readonly dropped: readonly string[];
	readonly tokens: number;
}

/**
 * Layers → one deterministic markdown block, in LAYER_ORDER, stopping at the
 * budget. Deterministic matters: the same screen must produce the same envelope
 * twice, or the insight cache in insights.ts would miss every time.
 */
export function render(layers: readonly Layer[], budgetTokens: number): Envelope {
	const ordered = [...layers].sort((a, b) => LAYER_ORDER.indexOf(a.id) - LAYER_ORDER.indexOf(b.id));
	const parts: string[] = [];
	const included: string[] = [];
	const dropped: string[] = [];
	let tokens = 0;
	for (const layer of ordered) {
		if (!layer.body.trim()) {
			continue;
		}
		const block = `## ${layer.label}\n${layer.body.trim()}\n`;
		const cost = estimateTokens(block);
		if (tokens + cost > budgetTokens) {
			dropped.push(layer.id);
			continue;
		}
		parts.push(block);
		included.push(layer.id);
		tokens += cost;
	}
	return { text: parts.join('\n'), included, dropped, tokens };
}

/** The question, with the envelope in front of it. Kept in one place so what
 *  the developer previews is byte-for-byte what the model is sent. */
export function withQuestion(envelope: string, question: string): string {
	if (!envelope) {
		return question;
	}
	return [
		'<burrow-context>',
		'What the developer is looking at right now. Use it instead of searching for these files.',
		'',
		envelope.trim(),
		'</burrow-context>',
		'',
		question,
	].join('\n');
}
