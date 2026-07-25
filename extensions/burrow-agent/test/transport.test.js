/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The CLI protocol, tested without the CLI. protocol.ts and transport.ts import
// nothing from 'vscode', so out/*.js are plain CommonJS modules; the spawn case
// runs test/fake-cli.js, which speaks the same stream-json and costs nothing.
// Run: `npm test` (after a compile) or `node test/transport.test.js`.

'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { parseEvent, buildArgs, scrubEnv, userMessageLine, BURROW_SYSTEM_PREAMBLE } = require('../out/protocol');
const { Transport, resolveCli } = require('../out/transport');

const FAKE_CLI = path.join(__dirname, 'fake-cli.js');

const cases = {
	'system/init yields the session to resume with': () => {
		assert.deepStrictEqual(parseEvent('{"type":"system","subtype":"init","session_id":"7b21"}'), { kind: 'session', id: '7b21' });
	},
	'other system subtypes (hook chatter) are not ours to render': () => {
		assert.strictEqual(parseEvent('{"type":"system","subtype":"hook_started","hook_name":"SessionStart"}'), undefined);
	},
	'a partial message yields a text delta': () => {
		const line = '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"po"}}}';
		assert.deepStrictEqual(parseEvent(line), { kind: 'delta', text: 'po' });
	},
	'non-text deltas (thinking, tool input) are skipped': () => {
		const line = '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}}';
		assert.strictEqual(parseEvent(line), undefined);
	},
	'an assistant message joins its text blocks and drops tool_use': () => {
		const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"a"},{"type":"tool_use","name":"Read"},{"type":"text","text":"b"}]}}';
		assert.deepStrictEqual(parseEvent(line), { kind: 'text', text: 'ab' });
	},
	'the result carries the answer, the cost and the token total': () => {
		const line = '{"type":"result","subtype":"success","is_error":false,"result":"pong","total_cost_usd":0.3,"duration_ms":3072,"usage":{"input_tokens":2,"output_tokens":5}}';
		assert.deepStrictEqual(parseEvent(line), { kind: 'result', text: 'pong', isError: false, costUsd: 0.3, durationMs: 3072, tokens: 7 });
	},
	'a failed result is marked as one': () => {
		const line = '{"type":"result","subtype":"error_during_execution","is_error":true,"result":""}';
		assert.strictEqual(parseEvent(line).isError, true);
	},
	'a rate-limit warning is surfaced, not hidden': () => {
		const line = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","utilization":0.81}}';
		assert.deepStrictEqual(parseEvent(line), { kind: 'rateLimit', status: 'allowed_warning', utilization: 0.81 });
	},
	'garbage and blank lines are silence, never a throw': () => {
		for (const line of ['', '   ', 'SessionEnd hook failed: no such file', '{"type":', '{}', 'null']) {
			assert.strictEqual(parseEvent(line), undefined, line);
		}
	},

	'the argument vector is print + stream-json both ways, with plan mode enforced': () => {
		const args = buildArgs({ preamble: 'P' });
		for (const flag of ['--print', '--input-format', '--output-format', '--include-partial-messages', '--verbose']) {
			assert.ok(args.includes(flag), flag);
		}
		assert.strictEqual(args[args.indexOf('--permission-mode') + 1], 'plan');
		assert.strictEqual(args[args.indexOf('--disallowedTools') + 1], 'Edit,Write,MultiEdit,NotebookEdit');
		assert.strictEqual(args[args.indexOf('--append-system-prompt') + 1], 'P');
	},
	'resume and model are only passed when there is one': () => {
		const bare = buildArgs({ preamble: 'P' });
		assert.ok(!bare.includes('--resume') && !bare.includes('--model'));
		const full = buildArgs({ preamble: 'P', resume: 'abc', model: 'sonnet' });
		assert.strictEqual(full[full.indexOf('--resume') + 1], 'abc');
		assert.strictEqual(full[full.indexOf('--model') + 1], 'sonnet');
	},
	'the preamble tells the model it is advisory and in a narrow column': () => {
		assert.match(BURROW_SYSTEM_PREAMBLE, /never write, edit, or create files/);
	},
	'every ANTHROPIC_ override is stripped from the child environment': () => {
		const env = scrubEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_MODEL: 'm' });
		assert.deepStrictEqual(env, { PATH: '/bin', HOME: '/h' });
	},
	'a user turn is one JSON line the CLI accepts': () => {
		const line = userMessageLine('why is the dot misaligned?');
		assert.ok(line.endsWith('\n'));
		assert.deepStrictEqual(JSON.parse(line), {
			type: 'user',
			message: { role: 'user', content: [{ type: 'text', text: 'why is the dot misaligned?' }] },
		});
	},
	'a configured cliPath that exists is used as given': () => {
		assert.strictEqual(resolveCli(process.execPath), process.execPath);
	},
	'a configured cliPath that is NOT there resolves to nothing, so the panel can offer the setting': () => {
		assert.strictEqual(resolveCli(path.join(__dirname, 'no-such-claude')), undefined);
	},
	'a bare command name is looked up on PATH': () => {
		const saved = process.env.PATH;
		process.env.PATH = path.dirname(process.execPath);
		try {
			assert.strictEqual(resolveCli(path.basename(process.execPath)), process.execPath);
			assert.strictEqual(resolveCli('definitely-not-a-command'), undefined);
		} finally {
			process.env.PATH = saved;
		}
	},
	'with nothing configured and nothing on PATH, only the installer location is left': () => {
		const saved = process.env.PATH;
		process.env.PATH = '/nonexistent-burrow-test';
		try {
			// A machine WITH the CLI installed legitimately finds it there.
			const found = resolveCli('');
			assert.ok(found === undefined || found.endsWith('/.local/bin/claude'));
		} finally {
			process.env.PATH = saved;
		}
	},
};

