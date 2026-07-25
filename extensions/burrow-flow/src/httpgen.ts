/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// httpgen.ts — the Route Runner generator: renders the traced route catalog
// into a burrow-http .http file with editable defaults. Pure (no 'vscode') so
// the node test drives it directly.
//
// The generated file is grouped by domain; every request interpolates
// {{baseUrl}} and {{param}} variables whose values live in a user-overrides
// region that SURVIVES regeneration — edit defaults there, refresh freely.
// POST/PUT/PATCH bodies are JSON skeletons derived from the oracle contract
// type matching the route's entity (required fields only, zero-ish values).

import { Flow, groupFlows, handlerOf } from './model';
import type { SeedProfile } from './seedProfile';

export const OVERRIDES_START = '### user-overrides — values below survive regeneration; edit freely';
export const OVERRIDES_END = '### end-user-overrides';

/** Parse the digest's ```contract fence into TypeName → field-spec string. */
export function parseContractFence(digestMd: string): Map<string, string> {
	const contract = new Map<string, string>();
	let inFence = false;
	for (const rawLine of digestMd.split('\n')) {
		const line = rawLine.trimEnd();
		if (line.startsWith('```')) {
			inFence = line.slice(3).trim() === 'contract';
			continue;
		}
		if (!inFence) {
			continue;
		}
		const m = /^(?<name>[A-Za-z][A-Za-z0-9_]*): (?<fields>.+)$/.exec(line);
		if (m?.groups) {
			contract.set(m.groups.name, m.groups.fields);
		}
	}
	return contract;
}

interface ContractField {
	readonly name: string;
	readonly optional: boolean; // `?` — json omitempty
	readonly nullable: boolean; // `*` — pointer
	readonly type: string;
}

export function parseFields(spec: string): ContractField[] {
	const fields: ContractField[] = [];
	for (const token of spec.split(' ')) {
		const m = /^(?<name>[A-Za-z0-9_]+)(?<mark>\?\*|\?|\*|:)(?<type>.+)$/.exec(token);
		if (!m?.groups) {
			continue;
		}
		fields.push({
			name: m.groups.name,
			optional: m.groups.mark.includes('?'),
			nullable: m.groups.mark.includes('*'),
			type: m.groups.type,
		});
	}
	return fields;
}

/** The target's own example for this field, if its seed profile has one:
 *  the per-type entry first (Node.name), then the global field name. */
function seededValue(field: ContractField, seed?: SeedProfile, typeName?: string): unknown {
	const typed = typeName ? seed?.types[typeName] : undefined;
	if (typed && Object.prototype.hasOwnProperty.call(typed, field.name)) {
		return typed[field.name];
	}
	if (seed && Object.prototype.hasOwnProperty.call(seed.fields, field.name)) {
		return seed.fields[field.name];
	}
	return undefined;
}

function exampleValue(field: ContractField, seed?: SeedProfile, typeName?: string): string {
	const seeded = seededValue(field, seed, typeName);
	if (seeded !== undefined) {
		// The profile speaks JSON, so its value goes in as JSON — a seeded
		// number stays a number, a seeded object stays an object.
		return JSON.stringify(seeded);
	}
	const t = field.type;
	if (t.startsWith('[]')) {
		return '[]';
	}
	if (t.startsWith('map[')) {
		return '{}';
	}
	switch (t) {
		case 'string':
			return field.name === 'id' ? '"{{id}}"' : `"${field.name.replace(/_/g, '-')}"`;
		case 'bool':
			return 'false';
		case 'int': case 'int64': case 'int32': case 'float64': case 'float32':
			return '0';
		case 'time.Time':
			return '"2026-01-01T00:00:00Z"';
		default:
			return field.nullable ? 'null' : '{}';
	}
}

/** JSON skeleton for a contract type: required fields only, server-set ones dropped. */
export function bodySkeleton(spec: string, seed?: SeedProfile, typeName?: string): string {
	const serverSet = new Set(['id', 'created_at', 'updated_at', 'api_key']);
	const fields = parseFields(spec).filter(f => !f.optional && !serverSet.has(f.name));
	if (!fields.length) {
		return '{}';
	}
	const lines = fields.map(f => `\t"${f.name}": ${exampleValue(f, seed, typeName)}`);
	return `{\n${lines.join(',\n')}\n}`;
}

/** naive singular: nodes→node, dashboards→dashboard, policies→policy. */
function singular(word: string): string {
	if (word.endsWith('ies')) {
		return word.slice(0, -3) + 'y';
	}
	if (word.endsWith('s')) {
		return word.slice(0, -1);
	}
	return word;
}

