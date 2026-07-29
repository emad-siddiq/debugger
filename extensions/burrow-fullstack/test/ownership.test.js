/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Port ownership for the Full Stack compound (WO-61 §1). `ownershipOf` and the
// message builders are pure — the only parts that touch the machine are
// `listenerOn`'s `lsof`/`ps` calls, which are covered by driving the compound
// against a real foreign listener rather than here.
// Run: `npm test` (after a compile) or `node test/ownership.test.js`.

'use strict';

const assert = require('node:assert');
const {
	ownershipOf, describeListener, foreignPortMessage, noListenerMessage, hostPortOfUrl, sameOrigin,
} = require('../out/ownership');

const closed = { open: false };
const open = (pid, command) => ({ open: true, pid, command });

const cases = {
	// The case this whole module exists for.
	'a port already held before we launch is foreign, whatever happens after': () => {
		assert.strictEqual(ownershipOf(open(38596, 'nodewatch-api'), open(38596, 'nodewatch-api')), 'foreign');
		// Even if OUR process somehow replaced theirs, we did not establish that.
		assert.strictEqual(ownershipOf(open(1), open(2)), 'foreign');
	},
	'closed before, open after, is ours': () => {
		assert.strictEqual(ownershipOf(closed, open(999, 'backend')), 'ours');
		assert.strictEqual(ownershipOf(closed, { open: true }), 'ours');
	},
	'closed before and still closed after is unknown, never ours': () => {
		assert.strictEqual(ownershipOf(closed, closed), 'unknown');
	},
	'every before/after pair has a verdict': () => {
		for (const before of [closed, open(1)]) {
			for (const after of [closed, open(2)]) {
				assert.ok(['ours', 'foreign', 'unknown'].includes(ownershipOf(before, after)),
					`no verdict for ${JSON.stringify({ before, after })}`);
			}
		}
	},

	'a listener is described so a person can act on it': () => {
		assert.strictEqual(describeListener(open(38596, '/usr/local/bin/nodewatch-api')), 'pid 38596 (nodewatch-api)');
		assert.strictEqual(describeListener(open(38596)), 'pid 38596');
		assert.strictEqual(describeListener({ open: true }), 'a process this tool could not identify');
		assert.strictEqual(describeListener(closed), 'nothing');
	},
	'the foreign-port message names the holder, the consequence and both ways out': () => {
		const msg = foreignPortMessage('http://127.0.0.1:8080/healthz', 8080, open(38596, 'nodewatch-api'));
		assert.match(msg, /pid 38596 \(nodewatch-api\)/);
		assert.match(msg, /LAUNCHES/);
		assert.match(msg, /breakpoints would never be hit/);   // why it matters, not just that it happened
		assert.match(msg, /kill 38596/);                        // one way out, with the actual pid
		assert.match(msg, /attach configuration/);              // the other
	},
	'the foreign-port message degrades without a pid': () => {
		const msg = foreignPortMessage('http://127.0.0.1:8080/healthz', 8080, { open: true });
		assert.match(msg, /kill <pid>/);
		assert.ok(!msg.includes('undefined'), 'a message with "undefined" in it teaches nothing');
	},
	'the no-listener message still blames the likely cause': () => {
		assert.match(noListenerMessage('http://127.0.0.1:8080/healthz', 300), /halted at a breakpoint/);
	},

	'a health URL resolves to the port to watch': () => {
		assert.deepStrictEqual(hostPortOfUrl('http://127.0.0.1:8080/healthz'), { host: '127.0.0.1', port: 8080 });
		assert.deepStrictEqual(hostPortOfUrl('http://localhost/healthz'), { host: 'localhost', port: 80 });
		assert.deepStrictEqual(hostPortOfUrl('https://example.test/healthz'), { host: 'example.test', port: 443 });
	},
	'an unparseable or absent health URL yields nothing rather than a guess': () => {
		assert.strictEqual(hostPortOfUrl(''), undefined);
		assert.strictEqual(hostPortOfUrl(undefined), undefined);
		assert.strictEqual(hostPortOfUrl('not a url'), undefined);
	},

	// The join (§2). A different PORT is the disagreement that mattered: the
	// compound serves the app on the sidecar's 5180 while merkle's launch config
	// hard-codes 5173, so Chrome opened a dead port and nothing bound.
	'a different port is a different server — the bug that broke the join': () => {
		assert.strictEqual(sameOrigin('http://localhost:5173/watch/app/', 'http://localhost:5180/'), false);
	},
	'a different path is NOT a disagreement worth overriding': () => {
		assert.strictEqual(sameOrigin('http://localhost:5180/watch/app/', 'http://localhost:5180/'), true);
	},
	'localhost and 127.0.0.1 are the same host': () => {
		assert.strictEqual(sameOrigin('http://127.0.0.1:5180/', 'http://localhost:5180/'), true);
		assert.strictEqual(sameOrigin('http://[::1]:5180/', 'http://localhost:5180/'), true);
	},
	'a default port equals the explicit one': () => {
		assert.strictEqual(sameOrigin('http://localhost/', 'http://localhost:80/'), true);
		assert.strictEqual(sameOrigin('https://x.test/', 'https://x.test:443/'), true);
	},
	'protocol still separates them': () => {
		assert.strictEqual(sameOrigin('http://localhost:5180/', 'https://localhost:5180/'), false);
	},
	'a missing or unparseable side is never "the same"': () => {
		assert.strictEqual(sameOrigin(undefined, 'http://localhost:5180/'), false);
		assert.strictEqual(sameOrigin('nonsense', 'http://localhost:5180/'), false);
	},
};

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
	try {
		fn();
		console.log('  ok  ' + name);
	} catch (err) {
		failed++;
		console.error('FAIL  ' + name + '\n      ' + (err && err.message));
	}
}
if (failed) {
	console.error('\n' + failed + ' ownership test(s) failed');
	process.exit(1);
}
console.log('\nAll ' + Object.keys(cases).length + ' ownership tests passed');
