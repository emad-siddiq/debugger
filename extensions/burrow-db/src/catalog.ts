/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// catalog.ts — schema introspection for the explorer tree (architecture task
// 10.2 "Catalog + tree"). Pure over a `QueryClient`: it owns the
// `information_schema` query, folds the flat result into schema→table groups,
// and safely quotes identifiers for the preview SELECT. pg_catalog/timescaledb
// introspection (indexes, FKs, hypertable badges) is a later slice; this first
// cut lists schemas, tables, views and matviews. No 'vscode' import, so the
// grouping + identifier quoting are unit-tested against a fake client.

import { QueryClient } from './query';

/**
 * List every user table/view/matview, ordered for a stable tree. `pg_catalog`
 * and `information_schema` are excluded — the explorer shows the user's schema,
 * not the server's plumbing. Matviews are absent from `information_schema.tables`,
 * so they are `UNION`ed in from `pg_matviews`.
 */
export const LIST_TABLES_SQL = `SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
UNION ALL
SELECT schemaname AS table_schema, matviewname AS table_name, 'MATERIALIZED VIEW' AS table_type
FROM pg_matviews
ORDER BY table_schema, table_name`;

/** The three shapes we badge differently in the tree. */
export type TableKind = 'table' | 'view' | 'matview';

/** One table/view/matview within a schema. */
export interface TableEntry {
	readonly schema: string;
	readonly name: string;
	readonly kind: TableKind;
}

/** A schema and its (already sorted) relations — one top-level tree node. */
export interface SchemaGroup {
	readonly schema: string;
	readonly tables: readonly TableEntry[];
}

/** Map `information_schema.table_type` (and our matview alias) to a {@link TableKind}. */
export function classifyTableType(tableType: string): TableKind {
	const t = tableType.toUpperCase();
	if (t === 'VIEW') {
		return 'view';
	}
	if (t === 'MATERIALIZED VIEW') {
		return 'matview';
	}
	return 'table';
}

/**
 * Fold flat `{table_schema, table_name, table_type}` rows into schema groups,
 * preserving the query's ordering (schemas and tables both already sorted).
 * Tolerant of loosely-typed rows — every field is coerced with `String()` so a
 * driver quirk can't crash the tree.
 */
export function buildSchemaTree(rows: ReadonlyArray<Record<string, unknown>>): readonly SchemaGroup[] {
	const groups = new Map<string, TableEntry[]>();
	const order: string[] = [];
	for (const row of rows) {
		const schema = String(row.table_schema ?? '');
		const name = String(row.table_name ?? '');
		if (!schema || !name) {
			continue;
		}
		let bucket = groups.get(schema);
		if (!bucket) {
			bucket = [];
			groups.set(schema, bucket);
			order.push(schema);
		}
		bucket.push({ schema, name, kind: classifyTableType(String(row.table_type ?? '')) });
	}
	return order.map(schema => ({ schema, tables: groups.get(schema)! }));
}

/** Run the introspection query and return the schema tree. */
export async function loadSchemaTree(client: QueryClient): Promise<readonly SchemaGroup[]> {
	const result = await client.query(LIST_TABLES_SQL);
	return buildSchemaTree(result.rows);
}

/**
 * Double-quote a Postgres identifier, escaping embedded quotes — so a schema or
 * table name can never break out of its position in generated SQL. `"a""b"` is
 * the correct encoding of the identifier `a"b`.
 */
export function quoteIdent(identifier: string): string {
	return '"' + identifier.replace(/"/g, '""') + '"';
}

/**
 * The read-only preview SELECT the tree opens for a table: every column, capped
 * to `limit` rows. Identifiers are quoted; the limit is clamped to a positive
 * integer so it is always a safe literal.
 */
export function buildPreviewSql(schema: string, table: string, limit = 100): string {
	const rows = Math.max(1, Math.floor(limit));
	return `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT ${rows}`;
}
