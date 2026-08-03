/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// parse.ts — "does this file hold together", per language, with no toolchain.
//
// WHY THIS EXISTS. 1,680 of 2,094 steps had exactly one check between them and a
// green tick: `the file exists and is not empty`. A single byte passes it. Every
// stylesheet, every migration, every React component in the plan could be
// finished by typing a space, and the surface would have said so — which makes
// the tick worth nothing on the 1,056 written steps that had no other, and makes
// the four hundred that DO have one look like an accident rather than a rule.
//
// WHAT A CHECK HERE MAY CLAIM. Only that the file holds together as an instance
// of its language: it is complete, its brackets and quotes and comments close,
// and nothing is truncated. It may NOT claim the file is correct — a stylesheet
// with a misspelt property parses, and saying otherwise would be the same defect
// as the sentence that counted files and called it a graph fact.
//
// WHY NOT A COMPILER. A check runs at ITS OWN step, with nothing below it
// written: `tsc --noEmit` on the first component of a project resolves imports
// that do not exist yet and fails a file that is byte-identical to the
// reference. That is the failure mode this whole feature is organised against
// (see `08b §1`), so every parser here reads one file and nothing else.
//
// No `vscode` import: unit-tested standalone, like everything else the plan
// leans on. TypeScript is loaded through `require` at call time and its absence
// degrades to "could not run", never to a pass and never to a red.

/** The languages a `parse` check knows. One per shape, not one per extension:
 *  `.mjs`, `.cjs` and `.jsx` are all `js`. */
export type ParseLang = 'json' | 'jsonc' | 'ts' | 'tsx' | 'js' | 'css' | 'sql' | 'yaml' | 'xml';

export interface ParseVerdict {
	readonly ok: boolean;
	/** Empty when `ok`. Otherwise where it stopped, in the file's own terms —
	 *  never a bare "invalid", which sends a reader to re-read the whole file. */
	readonly message: string;
	/** The parser itself is missing. Not the file's fault, and not a failure:
	 *  `checks.ts` turns this into `unavailable`. */
	readonly unavailable?: boolean;
}

const OK: ParseVerdict = { ok: false, message: '' };
const ok = (): ParseVerdict => ({ ...OK, ok: true });

/** `path:line:col: what` — the shape every compiler on the machine already uses,
 *  and the shape the Go check already produces. */
function at(file: string, text: string, index: number, message: string): ParseVerdict {
	const before = text.slice(0, index);
	const line = before.split('\n').length;
	const col = index - (before.lastIndexOf('\n') + 1) + 1;
	return { ok: false, message: `${file}:${line}:${col}: ${message}` };
}

export function parseFile(lang: ParseLang, file: string, text: string, keys: readonly string[] = []): ParseVerdict {
	switch (lang) {
		case 'json': return parseJson(file, text, keys);
		case 'jsonc': return parseJson(file, stripJsonComments(text), keys);
		case 'ts': case 'tsx': case 'js': return parseTypeScript(lang, file, text);
		case 'css': return parseBalanced(file, text, CSS);
		case 'sql': return parseBalanced(file, text, SQL);
		case 'xml': return parseXml(file, text);
		case 'yaml': return parseYaml(file, text, keys);
	}
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * `JSON.parse`, plus the top-level names the reference declares.
 *
 * The keys are the part worth having. `{}` is valid JSON, so parsing alone would
 * pass a `tsconfig.json` containing two characters — the same hole one level up
 * from the one this file is about.
 */
/**
 * JSON with comments and trailing commas, blanked rather than deleted.
 *
 * `tsconfig.json` is JSONC by specification and every `.vscode/*.json` is by
 * convention — merkle carries eight such files, and a strict `JSON.parse` failed
 * all eight on content byte-identical to the reference. Excluding them would have
 * left the tsconfigs, which is where a top-level key check is most worth having,
 * with nothing at all.
 *
 * Comments become spaces and newlines stay newlines, so a position reported by
 * `JSON.parse` still points at the right place in the file the reader has open.
 */
export function stripJsonComments(text: string): string {
	const out = text.split('');
	let i = 0;
	while (i < text.length) {
		if (text[i] === '"') {
			i++;
			while (i < text.length && text[i] !== '"') {
				i += text[i] === '\\' ? 2 : 1;
			}
			i++;
			continue;
		}
		if (text.startsWith('//', i)) {
			while (i < text.length && text[i] !== '\n') {
				out[i++] = ' ';
			}
			continue;
		}
		if (text.startsWith('/*', i)) {
			const end = text.indexOf('*/', i + 2);
			const stop = end < 0 ? text.length : end + 2;
			while (i < stop) {
				out[i] = text[i] === '\n' ? '\n' : ' ';
				i++;
			}
			continue;
		}
		i++;
	}
	// A trailing comma, once the comments around it are gone: `,` followed by
	// nothing but whitespace before a `}` or `]`.
	const blanked = out.join('');
	return blanked.replace(/,(\s*[}\]])/g, ' $1');
}

