/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the pure response renderer. render.ts imports nothing from
// 'vscode', so out/render.js is a clean CommonJS module we require directly. Run:
// `npm test` (after a compile) or `node test/render.test.js`.

'use strict';

const assert = require('node:assert');
const { escapeHtml, formatBody, formatSize, statusClass, renderResponse, renderError } = require('../out/render');

const cases = {
	'escapeHtml neutralizes the five significant characters': () => {
		assert.strictEqual(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
	},
	'formatBody pretty-prints JSON when content-type is JSON': () => {
		const out = formatBody('{"a":1}', [['Content-Type', 'application/json']]);
		assert.strictEqual(out, '{\n  "a": 1\n}');
	},
	'formatBody leaves non-JSON bodies untouched': () => {
		assert.strictEqual(formatBody('plain text', [['Content-Type', 'text/plain']]), 'plain text');
	},
	'formatBody falls back to raw on invalid JSON': () => {
		assert.strictEqual(formatBody('{not json', [['content-type', 'application/json']]), '{not json');
	},
	'formatSize scales bytes to B/KB/MB': () => {
		assert.strictEqual(formatSize(512), '512 B');
		assert.strictEqual(formatSize(2048), '2.0 KB');
		assert.strictEqual(formatSize(3 * 1024 * 1024), '3.0 MB');
	},
	'statusClass buckets by status range': () => {
		assert.strictEqual(statusClass(200), 'ok');
		assert.strictEqual(statusClass(301), 'redirect');
		assert.strictEqual(statusClass(404), 'error');
		assert.strictEqual(statusClass(500), 'error');
	},
	'renderResponse shows status chip, headers and body': () => {
		const html = renderResponse({
			status: 200,
			statusText: 'OK',
			headers: [['content-type', 'application/json']],
			body: '{"id":7}',
			durationMs: 12,
		});
		assert.ok(html.includes('chip ok'));
		assert.ok(html.includes('200 OK'));
		assert.ok(html.includes('12 ms'));
		assert.ok(html.includes('content-type'));
		assert.ok(html.includes('&quot;id&quot;: 7'));
	},
	'renderResponse escapes a body that contains markup': () => {
		const html = renderResponse({ status: 200, statusText: 'OK', headers: [], body: '<script>alert(1)</script>', durationMs: 1 });
		assert.ok(!html.includes('<script>alert(1)</script>'));
		assert.ok(html.includes('&lt;script&gt;'));
	},
	'renderError produces a failed chip with the escaped message': () => {
		const html = renderError('getaddrinfo ENOTFOUND <host>');
		assert.ok(html.includes('chip error'));
		assert.ok(html.includes('ENOTFOUND &lt;host&gt;'));
	},
};

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
	try {
		fn();
		console.log(`ok   — ${name}`);
	} catch (err) {
		failed++;
		console.error(`FAIL — ${name}\n       ${err.message}`);
	}
}

const total = Object.keys(cases).length;
console.log(`\n${total - failed}/${total} passed`);
if (failed > 0) {
	process.exit(1);
}
