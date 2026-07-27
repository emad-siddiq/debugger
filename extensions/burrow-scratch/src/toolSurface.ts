/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

// The tool's half of tool-surface isolation (docs/plans/02 §6, WO-23). The
// registry itself lives in burrow-core. Scratch only says the first of the two
// things a tool can say — "my view became visible" — because its step page is
// where the work happens rather than a transient result tab; see extension.ts.
//
// Deliberately forgiving: a Burrow build without burrow-core, or one where the
// registry is not yet loaded, simply gets no isolation. A tool must never fail
// to open its own surface because a tidying feature is missing.

interface ToolsApi {
	activated(toolId: string): void;
}

/**
 * burrow-core's registry, waited for if it has not activated yet. This is not
 * paranoia: a tool with a `workspaceContains` activation event (burrow-http has one
 * for .http files) activates BEFORE burrow-core's `onStartupFinished`, and resolving
 * the API once, eagerly, silently dropped its claim for the life of the window —
 * the tab then never tidied and nothing said why.
 */
async function tools(): Promise<ToolsApi | undefined> {
	try {
		const core = vscode.extensions.getExtension('burrow.burrow-core');
		if (!core) {
			return undefined;
		}
		const exports = (core.isActive ? core.exports : await core.activate()) as { tools?: ToolsApi } | undefined;
		return exports?.tools;
	} catch {
		return undefined;
	}
}

/** Announce this tool when its rail view becomes visible. */
export function announceOnVisible(toolId: string, view: { onDidChangeVisibility: vscode.Event<{ visible: boolean }>; visible: boolean }): vscode.Disposable {
	const announce = () => void tools().then((api) => api?.activated(toolId));
	if (view.visible) {
		announce();
	}
	return view.onDidChangeVisibility((e) => {
		if (e.visible) {
			announce();
		}
	});
}
