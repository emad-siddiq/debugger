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
	TreeView,
	commands,
	debug,
	window,
} from 'vscode';
import { DapScope, InspectorModel, InspectorNode, PAGE_SIZE } from './model';
import { DapVariable, GoKind } from './summary';
import { MillerInspectorProvider } from './miller';

// burrow-go-inspect — the IX inspector (architecture task 05). WO-3 landed the
// path-addressed DAP value model + per-Go-type summary renderer; WO-4 turns the
// presentation from an expanding tree into the **anti-tree**: a breadcrumb + a
// single flat column where drilling into a composite REPLACES the level instead
// of indenting it (task 05.4 — "constant visual depth no matter how deep the
// data; no recursive indentation, ever"). Rendered natively (no core patch, real
// keyboard). Literal side-by-side Miller columns + the rich value pane are the
// next IX slices (05.4 columns / 05.5), where the webview-vs-core-view fork bites.

const GO_DEBUG_TYPE = 'go';

/** One hop in the drill path: a scope or composite value we've descended into. */
interface DrillTarget {
	readonly label: string;
	readonly variablesReference: number;
	readonly path: readonly string[];
	readonly indexedVariables?: number;
}

/** A rendered row: navigation affordances, scope roots, values, or a status line. */
type Row =
	| { readonly kind: 'message'; readonly text: string }
	| { readonly kind: 'back' }
	| { readonly kind: 'scope'; readonly scope: DapScope }
	| { readonly kind: 'value'; readonly node: InspectorNode };

class InspectorNavProvider implements TreeDataProvider<Row> {

	private readonly _onDidChangeTreeData = new EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	/** The drill path from the frame's scopes to the current level (empty = scopes). */
	private stack: DrillTarget[] = [];
	private view: TreeView<Row> | undefined;

	constructor(private readonly models: Map<string, InspectorModel>) { }

	attach(view: TreeView<Row>): void {
		this.view = view;
	}

	private activeModel(): InspectorModel | undefined {
		const session = debug.activeDebugSession;
		return session ? this.models.get(session.id) : undefined;
	}

	private updateBreadcrumb(): void {
		if (this.view) {
			this.view.message = this.stack.length ? this.stack.map(t => t.label).join('  ›  ') : undefined;
		}
	}

	refresh(): void {
		this.updateBreadcrumb();
		this._onDidChangeTreeData.fire();
	}

	/** New stop or frame change: the old refs/path no longer apply — return to the scopes. */
	resetToRoot(): void {
		this.stack = [];
		this.refresh();
	}

	drill(target: DrillTarget): void {
		this.stack.push(target);
		this.refresh();
	}

	up(): void {
		this.stack.pop();
		this.refresh();
	}

	home(): void {
		this.stack = [];
		this.refresh();
	}

	async getChildren(element?: Row): Promise<Row[]> {
		if (element) {
			return []; // flat by design — drilling replaces the level, never nests.
		}
		const model = this.activeModel();
		if (!model) {
			return [{ kind: 'message', text: 'No active Go debug session.' }];
		}
		try {
			if (this.stack.length === 0) {
				const frameId = await model.activeFrameId();
				if (frameId === undefined) {
					return [{ kind: 'message', text: 'Session running — stop at a breakpoint to inspect.' }];
				}
				const scopes = await model.scopes(frameId);
				return scopes.filter(scope => !scope.expensive).map(scope => ({ kind: 'scope', scope }));
			}
			const top = this.stack[this.stack.length - 1];
			const nodes = await model.children(top.variablesReference, top.path, 0, PAGE_SIZE);
			const rows: Row[] = [{ kind: 'back' }, ...nodes.map(node => ({ kind: 'value', node } as Row))];
			const total = top.indexedVariables ?? 0;
			if (total > PAGE_SIZE && nodes.length === PAGE_SIZE) {
				rows.push({ kind: 'message', text: `Showing first ${PAGE_SIZE} of ${total} (paging: a later IX slice).` });
			}
			return rows;
		} catch (err) {
			return [{ kind: 'message', text: `Could not read this level: ${err instanceof Error ? err.message : String(err)}` }];
		}
	}

