/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// godoc.ts — the PURE core of burrow-go-docs (architecture task 07 "Go docs:
// hover → fullscreen"). Everything here is `vscode`-free so out/godoc.js is a
// clean CommonJS module the standalone node tests require directly:
//   • parseDocTarget  — user input → the tokens we hand `go doc`
//   • buildGoDocArgs  — those tokens → an execFile argv (no shell, ever)
//   • classifyGoDoc   — raw `go doc` text → a typed line model
//   • renderDocHtml   — that model → the safe HTML the viewer webview injects
// The child_process call and the webview live in runner.ts / viewer.ts; this
// module knows nothing about them so the parsing/formatting stays testable.

/** A resolved documentation request: the tokens for `go doc` plus a breadcrumb label. */
export interface DocTarget {
	/** The whitespace-split tokens passed to `go doc` (e.g. `['net/http']` or `['net/http', 'HandleFunc']`). */
	readonly args: string[];
	/** A human breadcrumb for the viewer's title bar (e.g. `net/http.HandleFunc`). */
	readonly label: string;
}

/**
 * Parse free-form user input into a {@link DocTarget}. `go doc` itself resolves
 * both the dotted (`net/http.HandleFunc`) and two-token (`net/http HandleFunc`)
 * forms, so we only normalise whitespace and hand the tokens through verbatim —
 * no fragile package/symbol splitting on our side.
 * @param input Raw text from the input box, hover, or a webview search.
 * @returns The target, or `undefined` when the input is blank.
 */
export function parseDocTarget(input: string): DocTarget | undefined {
	const trimmed = input.trim();
	if (trimmed === '') {
		return undefined;
	}
	const args = trimmed.split(/\s+/);
	return { args, label: args.join(' ') };
}

/**
 * Build the full `go doc` argv for an {@link execFile}-style call (never a shell).
 * @param target The resolved doc request.
 * @param showAll When true, pass `-all` for the exhaustive package/type dump.
 * @returns The argv, e.g. `['doc', '-all', 'net/http']`.
 */
export function buildGoDocArgs(target: DocTarget, showAll: boolean): string[] {
	return showAll ? ['doc', '-all', ...target.args] : ['doc', ...target.args];
}

/** One classified line (or grouped declaration block) of `go doc` output. */
export type DocLineKind = 'header' | 'section' | 'decl' | 'doc' | 'blank';

/** A typed line of `go doc` output — the model the HTML renderer consumes. */
export interface DocLine {
	readonly kind: DocLineKind;
	/** The line text; for a `decl` this may span multiple lines (a grouped block). */
	readonly text: string;
}

/** The all-caps standalone lines `go doc -all` uses as page sections. */
const SECTIONS = new Set(['CONSTANTS', 'VARIABLES', 'FUNCTIONS', 'TYPES', 'EXAMPLES', 'BUGS', 'SUBDIRECTORIES']);

/** A top-of-column declaration keyword (`func`/`type`/`const`/`var`). */
const DECL = /^(func|type|const|var)\b/;

/** The same keyword indented four spaces — a method/nested decl under `-all`. */
const DECL_INDENTED = /^ {4}(func|type|const|var)\b/;

/** A line that opens a multi-line block (`type X struct {`, `const (`). */
const OPENS_BLOCK = /[({]\s*$/;

/** The closing line of such a block, at column zero (`}` or `)`). */
const CLOSES_BLOCK = /^[)}]/;

/**
 * Classify raw `go doc` stdout into a typed line model. Column-zero declarations
 * that open a brace/paren are grouped with their body up to the closing line, so
 * a `type ... struct { ... }` renders as one code block rather than stray lines.
 * @param raw The stdout captured from `go doc`.
 * @returns The classified lines, in source order.
 */
export function classifyGoDoc(raw: string): DocLine[] {
	const lines = raw.replace(/\r\n?/g, '\n').split('\n');
	const out: DocLine[] = [];
	let seenHeader = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === '') {
			out.push({ kind: 'blank', text: '' });
			continue;
		}
		if (!seenHeader && line.startsWith('package ')) {
			out.push({ kind: 'header', text: line });
			seenHeader = true;
			continue;
		}
		if (SECTIONS.has(line)) {
			out.push({ kind: 'section', text: line });
			continue;
		}
		if (DECL.test(line)) {
			const block = [line];
			if (OPENS_BLOCK.test(line)) {
				while (i + 1 < lines.length) {
					i++;
					block.push(lines[i]);
					if (CLOSES_BLOCK.test(lines[i])) {
						break;
					}
				}
			}
			out.push({ kind: 'decl', text: block.join('\n') });
			continue;
		}
		if (DECL_INDENTED.test(line)) {
			out.push({ kind: 'decl', text: line.trimStart() });
			continue;
		}
		// A doc-comment line: drop one indent level (go doc uses a 4-space or tab lead).
		out.push({ kind: 'doc', text: line.replace(/^(?: {1,4}|\t)/, '') });
	}
	return out;
}

/**
 * Escape a string for safe inclusion in HTML text/attributes.
 * @param value The raw text.
 * @returns The escaped text.
 */
export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, ch => {
		switch (ch) {
			case '&': return '&amp;';
			case '<': return '&lt;';
			case '>': return '&gt;';
			case '"': return '&quot;';
			default: return '&#39;';
		}
	});
}

/**
 * Render raw `go doc` output into the self-contained HTML fragment the viewer
 * webview injects. All text is escaped; consecutive doc lines fold into one
 * paragraph, declarations become `<pre>` blocks, sections become `<h2>`.
 * @param raw The stdout captured from `go doc`.
 * @returns An HTML fragment (no scripts, safe under the webview CSP).
 */
export function renderDocHtml(raw: string): string {
	const lines = classifyGoDoc(raw);
	const parts: string[] = [];
	let doc: string[] = [];
	const flushDoc = () => {
		if (doc.length > 0) {
			parts.push(`<p class="doc">${doc.join('<br>')}</p>`);
			doc = [];
		}
	};
	for (const line of lines) {
		switch (line.kind) {
			case 'blank':
				flushDoc();
				break;
			case 'header':
				flushDoc();
				parts.push(`<div class="pkg">${escapeHtml(line.text)}</div>`);
				break;
			case 'section':
				flushDoc();
				parts.push(`<h2 class="section">${escapeHtml(line.text)}</h2>`);
				break;
			case 'decl':
				flushDoc();
				parts.push(`<pre class="decl">${escapeHtml(line.text)}</pre>`);
				break;
			case 'doc':
				doc.push(escapeHtml(line.text));
				break;
		}
	}
	flushDoc();
	return parts.join('\n');
}
