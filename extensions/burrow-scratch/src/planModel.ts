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

import { ParseLang, langOf, parseLabel, topLevelKeys } from './parse';

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
	/**
	 * `exists` — the file is there, and has something in it.
	 * `shell` — a command, run in the scratch. It can be missing, and then the
	 *   verdict is "could not run".
	 * `parse` — the file holds together as an instance of its language, decided
	 *   in process by {@link parseFile}. No toolchain, no network, one file: a
	 *   check at ITS OWN step cannot resolve imports that are still hundreds of
	 *   steps away, and a compiler asked to would fail correct work.
	 * `same` — byte-identical to the reference. ONLY for a `copy` step, where the
	 *   instruction is *"copy this one in"* and byte-identity is therefore the
	 *   whole of what done means. On a step you type it would be a transcription
	 *   test, which is not what any of this is for.
	 * `declares` — it exports the names the reference exports. The other half of
	 *   `parse` for a language with no minimum content: an empty TypeScript file
	 *   is valid TypeScript, so parsing alone passes a file containing a space.
	 */
	readonly kind: 'exists' | 'shell' | 'parse' | 'same' | 'declares';
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
	/** `parse` only. */
	readonly lang?: ParseLang;
	/** `parse` only: top-level names the reference declares, every one of which
	 *  the scratch's copy has to declare too. `{}` is valid JSON. */
	readonly keys?: readonly string[];
}

export interface ToolHint {
	readonly label: string;
	readonly command: string;
	readonly why: string;
}

/**
 * The half of a file a command writes, on a step you type the rest of.
 *
 * `go.mod` could become a whole `generate` step because there is nothing in it a
 * person decides. A `package.json` is not like that: its name, its `type` and its
 * `scripts` are the project stating what it is and how it is run, and its
 * dependency block is thirty-nine lines of version ranges nobody invents. Making
 * the whole file generated would delete the first; leaving it all typed is what
 * the plan did, and what a reader objected to in as many words — *"this still
 * wants me to populate package.json by hand"*.
 *
 * So the step is split rather than reclassified. The ranges are the REFERENCE's
 * own (`react@^19.2.4`, not `react`): resolving fresh would install whatever is
 * newest today, which can be a major the code beside it was not written against,
 * and the scratch would then fail to build for a reason the reader did not cause.
 */
export interface DerivedPart {
	/** What to run, as the reader would type it. */
	readonly cmd: string;
	/** Scratch-relative directory to run it in. */
	readonly cwd: string;
	/** The part of the file it fills in, so the page can say what you do NOT type. */
	readonly writes: string;
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
	/** `write` steps whose file is part authored and part generated. See {@link DerivedPart}. */
	readonly derived?: readonly DerivedPart[];
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
	/** Manifests only: how far this one actually reaches. See {@link ManifestReach}. */
	readonly resolves?: ManifestReach;
}

/**
 * How far a manifest actually reaches — measured, not counted by prefix.
 *
 * The page used to say *"every bare import under `test/` — 1 modules' worth —
 * resolves through the dependencies this file names"* about a manifest that
 * declares **no dependencies**, beside a single `.mjs` whose only imports are
 * `node:fs`, `node:path` and `node:url`. The sentence was false twice over, and
 * the reason it could be is that it never opened either file: it counted step ids
 * by extension under a directory prefix and presented the number as a graph fact.
 *
 * So the number is now the answer to a question you can check by opening files:
 * **how many of them import something this manifest names.** A specifier is
 * resolved against the manifest's own dependency block (`dependencies` and the
 * three fields beside it) or, for a `go.mod`, against its module path and its
 * `require` list. Nothing else counts.
 */
