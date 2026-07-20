/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// httpFile.ts — the pure `.http` parser/interpolator (architecture task 09, task 1:
// the ".http parser/printer"). It imports nothing from 'vscode', so out/httpFile.js is a
// clean CommonJS module the standalone node tests require directly. It parses the
// humao/JetBrains dialect this repo already uses: `###`-separated requests, a
// `METHOD URL` line, `Key: Value` headers, a blank line, then a body — plus `@var`
// definitions and `{{var}}` / `{{$env:NAME}}` interpolation.

/** A single parsed request from a `.http` file, before interpolation. */
export interface HttpRequest {
	/** Human label — the text after `###`, else `METHOD URL`. */
	readonly name: string;
	/** Upper-cased verb (`GET`, `POST`, …); defaults to `GET` when the line is bare URL. */
	readonly method: string;
	/** The raw request URL (may still contain `{{var}}` placeholders). */
	readonly url: string;
	/** Header pairs in file order (values may still contain placeholders). */
	readonly headers: ReadonlyArray<readonly [string, string]>;
	/** The request body, trailing newline trimmed (empty string when none). */
	readonly body: string;
	/** 0-based line index of the `METHOD URL` line — the codelens/Send anchor. */
	readonly line: number;
}

/** A parsed `.http` document: its file-level `@vars` and the requests it holds. */
export interface HttpFile {
	/** `@name = value` definitions, in file order, unresolved. */
	readonly variables: ReadonlyArray<readonly [string, string]>;
	readonly requests: ReadonlyArray<HttpRequest>;
}

/** Context for `{{…}}` expansion: resolved vars plus an optional `$env:` resolver. */
export interface InterpolationContext {
	readonly variables: Readonly<Record<string, string>>;
	/** Resolver for `{{$env:NAME}}`; omitted → env tokens expand to empty. */
	readonly env?: (name: string) => string | undefined;
}

/** A request with every `{{…}}` placeholder expanded — ready to send. */
export interface ResolvedRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: ReadonlyArray<readonly [string, string]>;
	readonly body: string;
}

const REQUEST_LINE = /^\s*(?:([A-Za-z]+)\s+)?(\S.*?)(?:\s+HTTP\/[\d.]+)?\s*$/;
const VAR_LINE = /^\s*@([A-Za-z_][\w-]*)\s*=\s*(.*?)\s*$/;
const HEADER_LINE = /^([^:\s][^:]*):\s?(.*)$/;
const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;
const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT']);

/** True for lines that are `.http` comments (`#`, `//`) but not a `###` separator. */
function isComment(line: string): boolean {
	const t = line.trimStart();
	return (t.startsWith('#') && !t.startsWith('###')) || t.startsWith('//');
}

/**
 * Parse a `.http` document into its `@vars` and request blocks. Blocks are split on
 * `###` lines; within a block, leading blanks/comments/`@vars` are skipped, the first
 * real line is `METHOD URL`, following lines up to a blank line are headers, and the
 * remainder is the body. Nothing is interpolated here — placeholders survive verbatim
 * so callers can resolve against a chosen environment.
 */
export function parseHttpFile(text: string): HttpFile {
	const lines = text.split(/\r?\n/);
	const variables: [string, string][] = [];
	const requests: HttpRequest[] = [];

	// Split into blocks, remembering each block's starting line index so request line
	// numbers stay absolute (for codelens placement).
	const blocks: { start: number; lines: string[]; separatorLabel: string }[] = [];
	let current: { start: number; lines: string[]; separatorLabel: string } = { start: 0, lines: [], separatorLabel: '' };
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.trimStart().startsWith('###')) {
			blocks.push(current);
			current = { start: i + 1, lines: [], separatorLabel: line.replace(/^\s*#+/, '').trim() };
			continue;
		}
		current.lines.push(line);
	}
	blocks.push(current);

	for (const block of blocks) {
		let i = 0;
		// Skip and collect leading blanks / comments / @vars until the request line.
		for (; i < block.lines.length; i++) {
			const raw = block.lines[i];
			const varMatch = VAR_LINE.exec(raw);
			if (varMatch) {
				variables.push([varMatch[1], varMatch[2]]);
				continue;
			}
			if (raw.trim() === '' || isComment(raw)) {
				continue;
			}
			break;
		}
		if (i >= block.lines.length) {
			continue; // no request line in this block (vars-only or empty)
		}

		const requestLineIndex = block.start + i;
		const reqMatch = REQUEST_LINE.exec(block.lines[i]);
		if (!reqMatch) {
			continue;
		}
		i++;
		const rawMethod = (reqMatch[1] ?? '').toUpperCase();
		// A leading token is only a verb if it's a known method; otherwise the whole
		// line is a bare URL (e.g. `example.com/health`) and the verb defaults to GET.
		let method: string;
		let url: string;
		if (rawMethod && KNOWN_METHODS.has(rawMethod)) {
			method = rawMethod;
			url = reqMatch[2].trim();
		} else {
			method = 'GET';
			url = `${reqMatch[1] ? reqMatch[1] + ' ' : ''}${reqMatch[2]}`.trim();
		}

		// Headers: contiguous `Key: Value` lines until the first blank line.
		const headers: [string, string][] = [];
		for (; i < block.lines.length; i++) {
			const raw = block.lines[i];
			if (raw.trim() === '') {
				i++; // consume the blank separator; the rest is body
				break;
			}
			const h = HEADER_LINE.exec(raw);
			if (h) {
				headers.push([h[1].trim(), h[2]]);
			}
		}

		// Body: everything after the blank line, trailing whitespace/newlines trimmed.
		const body = block.lines.slice(i).join('\n').replace(/\s+$/, '');

		const name = block.separatorLabel || `${method} ${url}`;
		requests.push({ name, method, url, headers, body, line: requestLineIndex });
	}

	return { variables, requests };
}

/**
 * Resolve `@var` definitions into a flat map, expanding `{{…}}` references a variable
 * may make to earlier ones (e.g. `@base = http://{{host}}`). Later definitions of the
 * same name win.
 */
export function resolveVariables(variables: ReadonlyArray<readonly [string, string]>, env?: (name: string) => string | undefined): Record<string, string> {
	const resolved: Record<string, string> = {};
	for (const [key, value] of variables) {
		resolved[key] = interpolate(value, { variables: resolved, env });
	}
	return resolved;
}

/**
 * Expand every `{{…}}` placeholder in `text`. `{{name}}` reads `ctx.variables`;
 * `{{$env:NAME}}` reads `ctx.env`. Unknown names are left verbatim so the surviving
 * placeholder is visible to the user rather than silently blanked.
 */
export function interpolate(text: string, ctx: InterpolationContext): string {
	return text.replace(PLACEHOLDER, (whole, token: string) => {
		if (token.startsWith('$env:')) {
			return ctx.env?.(token.slice('$env:'.length).trim()) ?? '';
		}
		if (token.startsWith('$secret:')) {
			return whole; // OS-keychain secrets are a later slice; keep the placeholder.
		}
		const v = ctx.variables[token];
		return v === undefined ? whole : v;
	});
}

/**
 * Produce a fully-interpolated request ready to hand to the send engine: the URL,
 * every header key and value, and the body are all expanded against `ctx`.
 */
export function resolveRequest(request: HttpRequest, ctx: InterpolationContext): ResolvedRequest {
	return {
		method: request.method,
		url: interpolate(request.url, ctx),
		headers: request.headers.map(([k, v]) => [interpolate(k, ctx), interpolate(v, ctx)] as const),
		body: interpolate(request.body, ctx),
	};
}
