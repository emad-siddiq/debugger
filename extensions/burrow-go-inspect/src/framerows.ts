/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// framerows.ts — turning a DAP stack trace into the compact rows the Frames view
// draws (IX, architecture task 05.2: "one line per frame … stdlib/runtime frames
// collapse into a single expandable `runtime ⋯ (12)` row by default — you almost
// never want them"). Pure and synchronous, so it is unit-tested directly.

/** The subset of a DAP `StackFrame` we read. */
export interface DapFrame {
	readonly id: number;
	readonly name: string;
	readonly line: number;
	readonly source?: { readonly name?: string; readonly path?: string };
}

/** A drawable row: either one frame, or a run of foreign frames folded up. */
export type FrameRow =
	| { readonly type: 'frame'; readonly frameId: number; readonly func: string; readonly location: string; readonly foreign: boolean }
	// `foldKey` is the STACK INDEX of the run's first frame, not a frame id: dlv
	// mints fresh frame ids on every `stackTrace` request (verified — a second call
	// returns 1008.. where the first returned 1004..), so fold state keyed on frame
	// id would never survive the re-render that expanding triggers. The index is
	// stable within a stop, which is exactly the fold state's lifetime.
	| { readonly type: 'fold'; readonly label: string; readonly count: number; readonly foldKey: number };

/**
 * The package part of a Go frame name: everything before the first `.` that
 * follows the last `/`. `github.com/x/y.(*T).M` → `github.com/x/y`,
 * `sync.(*Mutex).Lock` → `sync`, `main.gauntlet` → `main`.
 */
export function packageOf(func: string): string {
	const slash = func.lastIndexOf('/');
	const dot = func.indexOf('.', slash + 1);
	return dot < 0 ? func : func.slice(0, dot);
}

/**
 * Is this frame the user's own code?
 *
 * Decided by the SOURCE PATH being inside a workspace root, not by the package
 * name. The tempting name heuristic — "stdlib packages have no dot in their
 * first path segment" — quietly misfires on a module named `burrow/...` or
 * `myapp/...`, which is exactly this repo's own fixture. Paths do not lie.
 *
 * With no path at all (dlv omits it for some runtime frames) fall back to the
 * package name, where `runtime` and friends are the only realistic case.
 */
export function isProjectFrame(frame: DapFrame, roots: readonly string[]): boolean {
	const path = frame.source?.path;
	if (!path) {
		return false;
	}
	if (roots.length === 0) {
		return !isStdlibPackage(packageOf(frame.name));
	}
	return roots.some(root => path === root || path.startsWith(root.endsWith('/') ? root : root + '/'));
}

/** Fallback only: stdlib import paths have no dot in their first segment. */
function isStdlibPackage(pkg: string): boolean {
	const first = pkg.split('/')[0];
	return pkg !== 'main' && !first.includes('.');
}

/** The dominant package in a folded run, for its label. */
function foldLabel(frames: readonly DapFrame[]): string {
	const counts = new Map<string, number>();
	for (const f of frames) {
		const pkg = packageOf(f.name);
		counts.set(pkg, (counts.get(pkg) ?? 0) + 1);
	}
	let best = '';
	let bestCount = -1;
	for (const [pkg, count] of counts) {
		if (count > bestCount) {
			best = pkg;
			bestCount = count;
		}
	}
	return best;
}

/** `main.gauntlet` at `gauntlet.go:110` → the dim right-hand half of a row. */
function locationOf(frame: DapFrame): string {
	const file = frame.source?.name ?? '';
	return file ? `${file}:${frame.line}` : String(frame.line);
}

/**
 * Collapse each run of consecutive foreign frames into one fold row. Runs the
 * user expanded (by frame id of the run's first frame) stay expanded.
 *
 * A run of ONE is left alone: a `runtime ⋯ (1)` row costs a click to reveal
 * exactly as much text as it replaced.
 */
export function buildRows(frames: readonly DapFrame[], roots: readonly string[], expanded: ReadonlySet<number>): FrameRow[] {
	const rows: FrameRow[] = [];
	let run: DapFrame[] = [];
	let runStart = 0;

	const flush = () => {
		if (run.length === 0) {
			return;
		}
		if (run.length === 1 || expanded.has(runStart)) {
			rows.push(...run.map(f => frameRow(f, true)));
		} else {
			rows.push({ type: 'fold', label: foldLabel(run), count: run.length, foldKey: runStart });
		}
		run = [];
	};

	frames.forEach((frame, index) => {
		if (isProjectFrame(frame, roots)) {
			flush();
			rows.push(frameRow(frame, false));
		} else {
			if (run.length === 0) {
				runStart = index;
			}
			run.push(frame);
		}
	});
	flush();
	return rows;
}

function frameRow(frame: DapFrame, foreign: boolean): FrameRow {
	return { type: 'frame', frameId: frame.id, func: frame.name, location: locationOf(frame), foreign };
}
