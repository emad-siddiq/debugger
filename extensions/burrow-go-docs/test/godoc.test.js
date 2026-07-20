/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the pure Go doc core (parse/args/classify/render).
// godoc.ts imports nothing from 'vscode', so out/godoc.js is a clean CommonJS
// module we require directly — no test harness, no workbench. Run: `npm test`
// (after a compile) or `node test/godoc.test.js`.

'use strict';

const assert = require('node:assert');
const {
	parseDocTarget,
	buildGoDocArgs,
	classifyGoDoc,
	renderDocHtml,
	escapeHtml,
} = require('../out/godoc');

// A representative `go doc` page: header, a func + its doc, a section, and a
// multi-line interface block whose body must group into one decl.
const SAMPLE = [
	'package fmt // import "fmt"',
	'',
	'func Println(a ...any) (n int, err error)',
	'    Println formats using the default formats.',
	'',
	'TYPES',
	'',
	'type Stringer interface {',
	'\tString() string',
	'}',
	'    Stringer is implemented by any value.',
].join('\n');

const cases = {
	'parseDocTarget: blank input yields undefined': () => {
		assert.strictEqual(parseDocTarget('   '), undefined);
	},
	'parseDocTarget: dotted form passes through as one token': () => {
		assert.deepStrictEqual(parseDocTarget('  net/http.HandleFunc '), {
			args: ['net/http.HandleFunc'],
			label: 'net/http.HandleFunc',
		});
	},
	'parseDocTarget: two-token form splits on whitespace': () => {
		assert.deepStrictEqual(parseDocTarget('net/http   HandleFunc'), {
			args: ['net/http', 'HandleFunc'],
			label: 'net/http HandleFunc',
		});
	},
	'buildGoDocArgs: concise by default': () => {
		assert.deepStrictEqual(buildGoDocArgs({ args: ['fmt', 'Println'], label: 'fmt Println' }, false), ['doc', 'fmt', 'Println']);
	},
	'buildGoDocArgs: -all when requested': () => {
		assert.deepStrictEqual(buildGoDocArgs({ args: ['net/http'], label: 'net/http' }, true), ['doc', '-all', 'net/http']);
	},
	'classifyGoDoc: header/decl/doc/section + grouped interface block': () => {
		assert.deepStrictEqual(classifyGoDoc(SAMPLE), [
			{ kind: 'header', text: 'package fmt // import "fmt"' },
			{ kind: 'blank', text: '' },
			{ kind: 'decl', text: 'func Println(a ...any) (n int, err error)' },
			{ kind: 'doc', text: 'Println formats using the default formats.' },
			{ kind: 'blank', text: '' },
			{ kind: 'section', text: 'TYPES' },
			{ kind: 'blank', text: '' },
			{ kind: 'decl', text: 'type Stringer interface {\n\tString() string\n}' },
			{ kind: 'doc', text: 'Stringer is implemented by any value.' },
		]);
	},
	'classifyGoDoc: CRLF is normalised': () => {
		const out = classifyGoDoc('package x\r\n\r\nfunc F()');
		assert.deepStrictEqual(out, [
			{ kind: 'header', text: 'package x' },
			{ kind: 'blank', text: '' },
			{ kind: 'decl', text: 'func F()' },
		]);
	},
	'classifyGoDoc: -all indented method reads as a decl': () => {
		const out = classifyGoDoc('    func (r *Request) ParseForm() error');
		assert.deepStrictEqual(out, [{ kind: 'decl', text: 'func (r *Request) ParseForm() error' }]);
	},
	'escapeHtml: all five metacharacters': () => {
		assert.strictEqual(escapeHtml(`<a href="x" foo='y'>&`), '&lt;a href=&quot;x&quot; foo=&#39;y&#39;&gt;&amp;');
	},
	'renderDocHtml: sections/decls/docs wrap and text is escaped': () => {
		const html = renderDocHtml(SAMPLE);
		assert.ok(html.includes('<div class="pkg">package fmt // import &quot;fmt&quot;</div>'), 'package header');
		assert.ok(html.includes('<h2 class="section">TYPES</h2>'), 'section heading');
		assert.ok(html.includes('<pre class="decl">func Println(a ...any) (n int, err error)</pre>'), 'func decl');
		assert.ok(html.includes('<p class="doc">Println formats using the default formats.</p>'), 'doc paragraph');
		assert.ok(html.includes('type Stringer interface {\n\tString() string\n}'), 'grouped interface block escaped inline');
	},
	'renderDocHtml: no unescaped angle brackets leak from doc text': () => {
		const html = renderDocHtml('package x\n\nfunc F(w <-chan int)');
		assert.ok(!html.includes('<-chan'), 'raw < must be escaped');
		assert.ok(html.includes('func F(w &lt;-chan int)'), 'escaped channel arrow');
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
