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
		panel.show(item.flow, paths.backendDir, migrationFor);
		// …and take the code with it. Clicking route after route used to redraw the
		// diagram while the editor beside it kept showing whichever handler you had
		// opened by hand — the panel moved and the code did not. A PREVIEW tab
		// replaces itself, so this follows the selection instead of stacking up.
		const handler = handlerOf(item.flow);
		if (handler?.file) {
			await openSymbol(paths.backendDir, handler.file, handler.label, handler.line, { preview: true, preserveFocus: true });
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
