/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// scan.ts — read a reference project off disk into the plan's input shape.
// Node only, no `vscode`: the same function serves the extension and the tests.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { IGNORED_DIRS, SourceFile, isIgnored } from './planModel';

/** A file has to be readable as text to be a step. Anything with a NUL byte in
 *  its first block is an image or a binary and is silently left out. */
function isText(buffer: Buffer): boolean {
	return !buffer.subarray(0, 8000).includes(0);
}

export interface ScanResult {
	readonly files: readonly SourceFile[];
	/** Files skipped for being binary or oversized — reported, never hidden. */
	readonly skipped: number;
}

export function scanProject(root: string): ScanResult {
	const files: SourceFile[] = [];
	let skipped = 0;

	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;  // unreadable directory — not a reason to abandon the scan
		}
		for (const entry of entries) {
			const abs = path.join(dir, entry.name);
			const rel = path.relative(root, abs).split(path.sep).join('/');
			if (entry.isDirectory()) {
				if (!IGNORED_DIRS.includes(entry.name)) {
					walk(abs);
				}
				continue;
			}
			if (!entry.isFile() || isIgnored(rel)) {
				continue;
			}
			let buffer: Buffer;
			try {
				buffer = fs.readFileSync(abs);
			} catch {
				skipped++;
				continue;
			}
			if (!isText(buffer)) {
				skipped++;
				continue;
			}
			files.push({ path: rel, text: buffer.toString('utf8'), bytes: buffer.byteLength });
		}
	};

	walk(root);
	files.sort((a, b) => (a.path < b.path ? -1 : 1));
	return { files, skipped };
}
