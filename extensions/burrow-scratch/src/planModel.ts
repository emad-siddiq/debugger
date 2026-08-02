/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// planModel.ts — the curriculum, as data.
//
// Given every source file of a reference project, produce an ORDERED plan for
// rebuilding it by hand: stages you can finish in a sitting, steps inside them,
// and for each step the facts that make it writable (what it declares, what it
// needs, how long it is in the reference).
//
// The ordering rule is the whole idea and it is not a heuristic: you cannot
// write a file before the things it imports exist. Go packages form a DAG by
// language rule, TypeScript directories form one in practice, so both are
// topologically sorted and the plan reads bottom-up — leaves first, the router
// and the app shell last. That is also the order in which the project becomes
// *runnable*, which is what makes Burrow's own tools able to follow along.
//
// No `vscode` import: every rule here is unit-tested standalone
// (test/planModel.test.js). Nothing in this file knows the name of any
// particular project — it reads go.mod for the module path and package.json
// for the JS root, and everything else falls out of the file tree.

export type StepKind = 'go' | 'gotest' | 'ts' | 'tsx' | 'style' | 'sql' | 'manifest' | 'lock' | 'doc' | 'other';

/**
 * `write` — you type this one.
 * `copy` — prose or a diagram: real project content, but not something typing
 *   teaches you anything about.
 * `generate` — a toolchain writes it. The step carries the COMMAND rather than
 *   the content, and is done when the command exits 0 and the file it produces
 *   exists. `go.mod` is the case that made this necessary: the plan asked you to
 *   type out a file whose only correct way to come into existence is
 *   `go mod init`.
 */
export type StepMode = 'write' | 'copy' | 'generate';

/**
 * What a command needs in front of it before exiting 0 means anything.
 *
 * `go mod init … && go mod tidy` on an empty directory exits 0, prints
 * `warning: "all" matched no packages`, and writes a three-line `go.mod` where
 * the reference has thirty-six. Both checks went green and the step was done
 * with none of its twenty-six requires. `08b §1` guarantees a *missing
 * toolchain* never reports a pass; this is the adjacent hole — **a present
 * toolchain reporting success for work that has not happened.**
 *
 * The command still runs (`go mod init` does its half now). Its VERDICT is what
 * this qualifies.
 */
export interface Precondition {
	/** Scratch-relative directory to look in. */
	readonly dir: string;
	/** A filename, or a suffix like `.go` — whichever the command consumes. */
	readonly match: string;
	/** Said instead of a green tick. */
	readonly why: string;
}

export interface Check {
	readonly kind: 'exists' | 'shell';
	readonly label: string;
	/** `shell` only. Run with the scratch root as the default cwd. */
	readonly cmd?: string;
	/** `shell` only, relative to the scratch root. */
	readonly cwd?: string;
	/** `shell` only: exiting 0 with this unmet is not a pass. */
	readonly needs?: Precondition;
	/**
	 * `exists` only: an empty file is a pass, because the reference's own copy of
	 * this file is empty. Set at plan time from the file's byte count, never
	 * guessed at check time — see `checksFor`.
	 */
	readonly mayBeEmpty?: boolean;
}

export interface ToolHint {
	readonly label: string;
	readonly command: string;
	readonly why: string;
}

export interface ScratchStep {
	/** The reference-relative POSIX path. Doubles as the path inside the
	 *  scratch, which is why it is also the stable id. */
	readonly id: string;
	readonly stage: string;
	readonly title: string;
	readonly kind: StepKind;
	readonly mode: StepMode;
	readonly lines: number;
	readonly bytes: number;
	/** `generate` only: what to run, relative to {@link ScratchStep.commandCwd}. */
	readonly command?: string;
	readonly commandCwd?: string;
	/** The file's own leading comment, or a derived sentence when it has none. */
	readonly summary: string;
	/** Top-level exported declarations, in source order. */
	readonly declares: readonly string[];
	/** Step ids this file imports directly (TypeScript resolves to files). */
	readonly deps: readonly string[];
	/** Stage ids this file depends on (Go imports are package-level). */
	readonly depStages: readonly string[];
	readonly checks: readonly Check[];
	/** A derived sentence the graph cannot express — today, how to reach the
	 *  database this file starts, and what else in the project disagrees about
	 *  it. Enrichment only: absent unless something computed it. */
	readonly note?: string;
	/** Up to three routes this file serves, for the page to name. Enrichment
	 *  only: absent everywhere when flowscan has not run, and never structural. */
	readonly routes?: readonly string[];
	/** How many routes reach it in total, when more than `routes` names. */
	readonly routeCount?: number;
}

export type StageClass = 'foundations' | 'schema' | 'go' | 'web' | 'rest';

/**
 * A point where the thing you are building **does something**.
 *
 * 164 steps before the first command that executes code the learner wrote, 605
 * before the app compiles, 1,953 before a page renders (WO-78 §2c) — and nothing
 * anywhere in 2,093 steps says *now run it*. Reordering to fix that was refused
 * twice and correctly: the topological invariant is the feature. So the fix is
 * to name the moments that already exist.
 *
 * DERIVED, never a list. Every milestone below is a stage that contains the
 * files a particular command needs, found by looking at what is in it.
 *
 * A MILESTONE THAT LIES IS WORSE THAN NONE — the same rule as the checks. `go
 * build ./...` on an empty module exits 0 and proves nothing, so a milestone
 * carries the same {@link Precondition} the generate checks do, and reports
 * "could not run yet" rather than a success it did not earn.
 */
export interface Milestone {
	/** What happens, in the imperative. Shown as the button. */
	readonly label: string;
	/** Why this is a moment rather than another command. One sentence. */
	readonly why: string;
	readonly command: string;
	readonly cwd: string;
	/** What has to be in place for the command to mean anything. */
	readonly needs?: Precondition;
}

export interface ScratchStage {
	readonly id: string;
	readonly title: string;
	readonly blurb: string;
	readonly cls: StageClass;
	readonly steps: readonly string[];
	/** Run once before the stage's checks can pass (dependency installs). */
	readonly setup: readonly string[];
	/** What to run when the stage is finished. */
	readonly checks: readonly Check[];
	/** Burrow tools this stage lights up, with the reason. */
	readonly tools: readonly ToolHint[];
	/** The moment this stage's work starts doing something, if it does. */
	readonly milestone?: Milestone;
}

export interface ScratchPlan {
	readonly version: 1;
	readonly name: string;
	/** Absolute path of the project being rebuilt. */
	readonly reference: string;
	readonly stages: readonly ScratchStage[];
	readonly steps: Readonly<Record<string, ScratchStep>>;
	readonly counts: { readonly stages: number; readonly steps: number; readonly lines: number };
}

export interface SourceFile {
	/** Reference-relative, POSIX separators. */
	readonly path: string;
	readonly text: string;
	readonly bytes: number;
}

// ---------------------------------------------------------------------------
// What is not part of the project
// ---------------------------------------------------------------------------

/** Directories that are never authored by hand. Matched on any path segment. */
export const IGNORED_DIRS: readonly string[] = [
	'.git', 'node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', '.next', '.turbo',
	'.cache', '.venv', '__pycache__', 'playwright-report', 'test-results', '.playwright-cli',
	'.idea', '.DS_Store',
];

/** Files that are build output, secrets or noise rather than source. */
const IGNORED_FILE = /(^|\/)(\.DS_Store|.*\.log|.*\.tsbuildinfo|__debug_bin.*)$/;

/** A byte ceiling — past this it is a fixture or a blob, not something to write. */
const MAX_BYTES = 256 * 1024;

export function isIgnored(relPath: string): boolean {
	const segments = relPath.split('/');
	if (segments.some((s) => IGNORED_DIRS.includes(s))) {
		return true;
	}
	if (IGNORED_FILE.test(relPath)) {
		return true;
	}
	// A real .env holds secrets and is never checked in; .env.example IS worth
	// writing — it is the config contract, and often the only place the whole
	// set of environment variables is written down.
	const base = baseName(relPath);
	return base.startsWith('.env') && !/\.(example|sample|template)$/.test(base);
}

