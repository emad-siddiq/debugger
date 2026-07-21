/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// tslsp.ts — the pure, vscode-free resolver for the `typescript-language-server`
// binary. Kept free of any 'vscode' import so it is unit-testable as a plain
// CommonJS module (see test/tslsp.test.js). Mirrors burrow-go-base's gopls
// resolver: an explicit override, then the selected project's node_modules, then
// the extension's own bundled copy, then PATH.

import { existsSync } from 'fs';
import { delimiter, join } from 'path';

/** The subset of the environment the resolver reads (injectable for tests). */
export interface TsLspEnv {
	readonly BURROW_TS_LSP_PATH?: string | undefined;
	readonly PATH?: string | undefined;
}

/** Options for {@link resolveTsLsp}; `binRoots` + `exists` are injectable for tests. */
export interface ResolveTsLspOptions {
	/**
	 * Directories whose `node_modules/.bin/typescript-language-server` to probe,
	 * in order — the selected project first (use its pinned TS server), then the
	 * extension's own bundled copy as the turnkey fallback.
	 */
	readonly binRoots?: readonly string[];
	/** Existence probe, injectable for tests; defaults to `fs.existsSync`. */
	readonly exists?: (path: string) => boolean;
}

const SERVER_BIN = 'typescript-language-server';

/**
 * Resolves an absolute path to the `typescript-language-server` binary, or
 * `undefined` when none is found. Order: `BURROW_TS_LSP_PATH` → each `binRoots`
 * entry's `node_modules/.bin/typescript-language-server` → the first match on
 * `$PATH`. Like the gopls resolver it returns a concrete path (or `undefined`)
 * so `activate()` can decide up front whether to start a client or show a single
 * actionable message.
 */
export function resolveTsLsp(env: TsLspEnv, opts: ResolveTsLspOptions = {}): string | undefined {
	const exists = opts.exists ?? existsSync;

	const fromEnv = env.BURROW_TS_LSP_PATH;
	if (fromEnv && exists(fromEnv)) {
		return fromEnv;
	}

	for (const root of opts.binRoots ?? []) {
		if (!root) {
			continue;
		}
		const candidate = join(root, 'node_modules', '.bin', SERVER_BIN);
		if (exists(candidate)) {
			return candidate;
		}
	}

	for (const dir of (env.PATH || '').split(delimiter)) {
		if (!dir) {
			continue;
		}
		const candidate = join(dir, SERVER_BIN);
		if (exists(candidate)) {
			return candidate;
		}
	}

	return undefined;
}
