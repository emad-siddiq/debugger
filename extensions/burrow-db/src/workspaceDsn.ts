/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// workspaceDsn.ts — discover a Postgres DATABASE_URL from the workspace itself,
// so the DB explorer connects with zero configuration in repos that already
// document their local database (merkle installs it in .vscode/launch.json's Go
// debug configs, both inline and via infra/test/env/*.env). Third in the
// precedence chain: setting → process env → THIS. Read-on-demand and best-effort:
// any parse/read failure just means "no workspace fallback".

import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join } from 'path';

/** Strip line/block comments + trailing commas so VS Code's JSONC parses as JSON. */
export function stripJsonComments(text: string): string {
	let out = '';
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (inString) {
			out += ch;
			if (ch === '\\') { out += next ?? ''; i++; }
			else if (ch === '"') { inString = false; }
			continue;
		}
		if (ch === '"') { inString = true; out += ch; continue; }
		if (ch === '/' && next === '/') {
			while (i < text.length && text[i] !== '\n') { i++; }
			out += '\n';
			continue;
		}
		if (ch === '/' && next === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { i++; }
			i++;
			continue;
		}
		out += ch;
	}
	// Trailing commas before } or ] (valid JSONC, invalid JSON).
	return out.replace(/,\s*([}\]])/g, '$1');
}

/** Parse KEY=VALUE lines (with optional `export`, quotes, # comments). */
export function parseEnvFileForKey(text: string, key: string): string | undefined {
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const m = /^(?:export\s+)?(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*)$/.exec(line);
		if (!m?.groups || m.groups.name !== key) {
			continue;
		}
		let value = m.groups.value.trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
			value = value.slice(1, -1);
		}
		return value || undefined;
	}
	return undefined;
}

interface LaunchConfigLike {
	readonly env?: Record<string, unknown>;
	readonly envFile?: unknown;
}

/**
 * The first `DATABASE_URL` found in `<workspaceFolder>/.vscode/launch.json`:
 * inline `env` blocks win over `envFile`s, in configuration order.
 * `${workspaceFolder}` in envFile paths is resolved; anything unreadable is
 * skipped. Returns undefined when nothing is found.
 */
export function findWorkspaceDatabaseUrl(workspaceFolder: string | undefined): string | undefined {
	if (!workspaceFolder) {
		return undefined;
	}
	const launchPath = join(workspaceFolder, '.vscode', 'launch.json');
	let configs: LaunchConfigLike[];
	try {
		const parsed = JSON.parse(stripJsonComments(readFileSync(launchPath, 'utf8')));
		configs = Array.isArray(parsed?.configurations) ? parsed.configurations : [];
	} catch {
		return undefined;
	}
	for (const config of configs) {
		const inline = config?.env?.['DATABASE_URL'];
		if (typeof inline === 'string' && inline.trim()) {
			return inline.trim();
		}
	}
	for (const config of configs) {
		const files = Array.isArray(config?.envFile) ? config.envFile : [config?.envFile];
		for (const file of files) {
			if (typeof file !== 'string' || !file) {
				continue;
			}
			const resolved = file.replace(/\$\{workspaceFolder\}/g, workspaceFolder);
			const abs = isAbsolute(resolved) ? resolved : join(workspaceFolder, resolved);
			if (!existsSync(abs)) {
				continue;
			}
			try {
				const value = parseEnvFileForKey(readFileSync(abs, 'utf8'), 'DATABASE_URL');
				if (value) {
					return value;
				}
			} catch {
				// unreadable env file — keep looking
			}
		}
	}
	return undefined;
}