	getTreeItem(element: Row): TreeItem {
		switch (element.kind) {
			case 'message': {
				const item = new TreeItem(element.text);
				item.contextValue = 'message';
				return item;
			}
			case 'back': {
				const item = new TreeItem('◀ Back', TreeItemCollapsibleState.None);
				item.iconPath = new ThemeIcon('arrow-left');
				item.command = { command: 'burrow.inspect.up', title: 'Back' };
				item.contextValue = 'back';
				return item;
			}
			case 'scope': {
				const { scope } = element;
				const item = new TreeItem(scope.name, TreeItemCollapsibleState.None);
				item.description = '›';
				item.iconPath = new ThemeIcon('symbol-namespace');
				item.command = drillCommand({ label: scope.name, variablesReference: scope.variablesReference, path: [scope.name], indexedVariables: scope.indexedVariables });
				item.contextValue = 'scope';
				return item;
			}
			case 'value': {
				const { variable, summary, changed, path } = element.node;
				const drillable = summary.expandable && variable.variablesReference > 0;
				const item = new TreeItem(variable.name, TreeItemCollapsibleState.None);
				// A leading `●` (amber) marks a value that changed since the last stop;
				// a trailing `›` marks a value you can drill into (task 05: amber tint).
				item.description = `${changed ? '● ' : ''}${summary.text}${drillable ? '  ›' : ''}`;
				item.iconPath = new ThemeIcon(iconFor(summary.kind), changed ? new ThemeColor('charts.yellow') : undefined);
				item.tooltip = tooltipFor(variable, changed, path);
				if (drillable) {
					item.command = drillCommand({ label: variable.name, variablesReference: variable.variablesReference, path: [...path], indexedVariables: variable.indexedVariables });
				}
				item.contextValue = changed ? 'value-changed' : 'value';
				return item;
			}
		}
	}
}

function drillCommand(target: DrillTarget): TreeItem['command'] {
	return { command: 'burrow.inspect.drill', title: 'Drill Into', arguments: [target] };
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
	md.appendMarkdown(`${path.join(' › ')}\n\n`);
	md.appendCodeblock(v.value, 'go');
	if (changed) {
		md.appendMarkdown('\n_changed since last stop_');
	}
	return md;
}

export function activate(context: ExtensionContext): void {
	const models = new Map<string, InspectorModel>();
	const provider = new InspectorNavProvider(models);
	const view = window.createTreeView('burrowInspectorPreview', { treeDataProvider: provider });
	provider.attach(view);

	// The Miller-column webview inspector (WO-5) — the layer-4 prototype of the
	// task 05 webview-vs-core fork. It runs ALONGSIDE the native tree above so the
	// two can be compared before WO-6 picks one and retires the other (task 05.8).
	// Both share the same model map and the same stop/frame reset triggers below.
	const miller = new MillerInspectorProvider(models);

	const trackerFactory: DebugAdapterTrackerFactory = {
		createDebugAdapterTracker(session: DebugSession): ProviderResult<DebugAdapterTracker> {
			return {
				onDidSendMessage(message): void {
					// A `stopped` event is a new inspection point: roll the model's change-diff
					// snapshot (via onStopped) and return the navigator to the scopes. The model
					// is looked up per-message — the tracker can be created before
					// onDidStartDebugSession has registered it.
					const event = message as { type?: string; event?: string };
					if (event.type === 'event' && event.event === 'stopped') {
						const model = models.get(session.id);
						if (model) {
							model.onStopped();
							provider.resetToRoot();
							miller.reset();
						}
					}
				},
			};
		},
	};

	context.subscriptions.push(
		view,
		miller,
		window.registerWebviewViewProvider(MillerInspectorProvider.viewId, miller),
		debug.onDidStartDebugSession(session => {
			if (session.type === GO_DEBUG_TYPE) {
				models.set(session.id, new InspectorModel(session));
			}
		}),
		debug.onDidTerminateDebugSession(session => {
			models.delete(session.id);
			provider.resetToRoot();
			miller.reset();
		}),
		// A frame switch invalidates the current drill path (refs are frame-scoped),
		// so re-root both inspectors on the newly focused frame.
		debug.onDidChangeActiveStackItem(() => {
			provider.resetToRoot();
			miller.reset();
		}),
		debug.registerDebugAdapterTrackerFactory(GO_DEBUG_TYPE, trackerFactory),
		commands.registerCommand('burrow.inspect.drill', (target: DrillTarget) => provider.drill(target)),
		commands.registerCommand('burrow.inspect.up', () => provider.up()),
		commands.registerCommand('burrow.inspect.home', () => provider.home()),
		commands.registerCommand('burrow.inspect.refresh', () => provider.refresh()),
	);
}

export function deactivate(): void {
	// Models are dropped on session terminate; the tree view and its listeners are
	// disposed via context.subscriptions.
}
