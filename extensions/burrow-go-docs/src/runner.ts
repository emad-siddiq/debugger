/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// runner.ts — the one child_process boundary of burrow-go-docs (architecture
// task 07). It shells the workspace's own Go toolchain via `execFile` (argv, no
// shell — the tokens come pre-split from godoc.ts), so docs are version-true to
// the module's go.sum, offline, and safe from injection. The exec function is
// injected behind {@link ExecFileFn} so the result-shaping logic is unit-testable
// with a fake — this file imports only node's `child_process`, no `vscode`.

import { execFile } from 'child_process';

/** The outcome of a `go doc` invocation. */
export interface GoDocResult {
	/** True when `go doc` exited 0. */
	readonly ok: boolean;
	/** Captured stdout (the documentation text); may be empty on failure. */
	readonly text: string;
	/** A human error message when {@link ok} is false. */
	readonly error?: string;
}

/** The minimal `child_process.execFile` shape this module depends on (fakeable in tests). */
export type ExecFileFn = (
	file: string,
	args: readonly string[],
	options: { cwd?: string; timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
	callback: (error: Error | null, stdout: string, stderr: string) => void
) => void;

/**
 * `go doc` normally reads the local module cache, but for a package that is not
 * in it the toolchain will go and fetch one — which is a network call. When the
 * viewer is REVIVED rather than opened, nobody asked for that (WO-60 constraint
 * 2), so the restore path runs offline and shows the toolchain's own "not in
 * cache" error with a button that retries without the restriction.
 */
export const OFFLINE_ENV: NodeJS.ProcessEnv = { GOPROXY: 'off', GOFLAGS: '-mod=mod' };

/** Hard ceiling on how long a `go doc` call may run before it is killed. */
const TIMEOUT_MS = 15_000;

/** stdout ceiling — `go doc -all net/http` is large; give it generous headroom. */
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Run `go doc` and resolve its result. Never rejects: a non-zero exit (unknown
 * package, no toolchain) resolves with `ok: false` and the toolchain's own
 * stderr, so the viewer can surface it as page content.
 * @param goBin Path to the `go` binary (workspace-configurable; defaults to `go`).
 * @param args The full argv after the binary (e.g. `['doc', 'net/http']`).
 * @param cwd The module directory, so dependency docs match go.sum; `undefined` for stdlib-only.
 * @param exec The exec implementation; defaults to node's `execFile`, overridden in tests.
 * @param offline When true, run with {@link OFFLINE_ENV} so the toolchain cannot fetch a module.
 * @returns The captured result.
 */
export function runGoDoc(
	goBin: string,
	args: string[],
	cwd: string | undefined,
	exec: ExecFileFn = execFile as unknown as ExecFileFn,
	offline = false
): Promise<GoDocResult> {
	return new Promise<GoDocResult>(resolve => {
		const options = offline
			? { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: { ...process.env, ...OFFLINE_ENV } }
			: { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER };
		exec(goBin, args, options, (error, stdout, stderr) => {
			if (error) {
				const message = (stderr && stderr.trim()) || error.message;
				resolve({ ok: false, text: stdout ?? '', error: message });
				return;
			}
			resolve({ ok: true, text: stdout ?? '' });
		});
	});
}