function parseJson(file: string, text: string, keys: readonly string[]): ParseVerdict {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { ok: false, message: `${file}: ${(error as Error).message}` };
	}
	if (!keys.length) {
		return ok();
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return { ok: false, message: `${file}: the reference declares an object at the top level, with ${keys.length} keys in it.` };
	}
	const missing = keys.filter((k) => !Object.prototype.hasOwnProperty.call(value, k));
	return missing.length
		? { ok: false, message: `${file}: no top-level ${missing.map((k) => `"${k}"`).join(', ')}.` }
		: ok();
}

// ---------------------------------------------------------------------------
// TypeScript, TSX and JavaScript
// ---------------------------------------------------------------------------

interface TsModule {
	readonly ScriptTarget: { readonly Latest: number };
	readonly ScriptKind: { readonly TS: number; readonly TSX: number; readonly JS: number };
	createSourceFile(name: string, text: string, target: number, setParents: boolean, kind: number): {
		readonly parseDiagnostics?: ReadonlyArray<{ readonly start: number; readonly messageText: unknown }>;
	};
	flattenDiagnosticMessageText(messageText: unknown, newLine: string): string;
}

let typescriptModule: TsModule | null | undefined;

/**
 * The parser VS Code already ships.
 *
 * `extensions/node_modules/typescript` is in the packaged app as well as the
 * repository, and an extension's `require` walks up to it — so this needs no
 * dependency of its own and no `tsc` on the reader's PATH. Resolved once and
 * cached, including the failure: a missing parser must not be re-probed 474
 * times in a full pass.
 */
function typescript(): TsModule | null {
	if (typescriptModule === undefined) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			typescriptModule = require('typescript') as TsModule;
		} catch {
			typescriptModule = null;
		}
	}
	return typescriptModule;
}

/**
 * SYNTAX ONLY — `createSourceFile`, not `createProgram`.
 *
 * `parseDiagnostics` are the errors a file can be wrong about on its own: an
 * unclosed brace, a JSX tag that never ends, a `const` with no initialiser.
 * Everything a type-checker would add ("cannot find module './Badge'") is about
 * a file this step has not reached yet, and failing a step for that would fail
 * work that is byte-identical to the reference.
 */
function parseTypeScript(lang: 'ts' | 'tsx' | 'js', file: string, text: string): ParseVerdict {
	const ts = typescript();
	if (!ts) {
		return { ok: false, message: 'the TypeScript parser is not available here.', unavailable: true };
	}
	const kind = lang === 'tsx' ? ts.ScriptKind.TSX : lang === 'js' ? ts.ScriptKind.JS : ts.ScriptKind.TS;
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
	const first = source.parseDiagnostics?.[0];
	return first
		? at(file, text, first.start, ts.flattenDiagnosticMessageText(first.messageText, ' '))
		: ok();
}

// ---------------------------------------------------------------------------
// The bracket languages: CSS and SQL
// ---------------------------------------------------------------------------

/**
 * What a brace-and-quote scanner has to know about one language.
 *
 * This is not a parser for either of them and does not pretend to be. It answers
 * the one question a half-written file fails: **does everything that opens
 * close?** A truncated stylesheet, a migration whose `$$` body was pasted
 * without its terminator, a string that swallows the rest of the file — those
 * are what a reader typing 279,000 lines actually produces, and none of them
 * were caught by anything.
 */
interface Bracketed {
	/** Line-comment openers. */
	readonly line: readonly string[];
	/** Block comments, as [open, close]. */
	readonly block: readonly (readonly [string, string])[];
	/** Quote characters. */
	readonly quotes: readonly string[];
	/** A quote closes with a backslash escape (CSS, C) rather than by doubling. */
	readonly backslash: boolean;
	/** A doubled quote inside a quoted run is a literal (SQL). */
	readonly doubled: boolean;
	/** Postgres `$tag$ … $tag$`. */
	readonly dollar: boolean;
}

