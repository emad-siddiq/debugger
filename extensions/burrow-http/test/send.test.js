/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit test for the send engine. send.ts takes fetch through an injectable
// `FetchLike` interface, so we drive it with a fake — no network, no 'vscode'. Run:
// `npm test` (after a compile) or `node test/send.test.js`.

'use strict';

const assert = require('node:assert');
const { sendRequest } = require('../out/send');

/** A fake fetch that records the call and returns a canned response. */
function fakeFetch(response) {
	const calls = [];
	const impl = (url, init) => {
		calls.push({ url, init });
		return Promise.resolve(Object.assign({
			status: 200,
			statusText: 'OK',
			headers: { forEach(cb) { cb('application/json', 'content-type'); } },
			text() { return Promise.resolve('{}'); },
		}, response));
	};
	return { impl, calls };
}

const cases = {
	'sends method, url, and header object to fetch': async () => {
		const { impl, calls } = fakeFetch();
		await sendRequest({ method: 'GET', url: 'http://x/y', headers: [['Accept', 'json']], body: '' }, { fetchImpl: impl });
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].url, 'http://x/y');
		assert.strictEqual(calls[0].init.method, 'GET');
		assert.deepStrictEqual(calls[0].init.headers, { Accept: 'json' });
	},
	'GET drops the body even when one is present': async () => {
		const { impl, calls } = fakeFetch();
		await sendRequest({ method: 'GET', url: 'http://x', headers: [], body: 'nope' }, { fetchImpl: impl });
		assert.strictEqual(calls[0].init.body, undefined);
	},
	'POST forwards a non-empty body': async () => {
		const { impl, calls } = fakeFetch();
		await sendRequest({ method: 'POST', url: 'http://x', headers: [], body: '{"a":1}' }, { fetchImpl: impl });
		assert.strictEqual(calls[0].init.body, '{"a":1}');
	},
	'empty header keys are dropped from the header object': async () => {
		const { impl, calls } = fakeFetch();
		await sendRequest({ method: 'GET', url: 'http://x', headers: [['', 'orphan'], ['X', '1']], body: '' }, { fetchImpl: impl });
		assert.deepStrictEqual(calls[0].init.headers, { X: '1' });
	},
	'captures status, statusText, headers and body from the response': async () => {
		const { impl } = fakeFetch({
			status: 201,
			statusText: 'Created',
			headers: { forEach(cb) { cb('42', 'content-length'); cb('application/json', 'content-type'); } },
			text() { return Promise.resolve('{"id":7}'); },
		});
		const result = await sendRequest({ method: 'POST', url: 'http://x', headers: [], body: '{}' }, { fetchImpl: impl });
		assert.strictEqual(result.status, 201);
		assert.strictEqual(result.statusText, 'Created');
		assert.deepStrictEqual(result.headers, [['content-length', '42'], ['content-type', 'application/json']]);
		assert.strictEqual(result.body, '{"id":7}');
		assert.strictEqual(typeof result.durationMs, 'number');
	},
	'throws a clear error when no fetch implementation exists': async () => {
		const saved = globalThis.fetch;
		delete globalThis.fetch;
		try {
			await assert.rejects(
				() => sendRequest({ method: 'GET', url: 'http://x', headers: [], body: '' }),
				/No fetch implementation/,
			);
		} finally {
			globalThis.fetch = saved;
		}
	},
};

(async () => {
	let failed = 0;
	for (const [name, fn] of Object.entries(cases)) {
		try {
			await fn();
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
})();
