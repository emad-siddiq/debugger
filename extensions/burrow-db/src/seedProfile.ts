/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// seedProfile.ts — reads the TARGET project's seed profile: what realistic data
// looks like in that codebase, so the Data view can offer queries against rows
// that actually exist instead of a generic "first 100 rows".
//
// Burrow stays target-agnostic: nothing about any particular project lives in
// this file. A project opts in by authoring infra/seed/seed.json (documented in
// the target repo); with no profile every consumer keeps its previous
// behaviour exactly.
//
// TWIN: extensions/burrow-flow/src/seedProfile.ts is a deliberate copy — the two
// extensions are decoupled by design and neither may import from the other.
// Change one, change the other.
//
// No 'vscode' import: the settings read belongs to the caller, so the node test
// can require this module directly.

import * as fs from 'fs';
import * as path from 'path';

export interface SeedTableQuery {
	readonly label: string;
	readonly sql: string;
}

export interface SeedAction {
	readonly label: string;
	/** SQL file, project-root-relative. Runs through the query client. */
	readonly sqlFile?: string;
	/** Shell command. Only ever TYPED INTO a terminal, never auto-run. */
	readonly command?: string;
	/** Working directory for `command`, project-root-relative. */
	readonly cwd?: string;
}

export interface SeedProfile {
	readonly version: 1;
	/** `{{param}}` defaults for path parameters: id, chain, orgId… */
	readonly params: Record<string, string>;
	/** Field name → example value, whatever the type. */
	readonly fields: Record<string, unknown>;
	/** Contract type → field → example value. Beats `fields`. */
	readonly types: Record<string, Record<string, unknown>>;
	readonly db?: {
		readonly tables?: Record<string, { queries: SeedTableQuery[] }>;
		readonly seedActions?: SeedAction[];
	};
}

/** The documented convention, relative to the project root. */
export const SEED_PROFILE_REL = path.join('infra', 'seed', 'seed.json');

function isRecord(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Parse + validate profile JSON. Pure, so the node test drives it directly.
 * Malformed input yields undefined rather than throwing: a broken profile must
 * degrade to "no profile", never break generation.
 */
export function parseSeedProfile(json: string): SeedProfile | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (!isRecord(raw) || raw.version !== 1) {
		return undefined;
	}
	const params: Record<string, string> = {};
	if (isRecord(raw.params)) {
		for (const [k, v] of Object.entries(raw.params)) {
			if (typeof v === 'string') {
				params[k] = v;
			}
		}
	}
	const types: Record<string, Record<string, unknown>> = {};
	if (isRecord(raw.types)) {
		for (const [name, fields] of Object.entries(raw.types)) {
			if (isRecord(fields)) {
				types[name] = fields;
			}
		}
	}
	return {
		version: 1,
		params,
		fields: isRecord(raw.fields) ? raw.fields : {},
		types,
		db: isRecord(raw.db) ? (raw.db as SeedProfile['db']) : undefined,
	};
}

/**
 * The profile for `projectRoot`, or undefined. Discovery order (identical in
 * the twin): the workspace setting's path, then the convention.
 */
export function loadSeedProfile(projectRoot: string, settingPath?: string): SeedProfile | undefined {
	const candidates = [
		settingPath ? (path.isAbsolute(settingPath) ? settingPath : path.join(projectRoot, settingPath)) : undefined,
		path.join(projectRoot, SEED_PROFILE_REL),
	].filter((p): p is string => !!p);

	for (const file of candidates) {
		try {
			return parseSeedProfile(fs.readFileSync(file, 'utf8')) ?? undefined;
		} catch {
			// missing / unreadable → try the next candidate
		}
	}
	return undefined;
}
