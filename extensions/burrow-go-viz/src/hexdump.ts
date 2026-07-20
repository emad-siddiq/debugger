/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// hexdump.ts — the pure formatter behind the []byte / string visualizer
// (architecture task 06.3: "plain / JSON / hex / base64 with auto-detect").
// It imports nothing from 'vscode', so out/hexdump.js is a clean CommonJS module
// unit-tested directly. It never fetches: it takes the bytes the model already
// pulled off DAP (one indexed `variables` page per task 05's windowed model) and
// turns them into rows/text a webview paints.

/** One line of a canonical hex dump: offset, the two 8-byte hex groups, the ASCII gutter. */
export interface HexRow {
	/** Byte offset of the row's first byte, as 8 lowercase hex digits. */
	readonly offset: string;
	/** Space-separated byte hex, padded to `width` bytes with a gap after the 8th. */
	readonly hex: string;
	/** Printable bytes as chars, non-printable as `.` — the gutter's contents (no pipes). */
	readonly ascii: string;
}

/** The auto-detected best view for a byte payload; `base64` is a manual toggle, never auto. */
export type ByteView = 'hex' | 'text' | 'json' | 'base64';

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Parse dlv's indexed-child values for a `[]byte` into a byte array. Each element
 * arrives as its own DAP variable whose `value` dlv renders as a decimal (`72`) or,
 * depending on formatting, `0x48`; a byte may also carry a rune comment
 * (`72 = 'H'`). Tolerant by design: it reads the leading number, masks to a byte,
 * and skips anything it cannot parse rather than throwing into the visualizer.
 */
export function parseByteValues(values: readonly string[]): number[] {
	const out: number[] = [];
	for (const raw of values) {
		const token = String(raw ?? '').trim();
		const hex = /^0x([0-9a-fA-F]+)/.exec(token);
		const dec = /^(\d+)/.exec(token);
		let n: number;
		if (hex) {
			n = parseInt(hex[1], 16);
		} else if (dec) {
			n = parseInt(dec[1], 10);
		} else {
			continue; // unparseable element — drop it rather than poison the row.
		}
		if (Number.isFinite(n)) {
			out.push(n & 0xff);
		}
	}
	return out;
}

/** True for the printable ASCII range a hex dump shows verbatim (space through `~`). */
function isPrintable(byte: number): boolean {
	return byte >= 0x20 && byte <= 0x7e;
}

/** One byte as two lowercase hex digits. */
function byteHex(byte: number): string {
	return (byte & 0xff).toString(16).padStart(2, '0');
}

/**
 * Render bytes as canonical `hexdump -C`-style rows: `width` bytes per line
 * (default 16), the hex column split into two groups with a gap between, padded
 * so a short final row still aligns with the ASCII gutter above it.
 */
export function hexDump(bytes: readonly number[], width = 16): HexRow[] {
	const rows: HexRow[] = [];
	const half = Math.floor(width / 2);
	for (let start = 0; start < bytes.length; start += width) {
		const slice = bytes.slice(start, start + width);
		const cells: string[] = [];
		for (let i = 0; i < width; i++) {
			cells.push(i < slice.length ? byteHex(slice[i]) : '  ');
		}
		const left = cells.slice(0, half).join(' ');
		const right = cells.slice(half).join(' ');
		rows.push({
			offset: start.toString(16).padStart(8, '0'),
			hex: `${left}  ${right}`.trimEnd() === '' ? '' : `${left}  ${right}`,
			ascii: slice.map(b => (isPrintable(b) ? String.fromCharCode(b) : '.')).join(''),
		});
	}
	return rows;
}

/** Full ASCII decode, non-printable bytes shown as `.` — the flat "text-ish" view. */
export function asciiText(bytes: readonly number[]): string {
	return bytes.map(b => (isPrintable(b) || b === 0x0a || b === 0x09 ? String.fromCharCode(b) : '.')).join('');
}

/**
 * Decode bytes as UTF-8. Returns the decoded string, or `undefined` when the bytes
 * are not valid UTF-8 (a decode error means "these aren't text" — the caller falls
 * back to hex). Implemented without TextDecoder so it runs in a bare node test too.
 */
export function utf8Text(bytes: readonly number[]): string | undefined {
	let out = '';
	let i = 0;
	while (i < bytes.length) {
		const b = bytes[i];
		if (b < 0x80) {
			out += String.fromCharCode(b);
			i += 1;
			continue;
		}
		let need: number;
		let cp: number;
		if (b >= 0xc0 && b < 0xe0) {
			need = 1;
			cp = b & 0x1f;
		} else if (b >= 0xe0 && b < 0xf0) {
			need = 2;
			cp = b & 0x0f;
		} else if (b >= 0xf0 && b < 0xf8) {
			need = 3;
			cp = b & 0x07;
		} else {
			return undefined; // stray continuation or invalid lead byte.
		}
		if (i + need >= bytes.length) {
			return undefined; // truncated multi-byte sequence.
		}
		for (let k = 1; k <= need; k++) {
			const cont = bytes[i + k];
			if (cont < 0x80 || cont >= 0xc0) {
				return undefined;
			}
			cp = (cp << 6) | (cont & 0x3f);
		}
		out += String.fromCodePoint(cp);
		i += need + 1;
	}
	return out;
}

/**
 * If the bytes decode to valid JSON, return it pretty-printed (2-space indent);
 * otherwise `undefined`. This is the "what's actually in this request body" moment
 * the design calls out — a JSON body shows as a tree, not a hex wall.
 */
export function tryPrettyJson(bytes: readonly number[]): string | undefined {
	const text = utf8Text(bytes);
	if (text === undefined || text.trim() === '') {
		return undefined;
	}
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return undefined;
	}
}

/** Standard base64 of the bytes (the manual "decode as base64 came from here" toggle). */
export function toBase64(bytes: readonly number[]): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i];
		const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
		const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
		const triple = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
		out += B64_ALPHABET[(triple >> 18) & 0x3f];
		out += B64_ALPHABET[(triple >> 12) & 0x3f];
		out += b1 === undefined ? '=' : B64_ALPHABET[(triple >> 6) & 0x3f];
		out += b2 === undefined ? '=' : B64_ALPHABET[triple & 0x3f];
	}
	return out;
}

/**
 * Pick the best default view for a payload: JSON if it parses, else text if it is
 * valid UTF-8 that is mostly printable, else hex. Deterministic and pure so the
 * webview's initial mode is unit-testable rather than a guess made in the DOM.
 */
export function detectView(bytes: readonly number[]): ByteView {
	if (bytes.length === 0) {
		return 'hex';
	}
	if (tryPrettyJson(bytes) !== undefined) {
		return 'json';
	}
	const text = utf8Text(bytes);
	if (text !== undefined) {
		const printable = bytes.filter(b => isPrintable(b) || b === 0x0a || b === 0x09 || b === 0x0d).length;
		if (printable / bytes.length >= 0.85) {
			return 'text';
		}
	}
	return 'hex';
}
