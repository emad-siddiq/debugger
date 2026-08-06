/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// toolchain.ts — the PURE half of the toolchain doctor: reading four version
// banners, and knowing which tool version goes with which Go minor.
//
// IntelliJ has an SDK manager and Xcode has, effectively, one toolchain per
// Xcode. Burrow has three host prerequisites — go, gopls, dlv — and until now
// said nothing about any of them: a missing gopls produced an editor with no
// completion and no message, and a gopls too new for the host Go failed inside
// `go install` with an error about a go.mod nobody had heard of.
//
// No 'vscode' import, so out/toolchain.js is a clean CommonJS module.

export type ToolId = 'go' | 'gopls' | 'dlv' | 'staticcheck';

export interface ToolInfo {
	readonly id: ToolId;
	readonly label: string;
	/** Is Burrow's Go story broken without it, or merely reduced? */
	readonly required: boolean;
	/** What stops working when it is absent. */
	readonly provides: string;
}

export const TOOLS: readonly ToolInfo[] = [
	{ id: 'go', label: 'Go', required: true, provides: 'building, testing, profiling — everything' },
	{ id: 'gopls', label: 'gopls', required: true, provides: 'completion, hover, diagnostics, hierarchies, refactoring, rendered docs' },
	{ id: 'dlv', label: 'Delve', required: true, provides: 'debugging: breakpoints, the Miller inspector, the Frames view' },
	{ id: 'staticcheck', label: 'staticcheck', required: false, provides: 'the extended SA/S/ST/QF check set, above what the compiler and vet see' },
];

/** What a tool answered when asked its version. */
export interface ToolStatus {
	readonly id: ToolId;
	readonly version?: string;
	readonly path?: string;
	/** The whole banner, for the panel — a version is a summary, not the evidence. */
	readonly banner?: string;
	/** Set when the tool could not be run at all. */
	readonly error?: string;
}

/**
 * `go version` prints one line: `go version go1.24.1 darwin/arm64`.
 * Measured on both toolchains present on this machine (1.24.1 and 1.23.4).
 */
export function parseGoVersion(stdout: string): { version: string; platform: string } | undefined {
	const match = /^go version (go\d[\w.+-]*)\s+(\S+)/m.exec(stdout);
	return match ? { version: match[1], platform: match[2] } : undefined;
}

/**
 * `gopls version` prints `golang.org/x/tools/gopls v0.20.0`, sometimes followed
 * by a build-info block. Measured against the installed v0.20.0.
 */
export function parseGoplsVersion(stdout: string): string | undefined {
	const match = /gopls\s+(v\d[\w.+-]*)/.exec(stdout);
	return match ? match[1] : undefined;
}

/**
 * `dlv version` prints a THREE-LINE banner whose version is on the second line:
 *
 *   Delve Debugger
 *   Version: 1.25.2
 *   Build: $Id: af3df2… $
 *
 * A first-line match — the obvious implementation, and the one every other tool
 * here rewards — finds nothing at all.
 */
export function parseDlvVersion(stdout: string): string | undefined {
	const match = /^Version:\s*(\S+)/m.exec(stdout);
	return match ? `v${match[1].replace(/^v/, '')}` : undefined;
}

/** `staticcheck --version` prints `staticcheck 2025.1.1 (0.6.1)`. */
export function parseStaticcheckVersion(stdout: string): string | undefined {
	const match = /^staticcheck\s+(\S+)/m.exec(stdout);
	return match ? match[1] : undefined;
}

export function parseVersion(id: ToolId, stdout: string): string | undefined {
	switch (id) {
		case 'go': return parseGoVersion(stdout)?.version;
		case 'gopls': return parseGoplsVersion(stdout);
		case 'dlv': return parseDlvVersion(stdout);
		case 'staticcheck': return parseStaticcheckVersion(stdout);
		default: return undefined;
	}
}

/** `go1.24.1` → `1.24`. Returns undefined for anything that is not a Go version. */
export function goMinor(goVersion: string | undefined): string | undefined {
	if (!goVersion) {
		return undefined;
	}
	const match = /^go(\d+)\.(\d+)/.exec(goVersion.trim());
	return match ? `${match[1]}.${match[2]}` : undefined;
}