const CSS: Bracketed = { line: [], block: [['/*', '*/']], quotes: ['"', "'"], backslash: true, doubled: false, dollar: false };
const SQL: Bracketed = { line: ['--'], block: [['/*', '*/']], quotes: ["'", '"'], backslash: false, doubled: true, dollar: true };

const CLOSERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

function parseBalanced(file: string, text: string, lang: Bracketed): ParseVerdict {
	const stack: { char: string; index: number }[] = [];
	let i = 0;
	while (i < text.length) {
		const rest = text.slice(i, i + 2);
		const lineComment = lang.line.find((c) => text.startsWith(c, i));
		if (lineComment) {
			const end = text.indexOf('\n', i);
			i = end < 0 ? text.length : end + 1;
			continue;
		}
		const block = lang.block.find(([open]) => text.startsWith(open, i));
		if (block) {
			const end = text.indexOf(block[1], i + block[0].length);
			if (end < 0) {
				return at(file, text, i, `this ${block[0]} comment is never closed — the rest of the file is inside it.`);
			}
			i = end + block[1].length;
			continue;
		}
		if (lang.dollar && text[i] === '$') {
			const tag = /^\$[A-Za-z_]?\w*\$/.exec(text.slice(i));
			if (tag) {
				const end = text.indexOf(tag[0], i + tag[0].length);
				if (end < 0) {
					return at(file, text, i, `this ${tag[0]} quoted body is never closed.`);
				}
				i = end + tag[0].length;
				continue;
			}
		}
		const quote = lang.quotes.find((q) => q === text[i]);
		if (quote) {
			let j = i + 1;
			for (;;) {
				if (j >= text.length) {
					return at(file, text, i, `this ${quote} string is never closed.`);
				}
				if (lang.backslash && text[j] === '\\') {
					j += 2;
					continue;
				}
				if (text[j] === quote) {
					if (lang.doubled && text[j + 1] === quote) {
						j += 2;
						continue;
					}
					break;
				}
				j++;
			}
			i = j + 1;
			continue;
		}
		const char = text[i];
		if (char === '(' || char === '[' || char === '{') {
			stack.push({ char, index: i });
		} else if (CLOSERS[char]) {
			const open = stack.pop();
			if (!open) {
				return at(file, text, i, `a ${char} with no ${CLOSERS[char]} open before it.`);
			}
			if (open.char !== CLOSERS[char]) {
				return at(file, text, open.index, `this ${open.char} is closed by a ${char}.`);
			}
		}
		void rest;
		i++;
	}
	const open = stack.pop();
	return open ? at(file, text, open.index, `this ${open.char} is never closed.`) : ok();
}

// ---------------------------------------------------------------------------
// XML and SVG
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);

/** Tag balance, which is the whole of what an SVG can be half-written about.
 *  HTML void elements are allowed to stand alone; everything else must close. */
