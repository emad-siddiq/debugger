/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Everything the sidecar needs to boot, resolved from settings with
 * workspace-folder auto-detection. The sidecar itself reads these as env vars
 * (MERKLE_*, UI_PORT, …) — see tools/frontend-debugger/server/config.js.
 */
export interface SidecarConfig {
	readonly toolRoot: string;
	readonly targetDir: string;
	readonly repoRoot: string;
	readonly backendTarget: string;
	readonly mode: 'mock' | 'live';
	readonly uiPort: number;
	readonly targetPort: number;
	readonly targetBase: string;
}

export function resolveConfig(context: vscode.ExtensionContext): SidecarConfig {
	const cfg = vscode.workspace.getConfiguration('burrow.frontendDebugger');
	const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
	const repoRoot = cfg.get<string>('repoRoot') || workspace;

	let targetDir = cfg.get<string>('targetDir') || '';
	if (!targetDir && repoRoot) {
		// Auto-detect the Vite project folder. merkle de-nested its frontend to
		// <repo>/frontend (2026-07); it previously lived at nodewatch/frontend.
		// Probe both (newest layout first) and require a package.json so we pick a
		// real project dir, not the repo root. Other repos open the Vite folder
		// directly, so repoRoot is the fallback.
		const candidates = [
			path.join(repoRoot, 'frontend'),
			path.join(repoRoot, 'nodewatch', 'frontend'),
		];
		targetDir = candidates.find(d => fs.existsSync(path.join(d, 'package.json'))) || repoRoot;
	}

	const toolRoot = cfg.get<string>('toolPath')
		|| path.resolve(context.extensionPath, '..', '..', 'tools', 'frontend-debugger');

	return {
		toolRoot,
		targetDir,
		repoRoot,
		backendTarget: cfg.get<string>('backendTarget', 'http://localhost:8080'),
		mode: cfg.get<'mock' | 'live'>('mode', 'mock'),
		uiPort: cfg.get<number>('uiPort', 6080),
		targetPort: cfg.get<number>('targetPort', 5180),
		targetBase: cfg.get<string>('targetBase', '/'),
	};
}
