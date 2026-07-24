/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../util/dispose';

/**
 * Blocks larger than this fall back to highlight.js — full TextMate
 * tokenization of huge pastes is not worth the latency.
 */
const maxHighlightedSourceLength = 50_000;

/** Cleared wholesale once it grows past this many fenced blocks. */
const maxCacheEntries = 200;

/**
 * Maps common fence info strings to VS Code language ids. Anything not listed
 * here must already BE a language id (checked against `languages.getLanguages()`)
 * to get the TextMate treatment; otherwise the highlight.js fallback applies.
 */
const fenceLangToLanguageId = new Map<string, string>([
	['golang', 'go'],
	['py', 'python'],
	['py3', 'python'],
	['python3', 'python'],
	['rs', 'rust'],
	['js', 'javascript'],
	['jsx', 'javascriptreact'],
	['javascriptreact', 'javascriptreact'],
	['ts', 'typescript'],
	['tsx', 'typescriptreact'],
	['typescriptreact', 'typescriptreact'],
	['sh', 'shellscript'],
	['bash', 'shellscript'],
	['zsh', 'shellscript'],
	['shell', 'shellscript'],
	['console', 'shellscript'],
	['yml', 'yaml'],
	['json5', 'jsonc'],
	['jsonc', 'jsonc'],
	['docker', 'dockerfile'],
	['make', 'makefile'],
	['md', 'markdown'],
]);

function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, ch => {
		switch (ch) {
			case '&': return '&amp;';
			case '<': return '&lt;';
			case '>': return '&gt;';
			default: return '&quot;';
		}
	});
}

/**
 * Inline styles mirror the `SyntaxHighlightingTokenFontStyle` bitmask
 * (Italic = 1, Bold = 2, Underline = 4, Strikethrough = 8).
 */
function fontStyleCss(fontStyle: number): string {
	const declarations: string[] = [];
	if (fontStyle & 1) { declarations.push('font-style:italic'); }
	if (fontStyle & 2) { declarations.push('font-weight:bold'); }
	const decorations: string[] = [];
	if (fontStyle & 4) { decorations.push('underline'); }
	if (fontStyle & 8) { decorations.push('line-through'); }
	if (decorations.length) { declarations.push(`text-decoration:${decorations.join(' ')}`); }
	return declarations.join(';');
}

function tokensToHtml(source: string, result: vscode.SyntaxHighlightingResult): string {
	let html = '';
	let pos = 0;
	for (const token of result.tokens) {
		const text = escapeHtml(source.substr(pos, token.length));
		pos += token.length;

		const styles: string[] = [];
		const color = token.foreground > 0 ? result.colorMap[token.foreground] : undefined;
		if (color) {
			styles.push(`color:${color}`);
		}
		const fontStyle = fontStyleCss(token.fontStyle);
		if (fontStyle) {
			styles.push(fontStyle);
		}
		html += styles.length ? `<span style="${styles.join(';')}">${text}</span>` : text;
	}
	return html;
}

/** True when tokenization produced actual coloring, not one flat default run. */
function hasColoring(result: vscode.SyntaxHighlightingResult): boolean {
	const foregrounds = new Set<number>();
	for (const token of result.tokens) {
		foregrounds.add(token.foreground);
		if (foregrounds.size > 1) {
			return true;
		}
	}
	return false;
}

/**
 * Theme-true highlighting for the preview's fenced code blocks, powered by the
 * `documentSyntaxHighlighting` proposed API (installed TextMate grammars +
 * active color theme) — the same mechanism the experimental WYSIWYG editor uses.
 *
 * markdown-it's `highlight` callback is synchronous, so blocks are tokenized
 * up front ({@link prepare}, awaited by `MarkdownItEngine.render`) into a cache
 * the callback then reads ({@link getCachedHtml}). Cache misses — unknown
 * languages, uncolored results, oversized blocks — fall back to highlight.js.
 */
export class FencedCodeHighlighter extends Disposable {

	/** `<fence lang> <source>` → themed HTML spans (inline styles). */
	readonly #cache = new Map<string, string>();

	constructor() {
		super();
		this._register(vscode.languages.onDidChangeSyntaxHighlighting(() => {
			this.#cache.clear();
		}));
	}

	public async prepare(fences: ReadonlyArray<{ readonly info: string; readonly content: string }>): Promise<void> {
		const pending = fences.filter(fence =>
			fence.content.length <= maxHighlightedSourceLength && !this.#cache.has(this.#key(fence.info, fence.content)));
		if (!pending.length) {
			return;
		}

		const knownLanguages = new Set(await vscode.languages.getLanguages());
		await Promise.all(pending.map(async fence => {
			const languageId = this.#resolveLanguageId(fence.info, knownLanguages);
			if (!languageId) {
				return;
			}
			try {
				const result = await vscode.languages.computeFullSyntaxHighlighting(fence.content, languageId);
				if (hasColoring(result)) {
					if (this.#cache.size >= maxCacheEntries) {
						this.#cache.clear();
					}
					this.#cache.set(this.#key(fence.info, fence.content), tokensToHtml(fence.content, result));
				}
			} catch {
				// Fall back to highlight.js
			}
		}));
	}

	public getCachedHtml(source: string, fenceLang: string | undefined): string | undefined {
		return this.#cache.get(this.#key(fenceLang ?? '', source));
	}

	#key(info: string, source: string): string {
		return `${this.#fenceLang(info)} ${source}`;
	}

	#fenceLang(info: string): string {
		return info.trim().split(/\s+/)[0].toLowerCase();
	}

	#resolveLanguageId(info: string, knownLanguages: ReadonlySet<string>): string | undefined {
		const fenceLang = this.#fenceLang(info);
		if (!fenceLang) {
			return undefined;
		}
		const languageId = fenceLangToLanguageId.get(fenceLang) ?? fenceLang;
		return knownLanguages.has(languageId) ? languageId : undefined;
	}
}
