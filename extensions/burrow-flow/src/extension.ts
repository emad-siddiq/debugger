/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// extension.ts — burrow-flow activation: the Routes tree (grouped flows), the
// wire-diagram panel, refresh (oracle digest + flowscan, both host-side), and
// the symbol-anchored breakpoint/open-handler actions ported from the retiring
// nodewatch-debugger extension.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { armSymbolBreakpoint, openSymbol } from './breakpoints';
import { DiagramPanel } from './diagramPanel';
import { generateHttp, parseContractFence } from './httpgen';
import { loadSeedProfile } from './seedProfile';
import { flowsOf, handlerOf, railMessage, unfollowedOf } from './model';
import { cachedDigestFile, cachedFlowsFile, detectProject, flowState, refreshFlows } from './project';
import { FlowItem, FlowsTree } from './routesTree';
import { noBackendMessage, whereIs } from './spine';

/** The open folder's name, for messages that should say where they looked. */
function folderName(): string | undefined {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return root ? path.basename(root) : undefined;
}

/** What this extension lets OTHER extensions read (burrow-chat's workbench
 *  context, mirroring FrontendDebuggerApi). Read-only: the traced FlowsDoc as
 *  it currently stands, or undefined before the first trace. */
export interface BurrowFlowApi {
	readonly doc: () => import('./model').FlowsDoc | undefined;
}

