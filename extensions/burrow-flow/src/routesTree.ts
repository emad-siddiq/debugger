/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// routesTree.ts — the Routes view: every traced flow grouped by /api/<domain>
// (the same grouping the retiring nodewatch-debugger Routes tree used).
// Click opens the wire diagram; inline actions arm a symbol breakpoint or
// jump to the handler.

import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { Flow, FlowsDoc, groupFlows, handlerOf } from './model';

type Node = GroupItem | FlowItem | PlaceholderItem;

class PlaceholderItem extends vscode.TreeItem {
	constructor(message: string) {
		super(message, vscode.TreeItemCollapsibleState.None);
		this.iconPath = new vscode.ThemeIcon('info');
		this.command = { command: 'burrow.flow.refresh', title: 'Refresh Flows' };
	}
}

class GroupItem extends vscode.TreeItem {
	constructor(name: string, readonly flows: Flow[]) {
		super(name, vscode.TreeItemCollapsibleState.Collapsed);
		this.description = `${flows.length}`;
		this.iconPath = new vscode.ThemeIcon('symbol-namespace');
	}
}

export class FlowItem extends vscode.TreeItem {
	constructor(readonly flow: Flow) {
		super(`${flow.method} ${flow.path}`, vscode.TreeItemCollapsibleState.None);
		const handler = handlerOf(flow);
		this.description = handler ? handler.label : '';
		const tables = flow.tables?.length ? `\n▤ ${flow.tables.join(', ')}` : '';
		this.tooltip = `${handler?.label ?? '?'}  [${flow.file}:${flow.line}] · ${flow.status}${tables}\nclick → wire diagram`;
		this.iconPath = new vscode.ThemeIcon(
			flow.status === 'traced' ? 'type-hierarchy-sub' : flow.status === 'partial' ? 'issues' : 'question',
		);
		this.contextValue = 'flowRoute';
		this.command = { command: 'burrow.flow.openDiagram', title: 'Open Wire Diagram', arguments: [this] };
	}
}

export class FlowsTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private doc: FlowsDoc | undefined;
	private flowsFile: string | undefined;

	load(flowsFile: string): void {
		this.flowsFile = flowsFile;
		try {
			this.doc = JSON.parse(fs.readFileSync(flowsFile, 'utf8')) as FlowsDoc;
		} catch {
			this.doc = undefined;
		}
		this._onDidChangeTreeData.fire();
	}

	get document(): FlowsDoc | undefined {
		return this.doc;
	}

	reload(): void {
		if (this.flowsFile) {
			this.load(this.flowsFile);
		} else {
			this._onDidChangeTreeData.fire();
		}
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}

	getTreeItem(el: Node): vscode.TreeItem {
		return el;
	}

	getChildren(el?: Node): Node[] {
		if (el) {
			return el instanceof GroupItem ? el.flows.map(flow => new FlowItem(flow)) : [];
		}
		if (!this.doc || !this.doc.flows?.length) {
			return [new PlaceholderItem('No flows yet — run "API Flows: Refresh Flows"')];
		}
		return [...groupFlows(this.doc.flows).entries()].map(([name, flows]) => new GroupItem(name, flows));
	}
}
