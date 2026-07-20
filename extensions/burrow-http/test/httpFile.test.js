/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the pure `.http` parser/interpolator. httpFile.ts imports
// nothing from 'vscode', so out/httpFile.js is a clean CommonJS module we require
// directly — no test harness, no workbench. Run: `npm test` (after a compile) or
// `node test/httpFile.test.js`.

'use strict';

const assert = require('node:assert');
const { parseHttpFile, resolveVariables, interpolate, resolveRequest } = require('../out/httpFile');

// The golden fixture: a small `.http` collection exercising @vars, {{}} interpolation,
// a headers block, a JSON body, a bare-URL request, and a named separator.
const FIXTURE = [
	'@host = localhost:8080',
	'@base = http://{{host}}',
	'',
	'### List users',
	'GET {{base}}/api/users HTTP/1.1',
	'Accept: application/json',
	'',
	'###',
	'POST {{base}}/api/users',
	'Content-Type: application/json',
	'Authorization: Bearer {{$env:TOKEN}}',
	'',
	'{',
	'  "name": "neo"',
	'}',
	'',
	'### health',
	'localhost:8080/healthz',
	'',
].join('\n');

const cases = {
	'splits requests on ### and counts them': () => {
		const file = parseHttpFile(FIXTURE);
		assert.strictEqual(file.requests.length, 3);
	},
	'collects @vars in order': () => {
		const file = parseHttpFile(FIXTURE);
		assert.deepStrictEqual(file.variables, [['host', 'localhost:8080'], ['base', 'http://{{host}}']]);
	},
	'first request: method, url, header, anchor line, name from ###': () => {
		const r = parseHttpFile(FIXTURE).requests[0];
		assert.strictEqual(r.method, 'GET');
		assert.strictEqual(r.url, '{{base}}/api/users');
		assert.deepStrictEqual(r.headers, [['Accept', 'application/json']]);
		assert.strictEqual(r.name, 'List users');
		assert.strictEqual(r.line, 4);
	},
	'POST request keeps the JSON body, trailing blank trimmed': () => {
		const r = parseHttpFile(FIXTURE).requests[1];
		assert.strictEqual(r.method, 'POST');
		assert.strictEqual(r.body, '{\n  "name": "neo"\n}');
		assert.strictEqual(r.headers.length, 2);
	},
	'bare-URL request defaults to GET, name falls back to METHOD URL': () => {
		const r = parseHttpFile(FIXTURE).requests[2];
		assert.strictEqual(r.method, 'GET');
		assert.strictEqual(r.url, 'localhost:8080/healthz');
		assert.strictEqual(r.name, 'health');
	},
	'HTTP/1.1 suffix is stripped from the request line': () => {
		const r = parseHttpFile('GET http://x/y HTTP/1.1\n').requests[0];
		assert.strictEqual(r.url, 'http://x/y');
	},
	'a request with no body has an empty body string': () => {
		const r = parseHttpFile('GET http://x\nAccept: */*\n').requests[0];
		assert.strictEqual(r.body, '');
	},
	'resolveVariables expands cross-references': () => {
		const file = parseHttpFile(FIXTURE);
		const vars = resolveVariables(file.variables);
		assert.deepStrictEqual(vars, { host: 'localhost:8080', base: 'http://localhost:8080' });
	},
	'interpolate replaces known vars and leaves unknown verbatim': () => {
		assert.strictEqual(interpolate('{{a}}/{{b}}', { variables: { a: '1' } }), '1/{{b}}');
	},
	'interpolate reads $env via the resolver': () => {
		const out = interpolate('Bearer {{$env:TOKEN}}', { variables: {}, env: n => (n === 'TOKEN' ? 'sekret' : undefined) });
		assert.strictEqual(out, 'Bearer sekret');
	},
	'interpolate leaves $secret placeholders untouched (later slice)': () => {
		assert.strictEqual(interpolate('{{$secret:api}}', { variables: {} }), '{{$secret:api}}');
	},
	'resolveRequest expands url, headers and body against the context': () => {
		const file = parseHttpFile(FIXTURE);
		const vars = resolveVariables(file.variables);
		const resolved = resolveRequest(file.requests[1], { variables: vars, env: () => 'T0K' });
		assert.strictEqual(resolved.url, 'http://localhost:8080/api/users');
		assert.deepStrictEqual(resolved.headers, [['Content-Type', 'application/json'], ['Authorization', 'Bearer T0K']]);
		assert.strictEqual(resolved.body, '{\n  "name": "neo"\n}');
	},
	'empty input yields no requests and no vars': () => {
		assert.deepStrictEqual(parseHttpFile(''), { variables: [], requests: [] });
	},
	'CRLF line endings parse the same as LF': () => {
		const r = parseHttpFile('GET http://x\r\nAccept: json\r\n\r\nbody\r\n').requests[0];
		assert.strictEqual(r.url, 'http://x');
		assert.deepStrictEqual(r.headers, [['Accept', 'json']]);
		assert.strictEqual(r.body, 'body');
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