/** The one case that spawns a process: a whole turn against the fake CLI, which
 *  proves the parts no pure test can — that stdin reaches the child, that a
 *  stdout chunk split mid-line still parses, and that the turn ends. */
async function roundTrip() {
	const seen = [];
	const transport = new Transport({ cwd: __dirname, cliPath: FAKE_CLI, model: '' }, (e) => seen.push(e));
	transport.send('ping');
	await new Promise((resolve) => {
		const started = Date.now();
		const wait = () => {
			if (seen.some((e) => e.kind === 'ended') || Date.now() - started > 10000) {
				resolve();
			} else {
				setTimeout(wait, 20);
			}
		};
		wait();
	});
	assert.deepStrictEqual(seen.filter((e) => e.kind === 'session'), [{ kind: 'session', id: 'sess-1111' }]);
	assert.strictEqual(transport.resumeToken, 'sess-1111', 'the resume token is captured for the next window');
	assert.strictEqual(seen.filter((e) => e.kind === 'delta').map((e) => e.text).join(''), 'you said: ping');
	const result = seen.find((e) => e.kind === 'result');
	assert.strictEqual(result.text, 'you said: ping', 'the question reached the child over stdin');
	assert.strictEqual(result.costUsd, 0.0125);
	assert.strictEqual(result.tokens, 18);
	assert.ok(!seen.some((e) => e.kind === 'failed'), 'a clean exit reports no failure');
	transport.dispose();
}

/** A CLI that is not there says so once, in a sentence with a way out. */
async function missingCli() {
	const seen = [];
	const transport = new Transport({ cwd: __dirname, cliPath: path.join(__dirname, 'no-such-cli') }, (e) => seen.push(e));
	transport.send('ping');
	// spawn reports a bad path asynchronously, on the child's 'error' event.
	await new Promise((resolve) => setTimeout(resolve, 500));
	const failure = seen.find((e) => e.kind === 'failed');
	assert.ok(failure, 'a missing CLI fails loudly');
	assert.match(failure.message, /Claude Code CLI/);
	transport.dispose();
}

(async () => {
	let failed = 0;
	for (const [name, run] of Object.entries(cases)) {
		try {
			run();
			console.log(`  ok  ${name}`);
		} catch (err) {
			failed++;
			console.error(`FAIL  ${name}\n      ${err && err.message}`);
		}
	}
	for (const [name, run] of Object.entries({ 'a whole turn round-trips through a spawned CLI': roundTrip, 'a missing CLI is reported, not swallowed': missingCli })) {
		try {
			await run();
			console.log(`  ok  ${name}`);
		} catch (err) {
			failed++;
			console.error(`FAIL  ${name}\n      ${err && err.message}`);
		}
	}
	const total = Object.keys(cases).length + 2;
	console.log(`${total - failed}/${total} passed`);
	process.exit(failed ? 1 : 0);
})();
