/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Pure dotenv-style parsing + env merge for the `envFile` launch attribute.
// `dlv dap` honors `env` in the launch request but knows nothing about
// `envFile` (a vscode-go convenience), so Burrow merges the file(s) into `env`
// before launch. This module imports nothing from 'vscode' or 'fs' — the
// extension does the file I/O and hands the raw text in — so out/envfile.js is
// a clean CommonJS module the unit test can require directly (mirrors gopls.ts).

/**
 * Parses dotenv-style `KEY=VALUE` text into a plain map. Skips blank lines and
 * `#` comments, tolerates a leading `export `, requires a valid env identifier,
 * and strips one layer of matching single or double quotes from the value.
 * Duplicate keys follow shell semantics — last assignment wins.
 */
export function parseEnvFile(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
		const eq = body.indexOf('=');
		if (eq <= 0) {
			continue; // no key, or a leading `=` — nothing assignable
		}
		const key = body.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) {
			continue; // not a valid environment identifier
		}
		let value = body.slice(eq + 1).trim();
		const quote = value[0];
		if (value.length >= 2 && (quote === '"' || quote === '\'') && value[value.length - 1] === quote) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

/**
 * Merges parsed envFile maps under an inline `env` map. Precedence, lowest to
 * highest: earlier files < later files < inline `env` — an inline value always
 * wins over any file (merkle's launch.json documents "env above wins on
 * conflict"). Returns a fresh object; inputs are not mutated.
 */
export function mergeEnv(fileEnvs: Array<Record<string, string>>, inlineEnv?: Record<string, string>): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const fileEnv of fileEnvs) {
		Object.assign(merged, fileEnv);
	}
	if (inlineEnv) {
		Object.assign(merged, inlineEnv);
	}
	return merged;
}
