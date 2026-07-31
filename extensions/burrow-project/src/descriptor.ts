/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// descriptor.ts — what a project IS, and how Burrow works it out (WO-71 §1).
//
// DETECTION FIRST, DECLARATION SECOND. A folder with a `go.mod` is a Go project
// without anyone writing anything, and a repository that has never seen Burrow
// must work. So `detect()` answers from the tree alone, and the descriptor only
// records what detection could not infer or what the user overrode. It is never
// a prerequisite for opening a project.
//
// That ordering is the whole design. The alternative — a config file the tools
// require — is what Burrow has had until now, hand-written for one repository,
// which is why every rail went inert on any other folder.
//
// No `vscode` import: detection reads a `Tree`, so it can be unit-tested against
// a fake one, including shapes nobody has on disk.

/** The bits of a filesystem detection needs. Injected so tests can fake it. */
export interface Tree {
	exists(relativePath: string): boolean;
	read(relativePath: string): string | undefined;
	/** Immediate subdirectory names of `relativePath`, '' for the root. */
	dirs(relativePath: string): readonly string[];
	/** Immediate file names of `relativePath`. Empty for a path that is not a
	 *  directory — never throws, because detection runs on folders it has never
	 *  seen and half of these paths will not exist. */
	files(relativePath: string): readonly string[];
}

export type StackId = 'go';

/**
 * A thing this project can be told to START (WO-74 §1).
 *
 * **A module root is not a program.** WO-72 measured that on `alertmanager`: the
 * `go.mod` is at the root and the runnable code is in `cmd/alertmanager` and
 * `cmd/amtool`. Resolving a *module* and calling it a *program* is why F5 started a
 * session there, failed to build, and died without a word.
 *
 * SHAPED FOR FIVE STACKS, IMPLEMENTED FOR ONE. The design was driven by the row
 * least like the others — a Vite dev server — because a concept that only fits
 * compiled binaries is the wrong concept:
 *
 *   go     `go list` packages named `main`      → kind 'binary',  path = pkg dir
 *   rust   [[bin]] targets + src/main.rs        → kind 'binary',  path = target
 *   python __main__.py / console_scripts        → kind 'module',  path = module
 *   c/c++  CMake targets, Makefile rules        → kind 'binary',  path = target
 *   ts     the dev server command               → kind 'server',  command = 'npm run dev'
 *
 * So an entry point is `{ id, label, kind, path?, command? }` and NOT `{ program }`.
 * `path` is what a debugger launches; `command` is what a shell runs. A Go main
 * package has a path and no command; a Vite dev server has a command and no path;
 * a Python `-m` target arguably has both, which is why `kind` decides rather than
 * the presence of a field.
 *
 * `id` is stable across detections — it is what a remembered choice refers to — and
 * is the path or command, not an index, because an index changes when a sibling
 * appears.
 */
export type EntryKind = 'binary' | 'module' | 'server';

export interface EntryPoint {
	/** Stable identity for a remembered choice. The path, or the command. */
	readonly id: string;
	/** What a person would call it: `alertmanager`, `dev server`. */
	readonly label: string;
	readonly kind: EntryKind;
	/** Directory or file a debugger launches, relative to the project root. */
	readonly path?: string;
	/** Shell command that starts it, for the kinds nothing launches directly. */
	readonly command?: string;
}

export interface Stack {
	readonly id: StackId;
	/** Directory holding the module, relative to the project root. '.' for root. */
	readonly root: string;
	/** Module path from `go.mod`, when it could be read. */
	readonly module?: string;
	/** What the project's OWN toolchain does to build and run it. */
	readonly build: string;
	readonly run: string;
	/**
	 * Everything this stack can start. **Zero, one or many are all normal** — a
	 * library has none, a service has one, `alertmanager` has two — and the count
	 * is what decides whether F5 can act without asking.
	 */
	readonly entries: readonly EntryPoint[];
}

