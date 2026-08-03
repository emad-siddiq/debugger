/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// concepts.ts — the prose the graph cannot derive.
//
// WO-78 counted the legibility defects in Foundations and found eleven terms the
// surface requires a reader to already know, one of which it explains. It also
// costed the fix, and the number is small: **six concept paragraphs, two order
// arguments, one project-specific note.** Everything else about that stage falls
// out of data the planner already has, and WO-79 landed it.
//
// WHY THE PROSE IS HERE AND NOT IN THE PLAN. A plan is derived from a repository
// and re-derived whenever that repository moves; anything written by a person and
// stored in a derived artefact is lost on the next `Re-plan`. These are keyed by
// CONCEPT, not by file and not by project, so they survive re-planning and so
// they are read rather than re-authored by the next stack.
//
// THE REUSE BOUNDARY, stated rather than hoped for. `lockfile`, `makefile` and
// `compose-service` are about tools that do not care what language calls them:
// a Python or Rust stack reuses those three UNCHANGED and adds nothing. The
// manifest and module concepts are per-ecosystem by nature — `Cargo.toml` is not
// `package.json` with a different name — so a new stack writes one of those and
// extends CONCEPT_OF, which is the only table that mentions a filename.
//
// THE TEST THAT KEEPS THEM REUSABLE: a paragraph that names a project, an app,
// or any path out of this repository has failed. Asserted in
// test/concepts.test.js, which is a grep with a reason.
//
// No `vscode` import: unit-tested standalone, and readable by any other
// extension that plans a project (the plain-require route, WO-78 §1a).

export type ConceptId =
	| 'go-module'
	| 'npm-manifest'
	| 'lockfile'
	| 'tsconfig-references'
	| 'makefile'
	| 'compose-service';

export interface Concept {
	/** What the step page calls it, above the paragraph. */
	readonly term: string;
	/** The paragraph. One of them, no headings, no lists — it is read in place. */
	readonly text: string;
	/**
	 * Why this file is where it is in the order, for the steps whose position the
	 * graph cannot argue for. Absent for the concepts whose position IS derivable:
	 * a module root comes first because its tree resolves through it, and a
	 * lockfile follows its manifest because a command reads one to write the other.
	 */
	readonly order?: string;
}

