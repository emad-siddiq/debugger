/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// webPanel.ts — a panel that shows one of gopls' own web pages.
//
// The sibling of viewer.ts, and deliberately not the same thing. viewer.ts owns
// Burrow's offline `go doc` reader: it parses text, renders Burrow's own HTML and
// works with no server running. This panel shows a page gopls rendered — the
// pkg.go.dev-quality one, with cross-linked identifiers, rendered examples,
// per-symbol anchors and source links — by framing gopls' localhost server.
//
// What that buys, immediately and for the price of an <iframe>: the documentation
// browser, cross-linked identifiers and rendered examples rows, plus
// `source.assembly` (browse the compiled assembly for a function) and
// `source.freesymbols`, neither of which IntelliJ or Xcode offers for Go.
//
// What it costs, stated rather than discovered: the page belongs to gopls. It
// dies when gopls restarts, because the auth token in its path is per-session,
// and it renders Go's house typography rather than Burrow's. That is the reason
// the plan keeps a second route open — an owned renderer over `go/doc` — and the
// reason this file does not try to restyle what it frames. Reaching into a
// cross-origin frame to re-theme it is not possible, and pretending otherwise
// would produce a panel that looks broken in a light theme instead of one that
// honestly looks like gopls.

import {
	Disposable,
	ViewColumn,
	WebviewPanel,
	window,
} from 'vscode';

/** What burrow-go-base hands over — the shape of `parseGoplsWebPage`'s result. */
export interface GoplsWebPage {
	readonly url: string;
	readonly origin: string;
	readonly kind: 'doc' | 'assembly' | 'freesymbols' | 'other';
	readonly label: string;
}

export const WEB_VIEW_TYPE = 'burrowGoplsWeb';

/** Tab titles, so a doc page and an assembly listing are not both "gopls". */
const TITLES: Record<GoplsWebPage['kind'], string> = {
	doc: 'Go Docs',
	assembly: 'Assembly',
	freesymbols: 'Free Symbols',
	other: 'gopls',
};

/**
 * One reused panel for gopls' web pages. Reused rather than one-per-page for the
 * same reason viewer.ts reuses its own: reading documentation is a sequence of
 * hops, and a tab per hop turns the tab bar into the history.
 */
export class GoplsWebPanel implements Disposable {

	private panel: WebviewPanel | undefined;
	private readonly disposables: Disposable[] = [];

	/** Show a page, creating or revealing the panel. */
	show(page: GoplsWebPage): void {
		if (!this.panel) {
			this.panel = window.createWebviewPanel(
				WEB_VIEW_TYPE,
				TITLES[page.kind],
				ViewColumn.Active,
				{ enableScripts: true, retainContextWhenHidden: true },
			);
			this.panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.disposables);
		} else {
			this.panel.reveal(this.panel.viewColumn ?? ViewColumn.Active, false);
		}
		this.panel.title = `${TITLES[page.kind]} — ${page.label}`;
		this.panel.webview.html = html(page);
	}

	dispose(): void {
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
		this.disposables.length = 0;
	}

	// NO webview panel serializer, and that is a decision rather than an omission.
	//
	// gopls puts a per-session auth token in every URL it serves. Restoring this
	// panel after a window reload would frame a URL whose token gopls has already
	// forgotten, on a port it may not be listening on — a restored tab showing a
	// connection error, which is worse than a tab that is simply not there. The
	// page is one keystroke away from the editor it came from.
}

/**
 * The frame around gopls' page.
 *
 * The CSP is the whole of the security story and is worth reading closely.
 * `default-src 'none'` keeps the shell inert; `frame-src` is widened to exactly
 * gopls' own origin — the one measured from the URL it asked for, not a wildcard
 * over loopback — so a page on some other local port cannot be framed by a
 * crafted URL. The style block carries a nonce because a nonce-only `style-src`
 * silently drops every inline `style="…"` attribute, which is a trap this fork
 * has already paid for once.
 */
function html(page: GoplsWebPage): string {
	const n = nonce();
	const csp = [
		`default-src 'none'`,
		`frame-src ${page.origin}`,
		`style-src 'nonce-${n}'`,
		`script-src 'nonce-${n}'`,
	].join('; ');
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style nonce="${n}">
		:root { color-scheme: light dark; }
		html, body { height: 100%; margin: 0; }
		body { background: var(--vscode-editor-background); }
		iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
	</style>
</head>
<body>
	<iframe src="${escapeAttribute(page.url)}" title="${escapeAttribute(page.label)}"></iframe>
</body>
</html>`;
}

/** Escapes a value for an HTML attribute. The URL comes from gopls, but it also
 *  carries a symbol name that came from the user's own source. */
function escapeAttribute(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A per-render nonce for the CSP. */
function nonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return out;
}