/**
 * The tool versions that go with a given Go minor.
 *
 * THIS TABLE IS THE WHOLE POINT OF THE DOCTOR, and every row has a provenance:
 *
 *   1.26  gopls v0.22.0 — task-03-plan.md: "gopls v0.22.0 needs go 1.26"
 *   1.25  gopls v0.21.1, dlv v1.27.0 — the repo's own recorded pin invariant
 *   1.24  gopls v0.20.0, dlv v1.25.2 — measured working on this machine
 *
 * `@latest` is NEVER produced, and that is not stylistic. A gopls whose go.mod
 * requires a Go newer than the host resolves the toolchain, fails to build, and
 * reports it as an error about a module the reader never asked for. The
 * corresponding install always carries `GOTOOLCHAIN=local` so `go install`
 * cannot quietly download a different Go to satisfy the tool it is building.
 *
 * A Go minor with no row gets NO install command. Guessing a version here is
 * exactly the failure the table exists to prevent, so an unknown minor is
 * reported as unknown.
 */
export interface ToolPins {
	readonly gopls?: string;
	readonly dlv?: string;
}

const PINS: Readonly<Record<string, ToolPins>> = {
	'1.26': { gopls: 'v0.22.0' },
	'1.25': { gopls: 'v0.21.1', dlv: 'v1.27.0' },
	'1.24': { gopls: 'v0.20.0', dlv: 'v1.25.2' },
};

export function pinsFor(minor: string | undefined): ToolPins {
	return (minor && PINS[minor]) || {};
}

/** The module path `go install` wants for each tool. */
const MODULE_PATHS: Readonly<Record<string, string>> = {
	gopls: 'golang.org/x/tools/gopls',
	dlv: 'github.com/go-delve/delve/cmd/dlv',
	staticcheck: 'honnef.co/go/tools/cmd/staticcheck',
};

export interface InstallPlan {
	readonly command: string;
	readonly env: Readonly<Record<string, string>>;
}

/**
 * The command that installs `id` for a host running `goVersion`, or a reason it
 * cannot be produced.
 *
 * staticcheck is deliberately unpinned-but-not-`@latest`-free: it is optional, it
 * has no recorded pin, and its own release policy tracks the two most recent Go
 * releases. It is the one tool where `@latest` is the honest answer, and it says
 * so rather than pretending the table covers it.
 */
export function installPlan(id: ToolId, goVersion: string | undefined): InstallPlan | { reason: string } {
	if (id === 'go') {
		return { reason: 'Go itself is not installed by Go. Install it from go.dev/dl or your package manager.' };
	}
	const modulePath = MODULE_PATHS[id];
	if (!modulePath) {
		return { reason: `Burrow does not know how to install ${id}.` };
	}
	const env = { GOTOOLCHAIN: 'local' } as const;
	if (id === 'staticcheck') {
		return { command: `go install ${modulePath}@latest`, env };
	}
	const minor = goMinor(goVersion);
	if (!minor) {
		return { reason: 'Go is not installed, so there is no Go minor to match a tool version to.' };
	}
	const pin = (pinsFor(minor) as Record<string, string | undefined>)[id];
	if (!pin) {
		return {
			reason: `Burrow has no recorded ${id} pin for Go ${minor}. `
				+ `Installing @latest could pull a version whose go.mod outruns this toolchain, which fails inside \`go install\` `
				+ `with an error about a module you never asked for — so no command is offered rather than a guess.`,
		};
	}
	return { command: `go install ${modulePath}@${pin}`, env };
}

/** True when the plan is an actual command rather than a refusal. */
export function isInstallable(plan: InstallPlan | { reason: string }): plan is InstallPlan {
	return (plan as InstallPlan).command !== undefined;
}

/** The argv that asks a tool its version. */
export function versionArgs(id: ToolId): string[] {
	return id === 'staticcheck' ? ['--version'] : ['version'];
}

// --- the summary the status bar shows --------------------------------------

export interface ToolchainSummary {
	/** `go 1.24 · gopls ok · dlv ok`, or what is wrong instead. */
	readonly text: string;
	readonly healthy: boolean;
	/** The tools that are required and absent. */
	readonly missing: readonly ToolId[];
}

/**
 * One line for the status bar.
 *
 * Names what is MISSING when anything is, and only falls back to the reassuring
 * form when nothing is. A bar that reads `go 1.24 · gopls ok · dlv ok` while dlv
 * is absent is worse than no bar: it is a claim.
 */
export function summarise(statuses: readonly ToolStatus[]): ToolchainSummary {
	const by = new Map(statuses.map((s) => [s.id, s]));
	const missing = TOOLS.filter((t) => t.required && !by.get(t.id)?.version).map((t) => t.id);
	if (missing.length) {
		return { text: `${missing.join(' + ')} missing`, healthy: false, missing };
	}
	const minor = goMinor(by.get('go')?.version);
	return {
		text: `go ${minor ?? '?'} · gopls ok · dlv ok`,
		healthy: true,
		missing: [],
	};
}
