/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The type-along guide's one rule: positional first, unique-anchor resync
// second, and on divergence a CORRECTION rather than silence — the guide
// survives a typo, and only `burrow.scratch.ghostText` turns it off. The
// remaining `undefined` cases are the ones worth the most: they are where there
// is genuinely nothing to say, and a guess would be the tool arguing.
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

/** The karaoke case: an insertion at the cursor, rendered as ghost text. */
const insertion = (text, character) => ({ text, start: character, end: character, correction: false });

/** The persistence case: a replacement of the diverged tail, rendered as an inline edit. */
const correction = (text, start, end) => ({ text, start, end, correction: true });

const cases = {
	'the remainder of the current line, positionally': () => {
		assert.deepStrictEqual(at('package', 0, 7), insertion(' main\n\nimport (', 7));
	},

	'lookahead extends only on the document\'s last line': () => {
		// Same prefix, but lines already exist below the cursor — suggesting the
		// next reference lines would stack them on top of what is written.
		assert.deepStrictEqual(at('package\n\nimport (', 0, 7), insertion(' main', 7));
	},

	'an empty last line suggests the whole next reference line': () => {
		assert.deepStrictEqual(at('package main\n', 1, 0), insertion('\nimport (\n\t"encoding/json"', 0));
	},

	'a typo does not end the guide — it becomes a correction': () => {
		// The whole point of WO-82b: `wrong` for `main` used to leave the learner
		// with nothing. The reference tail replaces from where the lines part.
		assert.deepStrictEqual(at('package wrong', 0, 13), correction('main', 8, 13));
	},

	'a typo in the first character still corrects, pinned by the shared tail': () => {
		assert.deepStrictEqual(at('Package main', 0, 12), correction('package main', 0, 12));
	},

	'the correction covers text to the RIGHT of the cursor': () => {
		// What an auto-closing pair leaves behind: `)` parked past the cursor. The
		// replacement runs to end-of-line, so the pair is absorbed, not fatal.
		const doc = 'package main\n\nimport (\n\t"encoding/json"\n\t"log"\n)\n\nfunc main() {\n\tlog.Println()';
		assert.deepStrictEqual(ghostSuggestion(REF, ghostLines(doc), 8, 13), correction('"hi")', 13, 14));
	},

	'a mid-line cursor on a line that already matches says nothing': () => {
		assert.strictEqual(at('package main', 0, 4), undefined);
	},

	'an extra line resyncs when the previous line pins it uniquely': () => {
		// The learner added a blank line after `import (`, so positional
		// alignment is off by one from line 3 onward. Cursor on the line after
		// `\t"encoding/json"` — its unique anchor.
		const doc = 'package main\n\n\nimport (\n\t"encoding/json"\n\t"lo';
		assert.deepStrictEqual(ghostSuggestion(REF, ghostLines(doc), 5, 4), insertion('g"\n)', 4));
	},

	'a typo on a shifted line corrects against the anchored line, not the positional one': () => {
		// Same off-by-one document, and `\t"lig"` for `\t"log"`. The previous line
		// pins reference line 4, so the correction comes from there.
		const doc = 'package main\n\n\nimport (\n\t"encoding/json"\n\t"lig"';
		assert.deepStrictEqual(ghostSuggestion(REF, ghostLines(doc), 5, 6), correction('og"', 3, 6));
	},

	'a line with nothing in common is left alone': () => {
		// `im` shares no head and no tail with `\t"encoding/json"`: the learner is
		// writing something of their own, and a correction would be an argument.
		const doc = 'package main\n\n\nim';
		assert.strictEqual(ghostSuggestion(REF, ghostLines(doc), 3, 2), undefined);
	},

	'an ambiguous prefix inside the window falls back to the position, not a guess': () => {
		// Two reference lines start with `\t"` inside the window and the previous
		// line does not disambiguate them. Positional is `b`, which shares nothing
		// with what is typed — so silence, as before.
		const ambiguous = ghostLines('a\n\t"x"\nb\n\t"y"\nc');
		assert.strictEqual(ghostSuggestion(ambiguous, ghostLines('a\nzzz\n\t"'), 2, 2), undefined);
	},

	'beyond the reference there is nothing to suggest': () => {
		assert.strictEqual(at('package main\nextra\nmore\nlines\nof\nmy\nown\npast\nthe\nend\nnow', 10, 3), undefined);
	},

	'a finished line at the end of the document previews what Enter leads to': () => {
		assert.deepStrictEqual(at('package main\n\nimport (', 2, 8), insertion('\n\t"encoding/json"\n\t"log"', 8));
	},

	'a finished line with lines below it suggests nothing': () => {
		assert.strictEqual(at('package main\n\nimport (\nmine', 2, 8), undefined);
	},

	'an empty reference never suggests': () => {
		assert.strictEqual(ghostSuggestion([], ghostLines('anything'), 0, 8), undefined);
	},

	'CRLF references compare clean': () => {
		const crlf = ghostLines('package main\r\nimport (\r\n');
		assert.deepStrictEqual(ghostSuggestion(crlf, ghostLines('package'), 0, 7), insertion(' main\nimport (', 7));
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
