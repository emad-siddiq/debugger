/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import {
	DebugAdapterTracker,
	DebugAdapterTrackerFactory,
	DebugSession,
	EventEmitter,
	ExtensionContext,
	MarkdownString,
	ProviderResult,
	ThemeColor,
	ThemeIcon,
	TreeDataProvider,
	TreeItem,
	TreeItemCollapsibleState,
	commands,
	debug,
	window,
} from 'vscode';
import { DapScope, InspectorModel, InspectorNode, PAGE_SIZE } from './model';
import { DapVariable, GoKind } from './summary';

// burrow-go-inspect is the first IX slice (WO-3, architecture task 05.3): the
// path-addressed DAP value model + the per-Go-type summary renderer. This entry
// point wires them to a read-only "Inspector (preview)" tree in the Run & Debug
// container so the data layer is provable against a live `dlv dap` session
// (WO-2). The tree is scaffolding — the Miller-column inspector, value pane, and
// retirement of the stock Variables tree are the later IX WOs (task 05.4–05.8).

const GO_DEBUG_TYPE = 'go';

/** The tree renders scopes, values, and "load more" pagers over the active model. */
type TreeNode =
	| { readonly kind: 'scope'; readonly scope: DapScope }
	| { readonly kind: 'value'; readonly node: InspectorNode }
	| { readonly kind: 'page'; readonly parentRef: number; readonly path: readonly string[]; readonly start: number; readonly total: number }
	| { readonly kind: 'message'; readonly text: string };

class InspectorTreeProvider implements TreeDataProvider<TreeNode> {

	private readonly _onDidChangeTreeData = new EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly models: Map<string, InspectorModel>) { }

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	private activeModel(): InspectorModel | undefined {
		const session = debug.activeDebugSession;
		return session ? this.models.get(session.id) : undefined;
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		const model = this.activeModel();
		if (!model) {
			return element ? [] : [{ kind: 'message', text: 'No active Go debug session.' }];
		}
		if (!element) {
			const frameId = await model.activeFrameId();
			if (frameId === undefined) {
				return [{ kind: 'message', text: 'Session running — stop at a breakpoint to inspect.' }];
			}
			const scopes = await model.scopes(frameId);
			return scopes.filter(scope => !scope.expensive).map(scope => ({ kind: 'scope', scope }));
		}
		if (element.kind === 'scope') {
			return this.page(model, element.scope.variablesReference, [element.scope.name], 0, element.scope.indexedVariables ?? 0);
		}
		if (element.kind === 'value') {
			const v = element.node.variable;
			if (v.variablesReference === 0) {
				return [];
			}
			return this.page(model, v.variablesReference, element.node.path, 0, v.indexedVariables ?? 0);
		}
		if (element.kind === 'page') {
			return this.page(model, element.parentRef, element.path, element.start, element.total);
		}
		return [];
	}

	/** One indexed page of children, plus a `page` pager node when more remain. */
	private async page(model: InspectorModel, ref: number, path: readonly string[], start: number, total: number): Promise<TreeNode[]> {
		const nodes = await model.children(ref, path, start, PAGE_SIZE);
		const out: TreeNode[] = nodes.map(node => ({ kind: 'value', node }));
		const shown = start + nodes.length;
		if (total > shown && nodes.length === PAGE_SIZE) {
			out.push({ kind: 'page', parentRef: ref, path, start: shown, total });
		}
		return out;
	}

	getTreeItem(element: TreeNode): TreeItem {
		switch (element.kind) {
			case 'message': {
				const item = new TreeItem(element.text);
				item.contextValue = 'message';
				return item;
			}
			case 'page': {
				const remaining = element.total - element.start;
				const item = new TreeItem(`Load ${Math.min(PAGE_SIZE, remaining)} more… (${element.start}/${element.total})`, TreeItemCollapsibleState.Collapsed);
				item.iconPath = new ThemeIcon('ellipsis');
				item.contextValue = 'page';
				return item;
			}
			case 'scope': {
				const item = new TreeItem(element.scope.name, TreeItemCollapsibleState.Expanded);
				item.iconPath = new ThemeIcon('symbol-namespace');
				item.contextValue = 'scope';
				return item;
			}
			case 'value': {
				const { variable, summary, changed, path } = element.node;
				const state = summary.expandable ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None;
				const item = new TreeItem(variable.name, state);
				// A leading `●` (amber) marks a value that changed since the last stop
				// (task 05: "changed-since-last-stop values tint amber").
				item.description = (changed ? '● ' : '') + summary.text;
				item.iconPath = new ThemeIcon(iconFor(summary.kind), changed ? new ThemeColor('charts.yellow') : undefined);
				item.tooltip = tooltipFor(variable, changed, path);
				item.contextValue = changed ? 'value-changed' : 'value';
				return item;
			}
		}
	}
}

