/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Standalone unit tests for the byte visualizer's pure formatter (task 06.3).
// hexdump.ts imports nothing from 'vscode', so out/hexdump.js is a clean CommonJS
// module we require directly. Run: `npm test` (after a compile) or
// `node test/hexdump.test.js`.

'use strict';

const assert = require('node:assert');
const {
	parseByteValues,
	hexDump,
	asciiText,
	utf8Text,
	tryPrettyJson,
	toBase64,
	detectView,
} = require('../out/hexdump');

/** The bytes of "Hello, World!". */
const HELLO = [72, 101, 108, 108, 111, 44, 32, 87, 111, 114, 108, 100, 33];

const cases = {
	'parseByteValues reads dlv decimal element values': () => {
		assert.deepStrictEqual(parseByteValues(['72', '101', '108']), [72, 101, 108]);
	},
	'parseByteValues reads 0x-hex and rune-annotated values, masks to a byte': () => {
		assert.deepStrictEqual(parseByteValues(['0x48', "72 = 'H'", '256', '511']), [72, 72, 0, 255]);
	},
	'parseByteValues skips unparseable elements rather than throwing': () => {
		assert.deepStrictEqual(parseByteValues(['72', '', 'nil', '65']), [72, 65]);
	},
	'hexDump: one full 16-byte row aligns offset, groups and ascii': () => {
		const bytes = [];
		for (let i = 0; i < 16; i++) { bytes.push(0x41 + i); } // A..P
		const rows = hexDump(bytes);
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].offset, '00000000');
		assert.strictEqual(rows[0].hex, '41 42 43 44 45 46 47 48  49 4a 4b 4c 4d 4e 4f 50');
		assert.strictEqual(rows[0].ascii, 'ABCDEFGHIJKLMNOP');
	},
	'hexDump: non-printable bytes render as . in the ascii gutter': () => {
		const rows = hexDump([0x00, 0x1f, 0x7f, 0x41]);
		assert.strictEqual(rows[0].ascii, '...A');
	},
	'hexDump: a second row carries the right offset and a short final row still parses': () => {
		const bytes = new Array(20).fill(0x2e); // 20 dots
		const rows = hexDump(bytes);
		assert.strictEqual(rows.length, 2);
		assert.strictEqual(rows[1].offset, '00000010');
		assert.strictEqual(rows[1].ascii, '....'); // last 4 bytes
	},
	'asciiText decodes printable bytes and dots the rest, keeping tab/newline': () => {
		assert.strictEqual(asciiText([72, 105, 0x09, 0x0a, 0x00]), 'Hi\t\n.');
	},
	'utf8Text decodes valid multibyte UTF-8': () => {
		// "é€" = C3 A9 E2 82 AC
		assert.strictEqual(utf8Text([0xc3, 0xa9, 0xe2, 0x82, 0xac]), 'é€');
	},
	'utf8Text returns undefined on invalid / truncated UTF-8': () => {
		assert.strictEqual(utf8Text([0xff, 0x00]), undefined);
		assert.strictEqual(utf8Text([0xc3]), undefined); // truncated 2-byte lead
	},
	'tryPrettyJson pretty-prints a valid JSON body': () => {
		const body = Array.from(Buffer.from('{"a":1,"b":[2,3]}'));
		assert.strictEqual(tryPrettyJson(body), '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
	},
	'tryPrettyJson returns undefined for non-JSON bytes': () => {
		assert.strictEqual(tryPrettyJson(HELLO), undefined);
	},
	'toBase64 matches node Buffer base64 incl. padding': () => {
		assert.strictEqual(toBase64(HELLO), Buffer.from(HELLO).toString('base64'));
		assert.strictEqual(toBase64([1]), Buffer.from([1]).toString('base64'));
		assert.strictEqual(toBase64([1, 2]), Buffer.from([1, 2]).toString('base64'));
	},
	'detectView picks json for a JSON body': () => {
		const body = Array.from(Buffer.from('{"ok":true}'));
		assert.strictEqual(detectView(body), 'json');
	},
	'detectView picks text for printable ASCII': () => {
		assert.strictEqual(detectView(HELLO), 'text');
	},
	'detectView picks hex for mostly-binary bytes': () => {
		assert.strictEqual(detectView([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80]), 'hex');
	},
	'detectView picks hex for empty input': () => {
		assert.strictEqual(detectView([]), 'hex');
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
console.log(`\nhexdump: ${total - failed}/${total} passed`);
if (failed > 0) {
	process.exit(1);
}
