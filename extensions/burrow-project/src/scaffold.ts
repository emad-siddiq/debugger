/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// scaffold.ts — the only place this extension writes to disk.
//
// Two rules it enforces so the templates cannot break them by accident:
//
//   1. NEVER OVERWRITE. A scaffold that clobbers an existing `main.go` is a
//      scaffold nobody runs twice. Existing files are skipped and reported, so
//      "add Postgres to this project" is safe on a project that already has half
//      of it.
//   2. The `.burrow/` descriptor is written LAST and separately, so a failure
//      part-way through never leaves a descriptor describing files that are not
//      there.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GeneratedFile, MIN_GO_VERSION } from './goTemplate';

export interface WriteResult {
	readonly written: readonly string[];
	readonly skipped: readonly string[];
}

/** Write the files that do not exist yet; report both lists. */
export function writeFiles(root: string, files: readonly GeneratedFile[]): WriteResult {
	const written: string[] = [];
	const skipped: string[] = [];
	for (const file of files) {
		const target = path.join(root, file.path);
		if (fs.existsSync(target)) {
			skipped.push(file.path);
			continue;
		}
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, file.content, 'utf8');
		written.push(file.path);
	}
	return { written, skipped };
}

/**
 * The `go` directive to write, from the toolchain that is actually installed.
 *
 * A template that hard-codes a version NEWER than the local Go turns Go's
 * toolchain mechanism on: the first build wants to download the named toolchain,
 * which breaks the offline-first-build promise the template makes elsewhere (no
 * `require` block, and P2-14 builds it with `GOPROXY=off`). Measured 2026-07-30:
 * the template said `go 1.25`, the machine had `go1.24.1`.
 *
 * `go version` prints `go version go1.24.1 darwin/arm64`; the directive wants
 * `1.24`. Patch versions are deliberately dropped — a go.mod naming `1.24.1`
 * demands at least that patch, which is stricter than any scaffold should be.
 */
export function installedGoVersion(goBinary = 'go'): string | undefined {
	try {
		const out = cp.spawnSync(goBinary, ['version'], { encoding: 'utf8', timeout: 5000 });
		const match = /go(\d+)\.(\d+)/.exec(out.stdout || '');
		if (!match) {
			return undefined;
		}
		const [, major, minor] = match;
		// Never write a directive below the template's floor: on an older toolchain
		// the route patterns silently stop matching, and claiming 1.22 at least
		// makes Go say so out loud.
		return Number(major) === 1 && Number(minor) < 22 ? MIN_GO_VERSION : `${major}.${minor}`;
	} catch {
		return undefined;
	}
}

/** A `Tree` over a real directory, for `detect()`. */
export function treeOf(root: string) {
	return {
		exists: (rel: string): boolean => fs.existsSync(path.join(root, rel)),
		read: (rel: string): string | undefined => {
			try {
				return fs.readFileSync(path.join(root, rel), 'utf8');
			} catch {
				return undefined;
			}
		},
		dirs: (rel: string): string[] => entries(root, rel, (e) => e.isDirectory()),
		files: (rel: string): string[] => entries(root, rel, (e) => e.isFile()),
	};
}

/**
 * Directory entries of one kind, or nothing at all.
 *
 * Detection probes a dozen paths that will mostly not exist — `infra/`, `deploy/`,
 * `docker/` and friends — so a throw from any one of them would take the whole
 * answer down. Absent is not exceptional here; it is the common case.
 */
function entries(root: string, rel: string, keep: (e: fs.Dirent) => boolean): string[] {
	try {
		return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).filter(keep).map((e) => e.name);
	} catch {
		return [];
	}
}

/**
 * Write `.burrow/project.json`.
 *
 * Separate from `writeFiles` on purpose: this is the one file that IS Burrow's,
 * and keeping it out of the template list is what lets the "no generated file
 * mentions Burrow" test cover the templates without an exception list.
 */
export function writeDescriptor(root: string, relativePath: string, content: string): void {
	const target = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content, 'utf8');
}