/** A codicon id per Go kind — purely cosmetic, so unknown kinds fall back safely. */
function iconFor(kind: GoKind): string {
	switch (kind) {
		case 'slice':
		case 'array':
		case 'bytes':
			return 'symbol-array';
		case 'map':
			return 'symbol-object';
		case 'struct':
			return 'symbol-structure';
		case 'pointer':
			return 'references';
		case 'string':
			return 'symbol-string';
		case 'number':
			return 'symbol-number';
		case 'bool':
			return 'symbol-boolean';
		case 'error':
			return 'error';
		case 'time':
		case 'duration':
			return 'watch';
		case 'chan':
			return 'arrow-swap';
		case 'nil':
			return 'circle-slash';
		default:
			return 'symbol-variable';
	}
}

function tooltipFor(v: DapVariable, changed: boolean, path: readonly string[]): MarkdownString {
	const md = new MarkdownString();
	md.appendMarkdown(`**${v.name}**  \`${v.type ?? '?'}\`\n\n`);
	md.appendMarkdown(`${path.join(' ▸ ')}\n\n`);
	md.appendCodeblock(v.value, 'go');
	if (changed) {
		md.appendMarkdown('\n_changed since last stop_');
	}
	return md;
}

export function activate(context: ExtensionContext): void {
	const models = new Map<string, InspectorModel>();
	const provider = new InspectorTreeProvider(models);

	const trackerFactory: DebugAdapterTrackerFactory = {
		createDebugAdapterTracker(session: DebugSession): ProviderResult<DebugAdapterTracker> {
			return {
				onDidSendMessage(message): void {
					// A `stopped` event is a new inspection point: bump the model's stop
					// sequence so the next read rolls its change-diff snapshot. The model
					// is looked up per-message, not captured — the tracker can be created
					// before onDidStartDebugSession has registered the model.
					const event = message as { type?: string; event?: string };
					if (event.type === 'event' && event.event === 'stopped') {
						const model = models.get(session.id);
						if (model) {
							model.onStopped();
							provider.refresh();
						}
					}
				},
			};
		},
	};

	context.subscriptions.push(
		window.registerTreeDataProvider('burrowInspectorPreview', provider),
		debug.onDidStartDebugSession(session => {
			if (session.type === GO_DEBUG_TYPE) {
				models.set(session.id, new InspectorModel(session));
			}
		}),
		debug.onDidTerminateDebugSession(session => {
			models.delete(session.id);
			provider.refresh();
		}),
		// Frame switches re-read the same stop (no snapshot roll — that only
		// happens on `stopped`), so a plain refresh is right here.
		debug.onDidChangeActiveStackItem(() => provider.refresh()),
		debug.registerDebugAdapterTrackerFactory(GO_DEBUG_TYPE, trackerFactory),
		commands.registerCommand('burrow.inspect.refresh', () => provider.refresh()),
	);
}

export function deactivate(): void {
	// Models are dropped on session terminate; the tree provider and its
	// listeners are disposed via context.subscriptions.
}