export type ServiceKind = 'postgres';

export interface Service {
	readonly kind: ServiceKind;
	/** Compose file + service name, relative to the project root. */
	readonly composeFile?: string;
	readonly composeService?: string;
	/** The env var carrying the connection string, when one was found. */
	readonly urlEnv?: string;
	/** The connection string itself, when it was in a committed `.env`. NEVER
	 *  written to the descriptor — see `serialize`. */
	readonly url?: string;
}

export interface Project {
	readonly name: string;
	readonly stacks: readonly Stack[];
	readonly services: readonly Service[];
	/** Which fields came from `.burrow/project.json` rather than the tree. */
	readonly declared: readonly string[];
	/** The remembered choice, if the descriptor named one that still exists. */
	readonly entry?: string;
}

/**
 * Which entry point to start, and whether anyone needs to be asked.
 *
 * The three cases are three different obligations, not degrees of one:
 *
 *   one    act — no prompt, no ceremony
 *   many   ASK, and never guess. `cmd/<reponame>` was available and is declined:
 *          picking a binary for someone because its name matched the directory is
 *          the kind of convenience that debugs the wrong process at 2am.
 *   zero   say there is nothing to run, and why
 */
export function chooseEntry(project: Project): {
	readonly need: 'one' | 'many' | 'zero';
	readonly entry?: EntryPoint;
	readonly options: readonly EntryPoint[];
} {
	const options = project.stacks.flatMap((s) => s.entries);
	if (options.length === 0) {
		return { need: 'zero', options };
	}
	// A remembered choice settles it — but only if it still exists.
	const remembered = project.entry ? options.find((e) => e.id === project.entry) : undefined;
	if (remembered) {
		return { need: 'one', entry: remembered, options };
	}
	if (options.length === 1) {
		return { need: 'one', entry: options[0], options };
	}
	return { need: 'many', options };
}

/** The descriptor file, as authored. Every field optional: it is an override
 *  sheet, not a manifest. */
export interface Descriptor {
	readonly version?: number;
	readonly name?: string;
	readonly stacks?: readonly Partial<Stack>[];
	readonly services?: readonly Partial<Service>[];
	/**
	 * The entry point the user picked when there was more than one.
	 *
	 * **A descriptor field, not a setting, and not per launch configuration.** It is
	 * a fact about the project — "of this repository's two binaries, I debug this
	 * one" — which is precisely what WO-71 built an override sheet to hold. Per
	 * configuration would be wrong twice over: a bare F5 has no configuration, and
	 * the answer would have to be repeated in every one that did.
	 *
	 * It stores the entry point's `id`, so a choice survives a sibling appearing.
	 * An id that no longer exists is ignored and the question is asked again —
	 * silently honouring a stale choice would launch the wrong program.
	 */
	readonly entry?: string;
}

export const DESCRIPTOR_DIR = '.burrow';
export const DESCRIPTOR_PATH = '.burrow/project.json';
export const DESCRIPTOR_VERSION = 1;

/** Where a Go module might sit in a repository that has never seen Burrow.
 *  Ordered: the root wins, then the conventional server directories. */
const GO_SUBDIRS = ['backend', 'server', 'api', 'cmd', 'src', 'service'];

