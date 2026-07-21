/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, commands, window, workspace } from 'vscode';
import { describeDsn, parsePostgresUrl, pickConnectionString } from './dsn';
import { PgQueryClient, QueryClient } from './query';
import { buildPreviewSql, loadSchemaTree } from './catalog';
import { runSelect } from './grid';
import { DbExplorerProvider, OPEN_TABLE_COMMAND } from './explorer';
import { GridPanel } from './panel';
import { PgAdmin } from './pgadmin';

// burrow-db — the Postgres explorer (architecture task 10). FIRST SLICE:
//   • Connection layer (dsn.ts + query.ts) — resolve a connection string from
//     `burrow.db.connectionString` or `DATABASE_URL`, open a read-only `pg`
//     session lazily. Keychain secrets + the write toggle are later slices.
//   • Catalog tree (catalog.ts + explorer.ts) — list schemas/tables/views via
//     information_schema; click a table to preview it.
//   • Results grid (grid.ts + panel.ts) — run a SELECT, render type-classified
//     cells in a webview; edit + re-run in place. Virtualized windowing, filter
//     chips, the ERD and the EXPLAIN visualizer are the remaining tasks (10.4–10.8).
// The pure layers (dsn/query/catalog/grid) carry no 'vscode' import and are
// unit-tested against a fake QueryClient; this file is the only wiring seam.

const CONFIG_SECTION = 'burrow.db';

export function activate(context: ExtensionContext): void {
	// One lazily-opened client, keyed by the connection string that produced it.
	// A settings change (or a swap to DATABASE_URL) reopens it on next use.
	let client: QueryClient | undefined;
	let clientKey: string | undefined;

	/** The effective connection string: setting first, then `DATABASE_URL`. */
	const connectionString = (): string | undefined => pickConnectionString({
		setting: workspace.getConfiguration(CONFIG_SECTION).get<string>('connectionString'),
		env: process.env.DATABASE_URL,
	});

	/** Resolve (opening if needed) the query client, or throw a directive error. */
	const getClient = async (): Promise<QueryClient> => {
		const conn = connectionString();
		if (!conn) {
			throw new Error('No Postgres connection configured. Set "burrow.db.connectionString" or the DATABASE_URL environment variable.');
		}
		if (client && clientKey === conn) {
			return client;
		}
		await closeClient();
		const dsn = parsePostgresUrl(conn);
		client = new PgQueryClient(dsn.connectionString, dsn.ssl);
		clientKey = conn;
		return client;
	};

	/** Close and forget the current client (connection change / deactivate). */
	const closeClient = async (): Promise<void> => {
		const open = client;
		client = undefined;
		clientKey = undefined;
		if (open) {
			await open.end().catch(() => undefined);
		}
	};

	const previewLimit = (): number => workspace.getConfiguration(CONFIG_SECTION).get<number>('previewRowLimit') ?? 100;

	// The grid panel's runner: resolve the client, run the SELECT, cap the rows.
	const runner = async (sql: string) => runSelect(await getClient(), sql);

	const explorer = new DbExplorerProvider(async () => loadSchemaTree(await getClient()));

	// The pgAdmin surface: a Burrow-managed pgAdmin container, provisioned from the
	// same connection the native explorer uses (setting → DATABASE_URL → prompt)
	// and embedded in a webview. Reaches the host-published db over the host.
	const pgAdmin = new PgAdmin(context.extensionPath);

	context.subscriptions.push(
		pgAdmin,
		window.registerTreeDataProvider('burrowDbExplorer', explorer),

		commands.registerCommand('burrow.db.openPgAdmin', () => pgAdmin.open()),
		commands.registerCommand('burrow.db.stopPgAdmin', () => pgAdmin.stop()),

		commands.registerCommand('burrow.db.refresh', () => explorer.refresh()),

		commands.registerCommand('burrow.db.runQuery', async () => {
			const conn = connectionString();
			const sql = await window.showInputBox({
				title: conn ? `Run SQL — ${describeDsn(parsePostgresUrl(conn))}` : 'Run SQL Query',
				value: 'SELECT 1',
				prompt: 'A read-only SELECT to run against the connected database.',
			});
			if (sql === undefined) {
				return;
			}
			await GridPanel.show(runner).runAndShow(sql);
		}),

		commands.registerCommand(OPEN_TABLE_COMMAND, async (schema: string, table: string) => {
			await GridPanel.show(runner).runAndShow(buildPreviewSql(schema, table, previewLimit()));
		}),

		// A connection-string change invalidates the open session and the tree.
		workspace.onDidChangeConfiguration(async event => {
			if (event.affectsConfiguration(`${CONFIG_SECTION}.connectionString`)) {
				await closeClient();
				explorer.refresh();
			}
		}),

		// End the session when the extension unloads (deactivate can't await).
		{ dispose: () => { void closeClient(); } },
	);

	// A one-time hint when nothing is configured, so the empty tree isn't a mystery.
	if (!connectionString()) {
		void window.setStatusBarMessage('Burrow DB: set burrow.db.connectionString or DATABASE_URL to connect.', 8000);
	}
}

export function deactivate(): void {
	// The client is closed by the disposable registered in `activate`
	// (context.subscriptions), which the host disposes on unload.
}