export function activate(context: vscode.ExtensionContext): BurrowFlowApi {
	const log = vscode.window.createOutputChannel('Burrow Flow');
	const tree = new FlowsTree();
	const panel = new DiagramPanel();
	context.subscriptions.push(log, tree, panel);
	// `createTreeView`, not `registerTreeDataProvider`, for one reason: `message`.
	//
	// A router flowscan recognised and could not follow has to be VISIBLE, and the
	// view contract (docs/plans/02 rule 4) forbids a tree row pretending to be a
	// message. `TreeView.message` is the surface built for exactly this — a
	// sentence above the tree, present only when there is something to say.
	const view = vscode.window.createTreeView('burrowFlowRoutes', { treeDataProvider: tree });
	context.subscriptions.push(view);

	const cached = cachedFlowsFile(context);
	if (cached) {
		tree.load(cached);
	}

	/**
	 * The rail's own three states, as a context key.
	 *
	 * A context key and three `viewsWelcome` entries rather than a row in the tree:
	 * the view contract (docs/plans/02, rule 4) says an empty view gets one sentence
	 * and one button, never a list item pretending to be a message — and an empty
	 * tree is what lets a welcome view render at all.
	 *
	 * Which matters because the single welcome text said "No routes indexed yet" in
	 * all three situations, including after a trace that completed and found none.
	 * That is the surface a user actually looks at, and it was telling someone to run
	 * a tool that had already answered.
	 */
	const publishState = (): void => {
		const doc = tree.document;
		// The rail's own sentence. Undefined clears it, so a project with nothing
		// to warn about gets no chrome.
		view.message = railMessage(flowsOf(doc).length, unfollowedOf(doc));
		// `doc.flows` is NULL, not `[]`, when flowscan found nothing: a nil Go slice
		// marshals to `null`. flowscan already normalises `edges` and `nodes` for
		// exactly this reason and does not normalise the top-level list, so every
		// consumer here has to. `doc?.flows.length` throws on it — which is what the
		// notification below did, silently, for the whole of a zero-route refresh.
		const state = !detectProject() ? 'nostack' : !doc ? 'untraced' : flowsOf(doc).length ? 'routes' : 'empty';
		void vscode.commands.executeCommand('setContext', 'burrow.flow.state', state);
	};
	publishState();

	const migrationFor = (table: string): string | undefined => tree.document?.tables?.[table];

	// Panel persistence (WO-60): a restored diagram re-resolves its route out of
	// the cached flows document loaded just above — a file read, not a trace.
	context.subscriptions.push(panel.register(() => {
		const paths = detectProject();
		if (!paths) {
			return undefined;
		}
		return {
			backendDir: paths.backendDir,
			migrationFor,
			find: (method, routePath) => flowsOf(tree.document).find(f => f.method === method && f.path === routePath),
		};
	}));

	context.subscriptions.push(vscode.commands.registerCommand('burrow.flow.refresh', async () => {
		const paths = detectProject();
		if (!paths) {
			// Name what was looked for, not what merkle happens to have.
			void vscode.window.showWarningMessage(noBackendMessage(folderName()));
			return;
		}
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `API Flows: tracing ${whereIs(paths.backendRel)}…` },
			async () => {
				const flowsFile = await refreshFlows(context, paths, log);
				if (flowsFile) {
					tree.load(flowsFile);
					publishState();
					const doc = tree.document;
					const cov = doc?.coverage;
					const routes = flowsOf(doc).length;
					const state = flowState(paths.root);
					// A route count with an unfollowed router behind it is a FLOOR, not
					// an answer. Saying "13 routes" flat would be the one place this
					// fork breaks grey-with-a-reason inside its own differentiator.
					const notFollowed = unfollowedOf(doc);
					const caveat = notFollowed.length
						? `  ⚠︎ ${notFollowed.length} router(s) could not be followed, so there may be more — see the rail.`
						: '';
					// A measured zero is a RESULT, and it gets a sentence rather than the
					// same "refreshed — 0 routes" that reads like the tool did not run.
					// This is the state that had nowhere to live: chi's honest answer.
					void vscode.window.showInformationMessage(
						routes === 0
							? `No routes found in ${whereIs(paths.backendRel)}. flowscan seeds its walk from a router's own method set, so a value it never sees constructed traces empty.${caveat}`
							: `Flows refreshed — ${routes} routes (${cov?.traced ?? 0} traced, ${cov?.partial ?? 0} partial) @ ${doc?.rev ?? '?'}${caveat}`
							+ (state?.loadErrors ? `  ⚠︎ ${state.loadErrors} package(s) failed to type-check — the counts are incomplete; see the "Burrow Flow" output channel.` : ''),
					);
				}
			},
		);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('burrow.flow.openDiagram', async (item: FlowItem) => {
		const paths = detectProject();
		if (!paths || !item?.flow) {
			return;
		}
		// The CODE first, then the diagram beside it. The other order looks right
		// and is not: on a window with no editors open, `ViewColumn.Beside`
		// resolves to column one, so the handler's preview tab opened straight on
		// top of the diagram that had just been created there. Only reproducible
		// from a cold window, which is why it survived — measured 2026-07-27,
		// picking a route from search on a fresh profile left one tab, the source.
		//
		// A PREVIEW tab replaces itself, so the code follows the route you clicked
		// instead of stacking one tab per route.
		const handler = handlerOf(item.flow);
		if (handler?.file) {
			await openSymbol(paths.backendDir, handler.file, handler.label, handler.line, { preview: true, preserveFocus: true });
		}
		panel.show(item.flow, paths.backendDir, migrationFor);
	}));

	// Search: 235 routes in merkle, grouped into 20-odd domains. The tree is for
	// reading the surface by domain; this is for when you know the path. Picking
	// does exactly what clicking a tree row does — diagram, and the code follows.
	context.subscriptions.push(vscode.commands.registerCommand('burrow.flow.searchRoutes', async () => {
		const flows = flowsOf(tree.document);
		if (!flows.length) {
			void vscode.window.showWarningMessage('No routes indexed yet — run "API Flows: Refresh Flows" first.');
			return;
		}
		interface Item extends vscode.QuickPickItem { readonly flow: (typeof flows)[number] }
		const items: Item[] = flows
			.slice()
			.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
			.map((flow) => {
				const handler = handlerOf(flow);
				return {
					flow,
					label: `${flow.method} ${flow.path}`,
					description: handler?.label ?? '',
					// Tables are what you actually search for half the time —
					// "which route writes node_metrics" is a real question.
					detail: [flow.file ? `${flow.file}:${flow.line}` : undefined, flow.tables?.length ? `▤ ${flow.tables.join(', ')}` : undefined]
						.filter(Boolean).join('  ·  ') || undefined,
				};
			});
		const chosen = await vscode.window.showQuickPick(items, {
			placeHolder: 'Search routes — method, path, handler or table',
			matchOnDescription: true,
			matchOnDetail: true,
			title: `${flows.length} routes`,
		});
		if (chosen) {
			await vscode.commands.executeCommand('burrow.flow.openDiagram', new FlowItem(chosen.flow));
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('burrow.flow.armBreakpoint', async (item: FlowItem) => {
		const paths = detectProject();
		const handler = item?.flow ? handlerOf(item.flow) : undefined;
		if (!paths || !handler?.file) {
			void vscode.window.showWarningMessage('No resolved handler for this route.');
			return;
		}
		await armSymbolBreakpoint(paths.backendDir, handler.file, handler.label);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('burrow.flow.openHandler', async (item: FlowItem) => {
		const paths = detectProject();
		const handler = item?.flow ? handlerOf(item.flow) : undefined;
		if (!paths || !handler?.file) {
			return;
		}
		await openSymbol(paths.backendDir, handler.file, handler.label, handler.line);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('burrow.flow.generateHttp', async () => {
		const paths = detectProject();
		const doc = tree.document;
		const flows = flowsOf(doc);
		if (!paths || !doc || !flows.length) {
			void vscode.window.showWarningMessage('No flows yet — run "API Flows: Refresh Flows" first.');
			return;
		}
		const digestFile = cachedDigestFile(context);
		const contract = digestFile ? parseContractFence(fs.readFileSync(digestFile, 'utf8')) : new Map<string, string>();
		const outPath = path.join(paths.backendDir, '.vscode', 'api.generated.http');
		let existing: string | undefined;
		try {
			existing = fs.readFileSync(outPath, 'utf8');
		} catch { /* first generation */ }
		const config = vscode.workspace.getConfiguration('burrow.flow');
		// The Debug Config panel (burrow-fullstack) owns this state; skip-auth
		// defaults to on for the dev loop, so requests carry no token.
		const toggles = vscode.workspace.getConfiguration('burrow.debugConfig').get<Record<string, boolean>>('toggles') ?? {};
		const skipAuth = toggles['skipAuth'] ?? true;
		const content = generateHttp({
			flows: flows.slice(),
			contract,
			baseUrl: config.get<string>('baseUrl', 'http://localhost:8080'),
			authOn: !skipAuth,
			rev: doc.rev,
			existing,
			// Realistic ids and bodies when the target ships a seed profile —
			// without one this is undefined and the output is byte-identical to
			// what it always was.
			seed: loadSeedProfile(paths.root, config.get<string>('seedProfile', '') || undefined),
		});
		fs.mkdirSync(path.dirname(outPath), { recursive: true });
		fs.writeFileSync(outPath, content);
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(outPath)), { preview: false });
	}));

	return { doc: () => tree.document };
}

export function deactivate(): void {
	// Disposables are owned by the extension context.
}
