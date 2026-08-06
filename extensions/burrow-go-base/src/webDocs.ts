/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// webDocs.ts — recognising gopls' own web server, so its pages can be shown
// inside Burrow instead of escaping to a browser.
//
// gopls renders pkg.go.dev-quality documentation itself: proper heading scale,
// cross-linked identifiers, rendered examples, per-symbol anchors, source links.
// It does not hand that back over LSP. It starts a small HTTP server, and asks
// the editor to open a URL via `window/showDocument` with `external: true`. The
// measured shape, from a live gopls v0.20.0:
//
//   { "uri": "http://127.0.0.1:62895/gopls/mTAPUFaJSk8/pkg/example.com/doc?view=1#Rect",
//     "external": true, "takeFocus": true }
//
// Answering that request by opening a system browser — which is what an editor
// with no handler does — is why Burrow's documentation row read ✗ while the
// renderer was already running on localhost.
//
// This module is pure: it imports nothing from 'vscode', so out/webDocs.js is a
// clean CommonJS module the standalone tests require directly, in the same shape
// as settings.ts and gopls.ts. It decides ONLY whether a URI is gopls' own, and
// what kind of page it is. Opening anything is the caller's job.
//
// On strictness: the interception has to be narrow. A handler that swallowed any
// http URL would quietly stop a genuine external link — a pkg.go.dev address in a
// hover, an issue tracker — from reaching the browser the reader expected, and
// the failure would be silent. So the test is loopback host, http scheme, and
// gopls' own `/gopls/<token>/` path prefix. Everything else is somebody else's.

/** The path segment gopls puts in front of every page it serves. */
const GOPLS_PREFIX = '/gopls/';

/**
 * Hosts that are unambiguously this machine. A hostname that merely *resolves*
 * to a loopback address does not count: the check is on the literal, because
 * resolution is not available here and would be a network call in a parser.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

/** Which of gopls' web views a URL points at. */
export type GoplsPageKind = 'doc' | 'assembly' | 'freesymbols' | 'other';

/** A recognised gopls web page. */
export interface GoplsWebPage {
	/** The full URL, unchanged — the caller loads exactly what gopls asked for. */
	readonly url: string;
	/** `http://127.0.0.1:62895` — what a frame-src has to allow. */
	readonly origin: string;
	/** Which view this is, for the panel's title and icon. */
	readonly kind: GoplsPageKind;
	/**
	 * A short human label: the import path for a doc page, else the view name.
	 * Never the auth token, which is a secret and is not something to put in a
	 * tab title.
	 */
	readonly label: string;
}

/**
 * Recognises a `window/showDocument` URI as one of gopls' own pages.
 *
 * Returns `undefined` for anything else — a non-loopback host, an https URL, a
 * `file:` URI, a path that is not gopls'. `undefined` means "not ours", and the
 * caller must fall through to the default handler rather than dropping it.
 */
export function parseGoplsWebPage(uri: string): GoplsWebPage | undefined {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return undefined;
	}
	// http only. gopls serves plaintext on loopback; an https URL claiming this
	// shape did not come from the server we started.
	if (parsed.protocol !== 'http:') {
		return undefined;
	}
	if (!LOOPBACK.has(parsed.hostname)) {
		return undefined;
	}
	if (!parsed.pathname.startsWith(GOPLS_PREFIX)) {
		return undefined;
	}

	// /gopls/<token>/<view>[/<rest>] — the token is gopls' per-session secret and
	// is deliberately never surfaced.
	const segments = parsed.pathname.slice(GOPLS_PREFIX.length).split('/');
	const view = segments[1] ?? '';
	const rest = segments.slice(2).filter(Boolean).join('/');

	if (view === 'pkg') {
		// The import path, plus the symbol anchor when gopls aimed at one, so the
		// tab says `net/http · Request` rather than repeating the package twice.
		const symbol = decodeURIComponent(parsed.hash.replace(/^#/, ''));
		return {
			url: uri,
			origin: parsed.origin,
			kind: 'doc',
			label: symbol ? `${rest} · ${symbol}` : rest || 'documentation',
		};
	}
	if (view === 'assembly') {
		return { url: uri, origin: parsed.origin, kind: 'assembly', label: parsed.searchParams.get('symbol') ?? 'assembly' };
	}
	if (view === 'freesymbols') {
		return { url: uri, origin: parsed.origin, kind: 'freesymbols', label: 'free symbols' };
	}
	// gopls gains views with every release (`/splitpkg`, `/gc-details`). Showing an
	// unrecognised one in the panel is right — the alternative is that a new gopls
	// feature silently opens a browser again, which is the bug this module fixes.
	return { url: uri, origin: parsed.origin, kind: 'other', label: view || 'gopls' };
}
