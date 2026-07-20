/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// grid.ts — query-result → grid model (architecture task 10.3 "Data grid core",
// first cut). Pure over a `QueryClient`: it turns a `QueryResult` into a wire
// model of type-classified cells the webview paints, with a hard row cap so a
// forgotten LIMIT can't ship a million rows over postMessage. Type-aware cell
// formatting (NULL vs empty string, JSON, timestamps, bytea) is the seed of the
// "pandas feel"; keyset windowing + filter chips are later slices. No 'vscode'
// import — the formatting and capping are unit-tested directly.

import { QueryClient, QueryResult } from './query';

/** How a cell classifies — drives the column-agnostic cell styling in the webview. */
export type CellKind = 'null' | 'number' | 'bool' | 'json' | 'date' | 'bytes' | 'string';

/** A rendered cell: display text plus its kind. */
export interface Cell {
	readonly text: string;
	readonly kind: CellKind;
}

/** The grid the webview renders — columns, capped rows, and the honest total. */
export interface GridModel {
	readonly columns: readonly string[];
	readonly rows: ReadonlyArray<readonly Cell[]>;
	/** Total rows the query returned (may exceed `rows.length` when capped). */
	readonly rowCount: number;
	/** True when `rows` is a prefix of the full result. */
	readonly truncated: boolean;
}

/** Ceiling on rows sent to the webview — a big result scrolls the window, not the wire. */
export const MAX_GRID_ROWS = 1000;

/**
 * Classify and stringify one value from a result row. The distinctions matter
 * for reading data: SQL `NULL` must never look like an empty string, JSON/array
 * values are shown as compact JSON, timestamps as ISO, and `bytea` as `\x…` hex.
 */
export function formatCell(value: unknown): Cell {
	if (value === null || value === undefined) {
		return { text: 'NULL', kind: 'null' };
	}
	if (typeof value === 'boolean') {
		return { text: value ? 'true' : 'false', kind: 'bool' };
	}
	if (typeof value === 'number' || typeof value === 'bigint') {
		return { text: String(value), kind: 'number' };
	}
	if (typeof value === 'string') {
		return { text: value, kind: 'string' };
	}
	if (value instanceof Date) {
		return { text: value.toISOString(), kind: 'date' };
	}
	if (value instanceof Uint8Array) {
		return { text: '\\x' + Buffer.from(value).toString('hex'), kind: 'bytes' };
	}
	// Objects and arrays (json/jsonb, composite types) → compact JSON.
	return { text: safeJson(value), kind: 'json' };
}

/**
 * Build the grid wire model from a query result, capping rows at `max`. Cells
 * are emitted in column (field) order so the webview never has to re-key.
 */
export function toGrid(result: QueryResult, max = MAX_GRID_ROWS): GridModel {
	const columns = result.fields.map(field => field.name);
	const limited = result.rows.slice(0, Math.max(0, max));
	const rows = limited.map(row => columns.map(column => formatCell(row[column])));
	return {
		columns,
		rows,
		rowCount: result.rows.length,
		truncated: result.rows.length > limited.length,
	};
}

/** Run a SELECT and return its grid model — the explorer's one real round trip. */
export async function runSelect(client: QueryClient, sql: string, max = MAX_GRID_ROWS): Promise<GridModel> {
	return toGrid(await client.query(sql), max);
}

/** `JSON.stringify` that never throws (cyclic/BigInt values fall back to `String`). */
function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, (_key, val) => (typeof val === 'bigint' ? val.toString() : val));
	} catch {
		return String(value);
	}
}
