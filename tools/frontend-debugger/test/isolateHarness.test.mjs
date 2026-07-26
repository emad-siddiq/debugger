/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Escaping guard for the isolation harness. buildIsolateHtml returns one big
// template literal, so a stray backtick in a comment silently terminates it and
// the whole module fails to parse — which surfaces only as the sidecar refusing
// to boot. These checks catch it in a second instead.
// Run: node --test test/isolateHarness.test.mjs

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildIsolateHtml } from '../server/isolateHarness.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'isolateHarness.js');

test('no stray backtick inside the emitted template literal', () => {
	const lines = fs.readFileSync(SRC, 'utf8').split('\n');
	const start = lines.findIndex((l) => l.includes('return `<!doctype html>'));
	assert.ok(start > 0, 'could not find the start of the template literal');
	const offenders = [];
	for (let i = start + 1; i < lines.length; i++) {
		if (!lines[i].includes('`')) {
			continue;
		}
		// The literal's own closing line is the only legal backtick.
		if (lines[i].trim() === '</html>`') {
			continue;
		}
		offenders.push(`${i + 1}: ${lines[i].trim()}`);
	}
	assert.deepStrictEqual(offenders, [], 'backticks inside the template literal terminate it early');
});

test('the emitted page and its module script both parse', () => {
	const html = buildIsolateHtml({ module: 'src/primitives/button/Button.tsx', export: 'Button', router: true });
	assert.ok(html.startsWith('<!doctype html>'));
	const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
	assert.ok(script, 'no module script in the emitted page');
	// Parse as a plain script, so drop the two things only a module may have:
	// the bare imports (they need the target's Vite graph) and import.meta.
	const body = script[1].replace(/^import .*$/gm, '').replace(/import\.meta/g, '({env:{}})');
	assert.doesNotThrow(() => new vm.Script(body), 'the emitted module script is not valid JS');
});

test('every control kind the panel dispatches on is implemented', () => {
	const html = buildIsolateHtml({ module: 'src/x/X.tsx' });
	for (const fn of ['toggleControl', 'enumControl', 'numberControl', 'stringControl', 'colorControl', 'jsonControl', 'stubControl']) {
		assert.ok(html.includes('function ' + fn), `missing ${fn}`);
	}
	// The invariant that keeps a half-typed JSON edit alive: controls repair
	// their own row instead of rebuilding the panel.
	assert.ok(html.includes('function refreshRowChrome'));
	assert.ok(html.includes('function replaceRow'));
});