/** Images that mean "this project wants a Postgres". */
const POSTGRES_IMAGE = /\b(?:image:\s*['"]?)?(?:docker\.io\/)?(?:library\/)?(postgres|postgis\/postgis|timescale\/timescaledb)\b/;

const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
const ENV_NAMES = ['.env', '.env.local', '.env.development'];

/**
 * Where compose files and env files live when they are not at the root.
 *
 * Added after §4 measured this against three repositories and found the Data rail
 * reading *inert* on merkle — whose compose is `infra/docker-compose.yml` and whose
 * DSN is under `infra/test/env/`. A root-only search is the same single-target
 * assumption this work order exists to remove, just inverted: it happened to fit
 * the scaffold and nothing else.
 *
 * These are conventions, not a fix aimed at one repository — `infra/`, `deploy/`,
 * `docker/`, `build/` and `.docker/` are where projects put this by habit. The
 * list is short and shallow on purpose: a recursive hunt would find a fixture's
 * compose file in someone's test data and report a database that is not theirs.
 */
const CONFIG_DIRS = ['', 'infra', 'deploy', 'docker', '.docker', 'build', 'infra/local', 'infra/dev'];

/** Every candidate path for a name, root first. */
function candidates(names: readonly string[]): string[] {
	const out: string[] = [];
	for (const dir of CONFIG_DIRS) {
		for (const name of names) {
			out.push(dir ? `${dir}/${name}` : name);
		}
	}
	return out;
}

/**
 * Env files nested a little deeper than `CONFIG_DIRS` reaches.
 *
 * merkle keeps its development env under `infra/test/env/*.env`, which is a real
 * and reasonable shape — env files grouped by the thing they configure. Rather
 * than deepen the whole search, look one level of `*.env` inside the config dirs'
 * `test/env` and `env` subdirectories, which is where grouped env files go.
 */
const ENV_SUBDIRS = ['test/env', 'env', 'envs'];

/**
 * What this folder is, from the tree alone.
 *
 * Returns a project with no stacks rather than `undefined` when it finds nothing:
 * "this is a folder with no stack Burrow knows" is a real, reportable answer, and
 * the rails need it to go inert *with a reason* rather than silently.
 */
export function detect(tree: Tree, folderName: string): Project {
	const stacks: Stack[] = [];

	for (const dir of ['.', ...GO_SUBDIRS]) {
		const rel = dir === '.' ? 'go.mod' : `${dir}/go.mod`;
		if (!tree.exists(rel)) {
			continue;
		}
		stacks.push({
			id: 'go',
			root: dir,
			module: modulePath(tree.read(rel)),
			// The project's OWN commands. Burrow does not appear in them, and that
			// is the point: these are what a person would type.
			build: 'go build ./...',
			run: 'go run .',
			entries: goEntries(tree, dir),
		});
		// One Go stack is enough for this work order. A monorepo with several
		// modules is a real shape and an honest gap, not something to guess at.
		break;
	}

	return { name: folderName, stacks, services: detectServices(tree), declared: [] };
}

/**
 * Every `package main` under a Go module, as entry points.
 *
 * `go list ./...` is the authoritative answer and this is not it — deliberately.
 * Detection must work on a folder that has never been built, with no network, and
 * without shelling out on every window open; `go list` on a cold module cache can
 * take a minute and wants to download dependencies. So this reads the package
 * clause of the `.go` files where a main can be, which is exactly as accurate for
 * the question "what could be started" and free.
 *
 * Where a main can be: the module root, and one level under the conventional
 * command directories. NOT recursive — a `main` five levels down inside
 * `internal/testdata` is a fixture, and the shallow-search argument from the
 * compose scan applies unchanged.
 */
export function goEntries(tree: Tree, moduleRoot: string): EntryPoint[] {
	const under = (rel: string) => (moduleRoot === '.' ? rel : `${moduleRoot}/${rel}`);
	// `dir` may be '' for the project root, and `'' + '/' + f` is an absolute path.
	// Join through a helper so the root case cannot produce `/main.go`.
	const at = (dir: string, file: string) => (dir === '' || dir === '.' ? file : `${dir}/${file}`);
	const isMain = (dir: string): boolean => {
		for (const file of tree.files(dir)) {
			if (!file.endsWith('.go') || file.endsWith('_test.go')) {
				continue;
			}
			if (/^\s*package\s+main\b/m.test(tree.read(at(dir, file)) ?? '')) {
				return true;
			}
		}
		return false;
	};

	const entries: EntryPoint[] = [];
	const add = (rel: string, label: string) => {
		const path = rel === '' ? moduleRoot : under(rel);
		entries.push({ id: path, label, kind: 'binary', path });
	};

	// The module root itself — the scaffold's shape, and most single services.
	if (isMain(moduleRoot === '.' ? '' : moduleRoot)) {
		add('', lastSegment(moduleRoot === '.' ? 'main' : moduleRoot));
	}
	// `cmd/<name>` and friends — alertmanager's shape, and Go's own convention.
	for (const parent of ['cmd', 'cmds', 'apps', 'tools']) {
		for (const name of tree.dirs(under(parent))) {
			if (isMain(under(`${parent}/${name}`))) {
				add(`${parent}/${name}`, name);
			}
		}
	}
	return entries;
}

function lastSegment(value: string): string {
	return value.split('/').filter(Boolean).pop() || value;
}

function detectServices(tree: Tree): Service[] {
	const services: Service[] = [];

	// The first compose file that actually contains a Postgres — not the first
	// compose file. A repository may have several and only one of them is the
	// database's, which is merkle exactly.
	let composeFile: string | undefined;
	let service: string | undefined;
	for (const candidate of candidates(COMPOSE_NAMES)) {
		const text = tree.read(candidate);
		const found = text ? postgresServiceName(text) : undefined;
		if (found) {
			composeFile = candidate;
			service = found;
			break;
		}
	}

	const dsn = findDsn(tree);

	if (service || dsn) {
		services.push({
			kind: 'postgres',
			composeFile: service ? composeFile : undefined,
			composeService: service,
			urlEnv: dsn ? dsn.key : undefined,
			url: dsn ? dsn.value : undefined,
		});
	}
	return services;
}

/**
 * The first `postgres://` connection string, from an env file or the workspace's
 * own `launch.json`.
 *
 * `launch.json` is here because it is where a VS Code user puts the env their
 * program runs with, and burrow-db already reads it — leaving it out would have
 * the spine disagree with the rail it is supposed to inform.
 */
function findDsn(tree: Tree): { key: string; value: string } | undefined {
	for (const candidate of candidates(ENV_NAMES)) {
		const text = tree.read(candidate);
		const dsn = text ? postgresUrl(text) : undefined;
		if (dsn) {
			return dsn;
		}
	}
	// Grouped env files: infra/test/env/*.env and friends.
	for (const dir of CONFIG_DIRS) {
		for (const sub of ENV_SUBDIRS) {
			const at = dir ? `${dir}/${sub}` : sub;
			for (const name of tree.files(at)) {
				if (!/\.env$/.test(name) && !/^\.env/.test(name)) {
					continue;
				}
				const dsn = postgresUrl(tree.read(`${at}/${name}`) ?? '');
				if (dsn) {
					return dsn;
				}
			}
		}
	}
	const launch = tree.read('.vscode/launch.json');
	return launch ? postgresUrl(dsnLinesFromJson(launch)) : undefined;
}

/**
 * Pull `"KEY": "postgres://…"` pairs out of a launch.json into env-file form, so
 * one parser handles both.
 *
 * A scanner, not a JSON parse: launch.json is JSON-with-comments and trailing
 * commas, and `JSON.parse` throws on most real ones.
 */
export function dsnLinesFromJson(text: string): string {
	const out: string[] = [];
	for (const match of text.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"(postgres(?:ql)?:\/\/[^"]+)"/g)) {
		out.push(`${match[1]}=${match[2]}`);
	}
	return out.join('\n');
}

