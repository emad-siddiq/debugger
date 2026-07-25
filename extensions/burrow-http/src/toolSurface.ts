/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

// The tool's half of tool-surface isolation (docs/plans/02 §6, WO-23). The
// registry itself lives in burrow-core; a tool only has to say two things:
// "my view became visible" and "this tab is mine and transient". Everything
// else — when to close, what to spare (dirty, pinned) — is core's decision.
//
// Deliberately forgiving: a Burrow build without burrow-core, or one where the
// registry is not yet loaded, simply gets no isolation. A tool must never fail
// to open its own surface because a tidying feature is missing.

interface ToolsApi {
	activated(toolId: string): void;
	claim(toolId: string, marker: { uri: vscode.Uri } | { viewType: string }): vscode.Disposable;
}

function tools(): ToolsApi | undefined {
	try {
		return (vscode.extensions.getExtension('burrow.burrow-core')?.exports as { tools?: ToolsApi } | undefined)?.tools;
	} catch {
		return undefined;
	}
}

/** Announce this tool when its rail view becomes visible. */
export function announceOnVisible(toolId: string, view: { onDidChangeVisibility: vscode.Event<{ visible: boolean }>; visible: boolean }): vscode.Disposable {
	if (view.visible) {
		tools()?.activated(toolId);
	}
	return view.onDidChangeVisibility((e) => {
		if (e.visible) {
			tools()?.activated(toolId);
		}
	});
}

/** Register a transient surface this tool just opened. */
export function claimSurface(toolId: string, marker: { uri: vscode.Uri } | { viewType: string }): vscode.Disposable {
	return tools()?.claim(toolId, marker) ?? new vscode.Disposable(() => undefined);
}