function parseXml(file: string, text: string): ParseVerdict {
	const stack: { name: string; index: number }[] = [];
	const tag = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[?!][^>]*>|<\/?([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
	for (const m of text.matchAll(tag)) {
		if (!m[1]) {
			continue;  // a comment, a CDATA section, a declaration or a processing instruction
		}
		const name = m[1];
		if (m[0].startsWith('</')) {
			const open = stack.pop();
			if (!open) {
				return at(file, text, m.index, `</${name}> with no <${name}> open before it.`);
			}
			if (open.name !== name) {
				return at(file, text, open.index, `this <${open.name}> is closed by a </${name}>.`);
			}
		} else if (!m[3] && !VOID_TAGS.has(name.toLowerCase())) {
			stack.push({ name, index: m.index });
		}
	}
	const open = stack.pop();
	return open ? at(file, text, open.index, `this <${open.name}> is never closed.`) : ok();
}

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

/**
 * NOT a YAML parser, and the label on this check says so.
 *
 * There is no YAML parser aboard and adding a dependency to assert twenty-four
 * files would be a poor trade. What is left is still worth having and still
 * fails on wrong content: **a tab in the indentation**, which YAML rejects
 * outright and an editor produces by accident, and **the top-level keys the
 * reference declares**, which is what tells a half-written `docker-compose.yml`
 * from a finished one. Multi-document files (`---`) are read as one namespace,
 * which is right for the question being asked.
 */
function parseYaml(file: string, text: string, keys: readonly string[]): ParseVerdict {
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const indent = /^[ \t]*/.exec(lines[i])![0];
		if (indent.includes('\t')) {
			return { ok: false, message: `${file}:${i + 1}:${indent.indexOf('\t') + 1}: a tab in the indentation — YAML does not allow one.` };
		}
	}
	const declared = new Set<string>();
	for (const line of lines) {
		const key = /^([A-Za-z_][\w.-]*):(\s|$)/.exec(line);
		if (key) {
			declared.add(key[1]);
		}
	}
	const missing = keys.filter((k) => !declared.has(k));
	return missing.length
		? { ok: false, message: `${file}: no top-level ${missing.map((k) => `${k}:`).join(', ')}.` }
		: ok();
}

// ---------------------------------------------------------------------------
// What the plan asks for
// ---------------------------------------------------------------------------

/** Editor config files that permit comments, wherever they are kept. */
const EDITOR_JSONC = new Set(['launch.json', 'settings.json', 'tasks.json', 'extensions.json', 'keybindings.json', 'argv.json']);

/** The language a path is an instance of, or `undefined` when nothing here can
 *  say anything true about it. Extension-keyed, deliberately: the alternative is
 *  sniffing content, and a check that guesses wrong fails correct work. */
export function langOf(relPath: string): ParseLang | undefined {
	const base = relPath.slice(relPath.lastIndexOf('/') + 1);
	// JSON with comments, where the ecosystem's own tools accept them: tsconfig by
	// specification, the editor's own config files by convention. By NAME and not
	// by directory — merkle keeps a set of them in `infra/test/vscode/`, without
	// the dot, and a path rule missed all three while catching an `.http` file
	// that happened to sit beside one. Everywhere else `.json` is strict, because
	// npm and Go are.
	if (/\.jsonc$/.test(base) || base.endsWith('.code-snippets')) {
		return 'jsonc';
	}
	if (/\.json$/.test(base)) {
		return /^(ts|js)config.*\.json$/.test(base) || EDITOR_JSONC.has(base) ? 'jsonc' : 'json';
	}
	if (/\.tsx$/.test(base)) {
		return 'tsx';
	}
	if (/\.(ts|mts|cts)$/.test(base)) {
		return 'ts';
	}
	if (/\.(js|jsx|mjs|cjs)$/.test(base)) {
		return /\.jsx$/.test(base) ? 'tsx' : 'js';
	}
	if (/\.(css|scss|less)$/.test(base)) {
		return 'css';
	}
	if (/\.sql$/.test(base)) {
		return 'sql';
	}
	if (/\.(svg|xml|html|htm)$/.test(base)) {
		return 'xml';
	}
	if (/\.ya?ml$/.test(base)) {
		return 'yaml';
	}
	return undefined;
}

/** What the check's row on the page says it did. Per language, because "it
 *  parses" would be a lie about YAML and an understatement about JSON. */
export function parseLabel(lang: ParseLang, keys: readonly string[]): string {
	if (lang === 'yaml') {
		return keys.length ? `it declares the ${keys.length} top-level keys, and indents with spaces` : 'it indents with spaces, not tabs';
	}
	if (lang === 'json' || lang === 'jsonc') {
		return keys.length ? `it parses, and declares the ${keys.length} top-level key${keys.length === 1 ? '' : 's'}` : 'it parses as JSON';
	}
	if (lang === 'xml') {
		return 'every tag it opens is closed';
	}
	if (lang === 'css' || lang === 'sql') {
		return 'every bracket, quote and comment it opens is closed';
	}
	return 'it parses';
}

/**
 * The top-level names the reference declares, for the two languages where "what
 * is in it" is a set of keys. Read at plan time from the reference, like the
 * byte count `existsCheck` uses — a check cannot work out what correct is by
 * looking at a scratch.
 */
export function topLevelKeys(lang: ParseLang, text: string): string[] {
	if (lang === 'json' || lang === 'jsonc') {
		try {
			const value = JSON.parse(lang === 'jsonc' ? stripJsonComments(text) : text) as unknown;
			return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value) : [];
		} catch {
			return [];
		}
	}
	if (lang === 'yaml') {
		const keys: string[] = [];
		for (const line of text.split('\n')) {
			const key = /^([A-Za-z_][\w.-]*):(\s|$)/.exec(line);
			if (key && !keys.includes(key[1])) {
				keys.push(key[1]);
			}
		}
		return keys;
	}
	return [];
}
