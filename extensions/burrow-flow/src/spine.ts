/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// spine.ts — where burrow-flow's Go stack is, and what the last trace found.
//
// WHY THIS EXISTS. `burrow-flow` is the fork's headline differentiator and until
// now it could only find a backend three ways, all of them merkle's: a
// `<root>/backend/go.mod`, a root module that also had a `router.go`, or the
// environment variable `MERKLE_ROOT`. flowscan the TOOL traces arbitrary Go — 14
// routes on go-chi/chi, measured — so the API rail was narrower than the analysis
// underneath it by a wide margin, for no reason but detection.
//
// DUPLICATED, NOT IMPORTED — and bound by a contract test.
//
// WO-72 duplicated six lines of detection order into `burrow-go-debug` on the
// grounds that a rail going dark because a SIBLING EXTENSION failed to activate is
// a worse failure than repetition. That argument is about RUNTIME coupling and it
// holds here unchanged: an API rail that needs `burrow-project` to have activated
// first is an API rail with a new way to be empty.
//
// But this case differs from WO-72's in one way that matters. There, the copy was
// six lines of an ordered list; here the two copies also have to agree about a FILE
// FORMAT — `.burrow/flow.json`, which this extension writes and `burrow-project`
// reads. Duplication that spans a serialized contract drifts silently and the
// symptom is a capability that reports the wrong state forever.
//
// So the copy stays, and `test/spine.test.js` requires BOTH this module and
// `burrow-project`'s compiled `descriptor.js` and asserts they agree — on the
// search order, on the descriptor path, and on every field of the state file. A
// test-only require has no runtime coupling at all, and drift fails a test instead
// of a rail.
//
// No `vscode` import, so `out/spine.js` is require()-able from the plain node tests.

/** The bits of a filesystem this module needs. Injected so tests can fake it. */
export interface Tree {
	exists(relativePath: string): boolean;
	read(relativePath: string): string | undefined;
}

/**
 * Where a Go module sits in a repository that has never seen Burrow. The root
 * wins, then the conventional server directories.
 *
 * MUST equal `burrow-project`'s `GO_SUBDIRS`, root-first. Asserted by the contract
 * test — if the two disagree, `burrow.project.explain` and the API rail will name
 * different directories and neither will say which is right.
 */
export const GO_SEARCH_ORDER = ['.', 'backend', 'server', 'api', 'cmd', 'src', 'service'] as const;

export const DESCRIPTOR_PATH = '.burrow/project.json';

// --- the Go stack ----------------------------------------------------------

export interface GoStack {
	/** Module directory relative to the project root. '.' for the root itself. */
	readonly root: string;
	/** How it was found — carried into the message a user reads when it is not. */
	readonly from: 'setting' | 'descriptor' | 'detected';
}

/**
 * The Go module this project's routes live in.
 *
 * Order is deliberate and is the descriptor's own: an explicit SETTING is a
 * decision someone typed, the DESCRIPTOR is a decision someone recorded, and
 * detection is a guess from the tree. Each one is allowed to overrule the next.
 *
 * `MERKLE_ROOT` is gone and does not come back. An environment variable naming one
 * company's repository is not detection, it is a hard-coded target wearing a
 * disguise — and it took precedence over the folder the user actually had open.
 *
 * The `router.go` requirement is gone too. It was there to distinguish "a Go module"
 * from "the Go module with the routes in it", which it does not do: merkle's own
 * router lives in `router.go` and nothing else's does. chi puts its registrations
 * in `middleware/profiler.go`; the scaffold puts them in `main.go`. Requiring a
 * filename made the common case — a module at the root — undetectable.
 */
export function goStack(tree: Tree, settingDir: string | undefined): GoStack | undefined {
	if (settingDir) {
		// An absolute setting is resolved by the caller; here it is already relative
		// or absolute-and-checked. Trust it if it has a go.mod, and say so if not.
		return { root: settingDir, from: 'setting' };
	}
	const declared = declaredGoRoot(tree.read(DESCRIPTOR_PATH));
	if (declared && tree.exists(joinRel(declared, 'go.mod'))) {
		return { root: declared, from: 'descriptor' };
	}
	for (const dir of GO_SEARCH_ORDER) {
		if (tree.exists(joinRel(dir, 'go.mod'))) {
			return { root: dir, from: 'detected' };
		}
	}
	return undefined;
}

/** The Go stack root a `.burrow/project.json` declares, if it declares one. */
export function declaredGoRoot(descriptorText: string | undefined): string | undefined {
	const descriptor = parseJson(descriptorText) as { stacks?: { id?: string; root?: string }[] } | undefined;
	const stack = descriptor?.stacks?.find((s) => s?.id === 'go' && typeof s.root === 'string');
	return stack?.root;
}

/**
 * The project's name, for the oracle's `--digest <app>` argument.
 *
 * The default was the literal string `nodewatch` — merkle's app name, in a
 * setting's `default` field, where nobody would look for it. Now it is the
 * descriptor's name or the folder's, and the setting overrides.
 */
export function oracleAppName(descriptorText: string | undefined, folderName: string): string {
	const descriptor = parseJson(descriptorText) as { name?: string } | undefined;
	return (typeof descriptor?.name === 'string' && descriptor.name) || folderName;
}

/** `'.'` + `'go.mod'` is `'go.mod'`, not `'./go.mod'`. */
export function joinRel(dir: string, name: string): string {
	return dir === '.' || dir === '' ? name : `${dir}/${name}`;
}

// --- what the last trace found ---------------------------------------------

