/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// render.ts — pure HTML builders for the response viewer (architecture task 09, task 4:
// the "response viewer" — status chips, headers table, body). Kept vscode-import-free so
// the escaping and body-formatting logic is unit-testable standalone; the webview
// (workbench.ts) injects the returned fragment into a nonce-guarded page. Everything
// user- or server-controlled is HTML-escaped, so the fragment is safe to `innerHTML`.

import { SendResult } from './send';

/** Cap the rendered body so a huge response can't wedge the webview (task: "size guards"). */
const MAX_BODY_CHARS = 200_000;

/** Escape the five HTML-significant characters so untrusted text can't inject markup. */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** True when a `Content-Type` (or its value) names a JSON media type. */
function isJsonContentType(headers: ReadonlyArray<readonly [string, string]>): boolean {
	for (const [key, value] of headers) {
		if (key.toLowerCase() === 'content-type') {
			return /\bjson\b/i.test(value);
		}
	}
	return false;
}

/**
 * Pretty-print a body for display: JSON responses are re-indented (2 spaces) when they
 * parse; everything else passes through unchanged. Non-parsing "JSON" falls back to raw
 * text rather than throwing.
 */
export function formatBody(body: string, headers: ReadonlyArray<readonly [string, string]>): string {
	if (isJsonContentType(headers) && body.trim() !== '') {
		try {
			return JSON.stringify(JSON.parse(body), null, 2);
		} catch {
			return body;
		}
	}
	return body;
}

/** Human-readable byte size (`823 B`, `4.2 KB`, `1.7 MB`) for the size chip. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Bucket an HTTP status into a CSS class name for coloring the status chip. */
export function statusClass(status: number): string {
	if (status >= 200 && status < 300) {
		return 'ok';
	}
	if (status >= 300 && status < 400) {
		return 'redirect';
	}
	if (status >= 400) {
		return 'error';
	}
	return 'info';
}

/**
 * Build the escaped HTML fragment for a completed response: a chip row (status, timing,
 * size), the headers table, and the (formatted, truncated-safe) body block. Returns a
 * fragment — the caller drops it into a nonce-guarded page.
 */
export function renderResponse(result: SendResult): string {
	const byteLength = Buffer.byteLength(result.body, 'utf8');
	const formatted = formatBody(result.body, result.headers);
	const truncated = formatted.length > MAX_BODY_CHARS;
	const shown = truncated ? formatted.slice(0, MAX_BODY_CHARS) : formatted;

	const chips = [
		`<span class="chip ${statusClass(result.status)}">${result.status} ${escapeHtml(result.statusText)}</span>`,
		`<span class="chip">${result.durationMs} ms</span>`,
		`<span class="chip">${escapeHtml(formatSize(byteLength))}</span>`,
	].join('');

	const headerRows = result.headers
		.map(([key, value]) => `<tr><td class="hk">${escapeHtml(key)}</td><td class="hv">${escapeHtml(value)}</td></tr>`)
		.join('');

	const bodyNote = truncated
		? `<div class="note">Body truncated to ${MAX_BODY_CHARS.toLocaleString()} characters (${escapeHtml(formatSize(byteLength))} total).</div>`
		: '';

	return `
		<div class="chips">${chips}</div>
		<h3>Headers</h3>
		<table class="headers">${headerRows || '<tr><td class="hk">(none)</td><td></td></tr>'}</table>
		<h3>Body</h3>
		${bodyNote}
		<pre class="body">${escapeHtml(shown) || '<span class="note">(empty body)</span>'}</pre>`;
}

/** Build the escaped HTML fragment shown when a send fails (DNS, connect, timeout, …). */
export function renderError(message: string): string {
	return `<div class="chips"><span class="chip error">Request failed</span></div><pre class="body">${escapeHtml(message)}</pre>`;
}
