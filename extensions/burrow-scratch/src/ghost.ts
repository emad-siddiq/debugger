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
//   * positional first, unique-anchor resync second — what is below. When the
//     positional line does not match, a nearby line is accepted only if the
//     prefix pins it AND the learner's previous line matches its predecessor,
//     uniquely, within a small window.
//
// PERSISTENCE (WO-82b). A typo used to end the guide: one wrong character and
// every strategy above mismatched, so the learner lost the karaoke exactly when
// they most needed it, with no way to get it back except undoing to the last
// good prefix. It now survives divergence. When the anchored reference line and
// the typed line disagree, the guide returns a CORRECTION — a replacement of
// the diverged tail rather than an insertion at the cursor — which the caller
// renders as an inline edit. Ghost text cannot show it: the editor drops any
// inline completion whose text differs from what is already typed before the
// cursor (`inlineCompletionIsVisible`), which is precisely a typo. The only
// thing that silences the guide now is `burrow.scratch.ghostText`, plus the
// cases where there is genuinely nothing to say: past the end of the reference,
// a line already identical to it, or an anchor with no evidence behind it.
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
 * One suggestion, as a replacement of `[start, end)` on the cursor's line.
 *
 * `start === end === character` is the karaoke case — a pure insertion at the
 * cursor, rendered as ghost text. When `correction` is set the range covers
 * characters the learner has already typed, which ghost text cannot render; the
 * caller sends those as an inline edit instead.
 */
export interface GhostGuide {
	readonly text: string;
	readonly start: number;
	readonly end: number;
	readonly correction: boolean;
}

/**
 * The guide for one cursor position, or nothing.
 *
 * `undefined` now means only "there is nothing to say" — past the end of the
 * reference, on a line that already matches it, or when no anchor has any
 * evidence behind it. A typo is no longer one of those cases: see PERSISTENCE
 * at the top of the file. The learner who departs from the reference on purpose
 * is still allowed to — a correction is a suggestion, never an edit, and the
 * checks decide the outcome either way.
 */
export function ghostSuggestion(
	reference: readonly string[],
	doc: readonly string[],
	line: number,
	character: number,
): GhostGuide | undefined {
	const typed = doc[line] ?? '';
	const prefix = typed.slice(0, character);
	const prev = line > 0 ? doc[line - 1] : undefined;

	// Lookahead applies only when the cursor sits on the document's LAST line:
	// anywhere else the extra reference lines would be suggested on top of lines
	// the learner has already written below the cursor.
	const cursorOnLastLine = line >= doc.length - 1;

	// The insertion strategies need the cursor at the end of the line: with text
	// to the right, appending at the cursor would interleave. Divergence handles
	// that position instead — it replaces to end-of-line, so a `}` parked there
	// by an auto-closing pair is covered rather than fatal.
	if (character === typed.length) {
		// 1 — positional. The common case: the file tracks the reference line for
		//     line. An empty remainder still suggests at the end of the document —
		//     the line is finished and the ghost shows what pressing Enter leads to,
		//     which is the karaoke continuing rather than stopping at every newline.
		const positional = reference[line];
		if (positional !== undefined && positional.startsWith(prefix)) {
			const ghost = withLookahead(reference, line, cursorOnLastLine, positional.slice(prefix.length));
			if (ghost.length) {
				return insertion(ghost, character);
			}
		}

		// 2 — resync. Only when the prefix carries signal or the previous line can
		//     vouch, and only when exactly ONE nearby line fits both.
		if (prefix.trim().length >= 3 || anchors(prev)) {
			const candidates: number[] = [];
			for (let j = Math.max(0, line - RESYNC_WINDOW); j <= Math.min(reference.length - 1, line + RESYNC_WINDOW); j++) {
				if (!reference[j].startsWith(prefix) || reference[j].length === prefix.length) {
					continue;
				}
				// The previous line must corroborate: either both sides have one and
				// they agree, or the candidate is at the top of the file and so is the
				// cursor.
				const refPrev = j > 0 ? reference[j - 1] : undefined;
				if (prev !== undefined && refPrev !== undefined && prev.trimEnd() === refPrev.trimEnd() && anchors(prev)) {
					candidates.push(j);
				} else if (prefix.trim().length >= 3 && prev === undefined && refPrev === undefined) {
					candidates.push(j);
				}
			}
			if (candidates.length === 1) {
				return insertion(withLookahead(reference, candidates[0], cursorOnLastLine, reference[candidates[0]].slice(prefix.length)), character);
			}
		}
	}

	// 3 — divergence. Nothing lines up character for character, which is what a
	//     typo looks like from here. Rather than going quiet, name the reference
	//     line this one is trying to be and offer its tail as a correction.
	const target = correctionAnchor(reference, typed, prev, line);
	if (target === undefined) {
		return undefined;
	}
	const refLine = reference[target];
	if (refLine === typed) {
		return undefined;  // already right — silence here is agreement, not absence
	}
	const shared = commonPrefixLength(typed, refLine);
	return { text: refLine.slice(shared), start: shared, end: typed.length, correction: true };
}

/** A pure insertion at the cursor — the karaoke case, rendered as ghost text. */
function insertion(text: string, character: number): GhostGuide {
	return { text, start: character, end: character, correction: false };
}

/**
 * Which reference line the diverged line is trying to be, or nothing.
 *
 * Positional is the default — a typo does not move the learner down the file —
 * but a line that the PREVIOUS line pins wins over it, so an inserted or
 * deleted line still corrects against the right target. Either way the choice
 * needs evidence: a shared head or a shared tail. Without one the two lines
 * have nothing in common, the learner is writing something of their own, and a
 * "correction" would be the tool arguing with them.
 */
function correctionAnchor(
	reference: readonly string[],
	typed: string,
	prev: string | undefined,
	line: number,
): number | undefined {
	const candidates: number[] = [];
	if (anchors(prev)) {
		for (let j = Math.max(1, line - RESYNC_WINDOW); j <= Math.min(reference.length - 1, line + RESYNC_WINDOW); j++) {
			if (prev!.trimEnd() === reference[j - 1].trimEnd()) {
				candidates.push(j);
			}
		}
	}
	// Corroborated lines only count while they are unambiguous; otherwise fall
	// back to the position, which at least never wanders.
	if (candidates.length !== 1 && line < reference.length) {
		candidates.length = 0;
		candidates.push(line);
	}
	if (candidates.length !== 1) {
		return undefined;
	}
	const target = candidates[0];
	const refLine = reference[target];
	if (commonPrefixLength(typed, refLine) >= 1 || commonSuffixLength(typed, refLine) >= 2) {
		return target;
	}
	return undefined;
}

/** How many leading characters two lines share. */
function commonPrefixLength(a: string, b: string): number {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) {
		i++;
	}
	return i;
}

/** How many trailing characters two lines share, never overlapping the head. */
function commonSuffixLength(a: string, b: string): number {
	const limit = Math.min(a.length, b.length) - commonPrefixLength(a, b);
	let i = 0;
	while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) {
		i++;
	}
	return i;
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
