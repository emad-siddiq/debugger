/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The type-along guide's one rule: positional first, unique-anchor resync
// second, SILENCE on ambiguity. The silence cases are the ones worth the most —
// a wrong ghost suggestion in a learning tool is worse than none, so half of
// these assert `undefined`.
// Run: `npm test` (after a compile) or `node test/ghost.test.js`.

'use strict';

const assert = require('node:assert');
const { ghostLines, ghostSuggestion } = require('../out/ghost');

const REF = ghostLines([
	'package main',              // 0
	'',                          // 1
	'import (',                  // 2
	'\t"encoding/json"',         // 3
	'\t"log"',                   // 4
	')',                         // 5
	'',                          // 6
	'func main() {',             // 7
	'\tlog.Println("hi")',       // 8
	'}',                         // 9
].join('\n'));

const at = (docText, line, character) => ghostSuggestion(REF, ghostLines(docText), line, character);

const cases = {
	'the remainder of the current line, positionally': () => {
		assert.strictEqual(at('package', 0, 7), ' main\n\nimport (');
	},

	'lookahead extends only on the document\'s last line': () => {
		// Same prefix, but lines already exist below the cursor — suggesting the
		// next reference lines would stack them on top of what is written.
		assert.strictEqual(at('package\n\nimport (', 0, 7), ' main');
	},

	'an empty last line suggests the whole next reference line': () => {
		assert.strictEqual(at('package main\n', 1, 0), '\nimport (\n\t"encoding/json"');
	},

	'divergence is silence, not correction': () => {
		assert.strictEqual(at('package wrong', 0, 13), undefined);
	},

	'a mid-line cursor is silence': () => {
		// Auto-closing pairs park text after the cursor; v1 answers quietly.
		assert.strictEqual(at('package main', 0, 4), undefined);
	},

	'an extra line resyncs when the previous line pins it uniquely': () => {
		// The learner added a blank line after `import (`, so positional
		// alignment is off by one from line 3 onward. Cursor on the line after
		// `\t"encoding/json"` — its unique anchor.
		const doc = 'package main\n\n\nimport (\n\t"encoding/json"\n\t"lo';
		assert.strictEqual(ghostSuggestion(REF, ghostLines(doc), 5, 4), 'g"\n)');
	},

	'a common previous line (`}`, blank) pins nothing — silence': () => {
		// Prefix under 3 chars and the previous line is blank: no anchor, no guess.
		const doc = 'package main\n\n\nim';
		assert.strictEqual(ghostSuggestion(REF, ghostLines(doc), 3, 2), undefined);
	},

	'an ambiguous prefix inside the window is silence': () => {
		// Two reference lines start with `\t"` inside the window and the previous
		// line does not disambiguate them.
		const ambiguous = ghostLines('a\n\t"x"\nb\n\t"y"\nc');
		assert.strictEqual(ghostSuggestion(ambiguous, ghostLines('a\nzzz\n\t"'), 2, 2), undefined);
	},

	'beyond the reference there is nothing to suggest': () => {
		assert.strictEqual(at('package main\nextra\nmore\nlines\nof\nmy\nown\npast\nthe\nend\nnow', 10, 3), undefined);
	},

	'a finished line at the end of the document previews what Enter leads to': () => {
		assert.strictEqual(at('package main\n\nimport (', 2, 8), '\n\t"encoding/json"\n\t"log"');
	},

	'a finished line with lines below it suggests nothing': () => {
		assert.strictEqual(at('package main\n\nimport (\nmine', 2, 8), undefined);
	},

	'an empty reference never suggests': () => {
		assert.strictEqual(ghostSuggestion([], ghostLines('anything'), 0, 8), undefined);
	},

	'CRLF references compare clean': () => {
		const crlf = ghostLines('package main\r\nimport (\r\n');
		assert.strictEqual(ghostSuggestion(crlf, ghostLines('package'), 0, 7), ' main\nimport (');
	},
};

let failed = 0;
for (const [name, run] of Object.entries(cases)) {
	try {
		run();
		console.log(`  ✓ ${name}`);
	} catch (error) {
		failed++;
		console.error(`  ✗ ${name}\n    ${error.message}`);
	}
}
console.log(`${Object.keys(cases).length - failed}/${Object.keys(cases).length} passed`);
process.exit(failed ? 1 : 0);
