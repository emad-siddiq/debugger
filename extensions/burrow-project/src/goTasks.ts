/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// goTasks.ts — the PURE half of Go tasks: which argv each task runs, and which
// contributed problem matcher can turn its output into a Problems entry.
//
// The survey found VS Code's Tasks machinery compiled in and STARVED: every
// stock provider (grunt, gulp, jake, npm) was deleted in patch 0002 and nothing
// replaced them, so `Tasks: Run Task` offered nothing and no Go command anywhere
// in Burrow put a compiler error into the Problems view. IntelliJ has Maven and
// Gradle here; Xcode has schemes. Go has six commands people actually type.
//
// This module imports no 'vscode', so out/goTasks.js is a clean CommonJS module
// the standalone tests require directly — same shape as descriptor.ts.

/** The Go commands worth a task. Nothing here is invented; these are the six a
 *  person types by hand in a Go repository. */
export type GoTaskKind = 'build' | 'test' | 'vet' | 'generate' | 'tidy' | 'lint';

export interface GoTaskSpec {
	readonly kind: GoTaskKind;
	/** The task's name, as it appears in the Run Task list. */
	readonly label: string;
	/** One sentence: what running it does. */
	readonly detail: string;
	/** Which of VS Code's task groups it belongs to, if any. */
	readonly group: 'build' | 'test' | 'none';
	/** Does its output ever name a file:line worth putting in Problems? */
	readonly diagnostic: boolean;
}

export const GO_TASK_SPECS: readonly GoTaskSpec[] = [
	{ kind: 'build', label: 'go build', detail: 'Compile every package, reporting errors without producing binaries', group: 'build', diagnostic: true },
	{ kind: 'test', label: 'go test', detail: 'Run every test in the module', group: 'test', diagnostic: true },
	{ kind: 'vet', label: 'go vet', detail: 'Report suspicious constructs the compiler accepts', group: 'none', diagnostic: true },
	{ kind: 'generate', label: 'go generate', detail: 'Run every //go:generate directive', group: 'none', diagnostic: true },
	{ kind: 'tidy', label: 'go mod tidy', detail: 'Add what is imported and drop what is not, from go.mod and go.sum', group: 'none', diagnostic: false },
	{ kind: 'lint', label: 'staticcheck', detail: 'The extended check set — SA/S/ST/QF — beyond what the compiler and vet see', group: 'none', diagnostic: true },
];

export function goTaskSpec(kind: string): GoTaskSpec | undefined {
	return GO_TASK_SPECS.find((s) => s.kind === kind);
}

/** The default package pattern: everything under the module. */
export const ALL_PACKAGES = './...';

/**
 * The argv for a Go task, minus the program name.
 *
 * `tidy` takes NO package argument, and that is measured, not assumed: Go 1.23
 * answers `go mod tidy ./...` with `go: 'go mod tidy' accepts no arguments` and
 * exits 1. Passing the caller's `packages` through uniformly — the obvious
 * implementation — makes the one task whose whole job is to fix go.mod the one
 * task that cannot run.
 *
 * `lint` is not a `go` subcommand at all; it runs staticcheck. It is here so the
 * argv lives with its siblings, but the caller resolves a different binary for
 * it — see {@link lintPlan}.
 */
export function buildTaskArgs(kind: GoTaskKind, packages?: string): string[] {
	const pkgs = packages && packages.trim() ? packages.trim() : ALL_PACKAGES;
	switch (kind) {
		case 'build': return ['build', pkgs];
		case 'test': return ['test', pkgs];
		case 'vet': return ['vet', pkgs];
		case 'generate': return ['generate', pkgs];
		case 'tidy': return ['mod', 'tidy'];
		case 'lint': return [pkgs];
		default: throw new Error(`unknown go task: ${kind}`);
	}
}

/**
 * What `lint` should actually run, and what to say when it cannot.
 *
 * staticcheck is a HOST tool, like gopls and dlv. A project that has never
 * installed it is not a broken project, so the task degrades to `go vet` — which
 * is always present, because it ships with the toolchain — and says so, rather
 * than failing with `command not found` and leaving the reader to work out that
 * Burrow expected a binary nobody mentioned. This is the house rule at
 * 18-project-spine.md:40-42 applied to a tool instead of a file.
 */
