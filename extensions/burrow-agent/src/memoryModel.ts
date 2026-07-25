/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Which rows of the repo's own memory belong in the envelope (docs/plans/03 §4).
//
// merkle keeps a real contract in `.claude/memory/` — repo/api/db/env/design
// facts that are cheaper and truer than a grep. The selection is DETERMINISTIC
// on purpose: no model call decides what to load, so the same file always
// pulls the same rows and the insight cache can key on them.
//
// The files are read as text, not parsed: a top-level `key:` and everything
// indented under it is a section, which is all the shape we need and costs no
// YAML dependency (house rule: dependency-light).

export interface MemoryPick {
	/** File under `.claude/memory/`, e.g. `api.yaml`. */
	readonly file: string;
	/** Top-level keys to take; empty = the whole file. */
	readonly keys: readonly string[];
	/** Keep only rows mentioning one of these, when the section is a long list. */
	readonly mentioning?: readonly string[];
	readonly why: string;
}

const ALWAYS: MemoryPick[] = [
	{ file: 'repo.yaml', keys: ['meta', 'prefs', 'traps'], why: 'always' },
];

/**
 * The rules from the plan's table, in order. `question` is the developer's own
 * words — only the "what is in this repo" case reads them, and it is the only
 * rule that takes the whole of `repo.yaml`.
 */
export function selectMemory(activeFile: string | undefined, question: string): MemoryPick[] {
	const picks = [...ALWAYS];
	const file = (activeFile ?? '').replace(/\\/g, '/');
	const base = file.slice(file.lastIndexOf('/') + 1);

	if (/^(what|which).{0,40}\b(repo|project|codebase|shipped|built)\b/i.test(question.trim())) {
		return [{ file: 'repo.yaml', keys: [], why: 'asked what the repo is' }];
	}
	if (/(^|\/)backend\//.test(file) && /(router\.go|handler|\/api\/)/.test(file)) {
		picks.push({ file: 'api.yaml', keys: [], mentioning: [base], why: `route code in ${base}` });
	}
	if (/\.sql$/.test(file) || /(migration|store|repository)/i.test(file)) {
		picks.push({ file: 'db.yaml', keys: ['tables', 'migrations'], why: 'schema-adjacent file' });
	}
	if (/\.(css|scss)$/.test(file)) {
		picks.push({ file: 'design.yaml', keys: ['tokens'], why: 'stylesheet open' });
	}
	if (/(^|\/)models\/.*\.go$/.test(file) || /(^|\/)(types|models)\/.*\.ts$/.test(file)) {
		picks.push({ file: 'contract.json', keys: [], mentioning: [base.replace(/\.[a-z]+$/, '')], why: 'a model definition' });
	}
	return picks;
}

/** Environment names referenced in the open file, so `env.yaml` can be asked
 *  about exactly those instead of all of them. */
export function envNamesIn(source: string): string[] {
	const names = new Set<string>();
	const patterns = [/os\.Getenv\(\s*"([A-Z0-9_]+)"/g, /import\.meta\.env\.([A-Z0-9_]+)/g, /process\.env\.([A-Z0-9_]+)/g];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			names.add(match[1]);
		}
	}
	return [...names].sort();
}

/**
 * A top-level `key:` block out of a YAML-ish file: the key line plus every line
 * indented under it, stopping at the next unindented line. Unknown keys yield
 * nothing rather than guessing.
 */
export function section(text: string, key: string): string | undefined {
	const lines = text.split('\n');
	const start = lines.findIndex((line) => line.startsWith(`${key}:`));
	if (start < 0) {
		return undefined;
	}
	const out = [lines[start]];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() && !/^[\s-]/.test(line)) {
			break;
		}
		out.push(line);
	}
	return out.join('\n').trimEnd();
}

/** Rows of a section that mention one of `terms` — how a 400-row `api.yaml`
 *  becomes the four rows about the file on screen. */
export function rowsMentioning(text: string, terms: readonly string[], maxRows = 12): string {
	if (!terms.length) {
		return '';
	}
	const hits = text.split('\n').filter((line) => terms.some((term) => term && line.includes(term)));
	return hits.slice(0, maxRows).join('\n');
}

/** The `MEMORY.md` index reduced to its headings — the titles, so the agent
 *  knows what else it could ask for without being handed all of it. */
export function indexTitles(markdown: string, max = 20): string[] {
	return markdown
		.split('\n')
		.filter((line) => /^#{1,3} \S/.test(line) || /^- \*\*/.test(line))
		.map((line) => line.replace(/^#+ /, '').replace(/^- /, '').replace(/\*\*/g, '').trim())
		.slice(0, max);
}

/**
 * What a proposed change obliges the developer to update. merkle's memory is a
 * contract; the reason the IDE reads it is also the reason the IDE should say
 * when a change has just made it stale.
 */
export function contractReminders(diffText: string): string[] {
	const out: string[] = [];
	const touched = (pattern: RegExp) => pattern.test(diffText);
	if (touched(/^\+.*(router\.(Handle|Get|Post|Put|Delete)|http\.HandleFunc|\.HandleFunc\()/m)) {
		out.push('`api.yaml` — this adds or changes a route');
	}
	if (touched(/^\+.*(os\.Getenv\(|import\.meta\.env\.|process\.env\.)/m)) {
		out.push('`env.yaml` — this references an environment variable');
	}
	if (touched(/^\+.*(CREATE TABLE|ALTER TABLE|ADD COLUMN)/mi)) {
		out.push('`db.yaml` — this changes the schema');
	}
	if (touched(/^\+.*--[a-z][\w-]*\s*:/m)) {
		out.push('`design.yaml` — this declares a design token');
	}
	return out;
}
