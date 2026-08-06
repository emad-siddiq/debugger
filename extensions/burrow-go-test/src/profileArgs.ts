/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// profileArgs.ts — the PURE half of Go profiling: which flags produce which
// profile, and how to read the address the viewer says it is serving on.
//
// The survey's largest single gap was the profiler row: IntelliJ ships
// async-profiler with flame graphs, Xcode ships Instruments, and Burrow had
// nothing — zero `pprof` references in the whole repo. Go's own answer is
// better than it gets credit for: `go test` writes the profile, and
// `go tool pprof -http` serves a full web UI with a flame graph, top table,
// peek, source and disassembly views. Both halves already exist on any machine
// with a Go toolchain. What was missing was the wiring.
//
// This module imports neither 'vscode' nor 'child_process', so out/profileArgs.js
// is a clean CommonJS module the standalone tests require directly, in the same
// shape as command.ts and coverage.ts. The spawning lives in profile.ts.

/**
 * The kinds of profile a `go test` run can produce.
 *
 * `trace` is deliberately in the same list even though it is served by a
 * different tool: from the reader's side "profile this benchmark" is one
 * question, and making them pick the tool before they pick the question would
 * be organising the menu around our implementation.
 */
export type ProfileKind = 'cpu' | 'memory' | 'block' | 'mutex' | 'trace';

/** What a profile kind is called, what flag makes it, and what it answers. */
export interface ProfileSpec {
	readonly kind: ProfileKind;
	readonly label: string;
	/** The `go test` flag that writes it. */
	readonly flag: string;
	/** The file name written into the run's scratch directory. */
	readonly file: string;
	/** One sentence: the question this profile answers. */
	readonly detail: string;
	/** Which viewer serves it — `go tool pprof` for all but the execution trace. */
	readonly viewer: 'pprof' | 'trace';
}

/**
 * Every profile `go test` can write, in the order a reader is likely to want
 * them: where the time goes, then where the memory goes, then why goroutines
 * are waiting, then the whole timeline.
 */
export const PROFILE_SPECS: readonly ProfileSpec[] = [
	{
		kind: 'cpu', label: 'CPU', flag: '-cpuprofile', file: 'cpu.prof', viewer: 'pprof',
		detail: 'Where the time goes — flame graph, top, peek, source and disassembly',
	},
	{
		kind: 'memory', label: 'Memory', flag: '-memprofile', file: 'mem.prof', viewer: 'pprof',
		detail: 'What allocated, and how much survived',
	},
	{
		kind: 'block', label: 'Blocking', flag: '-blockprofile', file: 'block.prof', viewer: 'pprof',
		detail: 'Where goroutines waited on channels, mutexes and syscalls',
	},
	{
		kind: 'mutex', label: 'Mutex contention', flag: '-mutexprofile', file: 'mutex.prof', viewer: 'pprof',
		detail: 'Which locks were contended, and by whom',
	},
	{
		kind: 'trace', label: 'Execution trace', flag: '-trace', file: 'go.trace', viewer: 'trace',
		detail: 'The whole timeline — goroutines, GC, scheduler latency, syscalls',
	},
];

/** Looks a spec up by kind. */
export function profileSpec(kind: ProfileKind): ProfileSpec | undefined {
	return PROFILE_SPECS.find(spec => spec.kind === kind);
}

/** What to profile: a package, optionally narrowed to named benchmarks or tests. */
export interface ProfileRunOptions {
	readonly packagePath: string;
	readonly kind: ProfileKind;
	/** Absolute path the profile is written to. */
	readonly profilePath: string;
	/** Absolute path the compiled test binary is kept at, for symbolisation. */
	readonly binaryPath?: string;
	/** Benchmark or test names to select; empty means the package's benchmarks. */
	readonly names?: readonly string[];
	/** Profile benchmarks (the default) or ordinary tests. */
	readonly target?: 'benchmark' | 'test';
	/** `-benchtime`, e.g. `3s` or `1000x`. Omitted uses Go's default. */
	readonly benchtime?: string;
	readonly race?: boolean;
}