export interface ManifestReach {
	/** Files under this manifest that import at least one specifier it names. */
	readonly files: number;
	/** Distinct names from this manifest that those files actually import. For a
	 *  `go.mod` this is the requires only — the module path is named separately,
	 *  because it is the half the step's own check asserts. */
	readonly names: number;
	/** The three most-imported of them, for the page to say out loud rather than
	 *  leaving the reader with a bare number they cannot place. */
	readonly top: readonly string[];
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
	/** Why this stage carries that `setup`, when the reason is particular to it —
	 *  a runtime dependency arriving at the file that first imports it, rather
	 *  than a blanket install at the top of the plan. */
	readonly setupWhy?: string;
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

/**
 * The package a bare specifier belongs to: `react-dom/client` → `react-dom`,
 * `@scope/pkg/sub` → `@scope/pkg`.
 *
 * `undefined` for everything that is not a package — a relative path, the `@/`
 * source alias, a Node builtin. `node:fs` is the case that matters: a file whose
 * every import is a builtin depends on no manifest at all, and counting it as one
 * is how a dependency-free package came to claim it resolved something.
 */
export function packageOf(spec: string): string | undefined {
	if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/') || spec.startsWith('node:')) {
		return undefined;
	}
	const parts = spec.split('/');
	return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Module paths a `go.mod` requires, from either form of the directive. Version
 *  and `// indirect` are dropped: this answers "does this import resolve through
 *  the manifest", not "at what version". */
export function goRequires(text: string): string[] {
	const out: string[] = [];
	const push = (p: string | undefined): void => {
		if (p && !out.includes(p)) {
			out.push(p);
		}
	};
	for (const block of text.matchAll(/^require\s*\(([\s\S]*?)^\)/gm)) {
		for (const line of block[1].split('\n')) {
			push(/^\s*(\S+)\s+v\S/.exec(line)?.[1]);
		}
	}
	for (const single of text.matchAll(/^require\s+(\S+)\s+v\S/gm)) {
		push(single[1]);
	}
	return out;
}

/** The three parts of a `package.json` this plan distinguishes: what a person
 *  decides, what a command installs now, and what a command installs later. */
export interface NpmManifest {
	/** Script names, in declaration order. The project's own command line. */
	readonly scripts: readonly string[];
	/** Runtime dependencies and their ranges, verbatim from the reference. */
	readonly dependencies: Readonly<Record<string, string>>;
	readonly devDependencies: Readonly<Record<string, string>>;
}

/** `undefined` when the file is not JSON at all — the manifest's own `parse`
 *  check is what says so, and guessing here would say it twice and worse. */
export function npmManifest(text: string): NpmManifest | undefined {
	try {
		const json = JSON.parse(text) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
		return {
			scripts: Object.keys(json.scripts ?? {}),
			dependencies: json.dependencies ?? {},
			devDependencies: json.devDependencies ?? {},
		};
	} catch {
		return undefined;
	}
}

/** A shell word, quoted only when it has to be. The command is READ as much as
 *  it is run — it is printed on the page for the reader to type — so
 *  `react@^19.2.4` stays legible and only an exotic range gets quotes. */
function shellArg(word: string): string {
	return /^[A-Za-z0-9@._/^~+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * `npm install` for a named set, at the reference's own ranges (R76).
 *
 * `npm install react` writes whatever is newest the day it runs. That is the
 * honest thing for a project being started and the wrong thing for one being
 * REBUILT: a major version the reference's code was not written against turns
 * into a compile error the reader did not cause and cannot diagnose. So the
 * range is transcribed — which is exactly what `go mod init <path>` already does
 * with a module path, and the same argument.
 */
export function installCommand(names: readonly string[], ranges: Readonly<Record<string, string>>, dev: boolean): string {
	const args = names.map((n) => shellArg(ranges[n] ? `${n}@${ranges[n]}` : n)).join(' ');
	return `npm install ${dev ? '-D ' : ''}${args}`;
}

/** The nearest enclosing owner directory, longest prefix wins. `''` is the
 *  project root and owns anything no deeper owner claims. */
function nearestOwner(rel: string, owners: ReadonlySet<string>): string | undefined {
	let best: string | undefined;
	for (const dir of owners) {
		if ((dir === '' || rel.startsWith(`${dir}/`)) && (best === undefined || dir.length > best.length)) {
			best = dir;
		}
	}
	return best;
}

/**
 * Per manifest, how many files under it import something it names — and which
 * names those are. See {@link ManifestReach} for why this replaced a prefix count.
 *
 * Nearest manifest wins, so a nested package is not credited to its parent. The
 * manifest's own file never counts itself.
 */
export function manifestReach(files: readonly SourceFile[]): Map<string, ManifestReach> {
	const npm = new Map<string, Set<string>>();
	const go = new Map<string, { module: string; requires: readonly string[] }>();
	for (const f of files) {
		const base = baseName(f.path);
		if (base === 'package.json') {
			const named = new Set<string>();
			try {
				const json = JSON.parse(f.text) as Record<string, Record<string, string> | undefined>;
				for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
					for (const name of Object.keys(json[field] ?? {})) {
						named.add(name);
					}
				}
			} catch {
				// A manifest that does not parse names nothing. Not silent: its own
				// step carries a `parse` check that says so in as many words.
			}
			npm.set(dirName(f.path), named);
		} else if (base === 'go.mod') {
			const module = /^module\s+(\S+)/m.exec(f.text)?.[1];
			if (module) {
				go.set(dirName(f.path), { module, requires: goRequires(f.text) });
			}
		}
	}

	const counted = new Map<string, number>();
	const tally = new Map<string, Map<string, number>>();
	const bump = (id: string, names: readonly string[]): void => {
		counted.set(id, (counted.get(id) ?? 0) + 1);
		const t = tally.get(id) ?? new Map<string, number>();
		for (const n of names) {
			t.set(n, (t.get(n) ?? 0) + 1);
		}
		tally.set(id, t);
	};

	const npmDirs = new Set(npm.keys());
	const goDirs = new Set(go.keys());
	for (const f of files) {
		if (isJsModule(f.path)) {
			const dir = nearestOwner(f.path, npmDirs);
			if (dir === undefined) {
				continue;
			}
			const named = npm.get(dir)!;
			const used = [...new Set(tsImports(f.text).map(packageOf).filter((p): p is string => !!p && named.has(p)))];
			if (used.length) {
				bump(join(dir, 'package.json'), used);
			}
		} else if (f.path.endsWith('.go')) {
			const dir = nearestOwner(f.path, goDirs);
			if (dir === undefined) {
				continue;
			}
			const { module, requires } = go.get(dir)!;
			// The module path is counted as a HIT but not as a name: it is the half
			// this step's own check asserts, and the page says it separately.
			let internal = false;
			const used = new Set<string>();
			for (const spec of goImports(f.text)) {
				if (spec === module || spec.startsWith(`${module}/`)) {
					internal = true;
					continue;
				}
				const req = requires.find((r) => spec === r || spec.startsWith(`${r}/`));
				if (req) {
					used.add(req);
				}
			}
			if (internal || used.size) {
				bump(join(dir, 'go.mod'), [...used]);
			}
		}
	}

	const out = new Map<string, ManifestReach>();
	for (const dir of npmDirs) {
		out.set(join(dir, 'package.json'), reachOf(join(dir, 'package.json'), counted, tally));
	}
	for (const dir of goDirs) {
		out.set(join(dir, 'go.mod'), reachOf(join(dir, 'go.mod'), counted, tally));
	}
	return out;
}

function reachOf(id: string, counted: ReadonlyMap<string, number>, tally: ReadonlyMap<string, Map<string, number>>): ManifestReach {
	const names = tally.get(id) ?? new Map<string, number>();
	return {
		files: counted.get(id) ?? 0,
		names: names.size,
		top: [...names].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([n]) => n),
	};
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

/**
 * A `node -e` program as one shell word.
 *
 * Node is a prerequisite of anything with a `package.json`, and a check that
 * needs it reports its absence as "could not run" rather than as the reader's
 * mistake — that is what `isMissingTool` is for. The alternative was a pile of
 * `grep`s, which cannot tell a key in `scripts` from the same word in a comment
 * and would fail a correct file to make a point.
 */
function nodeCheck(program: string): string {
	return `node -e '${program.replace(/'/g, `'\\''`)}'`;
}

const READ_MANIFEST = 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));';

/** The `scripts` block, named one by one. This is the part of the manifest a
 *  person decides, so it is the part with a verdict: "exists and is not empty"
 *  passed on a file containing `{}`. */
function scriptsCheck(scripts: readonly string[], cwd: string): Check {
	return {
		kind: 'shell', cwd,
		label: `it declares all ${scripts.length} script${scripts.length === 1 ? '' : 's'}`,
		cmd: nodeCheck(READ_MANIFEST
			+ `const w=${JSON.stringify(scripts)};const m=w.filter((k)=>!(p.scripts||{})[k]);`
			+ 'if(m.length){console.error("package.json declares no script named: "+m.join(", "));process.exit(1)}'
			+ 'console.log(w.length+" scripts, all present.")'),
	};
}

/** Named AND installed, reported separately: they fail for different reasons and
 *  the fix is different. Not in `devDependencies` means the command has not run;
 *  not in `node_modules` means it ran somewhere else. */
function devDepsCheck(names: readonly string[], cwd: string): Check {
	return {
		kind: 'shell', cwd,
		label: `all ${names.length} devDependencies are named and installed`,
		cmd: nodeCheck(READ_MANIFEST
			+ `const w=${JSON.stringify(names)};`
			+ 'const nd=w.filter((k)=>!(p.devDependencies||{})[k]);'
			+ 'const ni=w.filter((k)=>!fs.existsSync("node_modules/"+k+"/package.json"));'
			+ 'if(nd.length)console.error("not in devDependencies: "+nd.join(", "));'
			+ 'if(ni.length)console.error("declared but not installed: "+ni.join(", "));'
			+ 'if(nd.length||ni.length)process.exit(1);'
			+ 'console.log(w.length+" devDependencies, all named and installed.")'),
	};
}

/**
 * A lockfile that locks what the manifest asks for.
 *
 * `npm install` beside a manifest with an empty dependency block exits 0 and
 * writes a four-line lockfile, so "the command succeeded" and "the file exists"
 * both went green on a file with nothing in it — the {@link Precondition} hole,
 * reopened one file over from where it was closed. The remedy is `go mod tidy`'s:
 * the step moved to where its input exists, and the verdict asks what it produced.
 */
function lockCheck(cwd: string): Check {
	return {
		kind: 'shell', cwd,
		label: 'it locks every package the manifest names',
		cmd: nodeCheck(READ_MANIFEST
			+ 'const l=JSON.parse(fs.readFileSync("package-lock.json","utf8"));'
			+ 'const named=Object.keys(Object.assign({},p.dependencies,p.devDependencies));'
			+ 'const have=new Set(Object.keys(l.packages||{}).filter((k)=>k.includes("node_modules/")).map((k)=>k.slice(k.lastIndexOf("node_modules/")+13)));'
			+ 'const miss=named.filter((n)=>!have.has(n));'
			+ 'if(miss.length){console.error(named.length+" named by package.json, "+(named.length-miss.length)+" locked. Not locked: "+miss.join(", "));process.exit(1)}'
			+ 'console.log(named.length+" packages named, all "+named.length+" locked.")'),
	};
}

/**
 * The directory a step's own command runs in: a `generate` step's, or the first
 * {@link DerivedPart} of a step that is otherwise typed. `undefined` when the
 * step has no command at all, which is what "Open a terminal" keys off.
 */
export function commandCwdOf(step: ScratchStep): string | undefined {
	if (step.mode === 'generate') {
		return step.commandCwd ?? dirName(step.id);
	}
	return step.derived?.[0]?.cwd;
}

/** The half of a `package.json` a command writes. See {@link DerivedPart}. */
function derivedFor(relPath: string, npm: NpmManifest | undefined): DerivedPart[] {
	if (baseName(relPath) !== 'package.json' || !npm) {
		return [];
	}
	const dev = Object.keys(npm.devDependencies);
	// devDependencies only. The runtime half is not a command on THIS step: it is
	// installed at the file that first imports it, which on a real project is
	// hundreds of steps away — see the batching pass at the end of `buildPlan`.
	return dev.length ? [{ cmd: installCommand(dev, npm.devDependencies, true), cwd: dirName(relPath), writes: 'devDependencies' }] : [];
}

function checksFor(
	step: {
		id: string; kind: StepKind; mode: StepMode; command?: string; commandCwd?: string;
		modulePath?: string; bytes?: number; npm?: NpmManifest; topKeys?: readonly string[];
		declares?: readonly string[];
	},
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
			// A lockfile's whole job is to pin what the manifest asked for, so that
			// is the verdict — not that a file appeared.
			...(LOCK_MANIFEST.get(baseName(step.id)) === 'package.json' && step.npm ? [lockCheck(step.commandCwd ?? dirName(step.id))] : []),
		];
	}
	const checks: Check[] = [existsCheck(step.bytes)];
	if (step.mode === 'copy') {
		// 624 of merkle's steps are prose and diagrams, and the whole verdict on
		// every one of them was that a file existed. Nothing here parses a Markdown
		// document usefully — almost any text is valid Markdown, which is the point
		// of it — but a `copy` step does not need parsing: the instruction is to
		// reproduce the file, so reproducing it is the check.
		checks.push({ kind: 'same', label: 'it matches the reference, byte for byte' });
		return checks;
	}
	// Does it hold together? The one question a check can ask about a file with
	// nothing below it written, and the question 1,056 written steps were never
	// asked: their whole verdict was that the file was not empty, which one space
	// satisfies. A reference file the project itself leaves empty gets nothing —
	// there is no such thing as an empty stylesheet that parses badly.
	const lang = step.bytes === 0 ? undefined : langOf(step.id);
	if (lang) {
		// `dependencies` and `devDependencies` are a command's to write and arrive
		// after this step (see `DerivedPart` and `installPass`), so requiring them
		// here would be a check nothing the reader does at this step can turn green.
		const deferred = baseName(step.id) === 'package.json' ? ['dependencies', 'devDependencies'] : [];
		const keys = (step.topKeys ?? []).filter((k) => !deferred.includes(k));
		checks.push({ kind: 'parse', label: parseLabel(lang, keys), lang, ...(keys.length ? { keys } : {}) });
		// An EMPTY TypeScript file is valid TypeScript, so parsing it is not by
		// itself a verdict — a file containing one space passes both checks above.
		// What the reference exports is the rest of the answer, and the plan already
		// read it. Go needs none of this: `gofmt -e` rejects a file with no
		// `package` clause, which is the same floor by another route.
		if ((lang === 'ts' || lang === 'tsx' || lang === 'js') && step.declares?.length) {
			const names = step.declares;
			checks.push({
				kind: 'declares', lang, keys: names,
				label: `it exports ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`,
			});
		}
	}
	// Two languages with no parser aboard and a real one on the machine. `bash -n`
	// reads the script and refuses to run it; Python's own `ast` is the compiler's
	// front half. Both report as "could not run" when absent, never as a pass.
	if (/\.sh$/.test(step.id)) {
		checks.push({ kind: 'shell', label: 'it parses as a shell script', cmd: `bash -n "${step.id}"` });
	}
	if (/\.py$/.test(step.id)) {
		checks.push({ kind: 'shell', label: 'it parses as Python', cmd: `python3 -c 'import ast,sys;ast.parse(open(sys.argv[1]).read(),sys.argv[1])' "${step.id}"` });
	}
	// The authored half of a manifest, asserted. Everything else about a
	// `package.json` is a command's to write (see `DerivedPart`); the `scripts`
	// block is the part a person decides, and it was checked by nothing.
	if (baseName(step.id) === 'package.json' && step.npm) {
		const cwd = dirName(step.id);
		if (step.npm.scripts.length) {
			checks.push(scriptsCheck(step.npm.scripts, cwd));
		}
		const dev = Object.keys(step.npm.devDependencies);
		if (dev.length) {
			checks.push(devDepsCheck(dev, cwd));
		}
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

/**
 * Compile a package and keep the result. `go build` on a main package WRITES an
 * executable into the working directory, named after the package — so the check
 * for `test/cmd/oracle` tried to write `test/oracle`, which is a directory of
 * the reader's own source, and failed with `build output "oracle" already exists
 * and is a directory`. On every other main package it succeeded, and left a
 * binary in the scratch that the reader never asked for and the reference does
 * not contain. `-o /dev/null` is the compile-only form: same errors, no artefact.
 */
function goBuildCommand(dir: string): string {
	return goPkgCommand('build', dir).replace('go build ', 'go build -o /dev/null ');
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

/** Take a step out of the stage it was planned into and put it at the front of
 *  another. Both stage objects are rebuilt rather than mutated, so a plan handed
 *  out earlier cannot change under its holder. */
function moveStep(stages: ScratchStage[], steps: Record<string, ScratchStep>, id: string, toStage: string): void {
	const from = stages.findIndex((s) => s.steps.includes(id));
	const to = stages.findIndex((s) => s.id === toStage);
	if (from < 0 || to < 0 || from === to) {
		return;
	}
	stages[from] = { ...stages[from], steps: stages[from].steps.filter((s) => s !== id) };
	stages[to] = { ...stages[to], steps: [id, ...stages[to].steps] };
	steps[id] = { ...steps[id], stage: toStage };
}

/**
 * Where a runtime dependency arrives — R74/R75, and the measurement behind them.
 *
 * `frontend/package.json` is step 3. The first file importing anything it names
 * is step 11; the first file importing a **runtime** dependency is step 660. The
 * two halves of one block are 649 steps apart, so a single rule for both is wrong
 * whichever way it is written: defer everything and five Foundations steps stop
 * working, install everything and you have run a thirty-eight package install for
 * code that does not exist yet.
 *
 * So they are separated. `devDependencies` install on the manifest step itself
 * (see `derivedFor`) because the configs immediately below it import them.
 * `dependencies` install on the stage holding the first file that imports them,
 * BATCHED per stage — thirteen commands on merkle rather than eighteen, each one
 * the set of packages that stage's own files introduce.
 *
 * A setup line is not a step and carries no import edge, so nothing here can move
 * the ordering invariant. The one thing that does is the lockfile, which stops
 * being a Foundations step: `npm install` beside a manifest with an empty
 * dependency block writes a lockfile with nothing in it, and the step now sits
 * where there is something to lock.
 */
function installPass(
	stages: ScratchStage[],
	steps: Record<string, ScratchStep>,
	analysed: ReadonlyMap<string, Analysed>,
	npmOf: ReadonlyMap<string, NpmManifest>,
): void {
	const order = stages.flatMap((s) => s.steps);
	const npmDirs = new Set(npmOf.keys());
	const rank = new Map(stages.map((s, i) => [s.id, i]));
	const extra = new Map<string, string[]>();
	const why = new Map<string, string>();

	for (const [dir, npm] of npmOf) {
		const runtime = Object.keys(npm.dependencies);
		if (!runtime.length) {
			continue;
		}
		const firstStage = new Map<string, string>();
		for (const id of order) {
			const text = analysed.get(id)?.file.text;
			if (text === undefined || !isJsModule(id) || nearestOwner(id, npmDirs) !== dir) {
				continue;
			}
			for (const spec of tsImports(text)) {
				const pkg = packageOf(spec);
				if (pkg !== undefined && npm.dependencies[pkg] !== undefined && !firstStage.has(pkg)) {
					firstStage.set(pkg, steps[id].stage);
				}
			}
		}
		const batches = new Map<string, string[]>();
		for (const pkg of runtime) {
			const stage = firstStage.get(pkg);
			if (stage !== undefined) {
				batches.set(stage, [...(batches.get(stage) ?? []), pkg]);
			}
		}
		const ordered = [...batches.keys()].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
		if (!ordered.length) {
			// Every dependency declared and none of them imported. The rule has no
			// first importer to point at, so the install stays where the manifest is
			// — which is what it would have been anyway, and is not a reason to drop
			// the packages on the floor.
			const home = steps[join(dir, 'package.json')]?.stage;
			if (home === undefined) {
				continue;
			}
			ordered.push(home);
			batches.set(home, []);
		}
		// A dependency nothing imports has no first importer, and this rule has
		// nothing to say about it. It still has to be installed for the manifest to
		// reach the reference, so it joins the first batch — and is NAMED there,
		// because "declared and never imported" is a fact about the project worth
		// telling rather than a gap to quietly paper over.
		const orphans = runtime.filter((pkg) => !firstStage.has(pkg));
		for (const stage of ordered) {
			const first = stage === ordered[0];
			const named = batches.get(stage)!;
			const list = (names: readonly string[]) => names.map((n) => `\`${n}\``).join(', ');
			extra.set(stage, [...(extra.get(stage) ?? []),
			`cd ${dir || '.'} && ${installCommand([...named, ...(first ? orphans : [])], npm.dependencies, false)}`]);
			why.set(stage, `${list(named)} — this stage holds the first file that imports ${named.length === 1 ? 'it' : 'them'}.`
				+ (first && orphans.length ? ` The command also carries ${orphans.length} package${orphans.length === 1 ? '' : 's'} the manifest`
					+ ` declares that nothing in the project imports: ${list(orphans)}.` : '')
				+ ' Nothing before this stage needed any of it, which is why it is not installed with the manifest.');
		}
		const lockId = join(dir, 'package-lock.json');
		if (steps[lockId]) {
			moveStep(stages, steps, lockId, ordered[0]);
		}
	}

	for (let i = 0; i < stages.length; i++) {
		const add = extra.get(stages[i].id);
		if (add) {
			stages[i] = { ...stages[i], setup: [...stages[i].setup, ...add], setupWhy: why.get(stages[i].id) };
		}
	}
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
	// Measured once over the step universe, so the numerator on the page and the
	// denominator it is quoted against are counted from the same set of files.
	const reach = manifestReach(source);
	const modules = new Map<string, string>();
	const npmOf = new Map<string, NpmManifest>();
	for (const f of source) {
		if (baseName(f.path) === 'go.mod') {
			modules.set(dirName(f.path), /^module\s+(\S+)/m.exec(f.text)?.[1] ?? '');
		} else if (baseName(f.path) === 'package.json') {
			const manifest = npmManifest(f.text);
			if (manifest) {
				npmOf.set(dirName(f.path), manifest);
			}
		}
	}
	/** The manifest a step is about: its own, for a `package.json`; the one beside
	 *  it, for the lockfile it is generated from. */
	const npmFor = (p: string): NpmManifest | undefined =>
		baseName(p) === 'package.json' || LOCK_MANIFEST.get(baseName(p)) === 'package.json' ? npmOf.get(dirName(p)) : undefined;

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
			const npm = npmFor(p);
			const derived = derivedFor(p, npm);
			// Read from the REFERENCE, like the byte count `existsCheck` uses: a check
			// running against a scratch cannot work out what "correct" would be.
			const lang = a.file.bytes === 0 ? undefined : langOf(p);
			const topKeys = lang ? topLevelKeys(lang, a.file.text) : [];
			const shape = {
				id: p, kind: a.kind, mode, command: gen?.cmd, commandCwd: gen?.cwd,
				modulePath: declares, bytes: a.file.bytes, npm, topKeys, declares: a.declares,
			};
			steps[p] = {
				id: p,
				stage: stage.id,
				title: baseName(p),
				kind: a.kind,
				mode,
				lines: a.lines,
				bytes: a.file.bytes,
				...(gen ? { command: gen.cmd, commandCwd: gen.cwd } : {}),
				...(derived.length ? { derived } : {}),
				summary: a.summary,
				declares: a.declares,
				deps: a.deps,
				depStages: a.depDirs,
				checks: checksFor(shape, owner?.[0]),
				...noteFor(p),
				...routesFor(p),
				...(reach.has(p) ? { resolves: reach.get(p)! } : {}),
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
		// `npm install` USED TO BE HERE, once per package.json, and it was the
		// blanket form of exactly what this stage should not do: install thirty-eight
		// packages for code that does not exist yet. The dev half is now a command on
		// the manifest step itself and the runtime half arrives at the file that
		// first imports it (see the batching pass at the end of this function), so
		// there is nothing left for a stage-wide install to add.
		setup: [...modules.keys()].map((d) => `cd ${d || '.'} && go mod download`),
		setupWhy: 'A generated `go.mod` requires nothing until a package has been tidied against it, so this'
			+ ' downloads nothing today. It is here as the command, for the first time there is something to download.',
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
	// package stages, which are where there is Go for it to read. Not on the
	// module root's own stage: `test/` keeps every one of its packages in a
	// subdirectory, so a root-anchored check would have no stage to live on and
	// the test module would never get one.
	for (const dir of topoSort([...goDirs], goEdges)) {
		// `testdata/` belongs to the package, not to the leftovers at the end.
		//
		// Go's own convention: the toolchain ignores the directory when building,
		// and `go test` reads it at run time — which makes it a dependency of the
		// stage's own check that no import graph can see. Left in the "everything
		// else" stage, `backend/fleet/install`'s golden file was planned 1,400
		// steps after the test that reads it, so a reader who completed the stage
		// exactly as written got `read testdata/install_sh.golden.sh: no such file
		// or directory` and nothing in the plan to do about it.
		const fixtures = [...byDir.keys()]
			.filter((d) => d === `${dir}/testdata` || d.startsWith(`${dir}/testdata/`))
			.flatMap((d) => (byDir.get(d) ?? []).filter((p) => !claimed.has(p)))
			.sort();
		const paths = [...pairTests(
			(byDir.get(dir) ?? [])
				.filter((p) => !claimed.has(p))
				.sort((a, b) => shapeRank(a) - shapeRank(b) || (a < b ? -1 : 1)),
		), ...fixtures];
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
				// Before `go build`, because it is what writes the requires the build
				// then resolves. It stays qualified: a package that is not written yet
				// has nothing to tidy, and that is not a failure.
				//
				// EVERY package stage, not just the first of the module. `go mod tidy`
				// resolves the imports that exist when it runs, and each new package
				// brings imports the ones before it did not have — so a single early
				// run left the module short of everything introduced later. Measured
				// on merkle: `backend/middleware` is the first package to import chi,
				// and from that stage on, 25 of the remaining stages failed `go build`
				// with `no required module provides package github.com/go-chi/chi/v5`
				// and no step in the plan would ever have fixed it. Tidy is idempotent
				// and cheap on a warm module cache.
				{
					kind: 'shell' as const,
					label: `go mod tidy resolves ${moduleDir || '.'}`,
					cmd: 'go mod tidy', cwd: moduleDir,
					needs: { dir, match: '.go', why: 'the package has no Go files yet, so there is nothing for it to resolve.' },
				},
				{ kind: 'shell', label: `go build ${rel}`, cmd: goBuildCommand(dir), cwd: moduleDir },
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

	// LAST, because it needs the whole order: a dependency's first importer is a
	// fact about the plan, not about any one stage. See `installPass`.
	installPass(stages, steps, analysed, npmOf);

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

/** The kinds a stage-level dependency can actually be about. A Go package or a
 *  TypeScript directory is imported as a unit, so every code file in it is a
 *  reason the importer waits; a lockfile or a golden fixture that happens to sit
 *  in the same stage is not imported by anybody. */
const IMPORTABLE: ReadonlySet<StepKind> = new Set<StepKind>(['go', 'gotest', 'ts', 'tsx', 'style']);

/**
 * Reverse edges: which steps name this one as a dependency. Computed rather than
 * stored so the plan file stays a tree and cannot disagree with itself.
 *
 * The stage-level half is qualified by kind. A stage edge means "s imports the
 * package this stage is", and a step that is not code is not part of that
 * package: `frontend/package-lock.json` now sits in the stage that first installs
 * a runtime dependency, and without the filter every file importing that stage
 * would have been listed under *What it unlocks* on a lockfile — the same class
 * of true-looking sentence this pass exists to remove. `testdata` fixtures folded
 * into a Go package stage were in the same position and had been all along.
 */
export function dependents(plan: ScratchPlan, stepId: string): string[] {
	const step = plan.steps[stepId];
	if (!step) {
		return [];
	}
	const viaStage = IMPORTABLE.has(step.kind);
	return Object.values(plan.steps)
		.filter((s) => s.deps.includes(stepId) || (viaStage && s.stage !== step.stage && s.depStages.includes(step.stage)))
		.map((s) => s.id);
}
