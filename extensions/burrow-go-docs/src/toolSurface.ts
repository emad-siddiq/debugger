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

/** Register a transient surface this tool opens. Safe to call at activation:
 *  the claim lands as soon as the registry exists, and the returned Disposable
 *  withdraws it whenever that happens to be. */
export function claimSurface(toolId: string, marker: { uri: vscode.Uri } | { viewType: string }): vscode.Disposable {
	let claim: vscode.Disposable | undefined;
	let withdrawn = false;
	void tools().then((api) => {
		claim = api?.claim(toolId, marker);
		if (withdrawn) {
			claim?.dispose();
		}
	});
	return new vscode.Disposable(() => {
		withdrawn = true;
		claim?.dispose();
	});
}

// ---------------------------------------------------------------------------
// Pop out / dock (patches/0016). Same shape, same forgiveness: a tool that opts
// a surface in gets the two title-bar buttons; a build without burrow-core just
// does not show them. The registry is a set of viewTypes published as a context
// key — burrow-core never holds a reference to anyone's WebviewPanel.

interface WindowsApi {
	detachable(viewType: string): vscode.Disposable;
}

async function windows(): Promise<WindowsApi | undefined> {
	try {
		const core = vscode.extensions.getExtension('burrow.burrow-core');
		if (!core) {
			return undefined;
		}
		const exports = (core.isActive ? core.exports : await core.activate()) as { windows?: WindowsApi } | undefined;
		return exports?.windows;
	} catch {
		return undefined;
	}
}

/** Opt a webview panel viewType into the Pop Out / Dock buttons. Call once at
 *  activation — registration is by viewType, so it does not need the panel to
 *  exist yet, and it survives the panel being closed and reopened. */
export function detachable(viewType: string): vscode.Disposable {
	let registration: vscode.Disposable | undefined;
	let withdrawn = false;
	void windows().then((api) => {
		registration = api?.detachable(viewType);
		if (withdrawn) {
			registration?.dispose();
		}
	});
	return new vscode.Disposable(() => {
		withdrawn = true;
		registration?.dispose();
	});
}