const MANIFESTS = new Set(['go.mod', 'package.json', 'Makefile', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.env.example']);
const LOCKS = new Set(['go.sum', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

/** The manifest a lockfile is generated FROM, when the project has one. */
const LOCK_MANIFEST = new Map([
	['go.sum', 'go.mod'], ['package-lock.json', 'package.json'],
	['pnpm-lock.yaml', 'package.json'], ['yarn.lock', 'package.json'],
]);

/**
 * A file that is JavaScript or TypeScript, whatever its step KIND says.
 *
 * `vite.config.ts` is taught as a manifest and is still a module: it imports,
 * and `.vite.mockport.config.ts` imports IT. Kind decides how a file is
 * explained; it must not decide whether the graph can see it — which it did,
 * and the ordering invariant was blind to every build-config file in every
 * project as a result.
 */
function isJsModule(relPath: string): boolean {
	return /\.(ts|tsx|js|mjs|cjs|mts)$/.test(baseName(relPath));
}

function isTsconfig(relPath: string): boolean {
	return /^tsconfig.*\.json$/.test(baseName(relPath));
}

function baseName(p: string): string {
	return p.slice(p.lastIndexOf('/') + 1);
}

function dirName(p: string): string {
	const i = p.lastIndexOf('/');
	return i < 0 ? '' : p.slice(0, i);
}

function join(a: string, b: string): string {
	return a ? (b ? `${a}/${b}` : a) : b;
}

export function kindOf(relPath: string): StepKind {
	const base = baseName(relPath);
	if (LOCKS.has(base)) {
		return 'lock';
	}
	if (MANIFESTS.has(base) || /^tsconfig.*\.json$/.test(base) || /\.config\.(ts|js|mts|cjs)$/.test(base)) {
		return 'manifest';
	}
	if (base.endsWith('_test.go')) {
		return 'gotest';
	}
	if (base.endsWith('.go')) {
		return 'go';
	}
	if (base.endsWith('.tsx')) {
		return 'tsx';
	}
	if (/\.(ts|js|mjs|mts)$/.test(base)) {
		return 'ts';
	}
	if (/\.(css|scss|less)$/.test(base)) {
		return 'style';
	}
	if (base.endsWith('.sql')) {
		return 'sql';
	}
	// `.puml` joins the doc kind rather than falling to `other`. That widens what
	// `doc` means — from "prose" to "prose and diagrams", i.e. project content
	// that is read rather than typed — and it is the only change to kindOf's
	// contract here. Everything a `doc` names is now a `copy` step.
	if (/\.(md|txt|puml)$/.test(base)) {
		return 'doc';
	}
	return 'other';
}

/**
 * The command that produces a file, for files no one should type.
 *
 * `go.sum` is deliberately absent: `go mod tidy` writes it as a side effect of
 * the `go.mod` step, so giving it a step of its own would ask the developer to
 * run a command that has already run.
 */
export function generatedBy(relPath: string, modulePath: string | undefined): { cmd: string; cwd: string } | undefined {
	const base = baseName(relPath);
	const cwd = dirName(relPath);
	if (base === 'go.mod') {
		// No module path means no go.mod to read it from, which cannot happen for
		// a file that IS a go.mod — but a corrupt one should not emit `go mod init`
		// with an empty argument.
		return modulePath ? { cmd: `go mod init ${modulePath} && go mod tidy`, cwd } : undefined;
	}
	if (base === 'package-lock.json') {
		return { cmd: 'npm install', cwd };
	}
	if (base === 'pnpm-lock.yaml') {
		return { cmd: 'pnpm install', cwd };
	}
	if (base === 'yarn.lock') {
		return { cmd: 'yarn install', cwd };
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Reading the source
// ---------------------------------------------------------------------------

const GO_IMPORT_BLOCK = /^import\s*\(([\s\S]*?)^\)/m;
const GO_IMPORT_LINE = /^import\s+(?:[\w.]+\s+)?"([^"]+)"/m;

/** Every import path a Go file declares, in source order. */
export function goImports(text: string): string[] {
	const paths: string[] = [];
	const block = GO_IMPORT_BLOCK.exec(text);
	if (block) {
		for (const line of block[1].split('\n')) {
			const m = /^\s*(?:[\w.]+\s+)?"([^"]+)"/.exec(line);
			if (m) {
				paths.push(m[1]);
			}
		}
	}
	const single = GO_IMPORT_LINE.exec(text);
	if (single && !paths.includes(single[1])) {
		paths.push(single[1]);
	}
	return paths;
}

/** Top-level exported names: funcs (methods by their own name), types, vars,
 *  consts, including the members of grouped `type (` / `const (` blocks. */
export function goDeclares(text: string): string[] {
	const names: string[] = [];
	const push = (n: string | undefined) => {
		if (n && /^[A-Z]/.test(n) && !names.includes(n)) {
			names.push(n);
		}
	};
	let grouped: 'type' | 'const' | 'var' | undefined;
	for (const raw of text.split('\n')) {
		if (grouped) {
			if (/^\)/.test(raw)) {
				grouped = undefined;
			} else {
				push(/^\s+([A-Za-z_]\w*)/.exec(raw)?.[1]);
			}
			continue;
		}
		const group = /^(type|const|var)\s*\($/.exec(raw.trimEnd());
		if (group) {
			grouped = group[1] as 'type' | 'const' | 'var';
			continue;
		}
		push(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(raw)?.[1]);
		push(/^(?:type|const|var)\s+([A-Za-z_]\w*)/.exec(raw)?.[1]);
	}
	return names;
}

/** Exported names from a TS/TSX module. */
export function tsDeclares(text: string): string[] {
	const names: string[] = [];
	const re = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
	for (const m of text.matchAll(re)) {
		if (!names.includes(m[1])) {
			names.push(m[1]);
		}
	}
	if (/^export\s+default\s+(?:function\s*\(|\{|class\s|\()/m.test(text) && !names.length) {
		names.push('default');
	}
	return names;
}

/**
 * The files a tsconfig names: `extends`, and every `references[].path`.
 *
 * These are real edges — a solution-style `tsconfig.json` is meaningless before
 * the configs it references — and they were invisible, so four Foundations steps
 * were sorted alphabetically and called leaves. Regex rather than `JSON.parse`
 * for the same reason `tsImports` is: tsconfig permits comments and trailing
 * commas, and merkle's own `e2e/tsconfig.json` carries a `"//"` key.
 */
export function configRefs(text: string): string[] {
	const specs: string[] = [];
	const push = (s: string | undefined): void => {
		if (s && !specs.includes(s)) {
			specs.push(s);
		}
	};
	const extend = /"extends"\s*:\s*(?:"([^"]+)"|\[([\s\S]*?)\])/.exec(text);
	if (extend?.[1]) {
		push(extend[1]);
	} else if (extend?.[2]) {
		// TypeScript 5 allows an array of bases, applied left to right.
		for (const m of extend[2].matchAll(/"([^"]+)"/g)) {
			push(m[1]);
		}
	}
	const refs = /"references"\s*:\s*\[([\s\S]*?)\]/.exec(text);
	if (refs) {
		for (const m of refs[1].matchAll(/"path"\s*:\s*"([^"]+)"/g)) {
			push(m[1]);
		}
	}
	return specs;
}

/** Module specifiers from `import`/`export … from` and bare `import './x.css'`. */
export function tsImports(text: string): string[] {
	const specs: string[] = [];
	const re = /(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
	for (const m of text.matchAll(re)) {
		if (!specs.includes(m[1])) {
			specs.push(m[1]);
		}
	}
	return specs;
}

// ---------------------------------------------------------------------------
// The database a compose file starts
//
// Foundations ends with a compose file and 134 migrations follow it, and a
// learner who cannot connect to the database they just started is stopped three
// steps from the end of the stage. Worse on merkle: `Makefile` (step 11) sets
// `DATABASE_URL` to `postgres://postgres:postgres@…` and the compose file
// (step 17) declares user, password and database `nodewatch`. Both are the
// project's own files, faithfully reproduced, and nothing reconciles them.
//
// So the surface NAMES the discrepancy. Pointing at one of the two would be a
// guess about which is right; saying "these two files disagree, and the one you
// started is this one" is a fact, and it is the fact that unblocks.
// ---------------------------------------------------------------------------

export interface DbService {
	readonly service: string;
	readonly user: string;
	readonly password: string;
	readonly database: string;
	readonly port?: number;
}

/** The Postgres service a compose file declares, if it declares one. Indent-
 *  scoped rather than YAML-parsed: the keys are unambiguous and a parser is a
 *  dependency this extension does not have. */
export function composeDatabase(text: string): DbService | undefined {
	const lines = text.split('\n');
	let service = '', user = '', password = '', database = '', port: number | undefined;
	let indent = -1;
	for (const raw of lines) {
		const line = raw.replace(/\t/g, '  ');
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		const at = line.search(/\S/);
		const name = /^([A-Za-z0-9._-]+):\s*$/.exec(trimmed)?.[1];
		// A new service header at or above the level of the one we are reading
		// ends it. `environment:` is a mapping key at a deeper level, not a peer.
		if (name && (indent < 0 || at <= indent) && !/^(services|volumes|networks|environment|ports|build|healthcheck|deploy|logging)$/.test(name)) {
			if (user && password && database) {
				break;
			}
			service = name;
			indent = at;
			user = password = database = '';
			port = undefined;
			continue;
		}
		const kv = /^-?\s*"?POSTGRES_(USER|PASSWORD|DB)"?\s*[:=]\s*"?([^"'\s]+)"?/.exec(trimmed);
		if (kv) {
			if (kv[1] === 'USER') { user = kv[2]; } else if (kv[1] === 'PASSWORD') { password = kv[2]; } else { database = kv[2]; }
		}
		const published = /^-\s*"?(\d+):(\d+)"?\s*$/.exec(trimmed);
		if (published && published[2] === '5432') {
			port = Number(published[1]);
		}
	}
	return user && password && database ? { service, user, password, database, port } : undefined;
}

/** The first Postgres URL a file states, if it states one. */
export function postgresUrl(text: string): string | undefined {
	return /postgres(?:ql)?:\/\/[^\s"'`)]+/.exec(text)?.[0];
}

/** How to reach the database this compose file starts, and what disagrees.
 *  `others` is every other file in the same stage, so the comparison is with
 *  what the reader has already written and nothing else. */
export function databaseNote(text: string, others: ReadonlyMap<string, string>): string | undefined {
	const db = composeDatabase(text);
	if (!db) {
		return undefined;
	}
	const url = `postgres://${db.user}:${db.password}@localhost:${db.port ?? 5432}/${db.database}`;
	const head = `Starts \`${db.service}\`. Once it is up, connect with \`${url}\` — that is what this file declares.`;
	for (const [id, other] of others) {
		const stated = postgresUrl(other);
		if (stated && stated.split('?')[0] !== url) {
			return `${head}\n\n⚠︎ \`${id}\` says \`${stated}\` instead. Two of your own files disagree about this database:`
				+ ' the one above is the one you started, so it is the one that will connect.';
		}
	}
	return head;
}

/** The file's own explanation: its leading comment block, cleaned up. */
export function leadingComment(text: string, kind: StepKind): string {
	const lines = text.split('\n');
	const out: string[] = [];
	let started = false;
	for (const raw of lines) {
		const line = raw.trim();
		if (!started && !line) {
			continue;
		}
		if (line.startsWith('/*')) {
			// A licence banner is not a summary — skip the whole block and retry.
			const end = lines.indexOf(lines.find((l, i) => i > lines.indexOf(raw) && l.includes('*/')) ?? '');
			return end > 0 ? leadingComment(lines.slice(end + 1).join('\n'), kind) : '';
		}
		if (line.startsWith('//')) {
			started = true;
			out.push(line.replace(/^\/\/+\s?/, '').trim());
			continue;
		}
		if (line.startsWith('--')) {
			started = true;
			out.push(line.replace(/^--+\s?/, '').trim());
			continue;
		}
		break;
	}
	const text_ = out.join(' ').replace(/\s+/g, ' ').trim();
	// Go doc comments repeat the identifier ("Package nodes …") — keep them, they
	// read fine. Drop anything that is only a directive or a lint pragma.
	return /^(go:|eslint|@ts-|nolint|Code generated)/.test(text_) ? '' : text_;
}

// ---------------------------------------------------------------------------
// Graphs
// ---------------------------------------------------------------------------

/**
 * Kahn's algorithm with a deterministic tie-break, so the same project always
 * produces the same plan. Nodes left over after the queue drains are in a cycle
 * (impossible for Go, occasional for TS) and are appended in tie-break order
 * rather than dropped — a cycle is not a reason to lose a file.
 */
/**
 * A topological order that stays as close to the order it was given as the edges
 * allow: repeatedly emit the FIRST node whose dependencies are already out.
 *
 * `topoSort` emits in waves — every ready node at once — which is right for a
 * directory graph and wrong here. A lockfile depends on its manifest, so a wave
 * pass drops it into round two and it lands behind every unrelated config in the
 * stage. The reader should meet `package.json` and `package-lock.json` together;
 * the edge decides which of the two comes first and nothing more.
 *
 * A cycle cannot deadlock it: with nothing ready, it takes the first remaining
 * node and moves on.
 */
export function stableTopo(order: readonly string[], depsOf: (id: string) => readonly string[]): string[] {
	const present = new Set(order);
	const out: string[] = [];
	const done = new Set<string>();
	const pending = [...order];
	while (pending.length) {
		const i = pending.findIndex((p) => depsOf(p).every((d) => !present.has(d) || done.has(d) || d === p));
		const [next] = pending.splice(i < 0 ? 0 : i, 1);
		out.push(next);
		done.add(next);
	}
	return out;
}

export function topoSort(
	nodes: readonly string[],
	edges: ReadonlyMap<string, ReadonlySet<string>>,
	/** How to break ties between nodes that are all ready at once. Defaults to
	 *  shallowest-then-alphabetical, which is right for directories. Foundations
	 *  passes its own, because "roots first, then manifests, then locks" is an
	 *  order with a reason and a topological pass must not throw it away. */
	rank: (a: string, b: string) => number = (a, b) => {
		const da = a.split('/').length, db = b.split('/').length;
		return da !== db ? da - db : a < b ? -1 : a > b ? 1 : 0;
	},
): string[] {
	const present = new Set(nodes);
	const remaining = new Map<string, Set<string>>();
	for (const n of nodes) {
		remaining.set(n, new Set([...(edges.get(n) ?? [])].filter((d) => d !== n && present.has(d))));
	}
	const out: string[] = [];
	while (remaining.size) {
		const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([n]) => n).sort(rank);
		if (!ready.length) {
			// A cycle — legal in TypeScript, and merkle's frontend has several
			// (a barrel re-exports a directory that imports back through it).
			// Break it on the node with the FEWEST unmet dependencies, not the
			// shallowest path: the alternative put App.tsx, which imports half
			// the app, ahead of everything it imports.
			ready.push([...remaining].sort(([a, da], [b, db]) => da.size - db.size || rank(a, b))[0][0]);
		}
		for (const n of ready) {
			out.push(n);
			remaining.delete(n);
		}
		for (const deps of remaining.values()) {
			for (const n of ready) {
				deps.delete(n);
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Ordering inside a stage
// ---------------------------------------------------------------------------

/** Files that hold the shapes everything else in a package refers to. Same
 *  package means no import edge to read, so this is the one place the plan
 *  leans on convention rather than the graph. */
const SHAPES_FIRST = ['doc.go', 'types.go', 'model.go', 'models.go', 'errors.go', 'schema.go', 'config.go', 'store.go', 'db.go', 'types.ts', 'index.css'];

function shapeRank(path: string): number {
	const i = SHAPES_FIRST.indexOf(baseName(path));
	return i < 0 ? SHAPES_FIRST.length : i;
}

/** Put each test immediately after the file it tests. Write it, then prove it. */
export function pairTests(paths: readonly string[]): string[] {
	const isTest = isTestPath;
	const subjectOf = (p: string) => p.replace(/_test\.go$/, '.go').replace(/\.(test|spec)\.(ts|tsx|js)$/, '.$2');
	const subjects = paths.filter((p) => !isTest(p));
	const tests = paths.filter(isTest);
	const out: string[] = [];
	for (const s of subjects) {
		out.push(s);
		for (const t of tests) {
			if (subjectOf(t) === s) {
				out.push(t);
			}
		}
	}
	for (const t of tests) {
		if (!out.includes(t)) {
			out.push(t);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

interface Analysed {
	readonly file: SourceFile;
	readonly kind: StepKind;
	readonly dir: string;
	readonly lines: number;
	readonly declares: string[];
	readonly summary: string;
	/** Reference-relative paths this file imports (TS) — resolved, may be empty. */
	readonly deps: string[];
	/** Directories this file depends on (Go packages, TS dirs). */
	readonly depDirs: string[];
}

function goModuleOf(rel: string, modules: ReadonlyMap<string, string>): [string, string] | undefined {
	let best: [string, string] | undefined;
	for (const [dir, modulePath] of modules) {
		if ((dir === '' || rel.startsWith(`${dir}/`)) && (!best || dir.length > best[0].length)) {
			best = [dir, modulePath];
		}
	}
	return best;
}

function resolveTs(from: string, spec: string, known: ReadonlySet<string>, jsRoots: readonly string[]): string | undefined {
	let base: string | undefined;
	if (spec.startsWith('.')) {
		const parts = join(dirName(from), spec).split('/');
		const stack: string[] = [];
		for (const part of parts) {
			if (part === '.' || part === '') {
				continue;
			}
			if (part === '..') {
				stack.pop();
			} else {
				stack.push(part);
			}
		}
		base = stack.join('/');
	} else if (spec.startsWith('@/')) {
		// The near-universal Vite/tsconfig alias for the JS project's src root.
		const root = jsRoots.filter((r) => from.startsWith(r ? `${r}/` : '')).sort((a, b) => b.length - a.length)[0];
		base = join(join(root ?? '', 'src'), spec.slice(2));
	}
	if (base === undefined) {
		return undefined;  // a package from node_modules — not ours to write
	}
	// `<dir>/tsconfig.json` is here for `configRefs`: a project reference may name
	// a directory. No TS import resolves that way, so it costs the import path
	// nothing and saves a second resolver.
	for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.css`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/tsconfig.json`]) {
		if (known.has(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function analyse(files: readonly SourceFile[]): Map<string, Analysed> {
	const known = new Set(files.map((f) => f.path));
	const modules = new Map<string, string>();
	for (const f of files) {
		if (baseName(f.path) === 'go.mod') {
			const m = /^module\s+(\S+)/m.exec(f.text);
			if (m) {
				modules.set(dirName(f.path), m[1]);
			}
		}
	}
	const jsRoots = files.filter((f) => baseName(f.path) === 'package.json').map((f) => dirName(f.path));

	const out = new Map<string, Analysed>();
	for (const file of files) {
		const kind = kindOf(file.path);
		const dir = dirName(file.path);
		const lines = file.text ? file.text.split('\n').length : 0;
		const deps: string[] = [];
		const depDirs: string[] = [];
		let declares: string[] = [];

		if (kind === 'go' || kind === 'gotest') {
			declares = goDeclares(file.text);
			const owner = goModuleOf(file.path, modules);
			if (owner) {
				const [moduleDir, modulePath] = owner;
				for (const spec of goImports(file.text)) {
					if (spec === modulePath) {
						depDirs.push(moduleDir);
					} else if (spec.startsWith(`${modulePath}/`)) {
						depDirs.push(join(moduleDir, spec.slice(modulePath.length + 1)));
					}
				}
			}
		} else if (kind === 'ts' || kind === 'tsx' || isJsModule(file.path)) {
			// `declares` stays with code: a config file's `export default {…}` is
			// not a surface anyone imports by name, and listing it as a declaration
			// would put a "What it declares: default" section on seventeen pages.
			// The IMPORTS are read either way — that is the whole point.
			declares = kind === 'ts' || kind === 'tsx' ? tsDeclares(file.text) : [];
			for (const spec of tsImports(file.text)) {
				const target = resolveTs(file.path, spec, known, jsRoots);
				if (target && target !== file.path) {
					deps.push(target);
					depDirs.push(dirName(target));
				}
			}
		} else if (kind === 'lock') {
			// A lockfile is generated FROM the manifest beside it, so that is an
			// edge and not a coincidence of the sort order. Saying "this is a leaf,
			// it can be written first and on its own" about a `package-lock.json`
			// was false on the page and invisible to the invariant.
			const manifest = LOCK_MANIFEST.get(baseName(file.path));
			if (manifest && known.has(join(dir, manifest))) {
				deps.push(join(dir, manifest));
			}
		} else if (isTsconfig(file.path)) {
			// FILE edges only, deliberately no `depDirs`. A stage edge expands to
			// every step of that stage, which is right for an import (the package
			// has to exist) and catastrophic here: `e2e/tsconfig.json` extends
			// `../tsconfig.app.json`, and naming the `frontend` directory made it
			// depend on 698 unrelated files including README.md and index.html.
			// A tsconfig references configs, not directories of source.
			for (const spec of configRefs(file.text)) {
				const target = resolveTs(file.path, spec, known, jsRoots);
				if (target && target !== file.path) {
					deps.push(target);
				}
			}
		}

		out.set(file.path, {
			file, kind, dir, lines, declares,
			summary: leadingComment(file.text, kind),
			deps: [...new Set(deps)],
			depDirs: [...new Set(depDirs.filter((d) => d !== dir))],
		});
	}
	return out;
}

/**
 * What a `generate` step's command reads, so that succeeding on nothing is not
 * mistaken for succeeding. About the tool, not about any particular project:
 * `npm install` resolves the dependencies its `package.json` names.
 *
 * `go.mod` USED TO BE HERE, gated on a `.go` file in the module root, and that
 * was the wrong step to gate. A precondition says "this command has nothing to
 * work on **yet**", which is only useful when the plan reaches the inputs soon.
 * It does not: measured against merkle, `backend/go.mod` is step 1 of 2,094 and
 * the first `.go` beside it is step 594 — and `test/go.mod` was worse, because
 * that module keeps all its Go in subpackages, so a one-level readdir never
 * matched and the check could not pass for the whole plan. A step-1 check that
 * nothing you do can turn green is the same defect as a green tick that means
 * nothing, viewed from the other side.
 *
 * `go mod tidy`'s verdict now belongs to the first Go package stage in each
 * module, where the files it reads actually exist. See `checksFor`.
 */
function generateInputs(step: { id: string; commandCwd?: string }): Precondition | undefined {
	const dir = step.commandCwd ?? dirName(step.id);
	const base = baseName(step.id);
	if (LOCK_MANIFEST.has(base)) {
		return { dir, match: LOCK_MANIFEST.get(base)!, why: `there is no ${LOCK_MANIFEST.get(base)} here for it to install from.` };
	}
	return undefined;
}

/**
 * "The file is there" — and, unless the reference's own copy is empty, that it
 * has something in it.
 *
 * A reference file of zero bytes is rare and real: merkle carries one, a
 * placeholder note under `.claude/docs`. Demanding a non-empty file for it asks
 * the reader to write something the project does not contain, and the step could
 * never be completed — the same defect as a check that cannot fail, seen from
 * the other end. The byte count is already in the plan, so the question is
 * settled where the reference is in hand rather than by a check that stats a
 * scratch and cannot know what "correct" is.
 */
function existsCheck(bytes: number | undefined): Check {
	return bytes === 0
		? { kind: 'exists', label: 'the file exists', mayBeEmpty: true }
		: { kind: 'exists', label: 'the file exists and is not empty' };
}

function checksFor(
	step: { id: string; kind: StepKind; mode: StepMode; command?: string; commandCwd?: string; modulePath?: string; bytes?: number },
	goModuleDir: string | undefined,
): Check[] {
	if (step.mode === 'generate') {
		// Run it, then prove it produced something. Both, in that order: a command
		// that exits 0 without writing the file is the failure worth catching.
		//
		// …and exiting 0 with nothing to work on is the OTHER one. A generated file
		// is derived from inputs; with no inputs the command succeeds at doing
		// nothing, so the verdict is "could not run yet", never a pass.
		//
		// The CHECK's command is guarded against a rerun; the step's own `command`
		// — the one the page teaches and the learner types — stays clean. `go mod
		// init` refuses to run when a go.mod already exists, so a learner who
		// typed the command in a terminal (the intended path) would then watch the
		// check fail on "already exists". POSIX `||`/`&&` are equal-precedence and
		// left-associative, so this parses as `(test || init) && tidy` — tidy
		// always runs, init only when the file is missing. `npm install` is
		// already idempotent and needs no guard.
		if (baseName(step.id) === 'go.mod' && step.modulePath) {
			// A go.mod step asks for `go mod init`, and that is ALL a go.mod step can
			// deliver: the `require` block is written by `go mod tidy` reading code
			// that this step, by construction, comes before. So the checks assert the
			// half that is achievable here and the third one makes that honest —
			// `go mod init` with no argument infers a module path from the folder
			// name, which succeeds and is wrong, and nothing else would catch it.
			//
			// The `go` directive is deliberately NOT asserted: `go mod init` writes
			// the toolchain that ran it, so a reference declaring a newer one is a
			// difference the learner cannot close and must not be failed for.
			return [
				{ kind: 'shell', label: `\`go mod init ${step.modulePath}\` succeeds`, cmd: `[ -f go.mod ] || go mod init ${step.modulePath}`, cwd: step.commandCwd },
				existsCheck(step.bytes),
				{
					kind: 'shell', label: `it declares module ${step.modulePath}`, cwd: step.commandCwd,
					// `-F` so a `.` in the module path is a dot and not "any character",
					// `-x` so a longer path that merely starts with this one is not a
					// pass. `-q` is silent, and a red verdict with no words is the thing
					// checks.ts exists to prevent — so say what the file actually has.
					cmd: `grep -Fqx "module ${step.modulePath}" go.mod`
						+ ` || { echo "go.mod declares: $(head -1 go.mod)"; echo "expected:      module ${step.modulePath}"; exit 1; }`,
				},
			];
		}
		const rerunSafe = baseName(step.id) === 'go.mod' && step.command
			? `[ -f go.mod ] || ${step.command}`
			: step.command;
		return [
			{ kind: 'shell', label: `\`${step.command}\` succeeds`, cmd: rerunSafe, cwd: step.commandCwd, needs: generateInputs(step) },
			existsCheck(step.bytes),
		];
	}
	const checks: Check[] = [existsCheck(step.bytes)];
	if (step.mode === 'copy') {
		return checks;
	}
	if (step.kind === 'go' || step.kind === 'gotest') {
		// Per-FILE and dependency-free: gofmt parses the file and says where it
		// stopped. `go build` cannot be a step check because a half-written package
		// legitimately does not build yet.
		//
		// PARSING ONLY — `-l` used to ride along, failing the step when the file was
		// not byte-identical to gofmt's own output, and four of merkle's own Go
		// files are not: `test/oracle/env.go` is missing a blank line before a func.
		// Reproduce the reference exactly, as the whole feature asks, and the check
		// went red about work that was correct; the only way to pass was to write
		// something the project does not contain. Formatting is what the editor
		// does on save, and a parse error is what the reader needs told.
		checks.push({ kind: 'shell', label: 'it parses', cmd: `gofmt -e "${step.id}" > /dev/null` });
	}
	if (step.kind === 'manifest' && baseName(step.id) === 'go.mod' && goModuleDir !== undefined) {
		checks.push({ kind: 'shell', label: 'the module resolves', cmd: 'go mod verify', cwd: goModuleDir });
	}
	return checks;
}

/** `_test.go`, `foo.test.ts`, `foo.spec.tsx` — the files that exercise code
 *  rather than being it. Shared by pairTests and by registration detection. */
function isTestPath(p: string): boolean {
	return /(_test\.go|\.test\.(ts|tsx|js)|\.spec\.(ts|tsx|js))$/.test(p);
}

/**
 * A file that CREATES a router. flowscan's route walk seeds at exactly these —
 * `NewRouter()`/`NewMux()` call sites — and reaches a `RegisterRoutes(r
 * chi.Router, …)` only by following one out from a seed.
 *
 * This distinction is the whole reason the hint was wrong. merkle has ONE
 * non-test file in its entire backend that creates a router, and until it is
 * written the API view traces nothing: a folder holding a registration site and
 * its complete import closure still scans to zero routes, and adding the root
 * file alone takes it to 174.
 */
const ROUTER_SEED = /\b(?:NewRouter|NewMux|NewServeMux)\s*\(/;

/** A file that hangs routes off a router something else made. Only ever worth
 *  pointing at once a seed exists — before that there is nothing to walk from. */
const ROUTE_MOUNT = /\.(?:Route|Mount)\s*\(|\bchi\.Router\b|\*chi\.Mux\b|\*http\.ServeMux\b/;

/** The name of a package that APPLIES migrations, as opposed to the directory of
 *  `.sql` files it applies — which holds no Go and so is never imported. */
const MIGRATOR = /^migrat/;

/**
 * Preconditions a tool needs, accumulated as the plan is emitted. Stages are
 * pushed in the order they are worked, and a precondition met at stage 20 is
 * still met at stage 21 — so this is carried forward rather than re-derived.
 */
interface ToolReadiness {
	/** Something has created a router: flowscan has a seed to walk from. */
	router: boolean;
	/** Some `.sql` has been planned: there is a schema to talk about. */
	schema: boolean;
	/** A migration runner has been planned: the schema can reach a database. */
	migrator: boolean;
}

/**
 * A tool is offered when it can function, not when a regex matches. Three of
 * the four hints used to fire on the mere presence of a file kind, which put the
 * API view 22 stages and the Data grid 18 stages before their tools had anything
 * to show.
 */
/**
 * The milestone a stage earns, from what is in it. One per stage at most, and
 * the first match wins — a stage that both serves and tests is remembered for
 * the serving, which is the bigger moment.
 */
/** `go <verb>` against a package, from the module root down. The module root is
 *  the cwd, so the argument is the rest of the path — and `.` when there is no
 *  rest, never `./.`. */
function goPkgCommand(verb: string, dir: string): string {
	const rest = dir.split('/').slice(1).join('/');
	return `go ${verb} ${rest ? `./${rest}` : '.'}`;
}

export function milestoneFor(paths: readonly string[], text: (p: string) => string): Milestone | undefined {
	// A database, from a compose file that declares one. This is the only kind
	// that needs nothing written first: the file IS the thing that runs.
	const compose = paths.find((p) => /docker-compose\.ya?ml$|(^|\/)compose\.ya?ml$/.test(p) && composeDatabase(text(p)));
	if (compose) {
		const db = composeDatabase(text(compose))!;
		return {
			label: 'Start the database',
			why: `Everything after this stage is about a database — the migrations first. \`${db.service}\` is one command away, `
				+ 'and starting it is the first point in the plan where the project does something rather than describing itself.',
			// NAMED, not the whole file. A compose file that also declares the app
			// would otherwise try to build an image from source that does not
			// exist yet — the milestone is the database, and the database is one
			// service. `ps` after it because `up -d` says nothing about health.
			command: `docker compose -f ${compose} up -d ${db.service} && docker compose -f ${compose} ps ${db.service}`,
			cwd: '',
			needs: { dir: dirName(compose), match: baseName(compose), why: 'the compose file is not written yet.' },
		};
	}

	// A server, from a main package that starts one.
	//
	// PER STAGE, not per file: a Go main package is a directory. merkle declares
	// `func main()` in `main.go` and calls `ListenAndServe` from `app.go`, and a
	// per-file test found neither half — the biggest milestone in the plan, missed
	// by asking the question of the wrong unit.
	const go = paths.filter((p) => p.endsWith('.go') && !isTestPath(p));
	const main = go.find((p) => /func main\(/.test(text(p)));
	if (main && go.some((p) => /http\.(ListenAndServe|Server)\b|\.ListenAndServe\(/.test(text(p)))) {
		const dir = dirName(main);
		return {
			label: 'Run it',
			why: 'This package starts an HTTP server. Running it is the first time the thing you are building answers anything.',
			command: goPkgCommand('run', dir),
			cwd: dir.split('/')[0] || '',
			needs: { dir, match: '.go', why: 'the package has no Go files yet.' },
		};
	}

	// A web app, from the entry document a dev server serves.
	const html = paths.find((p) => p.endsWith('index.html'));
	if (html) {
		const dir = dirName(html);
		return {
			label: 'Serve the page',
			why: 'This is the document a dev server hands a browser. It is the first thing here you can look at rather than read.',
			command: 'npm run dev',
			cwd: dir,
			needs: { dir, match: 'index.html', why: 'the entry document is not written yet.' },
		};
	}

	// A package with tests. Last, because it is the smallest of the four — but it
	// is the earliest one most projects reach, and it executes code you wrote.
	const tests = paths.filter((p) => isTestPath(p) && p.endsWith('.go'));
	if (tests.length) {
		const dir = dirName(tests[0]);
		return {
			label: 'Run its tests',
			why: `${tests.length} test file${tests.length === 1 ? '' : 's'} in this package. This is code you wrote, executing.`,
			command: goPkgCommand('test', dir),
			cwd: dir.split('/')[0] || '',
			needs: { dir, match: '.go', why: 'the package has no Go files yet.' },
		};
	}
	return undefined;
}

function stageTools(
	paths: readonly string[],
	text: (p: string) => string,
	depDirs: (p: string) => readonly string[],
	ready: ToolReadiness,
): ToolHint[] {
	const tools: ToolHint[] = [];
	// A test that spins up a router to exercise middleware is not a stage that
	// registers routes, and never was.
	const code = paths.filter((p) => !isTestPath(p) && p.endsWith('.go'));

	const seeds = code.some((p) => ROUTER_SEED.test(text(p)));
	ready.router ||= seeds;
	if (ready.router && (seeds || code.some((p) => ROUTE_MOUNT.test(text(p))))) {
		tools.push({
			label: 'Scan the routes', command: 'burrow.flow.refresh',
			why: 'The router the API view traces from now exists, so it can follow these registrations end to end.',
		});
	}

	if (paths.some((p) => p.endsWith('_test.go'))) {
		tools.push({
			label: 'Run the Go tests', command: 'burrow.test.runAll',
			why: 'You wrote tests in this stage — the Test Lab shows failures first.',
		});
	}

	// Writing 134 migrations puts 134 files on disk and nothing in a database.
	// The hint waits for whatever is going to APPLY them: a package importing the
	// project's own migration runner, or a `cmd/migrate`-shaped main that is its
	// own runner. A project with no such entry point gets no hint at all — the
	// same degrade-to-absent the route annotations use.
	const sql = paths.some((p) => p.endsWith('.sql'));
	ready.schema ||= sql;
	const applies = code.some((p) => depDirs(p).some((d) => MIGRATOR.test(baseName(d)))
		|| (MIGRATOR.test(baseName(dirName(p))) && baseName(dirName(dirName(p))) === 'cmd' && /^package\s+main\b/m.test(text(p))));
	ready.migrator ||= applies;
	if (ready.schema && ready.migrator && (applies || sql)) {
		tools.push({
			label: 'Open the database', command: 'burrow.db.refresh',
			why: 'A migration runner has been planned, so the schema can be applied and the Data view can read it back.',
		});
	}

	if (paths.some((p) => p.endsWith('.tsx'))) {
		tools.push({
			label: 'Open the component gallery', command: 'burrow.frontendDebugger.open',
			why: 'Components in this stage can be rendered in isolation with props you set by hand.',
		});
	}
	return tools;
}

export function buildPlan(
	files: readonly SourceFile[],
	options: {
		name: string;
		reference: string;
		routes?: ReadonlyMap<string, readonly string[]>;
		/**
		 * Authored notes about THIS project's files, keyed by step id — the one
		 * class of prose that cannot be a concept because it is not about a
		 * concept. Discovered in the reference (see `loadNotes`), never written
		 * here: a note stored in the plan would be lost on the next re-plan, and
		 * a note in the extension would be Burrow shipping opinions about
		 * somebody else's repository.
		 */
		notes?: ReadonlyMap<string, string>;
	},
): ScratchPlan {
	// go.sum is project content but never a step: `go mod tidy`, which the go.mod
	// step runs, writes it. Dropped from the step universe rather than from
	// isIgnored — it is not noise, it just has no step to call its own.
	//
	// The same reasoning, generalised, drops an ORPHANED lockfile. A lockfile is
	// generated from the manifest beside it, so with no manifest there is no
	// command that writes it and no step that can pass: merkle carries a root
	// `package-lock.json` and no root `package.json`, and `npm install` there
	// exits 254 while still writing the file — check one failing forever, check
	// two passing. The rule is about lockfiles and their manifests, not about
	// that path.
	const present = new Set(files.map((f) => f.path));
	const orphanLock = (p: string): boolean => {
		const manifest = LOCK_MANIFEST.get(baseName(p));
		return !!manifest && !present.has(join(dirName(p), manifest));
	};
	const source = files.filter((f) => !isIgnored(f.path) && f.bytes <= MAX_BYTES
		&& baseName(f.path) !== 'go.sum' && !orphanLock(f.path));
	const analysed = analyse(source);
	const modules = new Map<string, string>();
	for (const f of source) {
		if (baseName(f.path) === 'go.mod') {
			modules.set(dirName(f.path), /^module\s+(\S+)/m.exec(f.text)?.[1] ?? '');
		}
	}

	const stages: ScratchStage[] = [];
	const steps: Record<string, ScratchStep> = {};
	const claimed = new Set<string>();

	const textOf = (p: string) => analysed.get(p)?.file.text ?? '';
	const depDirsOf = (p: string) => analysed.get(p)?.depDirs ?? [];
	// Carried across stages, in the order they are emitted: see ToolReadiness.
	const ready: ToolReadiness = { router: false, schema: false, migrator: false };
	// Enrichment, not structure: nothing below reads this, and a plan built
	// without it differs only in the sentence the page prints.
	const routesFor = (p: string): { routes?: readonly string[]; routeCount?: number } => {
		const all = options.routes?.get(p);
		return all && all.length ? { routes: all.slice(0, 3), routeCount: all.length } : {};
	};
	const addStage = (stage: Omit<ScratchStage, 'steps'>, paths: readonly string[]): void => {
		if (!paths.length) {
			return;
		}
		// A compose file's own database, and what else in this stage contradicts
		// it. Computed per stage so the comparison is against files the reader has
		// already written, not against the whole project.
		const noteFor = (p: string): { note?: string } => {
			const parts: string[] = [];
			if (/docker-compose\.ya?ml$|(^|\/)compose\.ya?ml$/.test(p)) {
				const others = new Map(paths.filter((q) => q !== p).map((q) => [q, textOf(q)]));
				const derived = databaseNote(textOf(p), others);
				if (derived) {
					parts.push(derived);
				}
			}
			// The authored note comes SECOND. What the planner worked out is a fact
			// about the file as it stands; what a person wrote is context around it,
			// and a fact that arrives after its commentary reads as an afterthought.
			const authored = options.notes?.get(p);
			if (authored) {
				parts.push(authored.trim());
			}
			return parts.length ? { note: parts.join('\n\n') } : {};
		};
		for (const p of paths) {
			const a = analysed.get(p)!;
			const owner = goModuleOf(p, modules);
			// The module path this file DECLARES, not the one it resolves through —
			// only a go.mod has one, and its checks assert it (see `checksFor`).
			const declares = baseName(p) === 'go.mod' ? modules.get(dirName(p)) : undefined;
			const gen = generatedBy(p, baseName(p) === 'go.mod' ? declares : owner?.[1]);
			const mode: StepMode = gen ? 'generate' : a.kind === 'doc' ? 'copy' : a.kind === 'lock' ? 'copy' : 'write';
			const shape = { id: p, kind: a.kind, mode, command: gen?.cmd, commandCwd: gen?.cwd, modulePath: declares, bytes: a.file.bytes };
			steps[p] = {
				id: p,
				stage: stage.id,
				title: baseName(p),
				kind: a.kind,
				mode,
				lines: a.lines,
				bytes: a.file.bytes,
				...(gen ? { command: gen.cmd, commandCwd: gen.cwd } : {}),
				summary: a.summary,
				declares: a.declares,
				deps: a.deps,
				depStages: a.depDirs,
				checks: checksFor(shape, owner?.[0]),
				...noteFor(p),
				...routesFor(p),
			};
			claimed.add(p);
		}
		const milestone = milestoneFor(paths, textOf);
		stages.push({
			...stage, steps: paths,
			tools: stage.tools.length ? stage.tools : stageTools(paths, textOf, depDirsOf, ready),
			...(milestone ? { milestone } : {}),
		});
	};

	// 1 — Foundations. Every manifest and lockfile in the project, roots first.
	//     Nothing compiles until these exist, so nothing else can come before.
	const foundations = source
		.map((f) => f.path)
		.filter((p) => kindOf(p) === 'manifest' || kindOf(p) === 'lock')
		.sort((a, b) => {
			const weight = (p: string) => {
				const base = baseName(p);
				return base === 'go.mod' ? 0 : base === 'go.sum' ? 1 : base === 'package.json' ? 2
					: LOCKS.has(base) ? 3 : base.startsWith('tsconfig') ? 4 : 5;
			};
			return weight(a) - weight(b) || a.split('/').length - b.split('/').length || (a < b ? -1 : 1);
		});
	// …and then made to OBEY the edges inside it, with that order as the tie-break.
	//
	// The weight sort is an argument about kinds — a module root before a manifest
	// before a lockfile — and it says nothing about two files of the same kind that
	// name each other. So `tsconfig.json` came before the `tsconfig.node.json` it
	// references, and `.vite.mockport.config.ts` before the `vite.config.ts` it
	// imports, both by alphabetical accident. That was always a violation of this
	// plan's one invariant; it was invisible only because the analyser did not read
	// those files (WO-79 §3). Reading them without obeying them would have been the
	// worse half of the fix.
	const foundationSteps = stableTopo(foundations, (p) => analysed.get(p)?.deps ?? []);
	addStage({
		id: '@foundations',
		title: 'Foundations',
		blurb: 'The manifests: what the project is called, what it depends on, how it is built. '
			+ 'You type package.json and the configs; go.mod and the lockfiles are generated — the step runs the command.',
		cls: 'foundations',
		setup: [
			...[...modules.keys()].map((d) => `cd ${d || '.'} && go mod download`),
			...source.filter((f) => baseName(f.path) === 'package.json').map((f) => `cd ${dirName(f.path) || '.'} && npm install`),
		],
		checks: [],
		tools: [],
	}, foundationSteps);

	// 2 — Schema. Directories that are mostly .sql: the tables everything below
	//     stores into. They come before the Go that queries them.
	const byDir = new Map<string, string[]>();
	for (const f of source) {
		if (!claimed.has(f.path)) {
			byDir.set(dirName(f.path), [...(byDir.get(dirName(f.path)) ?? []), f.path]);
		}
	}
	for (const [dir, paths] of [...byDir].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const sql = paths.filter((p) => kindOf(p) === 'sql');
		if (sql.length && sql.length * 2 > paths.length) {
			addStage({
				id: dir,
				title: dir || 'schema',
				blurb: `The database schema — ${sql.length} migration${sql.length === 1 ? '' : 's'}, applied in order. `
					+ 'These are the shapes every store below reads and writes.',
				cls: 'schema',
				setup: [],
				checks: [],
				tools: [],
			}, paths.slice().sort());
		}
	}

	// 3 — Go packages, in dependency order. One stage per package.
	const goDirs = new Set<string>();
	for (const [p, a] of analysed) {
		if (!claimed.has(p) && (a.kind === 'go' || a.kind === 'gotest')) {
			goDirs.add(a.dir);
		}
	}
	const goEdges = new Map<string, Set<string>>();
	for (const dir of goDirs) {
		goEdges.set(dir, new Set());
	}
	for (const [p, a] of analysed) {
		if (goDirs.has(a.dir) && !claimed.has(p)) {
			for (const d of a.depDirs) {
				if (goDirs.has(d)) {
					goEdges.get(a.dir)!.add(d);
				}
			}
		}
	}
	// `go mod tidy` is the go.mod step's other half, and it lands HERE — on the
	// first package of each module, which is the earliest point in the plan where
	// there is Go for it to read. Not on the module root's own stage: `test/`
	// keeps every one of its packages in a subdirectory, so a root-anchored check
	// would have no stage to live on and the test module would never get one —
	// which is the bug this moved away from, rebuilt one level up.
	const tidied = new Set<string>();
	for (const dir of topoSort([...goDirs], goEdges)) {
		const paths = pairTests(
			(byDir.get(dir) ?? [])
				.filter((p) => !claimed.has(p))
				.sort((a, b) => shapeRank(a) - shapeRank(b) || (a < b ? -1 : 1)),
		);
		const pkg = paths.map((p) => /^package\s+(\w+)/m.exec(textOf(p))?.[1]).find(Boolean) ?? baseName(dir);
		const doc = paths.map((p) => analysed.get(p)!.summary).find((s) => s.length > 40);
		const moduleDir = goModuleOf(paths[0] ?? dir, modules)?.[0] ?? '';
		const rel = dir === moduleDir ? '.' : `./${dir.slice(moduleDir ? moduleDir.length + 1 : 0)}`;
		const firstOfModule = !tidied.has(moduleDir);
		tidied.add(moduleDir);
		addStage({
			id: dir,
			title: dir,
			blurb: doc || `Package ${pkg} — ${paths.length} file${paths.length === 1 ? '' : 's'}.`,
			cls: 'go',
			setup: [],
			checks: [
				// Before `go build`, because it is what writes the requires the build
				// then resolves. It stays qualified: a module whose first package is
				// not written yet has nothing to tidy, and that is not a failure.
				...(firstOfModule ? [{
					kind: 'shell' as const,
					label: `go mod tidy resolves ${moduleDir || '.'}`,
					cmd: 'go mod tidy', cwd: moduleDir,
					needs: { dir, match: '.go', why: 'the package has no Go files yet, so there is nothing for it to resolve.' },
				}] : []),
				{ kind: 'shell', label: `go build ${rel}`, cmd: `go build ${rel}`, cwd: moduleDir },
				...(paths.some((p) => p.endsWith('_test.go')) ? [{ kind: 'shell' as const, label: `go test ${rel}`, cmd: `go test ${rel}`, cwd: moduleDir }] : []),
			],
			tools: [],
		}, paths);
	}

	// 4 — The web app, directories in dependency order.
	const webDirs = new Set<string>();
	for (const [p, a] of analysed) {
		if (!claimed.has(p) && (a.kind === 'ts' || a.kind === 'tsx' || a.kind === 'style')) {
			webDirs.add(a.dir);
		}
	}
	const webEdges = new Map<string, Set<string>>();
	for (const dir of webDirs) {
		webEdges.set(dir, new Set());
	}
	for (const [p, a] of analysed) {
		if (webDirs.has(a.dir) && !claimed.has(p)) {
			for (const d of a.depDirs) {
				if (webDirs.has(d)) {
					webEdges.get(a.dir)!.add(d);
				}
			}
		}
	}
	for (const dir of topoSort([...webDirs], webEdges)) {
		const inDir = (byDir.get(dir) ?? []).filter((p) => !claimed.has(p));
		const edges = new Map<string, Set<string>>();
		for (const p of inDir) {
			edges.set(p, new Set(analysed.get(p)!.deps.filter((d) => inDir.includes(d))));
		}
		const paths = pairTests(topoSort(inDir, edges));
		addStage({
			id: dir,
			title: dir,
			blurb: paths.map((p) => analysed.get(p)!.summary).find((s) => s.length > 40)
				|| `${paths.length} file${paths.length === 1 ? '' : 's'} — written after everything they import.`,
			cls: 'web',
			setup: [],
			checks: [],
			tools: [],
		}, paths);
	}

	// 5 — Everything else, by directory: docs, scripts, fixtures, config.
	for (const [dir, paths] of [...byDir].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const left = paths.filter((p) => !claimed.has(p));
		if (left.length) {
			addStage({
				id: dir || '@root',
				title: dir || '(project root)',
				blurb: `${left.length} supporting file${left.length === 1 ? '' : 's'} — docs, scripts and fixtures the code above assumes.`,
				cls: 'rest',
				setup: [],
				checks: [],
				tools: [],
			}, left.slice().sort());
		}
	}

	const all = Object.values(steps);
	return {
		version: 1,
		name: options.name,
		reference: options.reference,
		stages,
		steps,
		counts: { stages: stages.length, steps: all.length, lines: all.reduce((n, s) => n + s.lines, 0) },
	};
}

// ---------------------------------------------------------------------------
// Route annotations
// ---------------------------------------------------------------------------

/** The subset of flowscan's flows.json this reads. */
export interface FlowsDoc {
	/** Absolute path of the backend flowscan scanned; paths inside are relative to it. */
	readonly backend?: string;
	readonly coverage?: { readonly traced?: number };
	readonly flows?: ReadonlyArray<{
		readonly method?: string;
		readonly path?: string;
		readonly file?: string;
		readonly middleware?: ReadonlyArray<{ readonly file?: string }>;
		readonly nodes?: ReadonlyArray<{ readonly file?: string }>;
	}>;
}

/** Below this many traced flows the data is a degraded run, not a thin project. */
export const MIN_TRACED_FLOWS = 50;

/**
 * Which routes reach which file, project-relative.
 *
 * Returns `undefined` — meaning annotate nothing — when flowscan did not run or
 * ran degraded. A curriculum that explains six routes out of two hundred and
 * thirty-five is worse than one that explains none: the reader cannot tell the
 * silence from the absence. The stale-binary case is exactly this, and it
 * reports 6 traced rather than failing.
 */
export function routeIndex(doc: FlowsDoc | undefined, backendPrefix: string): Map<string, string[]> | undefined {
	const traced = doc?.coverage?.traced ?? 0;
	if (!doc || !Array.isArray(doc.flows) || !doc.flows.length || traced < MIN_TRACED_FLOWS) {
		return undefined;
	}
	const out = new Map<string, string[]>();
	const add = (rel: string | undefined, route: string) => {
		if (!rel) {
			return;
		}
		const id = join(backendPrefix, rel);
		const list = out.get(id) ?? [];
		if (!list.includes(route)) {
			list.push(route);
			out.set(id, list);
		}
	};
	for (const flow of doc.flows) {
		if (!flow.method || !flow.path) {
			continue;
		}
		const route = `${flow.method} ${flow.path}`;
		add(flow.file, route);
		for (const m of flow.middleware ?? []) {
			add(m.file, route);
		}
		for (const n of flow.nodes ?? []) {
			add(n.file, route);
		}
	}
	for (const list of out.values()) {
		list.sort();
	}
	return out;
}

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

/** One step that is planned before something it needs. */
export interface OrderViolation {
	readonly step: string;
	readonly dep: string;
	readonly at: number;
	readonly depAt: number;
	/**
	 * The two are mutually reachable, so NO order satisfies both. TypeScript
	 * permits import cycles and merkle's frontend has several; reporting those as
	 * ordering errors would make the invariant unprovable rather than false.
	 * Only `cyclic: false` is a defect.
	 */
	readonly cyclic: boolean;
}

/**
 * Walk the emitted plan and report every step that comes before something it
 * depends on. The whole feature rests on this being empty, so it is checked
 * against the plan that actually ships rather than against the algorithm that
 * produced it — a reordering policy can be wrong in ways topoSort cannot see.
 */
export function orderViolations(plan: ScratchPlan): OrderViolation[] {
	const order = plan.stages.flatMap((s) => s.steps);
	const at = new Map(order.map((id, i) => [id, i]));
	const stageAt = new Map(plan.stages.map((s, i) => [s.id, i]));

	// Step-level edges, so "before what it imports" is one relation: a file's own
	// resolved imports, plus every step of every stage it names.
	const edges = new Map<string, string[]>();
	for (const id of order) {
		const step = plan.steps[id];
		const out = new Set(step.deps.filter((d) => at.has(d)));
		for (const stage of step.depStages) {
			for (const other of plan.stages[stageAt.get(stage) ?? -1]?.steps ?? []) {
				if (other !== id) {
					out.add(other);
				}
			}
		}
		edges.set(id, [...out]);
	}

	// Tarjan, iterative: 2,000-odd nodes is past the depth a recursive walk is
	// comfortable with, and a plan is not a place to risk a stack overflow.
	const index = new Map<string, number>(), low = new Map<string, number>(), comp = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	let next = 0, components = 0;
	for (const root of order) {
		if (index.has(root)) {
			continue;
		}
		const work: Array<{ v: string; i: number }> = [{ v: root, i: 0 }];
		while (work.length) {
			const frame = work[work.length - 1];
			if (frame.i === 0) {
				index.set(frame.v, next);
				low.set(frame.v, next++);
				stack.push(frame.v);
				onStack.add(frame.v);
			}
			const kids = edges.get(frame.v) ?? [];
			if (frame.i < kids.length) {
				const w = kids[frame.i++];
				if (!index.has(w)) {
					work.push({ v: w, i: 0 });
				} else if (onStack.has(w)) {
					low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
				}
				continue;
			}
			work.pop();
			if (low.get(frame.v) === index.get(frame.v)) {
				for (;;) {
					const w = stack.pop()!;
					onStack.delete(w);
					comp.set(w, components);
					if (w === frame.v) {
						break;
					}
				}
				components++;
			}
			const parent = work[work.length - 1];
			if (parent) {
				low.set(parent.v, Math.min(low.get(parent.v)!, low.get(frame.v)!));
			}
		}
	}

	const out: OrderViolation[] = [];
	for (const id of order) {
		for (const dep of edges.get(id) ?? []) {
			const [a, b] = [at.get(id)!, at.get(dep)!];
			if (b > a) {
				out.push({ step: id, dep, at: a, depAt: b, cyclic: comp.get(id) === comp.get(dep) });
			}
		}
	}
	return out;
}

/** One Tarjan pass per plan object. The step page re-renders on every click and
 *  the walk covers every step and every dependency edge in the project. */
const FORWARD_DEPS = new WeakMap<ScratchPlan, Map<string, Map<string, boolean>>>();

/**
 * `orderViolations` regrouped for the step page: per step, the dependencies that
 * come later, and whether each one is a genuine cycle.
 *
 * The page used to call every forward dependency an import cycle, which on
 * merkle was true of 2 out of 25 — it told a reader an avoidable ordering defect
 * was unavoidable. Both now read the SAME classification, so a label cannot
 * claim a cycle where the invariant counts a defect.
 */
export function forwardDeps(plan: ScratchPlan): ReadonlyMap<string, ReadonlyMap<string, boolean>> {
	const cached = FORWARD_DEPS.get(plan);
	if (cached) {
		return cached;
	}
	const out = new Map<string, Map<string, boolean>>();
	for (const violation of orderViolations(plan)) {
		const deps = out.get(violation.step) ?? new Map<string, boolean>();
		deps.set(violation.dep, violation.cyclic);
		out.set(violation.step, deps);
	}
	FORWARD_DEPS.set(plan, out);
	return out;
}

/** Reverse edges: which steps name this one as a dependency. Computed rather
 *  than stored so the plan file stays a tree and cannot disagree with itself. */
export function dependents(plan: ScratchPlan, stepId: string): string[] {
	const step = plan.steps[stepId];
	if (!step) {
		return [];
	}
	return Object.values(plan.steps)
		.filter((s) => s.deps.includes(stepId) || (s.stage !== step.stage && s.depStages.includes(step.stage)))
		.map((s) => s.id);
}
