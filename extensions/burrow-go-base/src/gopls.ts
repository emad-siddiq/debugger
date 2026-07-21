/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// gopls.ts — the pure, vscode-free `gopls` binary resolver. Kept free of any
// 'vscode' import so it is unit-testable as a plain CommonJS module (see
// test/gopls.test.js). The tool manager (architecture task 03, slice 2) will
// later redirect this at a pinned, Burrow-managed gopls; for the first slice we
// resolve the host binary, mirroring burrow-go-debug's `resolveDelve` order.

import { existsSync } from 'fs';
import { delimiter, join } from 'path';
import { homedir } from 'os';

/** The subset of the process environment the resolver reads (injectable for tests). */
export interface GoplsEnv {
	readonly BURROW_GOPLS_PATH?: string | undefined;
	readonly GOBIN?: string | undefined;
	readonly GOPATH?: string | undefined;
	readonly PATH?: string | undefined;
}

/** Options for {@link resolveGopls}; `home` and `exists` are injectable so tests need not touch the real filesystem. */
export interface ResolveGoplsOptions {
	/** Overrides `os.homedir()` for the `$GOPATH`-defaulting `$HOME/go/bin` fallback (defaults to the real home dir). */
	readonly home?: string;
	/** Existence probe, injectable for tests; defaults to `fs.existsSync`. */
	readonly exists?: (path: string) => boolean;
}

/**
 * Resolves an absolute path to the `gopls` language server, or `undefined` when
 * none is found on the host. Resolution order mirrors burrow-go-debug's dlv
 * resolver: `BURROW_GOPLS_PATH` → `$GOBIN/gopls` → `$GOPATH/bin/gopls`
 * (with `$HOME/go/bin` as the conventional GOPATH default) → the first `gopls`
 * found on `$PATH`.
 *
 * Unlike the dlv resolver — which returns a bare `'dlv'` and lets the OS resolve
 * it at spawn time — this returns a concrete absolute path (or `undefined`) so
 * `activate()` can decide up front whether a server exists and, if not, show a
 * single actionable message instead of spawning a command that will not resolve.
 *
 * @param env The environment to read (`process.env` in production).
 * @param opts Optional injectable `home` and `exists` probe for testing.
 */
export function resolveGopls(env: GoplsEnv, opts: ResolveGoplsOptions = {}): string | undefined {
	const exists = opts.exists ?? existsSync;
	const home = opts.home ?? homedir();

	const fromEnv = env.BURROW_GOPLS_PATH;
	if (fromEnv && exists(fromEnv)) {
		return fromEnv;
	}

	const goBin = env.GOBIN || join(env.GOPATH || join(home, 'go'), 'bin');
	const goBinCandidate = join(goBin, 'gopls');
	if (exists(goBinCandidate)) {
		return goBinCandidate;
	}

	for (const dir of (env.PATH || '').split(delimiter)) {
		if (!dir) {
			continue;
		}
		const candidate = join(dir, 'gopls');
		if (exists(candidate)) {
			return candidate;
		}
	}

	return undefined;
}
