/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

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
