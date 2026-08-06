/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit tests for the gopls web-page recogniser. webDocs.ts imports
// nothing from 'vscode', so out/webDocs.js is a clean CommonJS module.
// Run: `npm test` or `node test/webDocs.test.js`.
//
// The URLs below are not invented. They are the shapes a live gopls v0.20.0
// asked for over `window/showDocument`, captured with a raw LSP handshake before
// any of this was written.

'use strict';

const assert = require('node:assert');
const { parseGoplsWebPage } = require('../out/webDocs');

// Measured: gopls.doc on `type Rect` in module example.com/doc.
const REAL_DOC = 'http://127.0.0.1:62895/gopls/mTAPUFaJSk8/pkg/example.com/doc?view=1#Rect';

const cases = {
	'the URL gopls actually asked for is recognised': () => {
		const page = parseGoplsWebPage(REAL_DOC);
		assert.ok(page, 'gopls own documentation URL must be recognised');
		assert.strictEqual(page.kind, 'doc');
		assert.strictEqual(page.origin, 'http://127.0.0.1:62895');
		assert.strictEqual(page.url, REAL_DOC, 'the URL is passed through byte-for-byte');
	},

	'the label carries the package and symbol, never the auth token': () => {
		const page = parseGoplsWebPage(REAL_DOC);
		assert.strictEqual(page.label, 'example.com/doc · Rect');
		assert.ok(!page.label.includes('mTAPUFaJSk8'),
			'the path token is a per-session secret and must not reach a tab title');
	},

	'a package with no anchor is labelled by its import path alone': () => {
		const page = parseGoplsWebPage('http://127.0.0.1:1/gopls/tok/pkg/net/http?view=1');
		assert.strictEqual(page.label, 'net/http');
	},

	'the other two web views are told apart': () => {
		assert.strictEqual(parseGoplsWebPage('http://127.0.0.1:1/gopls/tok/assembly?symbol=Rect.Area').kind, 'assembly');
		assert.strictEqual(parseGoplsWebPage('http://127.0.0.1:1/gopls/tok/assembly?symbol=Rect.Area').label, 'Rect.Area');
		assert.strictEqual(parseGoplsWebPage('http://127.0.0.1:1/gopls/tok/freesymbols?f=x').kind, 'freesymbols');
	},

	'a view gopls adds later is still shown, not dropped': () => {
		// The failure this avoids: a gopls re-pin adds a view, Burrow does not know
		// the name, and the page silently opens in a browser again — which is the
		// exact bug this module exists to fix.
		const page = parseGoplsWebPage('http://127.0.0.1:1/gopls/tok/splitpkg?pkg=x');
		assert.ok(page, 'an unknown gopls view must still be framed');
		assert.strictEqual(page.kind, 'other');
		assert.strictEqual(page.label, 'splitpkg');
	},

	'every loopback spelling is accepted': () => {
		for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
			assert.ok(parseGoplsWebPage(`http://${host}:8080/gopls/tok/pkg/x`), `${host} must be recognised`);
		}
	},

	// ---- The negative half. Each of these, if intercepted, silently breaks
	// something the reader asked for. ----

	'a link to somewhere else on the internet is NOT ours': () => {
		// A pkg.go.dev link in a hover is the default `linksInHover` behaviour.
		// Swallowing it would show a blank frame instead of opening a browser.
		assert.strictEqual(parseGoplsWebPage('https://pkg.go.dev/net/http#Request'), undefined);
		assert.strictEqual(parseGoplsWebPage('https://github.com/golang/go/issues/1'), undefined);
	},

	'a file URI is NOT ours': () => {
		// gopls sends `file:` through showDocument to jump to a declaration —
		// clicking a symbol on its own doc page does exactly this. Intercepting it
		// would break go-to-definition from the docs panel.
		assert.strictEqual(parseGoplsWebPage('file:///Users/x/go/src/main.go'), undefined);
	},

	'another server on loopback is NOT ours': () => {
		// A local dev server, a pprof UI, an embedded pgAdmin. Framing one of those
		// because it happens to be on loopback would be a hijack.
		assert.strictEqual(parseGoplsWebPage('http://127.0.0.1:3000/'), undefined);
		assert.strictEqual(parseGoplsWebPage('http://localhost:8080/debug/pprof/'), undefined);
	},

	'a non-loopback host with a gopls-shaped path is NOT ours': () => {
		// The reason the host check is on the literal: this URL has our path prefix
		// and is a remote machine.
		assert.strictEqual(parseGoplsWebPage('http://10.0.0.5:62895/gopls/tok/pkg/x'), undefined);
		assert.strictEqual(parseGoplsWebPage('http://evil.example/gopls/tok/pkg/x'), undefined);
	},

	'https on loopback is NOT ours': () => {
		// gopls serves plaintext. Something claiming this shape over TLS is not the
		// server we started.
		assert.strictEqual(parseGoplsWebPage('https://127.0.0.1:62895/gopls/tok/pkg/x'), undefined);
	},

	'garbage is not a URL and does not throw': () => {
		assert.strictEqual(parseGoplsWebPage(''), undefined);
		assert.strictEqual(parseGoplsWebPage('not a uri'), undefined);
		assert.strictEqual(parseGoplsWebPage('/gopls/tok/pkg/x'), undefined);
	},
};

let failed = 0;
for (const [name, run] of Object.entries(cases)) {
	try {
		run();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failed++;
		console.error(`  ✗ ${name}\n    ${err.message}`);
	}
}
const total = Object.keys(cases).length;
console.log(`${total - failed}/${total} passed`);
process.exit(failed === 0 ? 0 : 1);
