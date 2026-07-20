/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// query.ts — the query-layer boundary for the Postgres explorer (architecture
// task 10.1). The catalog tree and the results grid depend only on the
// `QueryClient` INTERFACE, never on a concrete driver — so the pure layers stay
// unit-testable against a fake, and swapping the driver (or a future dialect)
// touches only this file. `PgQueryClient` is the real implementation; it requires
// the `pg` package LAZILY (inside a method, not a top-level import) so the
// extension compiles and its tree/grid logic runs even in a build where `pg` is
// not yet vendored — the one place the slice degrades, and it degrades loudly.
//
// This module imports nothing from 'vscode'.

/** A result column, mirroring the subset of `pg`'s `FieldDef` we render. */
export interface QueryField {
	readonly name: string;
	/** Postgres OID of the column type (0 when unknown); drives type-aware cells. */
	readonly dataTypeID: number;
}

/** A completed query — rows keyed by column name, in field order. */
export interface QueryResult {
	readonly fields: readonly QueryField[];
	readonly rows: ReadonlyArray<Record<string, unknown>>;
}

/** The one capability the explorer needs from a database: run parameterized SQL. */
export interface QueryClient {
	/** Run `text` with optional `$1..$n` parameters and resolve the full result. */
	query(text: string, params?: readonly unknown[]): Promise<QueryResult>;
	/** Close the underlying connection; idempotent. */
	end(): Promise<void>;
}

// ---- the real `pg`-backed client -------------------------------------------

/** The slice of `pg.Client` we use — declared locally so we never import `pg` at compile time. */
interface PgClientLike {
	connect(): Promise<void>;
	query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; fields: { name: string; dataTypeID: number }[] }>;
	end(): Promise<void>;
}

interface PgClientConfig {
	readonly connectionString: string;
	readonly ssl?: { readonly rejectUnauthorized: boolean };
	readonly options?: string;
	readonly application_name?: string;
}

interface PgModule {
	readonly Client: new (config: PgClientConfig) => PgClientLike;
}

/**
 * A {@link QueryClient} backed by the `pg` driver, opened lazily on first query.
 * Sessions default to `default_transaction_read_only=on` (architecture task 10:
 * "Read-only by default … writes are a deliberate act, never a mis-click"); the
 * write toggle that lifts it is a later slice.
 */
export class PgQueryClient implements QueryClient {

	private client: PgClientLike | undefined;
	private opening: Promise<PgClientLike> | undefined;

	constructor(private readonly connectionString: string, private readonly ssl: boolean) { }

	/**
	 * Run a query, opening the connection on first use. Concurrent first calls
	 * share one `connect()` rather than racing two sockets open.
	 */
	async query(text: string, params?: readonly unknown[]): Promise<QueryResult> {
		const client = await this.ensureOpen();
		const result = await client.query(text, params);
		return { fields: result.fields ?? [], rows: result.rows ?? [] };
	}

	/** Close the connection if it was ever opened. Safe to call more than once. */
	async end(): Promise<void> {
		const client = this.client;
		this.client = undefined;
		this.opening = undefined;
		if (client) {
			await client.end();
		}
	}

	private async ensureOpen(): Promise<PgClientLike> {
		if (this.client) {
			return this.client;
		}
		if (!this.opening) {
			this.opening = this.open();
		}
		this.client = await this.opening;
		return this.client;
	}

	private async open(): Promise<PgClientLike> {
		const pg = loadPgModule();
		const client = new pg.Client({
			connectionString: this.connectionString,
			// verify-full is a later slice; accept the server cert so `sslmode=require` connects.
			ssl: this.ssl ? { rejectUnauthorized: false } : undefined,
			// Read-only default (task 10) — set on the session at connect time.
			options: '-c default_transaction_read_only=on',
			application_name: 'burrow-db',
		});
		await client.connect();
		return client;
	}
}

/**
 * Resolve the `pg` module at runtime. Kept out of the import graph so a build
 * without `pg` still compiles and runs everything that does not touch a live
 * database; the failure here is explicit and points at the fix.
 */
function loadPgModule(): PgModule {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require('pg') as PgModule;
	} catch {
		throw new Error("The 'pg' driver is not installed in this build. Add `pg` to the extension host to enable live Postgres connections.");
	}
}
