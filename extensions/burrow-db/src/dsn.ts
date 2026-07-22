/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// dsn.ts — connection-string handling for the Postgres explorer (architecture
// task 10.1 "Connection layer"). Pure and synchronous: it parses a `postgres://`
// URL into the parts the driver needs, picks the effective string from the
// setting-then-env precedence the design mandates ("parse DATABASE_URL from the
// active scheme's env"), and redacts the password for anything user-visible. It
// imports nothing from 'vscode' or 'pg', so it is trivially unit-tested and the
// grid/tree layers can build on top without a live database.

/** The parts of a Postgres connection URL the driver + UI care about. */
export interface Dsn {
	readonly host: string;
	readonly port: number;
	readonly database: string;
	readonly user?: string;
	readonly password?: string;
	/** True when the URL asked for TLS (`sslmode=require|verify-*` or `ssl=true`). */
	readonly ssl: boolean;
	/** The original, un-redacted string — handed to the driver verbatim. */
	readonly connectionString: string;
}

/** The ordered sources a connection string can come from. */
export interface ConnectionSources {
	/** `burrow.db.connectionString` (workspace/user setting). */
	readonly setting?: string;
	/** `process.env.DATABASE_URL`. */
	readonly env?: string;
	/** `DATABASE_URL` discovered in the workspace's `.vscode/launch.json`
	 *  (env blocks / envFiles) — see workspaceDsn.ts. */
	readonly workspace?: string;
}

const POSTGRES_SCHEME = /^postgres(?:ql)?:\/\//i;

/**
 * Pick the effective connection string: an explicit setting wins, else the
 * environment's `DATABASE_URL`, else nothing. Whitespace-only values count as
 * absent so a blank setting cleanly falls through to the env fallback.
 */
export function pickConnectionString(sources: ConnectionSources): string | undefined {
	const setting = sources.setting?.trim();
	if (setting) {
		return setting;
	}
	const env = sources.env?.trim();
	if (env) {
		return env;
	}
	const ws = sources.workspace?.trim();
	if (ws) {
		return ws;
	}
	return undefined;
}

/**
 * Parse a `postgres://` / `postgresql://` URL into a {@link Dsn}. Missing parts
 * take libpq's defaults (localhost:5432, database `postgres`). Percent-encoded
 * user/password/host/database are decoded. Throws on a non-Postgres URL rather
 * than guessing.
 */
export function parsePostgresUrl(raw: string): Dsn {
	const trimmed = raw.trim();
	if (!POSTGRES_SCHEME.test(trimmed)) {
		throw new Error('Not a Postgres connection URL (expected postgres:// or postgresql://).');
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error('Malformed Postgres connection URL.');
	}
	const sslmode = url.searchParams.get('sslmode');
	const sslFlag = url.searchParams.get('ssl');
	const ssl = sslFlag === 'true' || (sslmode !== null && sslmode !== 'disable' && sslmode !== '');
	return {
		host: url.hostname ? decodeURIComponent(url.hostname) : 'localhost',
		port: url.port ? Number(url.port) : 5432,
		database: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
		user: url.username ? decodeURIComponent(url.username) : undefined,
		password: url.password ? decodeURIComponent(url.password) : undefined,
		ssl,
		connectionString: trimmed,
	};
}

/**
 * Mask the password in a connection string for logs, tree labels and error
 * messages. Returns the input unchanged if it does not parse as a URL — a
 * best-effort redaction never throws.
 */
export function redactPassword(raw: string): string {
	try {
		const url = new URL(raw.trim());
		if (url.password) {
			url.password = '***';
		}
		return url.toString();
	} catch {
		return raw;
	}
}

/** A short `user@host:port/database` label for the connection, password-free. */
export function describeDsn(dsn: Dsn): string {
	const authority = dsn.user ? `${dsn.user}@${dsn.host}` : dsn.host;
	return `${authority}:${dsn.port}/${dsn.database}`;
}
