/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// ghost.ts — the type-along guide.
//
// As the learner types a `write` step, the next characters of the reference
// appear as faded ghost text ahead of the cursor, so the eyes stay on the file
// being written instead of ping-ponging to the reference. Rendered through the
// stable inline-completions API (ghost text is exactly what that UI is), which
// also means Tab fast-forwards a chunk — the learner's choice, and the checks
// verify the result either way.
//
// THE RULE, and why it is this one. Three anchor strategies were considered:
//
//   * pure line-index alignment — dies silently after ONE extra or missing
//     line: every later prefix mismatches and the guide is gone for the rest of
//     the file;
//   * best-match search — mis-anchors constantly, because the commonest lines
//     in Go and TS are `}`, `)` and blank, and a WRONG ghost suggestion in a
//     learning tool is worse than none;
//   * positional first, unique-anchor resync second, SILENCE on ambiguity —
//     what is below. When the positional line does not match, a nearby line is
//     accepted only if the prefix pins it AND the learner's previous line
//     matches its predecessor, uniquely, within a small window.
//
// No `vscode` import: the whole rule is a pure function over line arrays,
// unit-tested standalone (test/ghost.test.js). The provider wrapper lives in
// extension.ts and stays SYNCHRONOUS — reference lines come from an in-memory
// cache, there is no await between reading the position and returning, so no
// document-version guard is needed. If this ever goes async, it grows one.

/** How far around the cursor line the resync looks for a unique anchor. */
const RESYNC_WINDOW = 10;

/** How many reference lines beyond the current one a suggestion may preview. */
const LOOKAHEAD = 2;

/** A previous-line anchor must carry some information: `}`, `)` and blank pin
 *  nothing — they are the commonest lines in the languages this teaches. */
function anchors(line: string | undefined): boolean {
	return !!line && line.trim().length > 2;
}

/** Split into lines with `\r` stripped, so a CRLF reference compares clean. */
export function ghostLines(text: string): string[] {
	return text.split('\n').map((l) => l.replace(/\r$/, ''));
}

/**
 * The ghost for one cursor position, or nothing.
 *
 * `undefined` is a first-class answer: on divergence, mid-line cursors and
 * ambiguous anchors the guide goes quiet rather than guessing. The learner who
 * departs from the reference is allowed to — "different and better" is a
 * legitimate outcome, and a guide that argues is a guide that gets disabled.
 */
export function ghostSuggestion(
	reference: readonly string[],
	doc: readonly string[],
	line: number,
	character: number,
): string | undefined {
	const typed = doc[line] ?? '';
	// Only at the end of the line: a mid-line cursor would need replace-range
	// semantics, and the honest v1 answer there is silence. (Known consequence:
	// auto-closing pairs park a `}` after the cursor and mute the guide until
	// the pair is passed.)
	if (character !== typed.length) {
		return undefined;
	}
	const prefix = typed;

	// Lookahead applies only when the cursor sits on the document's LAST line:
	// anywhere else the extra reference lines would be suggested on top of lines
	// the learner has already written below the cursor.
	const cursorOnLastLine = line >= doc.length - 1;

	// 1 — positional. The common case: the file tracks the reference line for
	//     line. An empty remainder still suggests at the end of the document —
	//     the line is finished and the ghost shows what pressing Enter leads to,
	//     which is the karaoke continuing rather than stopping at every newline.
	const positional = reference[line];
	if (positional !== undefined && positional.startsWith(prefix)) {
		const ghost = withLookahead(reference, line, cursorOnLastLine, positional.slice(prefix.length));
		if (ghost.length) {
			return ghost;
		}
	}

	// 2 — resync. Only when the prefix carries signal or the previous line can
	//     vouch, and only when exactly ONE nearby line fits both.
	const prev = line > 0 ? doc[line - 1] : undefined;
	if (prefix.trim().length < 3 && !anchors(prev)) {
		return undefined;
	}
	const candidates: number[] = [];
	for (let j = Math.max(0, line - RESYNC_WINDOW); j <= Math.min(reference.length - 1, line + RESYNC_WINDOW); j++) {
		if (!reference[j].startsWith(prefix) || reference[j].length === prefix.length) {
			continue;
		}
		// The previous line must corroborate: either both sides have one and they
		// agree, or the candidate is at the top of the file and so is the cursor.
		const refPrev = j > 0 ? reference[j - 1] : undefined;
		if (prev !== undefined && refPrev !== undefined && prev.trimEnd() === refPrev.trimEnd() && anchors(prev)) {
			candidates.push(j);
		} else if (prefix.trim().length >= 3 && prev === undefined && refPrev === undefined) {
			candidates.push(j);
		}
	}
	if (candidates.length === 1) {
		return withLookahead(reference, candidates[0], cursorOnLastLine, reference[candidates[0]].slice(prefix.length));
	}
	return undefined;
}

/**
 * The current-line remainder, extended with up to {@link LOOKAHEAD} following
 * reference lines when the cursor is on the document's last line. `refLine` is
 * where the remainder came from in the reference — the lookahead continues from
 * there, which matters after a resync.
 */
function withLookahead(reference: readonly string[], refLine: number, cursorOnLastLine: boolean, remainder: string): string {
	if (!cursorOnLastLine) {
		return remainder;
	}
	// Trailing empties add nothing worth previewing: a ghost that is only
	// newlines reads as a rendering glitch.
	const extra = reference.slice(refLine + 1, refLine + 1 + LOOKAHEAD);
	while (extra.length && !extra[extra.length - 1].length) {
		extra.pop();
	}
	return extra.length ? [remainder, ...extra].join('\n') : remainder;
}