export const CONCEPTS: Readonly<Record<ConceptId, Concept>> = {
	'go-module': {
		term: 'A Go module, and its module path',
		text: 'A `go.mod` declares a module path — the name every file in the tree below it is imported by. '
			+ 'It looks like a repository address because that is what resolves when somebody else imports it, '
			+ 'but the compiler treats it as an opaque prefix. '
			+ '`go mod init <path>` writes that declaration and nothing else: the `require` lines underneath are '
			+ '`go mod tidy`\'s, reconciled against the imports actually present in the code, which is why this '
			+ 'file stays near-empty until there is code to read. The `go` line is a third thing again — a '
			+ '**minimum**, not a target. `go mod init` writes the toolchain that ran it, so a reference '
			+ 'declaring a newer one is not yours to match.',
	},
	'npm-manifest': {
		term: 'An npm manifest',
		text: 'A `package.json` names a package, the dependencies it needs and the scripts that run it. '
			+ 'A dependency is a *range* — `^5.2.0` admits 5.9.1 — so identical text can resolve differently a '
			+ 'month apart. The range you install WITH is copied from what you are rebuilding: left open, an '
			+ 'installer fetches whatever is newest today, which can be a major the code was not written against. '
			+ 'What it writes BACK is its own caret over what it found, so this text may not come out identical. '
			+ 'The `scripts` block is the part nothing can derive — the project\'s real command-line interface, '
			+ 'and what someone arriving reads to find out how it is built, started and tested.',
	},
	'lockfile': {
		term: 'A lockfile',
		text: 'A lockfile records the exact versions an install resolved to, so the next install on another '
			+ 'machine reproduces that tree instead of resolving the ranges again. It is generated and never '
			+ 'typed: the manifest beside it is the input, and a command is the author. That is also why a '
			+ 'lockfile with no manifest above it is not a file anyone can produce — there is nothing to resolve. '
			+ 'It belongs in version control; a build that re-resolves every time is a build whose failures '
			+ 'depend on the day it ran.',
	},
	'tsconfig-references': {
		term: 'TypeScript project references',
		text: 'A `tsconfig.json` configures the compiler for one program. `references` splits a codebase into '
			+ 'several such programs that build separately and depend on each other — application code, build '
			+ 'tooling, tests — each with its own settings, so the file that runs under Node does not inherit '
			+ 'the browser\'s type library. A config that names references usually declares no files of its own; '
			+ 'it exists to point at the others. `extends` is the different mechanism: it merges one config\'s '
			+ 'settings into another, and a config can do both.',
	},
	'makefile': {
		term: 'A Makefile',
		text: 'A Makefile is a list of named targets and the commands each one runs; `make test` is a shell '
			+ 'script with a table of contents. The dependency machinery Make is famous for — rebuild a file when '
			+ 'what it is derived from is newer — goes largely unused in a project whose compiler already does '
			+ 'that. What survives is the naming, and it matters: this is the one place a project states its own '
			+ 'vocabulary for build, test, run and lint, and every other tool ends up deferring to those names.',
		order: 'Nothing needs it and it needs nothing. Every target it names runs a command over code that does '
			+ 'not exist yet, and will keep failing until that code does — so its position here is a **choice, '
			+ 'not a constraint**, and it is worth saying so rather than inventing a reason. The choice: this '
			+ 'stage is where a project says what it is, and a target list is the shortest statement of that. '
			+ 'Reading it now tells you what the finished thing is expected to do. The only thing that would '
			+ 'genuinely constrain it is a target the plan asks you to run, and there is none.',
	},
	'compose-service': {
		term: 'A compose service',
		text: 'A compose file declares containers. A service names an image, the ports it publishes to the host '
			+ 'and the environment it starts with; `docker compose up` starts them together on a shared network. '
			+ 'For a database service the environment block *is* the credentials — the image\'s entrypoint reads '
			+ 'them the first time it starts and creates the user and the database then, which is why changing '
			+ 'them later has no effect on a volume that already exists. The published port is what makes it '
			+ 'reachable from code running outside the container.',
		order: 'It is last in this stage because it is the only file here that produces something **running** '
			+ 'rather than something declared, and because nothing above it can use a database. What comes next '
			+ 'can: the schema is a directory of migrations, and a migration is a statement about a database that '
			+ 'has to exist before the statement means anything. So this is the end of the stage and also the '
			+ 'first point in the whole plan where the project does something rather than describing itself.',
	},
};

/**
 * Which concept a file is an instance of.
 *
 * The ONLY table here that mentions a filename, and therefore the only thing a
 * new stack edits: add `Cargo.toml → 'lockfile'`-style rows and the prose above
 * is reused rather than rewritten.
 */
export function conceptOf(relPath: string): ConceptId | undefined {
	const base = relPath.slice(relPath.lastIndexOf('/') + 1);
	if (base === 'go.mod') {
		return 'go-module';
	}
	if (base === 'package.json') {
		return 'npm-manifest';
	}
	if (base === 'go.sum' || base === 'package-lock.json' || base === 'pnpm-lock.yaml' || base === 'yarn.lock') {
		return 'lockfile';
	}
	if (/^tsconfig.*\.json$/.test(base)) {
		return 'tsconfig-references';
	}
	if (base === 'Makefile' || base === 'makefile' || base === 'GNUmakefile') {
		return 'makefile';
	}
	if (/^(docker-)?compose\.ya?ml$/.test(base)) {
		return 'compose-service';
	}
	return undefined;
}

/** The paragraph for a step, if its file is an instance of anything. */
export function conceptFor(relPath: string): Concept | undefined {
	const id = conceptOf(relPath);
	return id ? CONCEPTS[id] : undefined;
}
