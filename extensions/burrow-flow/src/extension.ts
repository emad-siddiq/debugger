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
import { handlerOf } from './model';
import { cachedDigestFile, cachedFlowsFile, detectProject, refreshFlows } from './project';
import { FlowItem, FlowsTree } from './routesTree';

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel('Burrow Flow');
	const tree = new FlowsTree();
	const panel = new DiagramPanel();
	context.subscriptions.push(log, tree, panel);
	context.subscriptions.push(vscode.window.registerTreeDataProvider('burrowFlowRoutes', tree));

	const cached = cachedFlowsFile(context);
	if (cached) {
		tree.load(cached);
	}

	const migrationFor = (table: string): string | undefined => tree.document?.tables?.[table];

	context.subscriptions.push(vscode.commands.registerCommand('burrow.flow.refresh', async () => {
		const paths = detectProject();
		if (!paths) {
			void vscode.window.showWarningMessage('No Go backend found — open a project with backend/go.mod or set burrow.flow.backendDir.');
			return;
		}
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'API Flows: tracing routes (oracle + flowscan)…' },
			async () => {
				const flowsFile = await refreshFlows(context, paths, log);
				if (flowsFile) {
					tree.load(flowsFile);
					const doc = tree.document;
					const cov = doc?.coverage;
					void vscode.window.showInformationMessage(
						`Flows refreshed — ${doc?.flows.length ?? 0} routes (${cov?.traced ?? 0} traced, ${cov?.partial ?? 0} partial) @ ${doc?.rev ?? '?'}`,
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
		const flows = tree.document?.flows ?? [];
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
		if (!paths || !doc?.flows.length) {
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
			flows: doc.flows,
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
}

export function deactivate(): void {
	// Disposables are owned by the extension context.
}
