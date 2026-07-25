#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// A stand-in for the Claude Code CLI, so transport.test.js can prove the real
// wiring — spawn, stdin lines, chunked stdout, session capture, cost — without
// spending a turn of the developer's account. It answers the FIRST message it
// is given and then exits, echoing back what it was asked so the test can check
// the message actually arrived.
//
// The stream is written in deliberately awkward chunks that split JSON lines
// down the middle: that is exactly what a real pipe does, and the line buffer
// in transport.ts is the thing most likely to be got wrong.

'use strict';

const HAS_RESUME = process.argv.includes('--resume');
const SESSION = HAS_RESUME ? process.argv[process.argv.indexOf('--resume') + 1] : 'sess-1111';

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	buffer += chunk;
	const at = buffer.indexOf('\n');
	if (at < 0) {
		return;
	}
	const asked = JSON.parse(buffer.slice(0, at)).message.content[0].text;
	buffer = '';
	answer(asked);
});

function answer(asked) {
	const lines = [
		JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' }),
		JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION, cwd: process.cwd() }),
		JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'you said: ' } } }),
		JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: asked } } }),
		JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `you said: ${asked}` }] } }),
		JSON.stringify({
			type: 'result', subtype: 'success', is_error: false, result: `you said: ${asked}`,
			total_cost_usd: 0.0125, duration_ms: 1234, usage: { input_tokens: 11, output_tokens: 7 },
		}),
	].join('\n') + '\n';

	// Split into 40-byte chunks: line boundaries land wherever they land.
	let at = 0;
	const tick = () => {
		if (at >= lines.length) {
			process.exit(0);
		}
		process.stdout.write(lines.slice(at, at + 40));
		at += 40;
		setTimeout(tick, 1);
	};
	tick();
}