/**
 * Composes the `go test` argv that writes a profile.
 *
 * Benchmarks are the default target, and the `-run '^$'` that comes with them
 * matters more here than in an ordinary run: a CPU profile that also contains
 * the test suite is a profile of the test suite. Profiling ordinary tests is
 * still offered, because a slow test is a real thing to investigate — it is just
 * not the default.
 *
 * `-o` is always passed. `go test` deletes the binary it builds, and
 * `go tool pprof` wants it for symbolisation of anything the profile did not
 * inline symbols for; keeping it costs one file in a scratch directory and
 * removes a whole class of "function unknown" frames.
 */
export function buildProfileArgs(opts: ProfileRunOptions): string[] {
	const spec = profileSpec(opts.kind);
	if (!spec) {
		throw new Error(`unknown profile kind: ${opts.kind}`);
	}
	const args = ['test'];
	if (opts.race) {
		args.push('-race');
	}
	if (opts.binaryPath) {
		args.push('-o', opts.binaryPath);
	}
	args.push(spec.flag, opts.profilePath);

	const names = opts.names ?? [];
	if (opts.target === 'test') {
		if (names.length) {
			args.push('-run', `^(${names.join('|')})$`);
		}
	} else {
		args.push('-run', '^$', '-bench', names.length ? `^(${names.join('|')})$` : '.', '-benchmem');
		if (opts.benchtime) {
			args.push('-benchtime', opts.benchtime);
		}
	}
	// NO `-json`. The runner's JSON event stream is for the Testing API's verdicts;
	// a profiling run has no verdict to report and the reader wants the benchmark
	// table, which `-json` wraps one line at a time.
	args.push(opts.packagePath);
	return args;
}

/**
 * Composes `go tool pprof -http` argv.
 *
 * `-no_browser` is not optional. Without it pprof opens the system browser the
 * moment it starts, so the reader gets the page twice — once outside Burrow,
 * where they did not ask for it.
 */
export function buildPprofArgs(port: number, profilePath: string, binaryPath?: string): string[] {
	const args = ['tool', 'pprof', `-http=127.0.0.1:${port}`, '-no_browser'];
	if (binaryPath) {
		args.push(binaryPath);
	}
	args.push(profilePath);
	return args;
}

/**
 * Composes `go tool trace -http` argv.
 *
 * `go tool trace` has **no** `-no_browser` flag — measured against the Go 1.24
 * toolchain, whose entire flag set is `-http`, `-pprof` and `-d`. It does honour
 * `$BROWSER`, also measured: pointing it at a program that exits 0 is what stops
 * a browser window appearing. See {@link traceEnv}.
 */
export function buildTraceArgs(port: number, tracePath: string, binaryPath?: string): string[] {
	const args = ['tool', 'trace', `-http=127.0.0.1:${port}`];
	if (binaryPath) {
		args.push(binaryPath);
	}
	args.push(tracePath);
	return args;
}

/**
 * The environment `go tool trace` must be spawned with so it does not open a
 * browser. `/usr/bin/true` exits 0 and does nothing, which is exactly what the
 * Go toolchain's browser opener treats as "the browser was opened".
 */
export function traceEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...base, BROWSER: '/usr/bin/true' };
}

/**
 * Reads the address a viewer says it is serving on.
 *
 * `go tool pprof` prints `Serving web UI on http://127.0.0.1:41234`; `go tool
 * trace` prints `... Trace viewer is listening on http://127.0.0.1:41234`, on a
 * line that also carries a timestamp. One matcher covers both because both end
 * in the URL.
 *
 * Returns `undefined` rather than guessing, so the caller waits rather than
 * framing an address nothing is listening on. Note that a port of `0` is NOT
 * resolved by either tool — they echo the `:0` back verbatim — which is why the
 * caller must choose a concrete port and why that case is rejected here.
 */
export function parseServingUrl(line: string): string | undefined {
	const match = /https?:\/\/[0-9.]+:(\d+)\b/.exec(line);
	if (!match) {
		return undefined;
	}
	if (match[1] === '0') {
		// Both tools echo `-http=127.0.0.1:0` back literally instead of reporting
		// the port they actually bound. Treating that as an address would frame
		// `http://127.0.0.1:0`, which fails with no explanation.
		return undefined;
	}
	return match[0];
}