/**
 * The record of a trace having HAPPENED (WO — burrow-flow §3).
 *
 * `flow` read `unknown` for every Go stack and kept reading it after the tool had
 * run and produced a number — correct at detection time, wrong forever after. The
 * three states a user has to be able to tell apart are:
 *
 *   not tried            no file       → `unknown`, "run the tool to find out"
 *   tried, found routes  routes > 0    → `live`,   with the count
 *   tried, found NONE    routes === 0  → `inert`,  and that is chi's honest state
 *
 * The third had nowhere to live, which is the whole reason this file exists: a
 * missing file and a file saying zero are different facts, and only one of them
 * means "there is nothing here".
 *
 * WHERE IT LIVES, and why not the descriptor. `.burrow/flow.json`, beside
 * `project.json` but not inside it. The descriptor is a committable statement of
 * what a project IS; this is a cache of what a tool DID, on this machine, at a
 * revision. Merging the two would put a machine-local timestamp into a file people
 * are meant to check in.
 *
 * NO PAYLOADS. Counts, the module directory and the revision — no route paths, no
 * SQL, no handler names. flows.json already holds all of that in the extension's
 * own storage; this is the summary a sibling extension is allowed to read, and the
 * standing rule about serialized state applies to it like everything else.
 */
export interface FlowState {
	readonly version: number;
	/** ISO-8601, so "when did this last run" is answerable without stat(). */
	readonly ranAt: string;
	/** Module directory the trace ran against, relative to the project root. */
	readonly backend: string;
	/** Git revision of the backend at trace time, when there was one. */
	readonly rev?: string;
	readonly routes: number;
	readonly traced: number;
	readonly partial: number;
	readonly unknown: number;
	/**
	 * Packages the Go loader could not type-check.
	 *
	 * Not decoration, and not a proven cause either. flowscan exits ZERO whatever it
	 * found: WO-75 measured two binaries against the same merkle tree and got
	 * `235 routes (209 traced)` from one and `235 routes (6 traced, 229 partial)`
	 * from the other — the same shape as a real answer, off by two hundred.
	 *
	 * WO-75 blamed the Go release the tracer was built with. WO-76 could not
	 * reproduce that: a go1.24 build reports 45 packages it could not type-check and
	 * still traces 209 of 235. So missing type information is a REAL signal that the
	 * analysis is working with less than the whole program, and it is not on its own
	 * enough to collapse the answer. The cause of the 6 is still unknown.
	 *
	 * It rides along anyway, because a count that is wrong and confident is worse
	 * than one that is missing, and this is the only evidence the surface has that
	 * the run was working blind. `P2-15` is the gate that does not depend on knowing
	 * the cause.
	 */
	readonly loadErrors?: number;
}

export const FLOW_STATE_PATH = '.burrow/flow.json';
export const FLOW_STATE_VERSION = 1;

export function serializeFlowState(state: FlowState): string {
	return JSON.stringify(state, undefined, '\t') + '\n';
}

/** Parse, tolerating anything: a corrupt cache must return "not tried", never throw. */
export function parseFlowState(text: string | undefined): FlowState | undefined {
	const value = parseJson(text) as Partial<FlowState> | undefined;
	if (!value || typeof value.routes !== 'number' || value.version !== FLOW_STATE_VERSION) {
		return undefined;
	}
	return {
		version: FLOW_STATE_VERSION,
		ranAt: typeof value.ranAt === 'string' ? value.ranAt : '',
		backend: typeof value.backend === 'string' ? value.backend : '.',
		rev: typeof value.rev === 'string' ? value.rev : undefined,
		routes: value.routes,
		traced: num(value.traced),
		partial: num(value.partial),
		unknown: num(value.unknown),
		loadErrors: typeof value.loadErrors === 'number' ? value.loadErrors : undefined,
	};
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseJson(text: string | undefined): unknown {
	if (!text) {
		return undefined;
	}
	try {
		const value = JSON.parse(text) as unknown;
		return value && typeof value === 'object' ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * How many packages the Go loader could not type-check, from flowscan's stderr.
 *
 * flowscan prints `flowscan: N load error(s), first: …` and exits ZERO, so a run
 * working with incomplete type information is indistinguishable from a clean one at
 * the call site — and announces itself only in an output channel nobody has open.
 *
 * Whether it changes the ANSWER is a separate question and the honest answer is
 * "sometimes". A go1.24 build of the current tracer reports 45 load errors on merkle
 * and still traces 209 of 235; a binary WO-75 measured reported the same 235 routes
 * with 6 traced. Both are worth surfacing; neither is proof of the other.
 */
export function loadErrorCount(stderr: string): number {
	const match = /flowscan:\s+(\d+)\s+load error/.exec(stderr);
	return match ? Number(match[1]) : 0;
}

/** A module directory as it belongs in a sentence. `'.'` is the project root, and
 *  "no routes found in ." reads as a typo — which it looked like. */
export function whereIs(moduleRoot: string): string {
	return moduleRoot === '.' || moduleRoot === '' ? 'this module' : moduleRoot;
}

// --- the sentence a user reads when there is no backend ---------------------

/**
 * Why the API rail is empty here, naming what was actually looked for.
 *
 * The old text said "open a project with backend/go.mod or set
 * burrow.flow.backendDir", which is a true statement about merkle and a lie about
 * every other repository: a Go module at the root needs neither. House rule from
 * WO-72 §3 — no Burrow code path may decline to act without saying why — and the
 * why has to be the real one.
 */
export function noBackendMessage(folderName: string | undefined): string {
	if (!folderName) {
		return 'No folder is open, so there is no Go module to trace.';
	}
	return `No Go module found in ${folderName} — looked for go.mod in the root and in `
		+ `${GO_SEARCH_ORDER.filter((d) => d !== '.').join('/, ')}/. `
		+ 'Set burrow.flow.backendDir, or record the module in .burrow/project.json.';
}