/** `module example.com/x` → `example.com/x`. */
export function modulePath(goMod: string | undefined): string | undefined {
	if (!goMod) {
		return undefined;
	}
	const match = /^\s*module\s+(\S+)/m.exec(goMod);
	return match ? match[1] : undefined;
}

/**
 * The name of the first compose service using a Postgres image.
 *
 * Deliberately a scanner and not a YAML parser: this has to answer on files it
 * has never seen, written by people who indent how they like, and a parser that
 * throws on one unusual file takes the whole Data rail down with it. It can be
 * fooled — a commented-out service counts — and the cost of that is a rail that
 * offers a connection which fails visibly, not a wrong answer that hides.
 */
export function postgresServiceName(compose: string): string | undefined {
	const lines = compose.split('\n');
	let current: string | undefined;
	let inServices = false;
	let servicesIndent = -1;

	for (const raw of lines) {
		const line = raw.replace(/\t/g, '  ');
		if (/^\s*#/.test(line) || !line.trim()) {
			continue;
		}
		const indent = line.length - line.trimStart().length;

		if (/^\s*services\s*:/.test(line)) {
			inServices = true;
			servicesIndent = indent;
			continue;
		}
		if (!inServices) {
			continue;
		}
		if (indent <= servicesIndent) {
			// Dropped out of `services:` into another top-level key.
			inServices = false;
			continue;
		}
		const name = /^\s*([A-Za-z0-9_.-]+)\s*:\s*$/.exec(line);
		if (name && indent === servicesIndent + 2) {
			current = name[1];
			continue;
		}
		if (current && POSTGRES_IMAGE.test(line) && /image\s*:/.test(line)) {
			return current;
		}
	}
	return undefined;
}

