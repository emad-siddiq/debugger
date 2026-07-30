/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// buildOutput.ts — reading Go's build failures out of dlv's stream (WO-74 §3).
//
// Its own module, importing nothing from `vscode`, so it can be unit-tested from
// plain node. That is not a style preference: this function decides whether to open
// a modal error dialog, so a false positive on ordinary program output is worse than
// a missed error, and the only way to hold that line is a table of cases.

/**
 * The compiler's complaint out of dlv's stream, or nothing.
 *
 * Matches what `go build` actually emits — `path/file.go:12:34: message`, plus the
 * headline forms for a module or package that cannot be resolved at all. Returns the
 * FIRST few lines: a Go build error's first line is the useful one and its twentieth
 * is a cascade.
 */
export function buildError(text: string): string | undefined {
	const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
	const interesting = lines.filter((l) =>
		/^[^\s:]+\.go:\d+(:\d+)?:/.test(l)
		|| /^#\s\S/.test(l)
		|| /cannot find main module|no Go files|no required module provides|build failed|undefined:|is not a main package/i.test(l));
	if (!interesting.length) {
		return undefined;
	}
	return interesting.slice(0, 4).join('\n');
}
