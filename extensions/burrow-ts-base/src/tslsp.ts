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
	 * Directories whose `node_modules` to probe, in order — the selected project
	 * first (use its pinned TS server), then the extension's own bundled copy as
	 * the turnkey fallback.
	 */
	readonly binRoots?: readonly string[];
	/** Existence probe, injectable for tests; defaults to `fs.existsSync`. */
	readonly exists?: (path: string) => boolean;
}

/**
 * How to launch what was found.
 *
 * `executable` — a real binary or npm shim; spawn it directly.
 * `module` — the server's own JS entry point, to be run under Node.
 *
 * The distinction exists because of a packaging fact that cost a bug report:
 * **the packaged app ships the `typescript-language-server` PACKAGE but not
 * `node_modules/.bin`.** `build/lib/extensions.ts` copies each declared
 * dependency with `glob(node_modules/<dep>/**)`, and npm's shims live in
 * `node_modules/.bin`, which matches no dependency name. So the bundled
 * fallback existed in the repo, passed every test, and was absent from every
 * installed build — "the TypeScript language server was not found", on a build
 * whose own error message says it bundles one.
 */
export interface TsLspResolution {
	readonly kind: 'executable' | 'module';
	readonly path: string;
}

const SERVER_BIN = 'typescript-language-server';
/** The package's own `bin` entry — present wherever the package itself is. */
const SERVER_MODULE = ['typescript-language-server', 'lib', 'cli.mjs'];

/**
 * Resolves how to launch `typescript-language-server`, or `undefined` when
 * nothing is found. Order:
 *
 *   1. `BURROW_TS_LSP_PATH` — a `.mjs`/`.js` there is a module, anything else a
 *      binary, so the override can point at either.
 *   2. Each `binRoots` entry's `node_modules/.bin/typescript-language-server` —
 *      an npm-installed shim, which a project that pins its own server has.
 *   3. Each `binRoots` entry's `node_modules/typescript-language-server/lib/cli.mjs`
 *      — the package's own entry, which is what the PACKAGED app has, because
 *      the bundle carries the package and not the shim.
 *   4. The first match on `$PATH`.
 *
 * Like the gopls resolver it returns something concrete (or `undefined`) so
 * `activate()` can decide up front whether to start a client or show a single
 * actionable message.
 */
export function resolveTsLsp(env: TsLspEnv, opts: ResolveTsLspOptions = {}): TsLspResolution | undefined {
	const exists = opts.exists ?? existsSync;
	const roots = (opts.binRoots ?? []).filter(Boolean);

	const fromEnv = env.BURROW_TS_LSP_PATH;
	if (fromEnv && exists(fromEnv)) {
		return { kind: /\.(mjs|cjs|js)$/.test(fromEnv) ? 'module' : 'executable', path: fromEnv };
	}

	for (const root of roots) {
		const shim = join(root, 'node_modules', '.bin', SERVER_BIN);
		if (exists(shim)) {
			return { kind: 'executable', path: shim };
		}
	}

	// Only after every shim: a project's own pinned server should still win over
	// the copy Burrow ships, and this loop is the one that finds Burrow's.
	for (const root of roots) {
		const entry = join(root, 'node_modules', ...SERVER_MODULE);
		if (exists(entry)) {
			return { kind: 'module', path: entry };
		}
	}

	for (const dir of (env.PATH || '').split(delimiter)) {
		if (!dir) {
			continue;
		}
		const candidate = join(dir, SERVER_BIN);
		if (exists(candidate)) {
			return { kind: 'executable', path: candidate };
		}
	}

	return undefined;
}
