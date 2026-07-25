/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, QuickPickItem, StatusBarAlignment, commands, window, workspace } from 'vscode';
import { describeDsn, parsePostgresUrl, pickConnectionString } from './dsn';
import { findWorkspaceDatabaseUrl } from './workspaceDsn';
import { PgQueryClient, QueryClient } from './query';
import { StarterQuery, buildColumnsSql, buildPreviewSql, loadSchemaTree, starterQueries } from './catalog';
import { runSelect } from './grid';
import { DbExplorerProvider, OPEN_TABLE_COMMAND, tableEntryOf } from './explorer';
import { GridPanel } from './panel';
import { PgAdmin } from './pgadmin';
import { SeedAction, SeedProfile, loadSeedProfile } from './seedProfile';
import * as fs from 'fs';
import * as path from 'path';

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

/** The workspace root the target project lives in (first folder). */
function projectRoot(): string | undefined {
	return workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** The target's seed profile, if it ships one. Setting first, then convention. */
function seedProfile(): SeedProfile | undefined {
	const root = projectRoot();
	if (!root) {
		return undefined;
	}
	const configured = workspace.getConfiguration(CONFIG_SECTION).get<string>('seedProfile', '');
	return loadSeedProfile(root, configured || undefined);
}

export function activate(context: ExtensionContext): void {
	// One lazily-opened client, keyed by the connection string that produced it.
	// A settings change (or a swap to DATABASE_URL) reopens it on next use.
	let client: QueryClient | undefined;
	let clientKey: string | undefined;

	// Writes are a deliberate act, never a mis-click: sessions open read-only,
	// the toggle is session-scoped (never persisted) and shows a status pill.
	let allowWrites = false;

	/** The effective connection string: setting → DATABASE_URL env → the
	 *  workspace's own .vscode/launch.json (merkle documents its local Postgres
	 *  there), so the explorer connects with zero configuration. */
	const connectionString = (): string | undefined => pickConnectionString({
		setting: workspace.getConfiguration(CONFIG_SECTION).get<string>('connectionString'),
		env: process.env.DATABASE_URL,
		workspace: findWorkspaceDatabaseUrl(workspace.workspaceFolders?.[0]?.uri.fsPath),
	});

	/** Resolve (opening if needed) the query client, or throw a directive error. */
	const getClient = async (): Promise<QueryClient> => {
		const conn = connectionString();
		if (!conn) {
			throw new Error('No Postgres connection configured. Set "burrow.db.connectionString" or the DATABASE_URL environment variable.');
		}
		const key = `${conn}#${allowWrites ? 'rw' : 'ro'}`;
		if (client && clientKey === key) {
			return client;
		}
		await closeClient();
		const dsn = parsePostgresUrl(conn);
		client = new PgQueryClient(dsn.connectionString, dsn.ssl, !allowWrites);
		clientKey = key;
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

	// The connection row reports what the tree is actually pointed at and
	// whether this session may write (docs/plans/02 §3.6) — both read live, so
	// the row cannot drift from the client.
	const explorer = new DbExplorerProvider(
		async () => loadSchemaTree(await getClient()),
		() => {
			const conn = connectionString();
			return { label: conn ? describeDsn(parsePostgresUrl(conn)) : undefined, writes: allowWrites };
		},
	);

	// The pgAdmin surface: a Burrow-managed pgAdmin container, provisioned from the
	// same connection the native explorer uses (setting → DATABASE_URL → prompt)
	// and embedded in a webview. Reaches the host-published db over the host.
	const pgAdmin = new PgAdmin(context.extensionPath);

	// The session-writes pill: visible only while the guard is lifted.
	const writesPill = window.createStatusBarItem(StatusBarAlignment.Right, 90);
	writesPill.text = '$(unlock) DB writes ON';
	writesPill.tooltip = 'burrow-db session accepts writes — click to restore read-only.';
	writesPill.command = 'burrow.db.toggleWrites';

	/** Per-table saved starter queries, in workspace state. */
	const startersKey = (schema: string, table: string): string => `burrow.db.starters:${schema}.${table}`;

	context.subscriptions.push(
		pgAdmin,
		writesPill,
		window.registerTreeDataProvider('burrowDbExplorer', explorer),

		commands.registerCommand('burrow.db.openPgAdmin', () => pgAdmin.open()),
		commands.registerCommand('burrow.db.stopPgAdmin', () => pgAdmin.stop()),

		commands.registerCommand('burrow.db.refresh', () => explorer.refresh()),

		// Optionally prefilled (burrow-flow hands a traced statement straight in);
		// the input box still shows, so what runs is always what you saw.
		commands.registerCommand('burrow.db.runQuery', async (prefill?: unknown) => {
			const conn = connectionString();
			const sql = await window.showInputBox({
				title: conn ? `Run SQL — ${describeDsn(parsePostgresUrl(conn))}` : 'Run SQL Query',
				value: typeof prefill === 'string' && prefill ? prefill : 'SELECT 1',
				prompt: allowWrites ? 'Session accepts writes — statements run as given.' : 'A read-only SELECT to run against the connected database.',
			});
			if (sql === undefined) {
				return;
			}
			await GridPanel.show(runner).runAndShow(sql);
		}),

		// Two call shapes: (schema, table) from the tree, or a single "table"
		// (public schema implied) from other extensions (burrow-flow table nodes).
		commands.registerCommand(OPEN_TABLE_COMMAND, async (schemaOrTable: string, maybeTable?: string) => {
			const schema = maybeTable ? schemaOrTable : 'public';
			const table = maybeTable ?? schemaOrTable;
			await GridPanel.show(runner).runAndShow(buildPreviewSql(schema, table, previewLimit()));
		}),

		// Column metadata grid — the one-glance "how does my data look" panel.
		commands.registerCommand('burrow.db.tableInfo', async (node: unknown) => {
			const entry = tableEntryOf(node);
			if (entry) {
				await GridPanel.show(runner).runAndShow(buildColumnsSql(entry.schema, entry.name));
			}
		}),

		// Seeded + saved starter queries for a table; "New…" saves to workspace state.
		commands.registerCommand('burrow.db.starterQuery', async (node: unknown) => {
			const entry = tableEntryOf(node);
			if (!entry) {
				return;
			}
			const saved = context.workspaceState.get<StarterQuery[]>(startersKey(entry.schema, entry.name), []);
			const newItem: QuickPickItem = { label: '$(add) New starter query…', description: 'saved for this table in this workspace' };
			// The target's own queries first: they hit rows that actually exist,
			// which is what someone opening a table wants to see.
			const seeded = seedProfile()?.db?.tables?.[entry.name]?.queries ?? [];
			const picks: (QuickPickItem & { sql?: string })[] = [
				...seeded.map(q => ({ label: `$(database) ${q.label}`, description: 'seeded', detail: q.sql, sql: q.sql })),
				...starterQueries(entry.schema, entry.name, previewLimit()),
				...saved.map(s => ({ label: `$(bookmark) ${s.label}`, description: s.sql, sql: s.sql })),
				newItem,
			];
			const pick = await window.showQuickPick(picks, { title: `${entry.schema}.${entry.name} — starter queries`, matchOnDescription: true });
			if (!pick) {
				return;
			}
			if (pick === newItem) {
				const sql = await window.showInputBox({ title: `New starter query for ${entry.schema}.${entry.name}`, value: buildPreviewSql(entry.schema, entry.name, previewLimit()) });
				if (!sql) {
					return;
				}
				const label = await window.showInputBox({ title: 'Name this starter query', value: 'my query' });
				if (label) {
					await context.workspaceState.update(startersKey(entry.schema, entry.name), [...saved, { label, sql }]);
				}
				await GridPanel.show(runner).runAndShow(sql);
				return;
			}
			if (pick.sql) {
				await GridPanel.show(runner).runAndShow(pick.sql);
			}
		}),

		// Seed the DB — run the target's own seed actions. Two kinds, deliberately
		// treated differently: a `sqlFile` is OUR statement to run (so it goes
		// through the query client, gated by the writes toggle and a confirm),
		// while a `command` is the target's shell script — we only TYPE it into a
		// terminal. Burrow never auto-runs a script out of someone's repo.
		commands.registerCommand('burrow.db.seedWorld', async () => {
			const root = projectRoot();
			const actions = seedProfile()?.db?.seedActions ?? [];
			if (!root || !actions.length) {
				void window.showInformationMessage('No seed actions — the project has no infra/seed/seed.json, or its profile declares none.');
				return;
			}
			const picks = actions.map(a => ({
				label: `$(database) ${a.label}`,
				description: a.sqlFile ? `runs ${a.sqlFile}` : `types "${a.command}" into a terminal`,
				action: a as SeedAction,
			}));
			const pick = await window.showQuickPick(picks, { title: 'Seed the DB', matchOnDescription: true });
			if (!pick) {
				return;
			}
			const action = pick.action;

			if (action.command) {
				const term = window.createTerminal({
					name: `seed: ${action.label}`,
					cwd: action.cwd ? path.resolve(root, action.cwd) : root,
				});
				term.show();
				// Not executed — the user presses Enter. This is the whole point.
				term.sendText(action.command, false);
				return;
			}
			if (!action.sqlFile) {
				return;
			}
			if (!allowWrites) {
				void window.showWarningMessage('Seeding writes to the database — turn off the read-only guard first (Burrow DB: Toggle Writes).');
				return;
			}
			const file = path.resolve(root, action.sqlFile);
			let sql: string;
			try {
				sql = fs.readFileSync(file, 'utf8');
			} catch {
				void window.showErrorMessage(`Seed file not found: ${action.sqlFile}`);
				return;
			}
			const confirmed = await window.showWarningMessage(
				`Run "${action.label}" against ${describeDsn(parsePostgresUrl(connectionString() ?? ''))}? It writes to the database.`,
				{ modal: true, detail: `${action.sqlFile} — ${sql.split('\n').length} lines` },
				'Run Seed',
			);
			if (confirmed !== 'Run Seed') {
				return;
			}
			// psql meta-commands (\set, \i) are a psql feature, not SQL — strip
			// them so the statement the driver receives is one it can parse.
			const statements = sql.replace(/^\\.*$/gm, '');
			await GridPanel.show(runner).runAndShow(statements);
		}),

		// Session-scoped write guard: flips the session, never persists.
		commands.registerCommand('burrow.db.toggleWrites', async () => {
			if (!allowWrites) {
				const confirmed = await window.showWarningMessage(
					'Allow writes on this database session? The read-only guard stays off until toggled back (or the window reloads).',
					{ modal: true },
					'Allow Writes',
				);
				if (confirmed !== 'Allow Writes') {
					return;
				}
			}
			allowWrites = !allowWrites;
			await closeClient();
			// The connection row carries the lock, so it has to repaint with it.
			explorer.refresh();
			if (allowWrites) {
				writesPill.show();
			} else {
				writesPill.hide();
				void window.setStatusBarMessage('burrow-db: session back to read-only.', 4000);
			}
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
