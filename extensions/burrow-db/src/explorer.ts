/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// explorer.ts — the schema tree (architecture task 10.2). A TreeDataProvider two
// levels deep for the first slice: schemas → tables/views/matviews. Introspection
// is delegated to catalog.ts (pure); this file only maps the resulting groups to
// TreeItems and turns a table into an "open preview" command. A load failure
// (no connection, `pg` absent) surfaces as an inline message node rather than a
// silent empty tree.

import { EventEmitter, ThemeIcon, TreeDataProvider, TreeItem, TreeItemCollapsibleState } from 'vscode';
import { SchemaGroup, TableEntry, TableKind } from './catalog';

/** The command a table row runs to open its preview grid. */
export const OPEN_TABLE_COMMAND = 'burrow.db.openTable';

/** A schema branch, a table/view/matview leaf, or an inline status message. */
type DbNode =
	| { readonly kind: 'schema'; readonly schema: string; readonly tables: readonly TableEntry[] }
	| { readonly kind: 'table'; readonly entry: TableEntry }
	| { readonly kind: 'message'; readonly text: string };

/** Loads the schema tree on demand — injected so the provider stays connection-agnostic. */
export type SchemaTreeLoader = () => Promise<readonly SchemaGroup[]>;

const TABLE_ICON: Record<TableKind, ThemeIcon> = {
	table: new ThemeIcon('table'),
	view: new ThemeIcon('eye'),
	matview: new ThemeIcon('layers'),
};

export class DbExplorerProvider implements TreeDataProvider<DbNode> {

	private readonly changed = new EventEmitter<DbNode | undefined>();
	readonly onDidChangeTreeData = this.changed.event;

	constructor(private readonly loadTree: SchemaTreeLoader) { }

	/** Re-run introspection and repaint the whole tree (the title-bar refresh + connection changes). */
	refresh(): void {
		this.changed.fire(undefined);
	}

	getTreeItem(node: DbNode): TreeItem {
		if (node.kind === 'schema') {
			const item = new TreeItem(node.schema, TreeItemCollapsibleState.Collapsed);
			item.iconPath = new ThemeIcon('database');
			item.contextValue = 'burrowDb.schema';
			item.description = `${node.tables.length}`;
			return item;
		}
		if (node.kind === 'table') {
			const item = new TreeItem(node.entry.name, TreeItemCollapsibleState.None);
			item.iconPath = TABLE_ICON[node.entry.kind];
			item.contextValue = `burrowDb.${node.entry.kind}`;
			item.description = node.entry.kind === 'table' ? undefined : node.entry.kind;
			item.tooltip = `${node.entry.schema}.${node.entry.name}`;
			item.command = {
				command: OPEN_TABLE_COMMAND,
				title: 'Open Table',
				arguments: [node.entry.schema, node.entry.name],
			};
			return item;
		}
		const item = new TreeItem(node.text, TreeItemCollapsibleState.None);
		item.iconPath = new ThemeIcon('info');
		return item;
	}

	async getChildren(node?: DbNode): Promise<DbNode[]> {
		if (!node) {
			return this.rootNodes();
		}
		if (node.kind === 'schema') {
			return node.tables.map(entry => ({ kind: 'table', entry }));
		}
		return [];
	}

	/** The top level: schema branches, or a single message node explaining an empty/failed load. */
	private async rootNodes(): Promise<DbNode[]> {
		try {
			const groups = await this.loadTree();
			if (groups.length === 0) {
				return [{ kind: 'message', text: 'No user schemas found.' }];
			}
			return groups.map(group => ({ kind: 'schema', schema: group.schema, tables: group.tables }));
		} catch (err) {
			return [{ kind: 'message', text: err instanceof Error ? err.message : String(err) }];
		}
	}
}
