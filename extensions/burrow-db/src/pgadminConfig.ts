/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// pgadminConfig.ts — pure generation of pgAdmin's provisioning files from a Dsn
// (architecture task 10, the pgAdmin surface). pgAdmin runs in a container, so a
// connection whose host is the loopback-published database (localhost/127.0.0.1)
// is rewritten to `host.docker.internal` — the container reaches the host's
// published 5432 there, which is why no attachment to merkle's compose network
// is needed once the single db publishes its port. servers.json pre-registers
// the server; the password travels via a mounted pgpass file (PassFile), never
// inline in servers.json. This module imports nothing from 'vscode'/'fs', so the
// rewrite + file shapes are unit-tested directly.

import { Dsn } from './dsn';

/**
 * The host a pgAdmin container should dial for a given Dsn host. A loopback host
 * (the db published on the host) becomes `host.docker.internal`, the gateway a
 * Docker Desktop container uses to reach the host; anything else (a real
 * hostname / container name) is handed through unchanged.
 */
export function containerHost(host: string): string {
	return host === 'localhost' || host === '127.0.0.1' || host === '::1' ? 'host.docker.internal' : host;
}

/**
 * pgAdmin `servers.json` (import format) pre-registering the one merkle server,
 * password-free — the password is supplied by the mounted pgpass via `PassFile`.
 * Returns pretty JSON with a trailing newline.
 */
export function pgAdminServers(dsn: Dsn, name = 'NodeWatch (merkle)'): string {
	const server = {
		Name: name,
		Group: 'Burrow',
		Host: containerHost(dsn.host),
		Port: dsn.port,
		MaintenanceDB: dsn.database,
		Username: dsn.user ?? 'postgres',
		SSLMode: dsn.ssl ? 'require' : 'prefer',
		PassFile: '/pgpass',
	};
	return JSON.stringify({ Servers: { '1': server } }, null, 2) + '\n';
}

/**
 * A single pgpass line `host:port:database:user:password` matching the server in
 * {@link pgAdminServers} (same rewritten host), so pgAdmin connects without a
 * prompt. Uses `*` for a missing database/user so libpq still matches.
 */
export function pgAdminPassLine(dsn: Dsn): string {
	const host = containerHost(dsn.host);
	const database = dsn.database || '*';
	const user = dsn.user ?? 'postgres';
	const password = dsn.password ?? '';
	return `${host}:${dsn.port}:${database}:${user}:${password}\n`;
}