/** Match a route to the contract type of its entity (POST /api/nodes → Node). */
export function typeForRoute(routePath: string, contractNames: Iterable<string>): string | undefined {
	const m = /^\/api\/(?<domain>[^/]+)/.exec(routePath);
	if (!m?.groups) {
		return undefined;
	}
	const want = singular(m.groups.domain).toLowerCase().replace(/-/g, '');
	for (const name of contractNames) {
		if (name.toLowerCase() === want) {
			return name;
		}
	}
	return undefined;
}

/** Path params referenced by a route: /api/nodes/{id} → ['id']. */
export function pathParams(routePath: string): string[] {
	return [...routePath.matchAll(/\{(?<param>[^}]+)\}/g)].map(m => m.groups!.param);
}

/** Pull the preserved user-overrides region out of a previously generated file. */
export function extractOverrides(existing: string): string[] {
	const start = existing.indexOf(OVERRIDES_START);
	const end = existing.indexOf(OVERRIDES_END);
	if (start < 0 || end < 0 || end <= start) {
		return [];
	}
	return existing
		.slice(start + OVERRIDES_START.length, end)
		.split('\n')
		.map(line => line.trimEnd())
		.filter(line => line.startsWith('@'));
}

export interface HttpGenOptions {
	readonly flows: Flow[];
	readonly contract: Map<string, string>;
	readonly baseUrl: string;
	readonly authOn: boolean;
	readonly rev: string;
	/** Content of the previously generated file, for override preservation. */
	readonly existing?: string;
	/** The target project's seed profile, when it has one: realistic values for
	 *  path params and body fields, so a generated request is sendable as-is. */
	readonly seed?: SeedProfile;
}

export function generateHttp(options: HttpGenOptions): string {
	const overrides = options.existing ? extractOverrides(options.existing) : [];
	const defined = new Set(overrides.map(line => line.split('=')[0].replace('@', '').trim()));

	const wanted = new Map<string, string>(); // var → default
	if (!defined.has('baseUrl')) {
		wanted.set('baseUrl', options.baseUrl);
	}
	if (options.authOn && !defined.has('bearer')) {
		wanted.set('bearer', '<paste-access-token>');
	}
	for (const flow of options.flows) {
		for (const param of pathParams(flow.path)) {
			if (!defined.has(param) && !wanted.has(param)) {
				// A seeded id points at a row that actually exists, so the very
				// first Send returns 200 instead of 404.
				wanted.set(param, options.seed?.params[param] ?? '1');
			}
		}
	}

	const lines: string[] = [
		'# api.generated.http — the route catalog traced by burrow-flow (flowscan',
		`# @ ${options.rev}, ${options.flows.length} routes). Regenerate with "API Flows: Generate`,
		'# Route Runner File" — everything OUTSIDE the user-overrides region is',
		'# rewritten. Send requests with the burrow-http codelens.',
		'',
		OVERRIDES_START,
		...overrides,
		...[...wanted.entries()].map(([name, value]) => `@${name} = ${value}`),
		OVERRIDES_END,
		'',
	];

	for (const [domain, flows] of groupFlows(options.flows)) {
		lines.push(`## ${domain}`);
		lines.push('');
		for (const flow of flows) {
			if (flow.method === '*') {
				continue; // mounts — not directly sendable
			}
			const handler = handlerOf(flow);
			const tables = flow.tables?.length ? ` · ▤ ${flow.tables.join(', ')}` : '';
			lines.push(`### ${flow.method} ${flow.path} — ${handler?.label ?? '?'} [${flow.file}:${flow.line}]${tables}`);
			const mwLabels = (flow.middleware ?? []).map(mw => mw.label);
			if (mwLabels.some(label => label.includes('APIKey'))) {
				lines.push('# agent ingest route — API-key/HMAC auth (see the target project\'s emitters)');
			}
			const urlPath = flow.path.replace(/\{(?<param>[^}]+)\}/g, (_s, param: string) => `{{${param}}}`);
			lines.push(`${flow.method} {{baseUrl}}${urlPath}`);
			const needsAuth = options.authOn && mwLabels.some(label => label.includes('JWT'));
			if (needsAuth) {
				lines.push('Authorization: Bearer {{bearer}}');
			}
			if (flow.method === 'POST' || flow.method === 'PUT' || flow.method === 'PATCH') {
				lines.push('Content-Type: application/json');
				lines.push('');
				const typeName = typeForRoute(flow.path, options.contract.keys());
				const spec = typeName ? options.contract.get(typeName) : undefined;
				lines.push(spec ? bodySkeleton(spec, options.seed, typeName) : '{}');
			}
			lines.push('');
		}
	}
	return lines.join('\n');
}
