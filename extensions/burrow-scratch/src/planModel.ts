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

export interface Check {
	readonly kind: 'exists' | 'shell';
	readonly label: string;
	/** `shell` only. Run with the scratch root as the default cwd. */
	readonly cmd?: string;
	/** `shell` only, relative to the scratch root. */
	readonly cwd?: string;
	/** `shell` only: output on stdout means FAIL even when the exit code is 0
	 *  (`gofmt -l` is the case — it prints the files it objects to). */
	readonly emptyOutput?: boolean;
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
	/** Up to three routes this file serves, for the page to name. Enrichment
	 *  only: absent everywhere when flowscan has not run, and never structural. */
	readonly routes?: readonly string[];
	/** How many routes reach it in total, when more than `routes` names. */
	readonly routeCount?: number;
}

export type StageClass = 'foundations' | 'schema' | 'go' | 'web' | 'rest';

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
export function topoSort(nodes: readonly string[], edges: ReadonlyMap<string, ReadonlySet<string>>): string[] {
	const rank = (a: string, b: string): number => {
		const da = a.split('/').length, db = b.split('/').length;
		return da !== db ? da - db : a < b ? -1 : a > b ? 1 : 0;
	};
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
	const isTest = (p: string) => /(_test\.go|\.test\.(ts|tsx|js)|\.spec\.(ts|tsx|js))$/.test(p);
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
	for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.css`, `${base}/index.ts`, `${base}/index.tsx`]) {
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
		} else if (kind === 'ts' || kind === 'tsx') {
			declares = tsDeclares(file.text);
			for (const spec of tsImports(file.text)) {
				const target = resolveTs(file.path, spec, known, jsRoots);
				if (target && target !== file.path) {
					deps.push(target);
					depDirs.push(dirName(target));
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

function checksFor(step: { id: string; kind: StepKind; mode: StepMode; command?: string; commandCwd?: string }, goModuleDir: string | undefined): Check[] {
	if (step.mode === 'generate') {
		// Run it, then prove it produced something. Both, in that order: a command
		// that exits 0 without writing the file is the failure worth catching.
		return [
			{ kind: 'shell', label: `\`${step.command}\` succeeds`, cmd: step.command, cwd: step.commandCwd },
			{ kind: 'exists', label: 'the file exists and is not empty' },
		];
	}
	const checks: Check[] = [{ kind: 'exists', label: 'the file exists and is not empty' }];
	if (step.mode === 'copy') {
		return checks;
	}
	if (step.kind === 'go' || step.kind === 'gotest') {
		// Per-FILE and dependency-free: gofmt parses the file and reports it when
		// it does not round-trip. `go build` cannot be a step check because a
		// half-written package legitimately does not build yet.
		checks.push({ kind: 'shell', label: 'it parses and is gofmt-clean', cmd: `gofmt -e -l "${step.id}"`, emptyOutput: true });
	}
	if (step.kind === 'manifest' && baseName(step.id) === 'go.mod' && goModuleDir !== undefined) {
		checks.push({ kind: 'shell', label: 'the module resolves', cmd: 'go mod verify', cwd: goModuleDir });
	}
	return checks;
}

function stageTools(paths: readonly string[], text: (p: string) => string): ToolHint[] {
	const tools: ToolHint[] = [];
	const any = (re: RegExp) => paths.some((p) => re.test(text(p)));
	if (any(/chi\.NewRouter\(|http\.NewServeMux\(|\.(Route|Mount)\(/)) {
		tools.push({
			label: 'Scan the routes', command: 'burrow.flow.refresh',
			why: 'This stage registers HTTP routes, so the API view can trace them end to end for the first time.',
		});
	}
	if (paths.some((p) => p.endsWith('_test.go'))) {
		tools.push({
			label: 'Run the Go tests', command: 'burrow.test.runAll',
			why: 'You wrote tests in this stage — the Test Lab shows failures first.',
		});
	}
	if (paths.some((p) => p.endsWith('.sql'))) {
		tools.push({
			label: 'Open the database', command: 'burrow.db.refresh',
			why: 'These migrations define the tables; the Data view reads the live schema back.',
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
	options: { name: string; reference: string; routes?: ReadonlyMap<string, readonly string[]> },
): ScratchPlan {
	// go.sum is project content but never a step: `go mod tidy`, which the go.mod
	// step runs, writes it. Dropped from the step universe rather than from
	// isIgnored — it is not noise, it just has no step to call its own.
	const source = files.filter((f) => !isIgnored(f.path) && f.bytes <= MAX_BYTES && baseName(f.path) !== 'go.sum');
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
		for (const p of paths) {
			const a = analysed.get(p)!;
			const owner = goModuleOf(p, modules);
			const gen = generatedBy(p, baseName(p) === 'go.mod' ? modules.get(dirName(p)) : owner?.[1]);
			const mode: StepMode = gen ? 'generate' : a.kind === 'doc' ? 'copy' : a.kind === 'lock' ? 'copy' : 'write';
			const shape = { id: p, kind: a.kind, mode, command: gen?.cmd, commandCwd: gen?.cwd };
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
				...routesFor(p),
			};
			claimed.add(p);
		}
		stages.push({ ...stage, steps: paths, tools: stage.tools.length ? stage.tools : stageTools(paths, textOf) });
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
	}, foundations);

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
		addStage({
			id: dir,
			title: dir,
			blurb: doc || `Package ${pkg} — ${paths.length} file${paths.length === 1 ? '' : 's'}.`,
			cls: 'go',
			setup: [],
			checks: [
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