export interface LintPlan {
	readonly tool: 'staticcheck' | 'go';
	readonly args: readonly string[];
	/** Present only when this is NOT what was asked for. */
	readonly degraded?: string;
}

export function lintPlan(staticcheckPath: string | undefined, packages?: string): LintPlan {
	const pkgs = packages && packages.trim() ? packages.trim() : ALL_PACKAGES;
	if (staticcheckPath) {
		return { tool: 'staticcheck', args: [pkgs] };
	}
	return {
		tool: 'go',
		args: ['vet', pkgs],
		degraded: 'staticcheck is not installed, so this ran `go vet` instead. '
			+ 'Install it with `go install honnef.co/go/tools/cmd/staticcheck@latest` to get the SA/S/ST/QF checks.',
	};
}

/**
 * The module roots a contributed problem matcher exists for.
 *
 * WHY THIS LIST EXISTS. Go prints diagnostic paths relative to the directory the
 * command ran in — measured in all four arrangements, including `go -C` and an
 * absolute package argument, and it is relative every time. So a task whose cwd
 * is a module under `backend/` reports `sub/deep.go`, and a matcher anchored at
 * `${workspaceFolder}` resolves that to a file that does not exist. VS Code's
 * `fileLocation` takes a literal path with variable substitution, not a value the
 * provider can compute, so the only way to anchor at the module root is to
 * contribute one matcher per root that detection can find.
 *
 * These are exactly `descriptor.ts`'s GO_SUBDIRS, plus the root. Keeping the two
 * lists equal is what {@link matcherFor} guarantees and what the tests check
 * against the shipped manifest — a root detection can find with no matcher
 * behind it would silently drop every diagnostic in that project.
 */
export const MATCHER_ROOTS: readonly string[] = ['.', 'backend', 'server', 'api', 'cmd', 'src', 'service'];

/**
 * The name of the contributed problem matcher anchored at `moduleRoot`.
 *
 * Falls back to the workspace-root matcher for anything unrecognised. That is
 * wrong-but-visible rather than wrong-and-silent: paths resolve to files that do
 * not exist and the Problems entries simply do not appear, where returning a
 * matcher name nothing contributes makes VS Code drop the matcher entirely and
 * log nothing at all.
 */
export function matcherFor(moduleRoot: string): string {
	const normalised = moduleRoot.replace(/^\.\//, '').replace(/\/+$/, '') || '.';
	if (normalised === '.' || !MATCHER_ROOTS.includes(normalised)) {
		return '$go';
	}
	return `$go-${normalised}`;
}

/** Every matcher name this module can ever return. The manifest must define all of them. */
export function allMatcherNames(): string[] {
	return MATCHER_ROOTS.map((root) => (root === '.' ? '$go' : `$go-${root}`));
}

/**
 * The regular expression the contributed matchers use, as a string, so a test can
 * assert the manifest carries exactly this and run it against output Go really
 * printed.
 *
 * Anchored on a `.go` file so the package header lines Go interleaves —
 * `# example.com/matcher/sub` — cannot match. Both path spellings Go emits IN THE
 * SAME RUN are covered by the optional `./`: a subpackage is reported as
 * `sub/deep.go` and the root package as `./bad.go`, which is the detail that
 * makes a naive matcher work on half a project's errors and no more.
 *
 * The leading `vet: ` is consumed because `go vet` prefixes the first diagnostic
 * of each package with it, and a path of `vet: ./bad.go` resolves to nothing.
 * `-: ` is staticcheck's marker on lines it is quoting from the compiler.
 *
 * The strip is `(?:\.\/)?` and NOT `\.?\/?` on purpose — the looser form eats the
 * leading slash of an absolute path, turning `/Users/x/main.go` into a relative
 * `Users/x/main.go` under the workspace, which resolves to nothing.
 */
export const GO_PROBLEM_REGEXP = '^(?:vet: |-: )?(?:\\.\\/)?(\\S+\\.go):(\\d+):(\\d+): (.*)$';
