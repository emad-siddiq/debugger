/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit tests for the adapter-capability store. capabilities.ts
// imports nothing from 'vscode', so out/capabilities.js is a clean CommonJS
// module. Run: `npm test` or `node test/capabilities.test.js`.
//
// The last case starts a real `dlv dap` and asserts the store's answers against
// what Delve itself advertises. The whole point of this module is that the
// greyed-out reason in the breakpoint sheet is a measured fact, so a test that
// only fed it a fixture would be asserting my memory of Delve, not Delve.

'use strict';

const assert = require('node:assert');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { AdapterCapabilities, adapterNameFrom } = require('../out/capabilities');

const cases = {
	'before any session, a field is offered but the claim is marked unconfirmed': () => {
		const caps = new AdapterCapabilities();
		assert.strictEqual(caps.known, false);
		const support = caps.support('hitCondition');
		assert.strictEqual(support.supported, true, 'the workbench offers it, and so do we');
		assert.match(support.reason, /not yet confirmed/);
	},

	'an observed capability answers without a reason': () => {
		const caps = new AdapterCapabilities();
		caps.record({ supportsConditionalBreakpoints: true });
		assert.deepStrictEqual(caps.support('condition'), { supported: true });
	},

	'an absent capability is a no, with the adapter named': () => {
		const caps = new AdapterCapabilities();
		caps.record({ supportsConditionalBreakpoints: true });
		caps.nameAdapter('Delve 1.25.2');
		const support = caps.support('hitCondition');
		assert.strictEqual(support.supported, false);
		assert.strictEqual(support.reason, 'Delve 1.25.2 does not support hit-count breakpoints');
	},

	'naming the adapter later does not erase what it said': () => {
		// The version arrives in an output event after the initialize response.
		// Folding the two calls together would blank the capabilities and grey
		// every field with a reason saying the adapter cannot do what it just
		// said it could.
		const caps = new AdapterCapabilities();
		caps.record({ supportsConditionalBreakpoints: true });
		caps.nameAdapter('Delve 1.25.2');
		assert.strictEqual(caps.support('condition').supported, true);
	},

	'a non-object body is ignored rather than recorded as "knows nothing"': () => {
		const caps = new AdapterCapabilities();
		caps.record(null);
		caps.record('nonsense');
		caps.record([1, 2, 3]);
		assert.strictEqual(caps.known, false);
	},

	'the adapter name is read out of Delve\'s own banner': () => {
		assert.strictEqual(
			adapterNameFrom('Delve Debugger\nVersion: 1.25.2\nBuild: $Id: abc $\n'),
			'Delve 1.25.2',
		);
		assert.strictEqual(adapterNameFrom('unrelated output'), undefined);
		assert.strictEqual(adapterNameFrom(undefined), undefined);
	},

	// -- against the real adapter ---------------------------------------------
	'the store\'s answers match what a live `dlv dap` advertises': async () => {
		const dlv = resolveDlv();
		if (!dlv) {
			console.log(
				'  ⚠ SKIPPED — dlv not found in GOBIN, GOPATH/bin or PATH.\n' +
				'    This case asserts Delve\'s own capabilities; install dlv to check them.',
			);
			return;
		}
		const body = await initializeDlv(dlv);
		const caps = new AdapterCapabilities();
		caps.record(body);
		caps.nameAdapter('Delve');

		// What Delve supports — the fields the sheet may offer.
		assert.strictEqual(caps.support('condition').supported, true, 'Delve advertises conditional breakpoints');
		assert.strictEqual(caps.support('logMessage').supported, true, 'Delve advertises logpoints');
		assert.strictEqual(caps.support('functionBreakpoint').supported, true, 'Delve advertises function breakpoints');

		// What it does not — the field that must be greyed with a reason. If a
		// re-pinned Delve ever gains this, the sheet stops greying it on its own
		// and this assertion is what says so.
		assert.strictEqual(
			caps.support('hitCondition').supported, false,
			'Delve advertised hit-count breakpoints; the sheet no longer needs to grey them',
		);

		// Recorded for the survey: neither is reachable through this sheet, and
		// both were specified in 04-delve-debugging-engine.md.
		assert.strictEqual(
			body.supportsDataBreakpoints ?? false, false,
			'Delve advertised data breakpoints; watchpoints are now buildable',
		);
		assert.ok(
			!body.exceptionBreakpointFilters || body.exceptionBreakpointFilters.length === 0,
			'Delve advertised exception filters; a panic-breakpoint section is now buildable',
		);
		console.log('      (live dlv: condition ✓ logpoint ✓ function ✓ · hitCondition ✗ dataBreakpoints ✗ exceptionFilters none)');
	},
};

/** Same probe order as burrow-go-debug's resolveDelve. */
function resolveDlv() {
	const env = process.env;
	const candidates = [
		env.BURROW_DLV_PATH,
		env.GOBIN && path.join(env.GOBIN, 'dlv'),
		env.GOPATH && path.join(env.GOPATH, 'bin', 'dlv'),
		env.HOME && path.join(env.HOME, 'go', 'bin', 'dlv'),
	].filter(Boolean);
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	for (const dir of (env.PATH ?? '').split(path.delimiter)) {
		const candidate = path.join(dir, 'dlv');
		if (dir && fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/** Starts `dlv dap`, sends `initialize`, resolves with the capabilities body. */
function initializeDlv(dlvPath) {
	return new Promise((resolve, reject) => {
		const dlv = spawn(dlvPath, ['dap', '--listen=127.0.0.1:0'], { stdio: ['ignore', 'pipe', 'pipe'] });
		const timer = setTimeout(() => { dlv.kill(); reject(new Error('dlv did not answer initialize in 15s')); }, 15000);
		let banner = '';
		dlv.stdout.on('data', chunk => {
			banner += chunk.toString();
			const m = /DAP server listening at:\s*([^:\s]+):(\d+)/.exec(banner);
			if (!m) { return; }
			banner = '';
			const sock = net.connect(Number(m[2]), m[1], () => {
				const payload = Buffer.from(JSON.stringify({
					seq: 1, type: 'request', command: 'initialize',
					arguments: { clientID: 'burrow-test', adapterID: 'go', linesStartAt1: true, columnsStartAt1: true },
				}), 'utf8');
				sock.write(`Content-Length: ${payload.length}\r\n\r\n`);
				sock.write(payload);
			});
			let buf = Buffer.alloc(0);
			sock.on('data', chunk2 => {
				buf = Buffer.concat([buf, chunk2]);
				for (;;) {
					const end = buf.indexOf('\r\n\r\n');
					if (end < 0) { return; }
					const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, end).toString())?.[1]);
					if (!Number.isFinite(len) || buf.length < end + 4 + len) { return; }
					const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString('utf8'));
					buf = buf.subarray(end + 4 + len);
					if (msg.type === 'response' && msg.command === 'initialize') {
						clearTimeout(timer);
						sock.destroy();
						dlv.kill();
						resolve(msg.body ?? {});
						return;
					}
				}
			});
			sock.on('error', err => { clearTimeout(timer); dlv.kill(); reject(err); });
		});
		dlv.on('error', err => { clearTimeout(timer); reject(err); });
	});
}

(async () => {
	let failed = 0;
	for (const [name, run] of Object.entries(cases)) {
		try {
			await run();
			console.log(`  ✓ ${name}`);
		} catch (err) {
			failed++;
			console.error(`  ✗ ${name}\n    ${err.message}`);
		}
	}
	const total = Object.keys(cases).length;
	console.log(`${total - failed}/${total} passed`);
	process.exit(failed === 0 ? 0 : 1);
})();
