/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Unified diffs, as text (docs/plans/03 §6). The panel never lets the model
// write: a proposed change comes back as a diff, is shown in Burrow's own diff
// editor, and only reaches disk when the developer presses Apply. This file is
// the part that has to be exactly right — finding the diff in an answer,
// reading it, and applying it to a file that may have moved on since.
//
// Deliberately not a full patch implementation: no renames, no modes, no binary.
// A model that returns those gets a clear refusal instead of a half-applied
// edit.

export interface Hunk {
	/** 1-based line the hunk claims to start at; a hint, not a promise. */
	readonly oldStart: number;
	/** Context + removed lines, i.e. what the file should currently say. */
	readonly before: readonly string[];
	/** Context + added lines, i.e. what it should say afterwards. */
	readonly after: readonly string[];
}

export interface FileDiff {
	readonly path: string;
	readonly hunks: readonly Hunk[];
	readonly isNew: boolean;
}

/**
 * The diff out of an answer. The system preamble asks for one fenced block and
 * nothing else, but an answer that explains itself first is not a failure —
 * take the first fenced ```diff, else the first fence that looks like a diff,
 * else a bare `--- a/…` run.
 */
export function extractDiff(answer: string): string | undefined {
	const fences = [...answer.matchAll(/```([a-zA-Z]*)\n([\s\S]*?)```/g)];
	const labelled = fences.find((f) => /^(diff|patch)$/i.test(f[1]));
	if (labelled) {
		return labelled[2];
	}
	const shaped = fences.find((f) => /^---\s+\S/m.test(f[2]) && /^@@ /m.test(f[2]));
	if (shaped) {
		return shaped[2];
	}
	const bare = /^---\s+\S[\s\S]*?(?=\n\S*$|$)/m.exec(answer);
	return bare && /^@@ /m.test(bare[0]) ? bare[0] : undefined;
}

/** Parse a unified diff. Unparseable input yields no files, never a throw. */
export function parseDiff(text: string): FileDiff[] {
	const files: FileDiff[] = [];
	const lines = text.split('\n');
	// A diff that ends in a newline has no trailing blank CONTEXT line; without
	// this the empty tail is carried into the last hunk and nothing matches.
	if (lines.length && lines[lines.length - 1] === '') {
		lines.pop();
	}
	let path: string | undefined;
	let isNew = false;
	let hunks: Hunk[] = [];
	let before: string[] = [];
	let after: string[] = [];
	let oldStart = 1;
	let inHunk = false;

	const closeHunk = () => {
		if (inHunk) {
			hunks.push({ oldStart, before, after });
			before = [];
			after = [];
			inHunk = false;
		}
	};
	const closeFile = () => {
		closeHunk();
		if (path && hunks.length) {
			files.push({ path, hunks, isNew });
		}
		path = undefined;
		isNew = false;
		hunks = [];
	};

	for (const line of lines) {
		if (line.startsWith('--- ')) {
			closeFile();
			isNew = /^--- (\/dev\/null|a\/dev\/null)/.test(line);
			continue;
		}
		if (line.startsWith('+++ ')) {
			path = stripPrefix(line.slice(4).trim());
			continue;
		}
		if (line.startsWith('@@')) {
			closeHunk();
			const match = /^@@ -(\d+)/.exec(line);
			oldStart = match ? Number(match[1]) : 1;
			inHunk = true;
			continue;
		}
		if (!inHunk) {
			continue;
		}
		if (line.startsWith('+')) {
			after.push(line.slice(1));
		} else if (line.startsWith('-')) {
			before.push(line.slice(1));
		} else if (line.startsWith(' ')) {
			before.push(line.slice(1));
			after.push(line.slice(1));
		} else if (line.startsWith('\\')) {
			// "\ No newline at end of file" — nothing to carry.
		} else if (line.trim() === '') {
			// Trailing blank context lines lose their leading space in transit.
			before.push('');
			after.push('');
		} else {
			closeHunk();
		}
	}
	closeFile();
	return files;
}

/** `a/src/x.ts` / `b/src/x.ts` → `src/x.ts`; a bare path is left alone. */
function stripPrefix(path: string): string {
	return /^[ab]\//.test(path) ? path.slice(2) : path;
}

export interface ApplyResult {
	/** The patched text, when every hunk landed. */
	readonly text?: string;
	/** 1-based indexes of the hunks that did not, for the reject message. */
	readonly rejected: readonly number[];
}

/**
 * Apply hunks to a file's text. The stated line is a hint: the file may have
 * been edited since the model saw it, so each hunk's `before` block is searched
 * for outward from that line and applied where it actually matches. A hunk that
 * matches nowhere is rejected rather than forced — a half-applied hunk is the
 * one outcome worse than no patch at all.
 */
export function applyDiff(original: string, hunks: readonly Hunk[]): ApplyResult {
	const eol = original.includes('\r\n') ? '\r\n' : '\n';
	let lines = original.split(/\r?\n/);
	const rejected: number[] = [];
	let drift = 0;

	hunks.forEach((hunk, index) => {
		const at = findBlock(lines, hunk.before, hunk.oldStart - 1 + drift);
		if (at < 0) {
			rejected.push(index + 1);
			return;
		}
		lines = [...lines.slice(0, at), ...hunk.after, ...lines.slice(at + hunk.before.length)];
		drift += hunk.after.length - hunk.before.length;
	});

	return rejected.length ? { rejected } : { text: lines.join(eol), rejected };
}

/** Exact match first at the hinted line, then outward. Trailing whitespace is
 *  forgiven — models reflow it and it never changes meaning. */
function findBlock(lines: readonly string[], block: readonly string[], hint: number): number {
	if (!block.length) {
		return Math.max(0, Math.min(hint, lines.length));
	}
	const matches = (at: number) => at >= 0 && at + block.length <= lines.length
		&& block.every((line, i) => lines[at + i].replace(/\s+$/, '') === line.replace(/\s+$/, ''));
	if (matches(hint)) {
		return hint;
	}
	for (let radius = 1; radius <= lines.length; radius++) {
		if (matches(hint - radius)) {
			return hint - radius;
		}
		if (matches(hint + radius)) {
			return hint + radius;
		}
	}
	return -1;
}

/** New-file diffs carry only additions; their whole content is the `after`. */
export function newFileContent(file: FileDiff): string {
	return file.hunks.flatMap((hunk) => hunk.after).join('\n');
}
