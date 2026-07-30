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

export interface Stack {
	readonly id: StackId;
	/** Directory holding the module, relative to the project root. '.' for root. */
	readonly root: string;
	/** Module path from `go.mod`, when it could be read. */
	readonly module?: string;
	/** What the project's OWN toolchain does to build and run it. */
	readonly build: string;
	readonly run: string;
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
}

/** The descriptor file, as authored. Every field optional: it is an override
 *  sheet, not a manifest. */
export interface Descriptor {
	readonly version?: number;
	readonly name?: string;
	readonly stacks?: readonly Partial<Stack>[];
	readonly services?: readonly Partial<Service>[];
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
		});
		// One Go stack is enough for this work order. A monorepo with several
		// modules is a real shape and an honest gap, not something to guess at.
		break;
	}

	return { name: folderName, stacks, services: detectServices(tree), declared: [] };
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

	return {
		name: take('name', descriptor.name, detected.name),
		stacks: stacks as readonly Stack[],
		services: services as readonly Service[],
		declared,
	};
}

const EMPTY_GO_STACK: Stack = { id: 'go', root: '.', build: 'go build ./...', run: 'go run .' };

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
		stacks: project.stacks.map((s) => ({ id: s.id, root: s.root, module: s.module, build: s.build, run: s.run })),
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

/** One line per rail: what is live, and when it is not, why not. Consumed by the
 *  report and by anything that wants to explain itself to a user. */
export function capabilities(project: Project): { readonly id: string; readonly live: boolean; readonly why: string }[] {
	const go = project.stacks.find((s) => s.id === 'go');
	const pg = project.services.find((s) => s.kind === 'postgres');
	return [
		{ id: 'go', live: !!go, why: go ? `go.mod in ${go.root}` : 'no go.mod found in the root or the usual server directories' },
		{ id: 'test', live: !!go, why: go ? 'the Go stack supplies the test packages' : 'needs a Go stack' },
		{ id: 'flow', live: !!go, why: go ? `flowscan analyses ${go.root}` : 'needs a Go stack' },
		{ id: 'data', live: !!pg, why: pg ? pgWhy(pg) : 'no Postgres service in a compose file and no postgres:// URL in an env file' },
	];
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
