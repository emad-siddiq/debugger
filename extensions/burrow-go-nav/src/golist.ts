/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// golist.ts — the concrete {@link GoListRunner}: shells `go list` via child_process
// (architecture task 16, WO-1). Kept vscode-free and thin — all parsing lives in
// packageindex.ts — so the only thing this adds over the pure code is the process
// spawn. The extension injects a `GoCli`; tests inject a fake runner instead.

import { execFile } from 'node:child_process';
import { GoListRunner } from './packageindex';

// go list on a large module tree can emit tens of MB of JSON; give it room.
const MAX_BUFFER = 128 * 1024 * 1024;

/** Runs the real `go list` in a workspace directory. */
export class GoCli implements GoListRunner {
	/**
	 * @param cwd Absolute directory to run `go list` in (the module root).
	 * @param goBin Path to the `go` binary (`burrow.nav.goBinary`); defaults to `go` on PATH.
	 */
	constructor(private readonly cwd: string, private readonly goBin: string = 'go') { }

	/**
	 * Run `go list <args>` and resolve its stdout. `go list` can exit non-zero on a
	 * partially broken tree while still printing usable JSON for the good packages,
	 * so a non-empty stdout wins over the error; a truly empty failure rejects.
	 */
	list(args: string[]): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			execFile(this.goBin, ['list', ...args], { cwd: this.cwd, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
				if (err && !stdout) {
					reject(new Error(stderr.trim() || err.message));
					return;
				}
				resolve(stdout);
			});
		});
	}
}
