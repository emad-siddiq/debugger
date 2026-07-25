/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// toggles.ts — the Debug Config toggle manifest: which checkboxes exist, what
// each does (env vars into the dlv launch, or seed processes to run), and how
// enabled state folds into an env patch. The manifest is DATA, not code —
// a project overrides the built-in default by shipping
// `.vscode/debug-toggles.json`, which keeps the panel target-project-agnostic.
// No 'vscode' import: everything here is unit-tested with plain node.

export interface ToggleProcess {
	readonly name: string;
	readonly command: string;
	readonly args: readonly string[];
	/** Working directory, relative to the project root. */
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
}

export interface Toggle {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	/** Env vars set on the backend debug session while the toggle is ON. */
	readonly env?: Readonly<Record<string, string>>;
	/** Child processes kept running while the toggle is ON (seed traffic etc.). */
	readonly processes?: readonly ToggleProcess[];
	readonly default?: boolean;
}

export interface ToggleManifest {
	readonly toggles: readonly Toggle[];
}

/**
 * The built-in manifest — the nodewatch (merkle) mapping. `skipAuth` doubles as
 * the auth signal for burrow-flow's Route Runner generation.
 */
export const DEFAULT_MANIFEST: ToggleManifest = {
	toggles: [
		{
			id: 'skipAuth',
			label: 'Skip auth',
			description: 'Auth0 JWT bypass: requests need no token, org falls back to the seeded default (NODEWATCH_DEV_NO_AUTH).',
			env: { NODEWATCH_DEV_NO_AUTH: '1', NODEWATCH_SIGNUP_MODE: 'open' },
			default: true,
		},
		{
			id: 'seedMode',
			label: 'Seed mode',
			description: 'Run the Python emitters against the live backend so real metric rows land in Postgres.',
			processes: [
				{ name: 'eth-emitter', command: 'python3', args: ['eth_emitter.py'], cwd: 'emitters', env: { API_KEY: 'test-key-eth', API_URL: 'http://localhost:8080', NODE_NAME: 'eth-validator-01' } },
				{ name: 'sol-emitter', command: 'python3', args: ['sol_emitter.py'], cwd: 'emitters', env: { API_KEY: 'test-key-sol', API_URL: 'http://localhost:8080', NODE_NAME: 'sol-validator-01' } },
			],
			default: false,
		},
		{
			id: 'readOnly',
			label: 'Read-only API',
			description: 'Mutating endpoints refuse (NODEWATCH_READ_ONLY).',
			env: { NODEWATCH_READ_ONLY: '1' },
			default: false,
		},
		{
			id: 'debugEmit',
			label: 'Debug emit routes',
			description: 'Mount the synthetic /debug/emit endpoints (NODEWATCH_DEBUG_EMIT — never in prod).',
			env: { NODEWATCH_DEBUG_EMIT: '1' },
			default: false,
		},
	],
};

/** Parse a project's debug-toggles.json; throws with a pointed message on shape errors. */
export function parseManifest(jsonText: string): ToggleManifest {
	const doc = JSON.parse(jsonText) as { toggles?: unknown };
	if (!Array.isArray(doc.toggles)) {
		throw new Error('debug-toggles.json: expected a top-level "toggles" array');
	}
	for (const toggle of doc.toggles as Toggle[]) {
		if (!toggle.id || !toggle.label) {
			throw new Error('debug-toggles.json: every toggle needs "id" and "label"');
		}
	}
	return doc as ToggleManifest;
}

/** Effective on/off per toggle: stored state where present, manifest default otherwise. */
export function effectiveState(manifest: ToggleManifest, stored: Readonly<Record<string, boolean>>): Record<string, boolean> {
	const state: Record<string, boolean> = {};
	for (const toggle of manifest.toggles) {
		state[toggle.id] = stored[toggle.id] ?? toggle.default ?? false;
	}
	return state;
}

/**
 * Fold the enabled toggles into an env patch for the debug session. Vars owned
 * by a toggle that is OFF map to `undefined` — the caller deletes them, so the
 * panel is authoritative for its declared vars even when a launch config also
 * sets them.
 */
export function envPatch(manifest: ToggleManifest, state: Readonly<Record<string, boolean>>): Record<string, string | undefined> {
	const patch: Record<string, string | undefined> = {};
	for (const toggle of manifest.toggles) {
		for (const [name, value] of Object.entries(toggle.env ?? {})) {
			patch[name] = state[toggle.id] ? value : patch[name];
			if (!state[toggle.id] && !(name in patch && patch[name] !== undefined)) {
				patch[name] = undefined;
			}
		}
	}
	return patch;
}

/** The seed processes that should be running for the given state. */
export function activeProcesses(manifest: ToggleManifest, state: Readonly<Record<string, boolean>>): ToggleProcess[] {
	const processes: ToggleProcess[] = [];
	for (const toggle of manifest.toggles) {
		if (state[toggle.id]) {
			processes.push(...(toggle.processes ?? []));
		}
	}
	return processes;
}