/** The first `KEY=postgres://…` in an env file. */
export function postgresUrl(env: string): { key: string; value: string } | undefined {
	for (const raw of env.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match) {
			continue;
		}
		const value = match[2].trim().replace(/^['"]|['"]$/g, '');
		if (/^postgres(ql)?:\/\//.test(value)) {
			return { key: match[1], value };
		}
	}
	return undefined;
}

/**
 * Detection, then the descriptor on top. The file always wins — it exists to
 * record what detection got wrong — and every field it supplies is named in
 * `declared`, so a surface can tell the user *why* it believes something.
 */
export function merge(detected: Project, descriptor: Descriptor | undefined): Project {
	if (!descriptor) {
		return detected;
	}
	const declared: string[] = [];
	const take = <T>(field: string, from: T | undefined, fallback: T): T => {
		if (from === undefined) {
			return fallback;
		}
		declared.push(field);
		return from;
	};

	const stacks = descriptor.stacks?.length
		? descriptor.stacks.map((s, i) => ({ ...(detected.stacks[i] ?? EMPTY_GO_STACK), ...prune(s) }))
		: detected.stacks;
	if (descriptor.stacks?.length) {
		declared.push('stacks');
	}

	const services = descriptor.services?.length
		? descriptor.services.map((s, i) => ({ ...(detected.services[i] ?? { kind: 'postgres' as const }), ...prune(s) }))
		: detected.services;
	if (descriptor.services?.length) {
		declared.push('services');
	}

	if (descriptor.entry !== undefined) {
		declared.push('entry');
	}
	return {
		name: take('name', descriptor.name, detected.name),
		stacks: stacks as readonly Stack[],
		services: services as readonly Service[],
		declared,
		entry: descriptor.entry,
	};
}

const EMPTY_GO_STACK: Stack = { id: 'go', root: '.', build: 'go build ./...', run: 'go run .', entries: [] };

/** Drop `undefined` values so a spread does not erase a detected field. */
function prune<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * The descriptor as it should be written.
 *
 * **No secrets.** A detected `url` is a live connection string, frequently with a
 * password in it; the descriptor records the env var's NAME and lets the env file
 * stay the one place the value lives. Writing the DSN here would put a credential
 * in a file people paste into issues.
 */
export function serialize(project: Project): string {
	const body = {
		version: DESCRIPTOR_VERSION,
		name: project.name,
		stacks: project.stacks.map((s) => ({
			id: s.id, root: s.root, module: s.module, build: s.build, run: s.run,
			entries: s.entries.map((e) => ({ id: e.id, label: e.label, kind: e.kind, path: e.path, command: e.command })),
		})),
		// The user's pick, when there was one to make. Written last because it is the
		// one field here that is a DECISION rather than an observation.
		entry: project.entry,
		services: project.services.map((s) => ({
			kind: s.kind,
			composeFile: s.composeFile,
			composeService: s.composeService,
			urlEnv: s.urlEnv,
		})),
	};
	return JSON.stringify(body, (_key, value) => (value === undefined ? undefined : value), '\t') + '\n';
}

/** Parse a descriptor, tolerating anything: a broken file must not stop a
 *  project opening, because detection alone is enough to work. */
export function parse(text: string | undefined): Descriptor | undefined {
	if (!text) {
		return undefined;
	}
	try {
		const value = JSON.parse(text) as Descriptor;
		return value && typeof value === 'object' ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * What each rail can do here, and when it cannot, why not.
 *
 * **`live` means measured. Anything short of that is `unknown`** (WO-72 §0.2).
 * WO-71 reported `flow: live` for go-chi/chi on the reasoning that flowscan
 * analyses any Go stack — but flowscan seeds its walk from `NewRouter()` CALL
 * sites, and chi *defines* `NewRouter` rather than calling it, so the claim was
 * inference dressed as a measurement. A capability list that guesses is worse than
 * none: it sends someone to a rail that will be empty and gives them no reason.
 *
 * `unknown` is not a hedge, it is a different fact — "this needs running the tool
 * to find out" — and it carries the sentence that says so.
 */
export type Liveness = 'live' | 'inert' | 'unknown';

export interface Capability {
	readonly id: string;
	readonly state: Liveness;
	readonly why: string;
	/** Kept for callers that only want a boolean; true ONLY for `live`. */
	readonly live: boolean;
}

/**
 * What `burrow-flow` recorded the last time it actually traced this project.
 *
 * Written by `burrow-flow` at `.burrow/flow.json`, read here — a FILE, not a call
 * into a sibling extension, so a capability report never depends on another
 * extension having activated. The two copies of this shape are bound by
 * `burrow-flow/test/spine.test.js`, which requires both modules and asserts they
 * agree field by field.
 */
export interface FlowRun {
	readonly routes: number;
	readonly traced: number;
	readonly partial: number;
	readonly unknown: number;
	readonly ranAt?: string;
	readonly loadErrors?: number;
}

export const FLOW_STATE_PATH = '.burrow/flow.json';
export const FLOW_STATE_VERSION = 1;

/** Parse `.burrow/flow.json`, tolerating anything — a corrupt cache means "not
 *  tried", which is the state the surface already knows how to say. */
export function parseFlowRun(text: string | undefined): FlowRun | undefined {
	if (!text) {
		return undefined;
	}
	try {
		const v = JSON.parse(text) as Partial<FlowRun> & { version?: number };
		if (!v || typeof v !== 'object' || v.version !== FLOW_STATE_VERSION || typeof v.routes !== 'number') {
			return undefined;
		}
		const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
		return {
			routes: v.routes, traced: n(v.traced), partial: n(v.partial), unknown: n(v.unknown),
			ranAt: typeof v.ranAt === 'string' ? v.ranAt : undefined,
			loadErrors: typeof v.loadErrors === 'number' ? v.loadErrors : undefined,
		};
	} catch {
		return undefined;
	}
}

export function capabilities(project: Project, flow?: FlowRun): Capability[] {
	const go = project.stacks.find((s) => s.id === 'go');
	const pg = project.services.find((s) => s.kind === 'postgres');
	const cap = (id: string, state: Liveness, why: string): Capability => ({ id, state, why, live: state === 'live' });

	return [
		// Measured by the tree: a go.mod is there or it is not.
		cap('go', go ? 'live' : 'inert',
			go ? `go.mod in ${go.root}` : 'no go.mod found in the root or the usual server directories'),
		cap('test', go ? 'live' : 'inert',
			go ? 'the Go stack supplies the test packages' : 'needs a Go stack'),

		// NOT measured by the tree — and, until a trace has run, not measured at all.
		//
		// THE THREE STATES, and the third is the point. `unknown` was correct at
		// detection time and stayed correct forever, including after the tool had run
		// and produced a number. What a user has to be able to tell apart is:
		//
		//   not tried            no .burrow/flow.json  → unknown
		//   tried, found routes  routes > 0            → live, with the count
		//   tried, found NONE    routes === 0          → inert, with the reason
		//
		// The last one had nowhere to live and is go-chi/chi's honest state: flowscan
		// ran, walked the module, and there was nothing it recognised as a router.
		// Reporting that as `unknown` sends someone to run a tool that has already
		// answered; reporting it as `live` sends them to an empty rail.
		//
		// (Delegated: no NEW affordance. The traffic light's three states already map
		// onto the three answers — find out / yes / no — and a fourth colour would be
		// a fourth thing to learn for a distinction the reason sentence carries
		// better. What "tried and found none" earns is a DIFFERENT SENTENCE from "no
		// Go stack", and it has one.)
		cap('flow', ...flowState(go, flow)),

		// Whether anything can be STARTED. Zero entry points is not `unknown` — it is
		// measured, and 'inert' with the reason is exactly right: a library has
		// nothing to run and saying so is the whole job. (Delegated question in §2:
		// no new state needed. `unknown` means "run the tool to find out"; this is
		// known.)
		cap('run', go ? (go.entries.length ? 'live' : 'inert') : 'inert',
			!go
				? 'needs a Go stack'
				: go.entries.length === 0
					? `no package main under ${go.root} or its cmd/ directories — this module is a library, so there is nothing to launch`
					: go.entries.length === 1
						? `one entry point: ${go.entries[0].label} (${go.entries[0].path})`
						: `${go.entries.length} entry points — ${go.entries.map((e) => e.label).join(', ')} — you will be asked which to debug, once`),

		cap('data', pg ? 'live' : 'inert',
			pg ? pgWhy(pg) : 'no Postgres service in a compose file and no postgres:// URL in an env file'),
	];
}

/** The `flow` capability's state and reason. Split out because it is the one
 *  capability whose answer changes after something has RUN. */
function flowState(go: Stack | undefined, flow: FlowRun | undefined): [Liveness, string] {
	if (!go) {
		return ['inert', 'needs a Go stack'];
	}
	// `'.'` is the project root; "traced . and found no routes" reads as a typo.
	const where = go.root === '.' ? 'this module' : go.root;
	if (!flow) {
		return ['unknown',
			`flowscan can analyse ${where}, but whether it finds routes depends on there being a router to seed from — run "API Flows: Refresh Flows" to find out`];
	}
	const when = flow.ranAt ? ` (last run ${flow.ranAt})` : '';
	// A run working with incomplete type information is not a clean one, and
	// flowscan exits zero either way. It does not always change the counts — a
	// go1.24 build reports 45 load errors on merkle and still traces 209 of 235 —
	// but when the counts ARE wrong this is the only warning anything has.
	const degraded = flow.loadErrors
		? ` — but ${flow.loadErrors} package(s) failed to type-check, so these counts are incomplete`
		: '';
	if (flow.routes === 0) {
		return ['inert',
			`traced ${where} and found no routes${when} — flowscan seeds its walk from NewRouter()/NewMux() call sites, so a router it does not recognise traces empty${degraded}`];
	}
	return ['live',
		`${flow.routes} routes traced from ${where} (${flow.traced} full, ${flow.partial} partial, ${flow.unknown} unresolved)${when}${degraded}`];
}

function pgWhy(pg: Service): string {
	const from: string[] = [];
	if (pg.composeService) {
		from.push(`${pg.composeFile} service "${pg.composeService}"`);
	}
	if (pg.urlEnv) {
		from.push(`${pg.urlEnv} in an env file`);
	}
	return from.join(' + ');
}
