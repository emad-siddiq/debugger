/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveConfig } from './config';
import { Sidecar } from './sidecar';

/**
 * Pick a sensible dev-server command from a package.json `scripts` map: `dev`,
 * then `start`, then the first script whose name reads like a dev/serve script.
 * Pure — the first-run seed for the `runCommand` setting. Unit-tested.
 */
export function detectRunCommand(scripts: Record<string, string> | undefined): string | undefined {
	if (!scripts) {
		return undefined;
	}
	for (const name of ['dev', 'start']) {
		if (scripts[name]) {
			return `npm run ${name}`;
		}
	}
	const devish = Object.keys(scripts).find(k => /dev|serve|start/i.test(k));
	return devish ? `npm run ${devish}` : undefined;
}

function readScripts(dir: string): Record<string, string> | undefined {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
		return pkg.scripts;
	} catch {
		return undefined;
	}
}

/** Trailing-slash-normalized base URL for the sidecar-served target. */
export function targetUrlFor(port: number, base: string): string {
	const b = base.endsWith('/') ? base : base + '/';
	return `http://127.0.0.1:${port}${b}`;
}

/**
 * "Open in Browser": launch the app in the real browser with the inspector
 * overlay, so ⌥-clicking a component reveals its source in Burrow (via the
 * reveal bridge).
 *
 * Two paths (Framer-mode T2):
 *  - `runCommand` set → run the user's command VERBATIM in a terminal (their
 *    real app, auth/env/mocks their concern) and open `appUrl`. The overlay must
 *    be in their app — they add the Burrow inspector Vite plugin (dev-guarded).
 *  - unset (default) → start the sidecar (which serves the instrumented target
 *    with the overlay already injected) and open that URL. Zero setup.
 */
export async function runOpenInBrowser(context: vscode.ExtensionContext, sidecar: Sidecar): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('burrow.frontendDebugger');
	const runCommand = (cfg.get<string>('runCommand') || '').trim();
	const sidecarCfg = resolveConfig(context);

	let appUrl: string;
	if (runCommand) {
		const cwd = sidecarCfg.targetDir || sidecarCfg.repoRoot || undefined;
		const term = vscode.window.createTerminal({ name: 'Burrow — dev server', cwd });
		term.show(true);
		term.sendText(runCommand, true);
		appUrl = (cfg.get<string>('appUrl') || '').trim() || 'http://localhost:5173/';
		// The dev server needs a moment before the URL answers; the user's own
		// HMR takes over from there. (Best-effort delay — the browser tab reloads
		// fine if it opens a beat early.)
		await new Promise(resolve => setTimeout(resolve, 2500));
	} else {
		await sidecar.start(sidecarCfg);
		const port = sidecar.targetPort || sidecarCfg.targetPort;
		appUrl = (cfg.get<string>('appUrl') || '').trim() || targetUrlFor(port, sidecarCfg.targetBase);
	}

	await vscode.env.openExternal(vscode.Uri.parse(appUrl));
	void vscode.window.showInformationMessage(
		`Frontend Debugger: opened ${appUrl} in your browser. ⌥-click a component to reveal its source.`,
	);
}

/**
 * First-run convenience: if `runCommand` is unset, offer to seed it from the
 * target's package.json scripts. No-op when already set or nothing detected.
 */
export async function maybeSeedRunCommand(context: vscode.ExtensionContext): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('burrow.frontendDebugger');
	if ((cfg.get<string>('runCommand') || '').trim()) {
		return;
	}
	const sidecarCfg = resolveConfig(context);
	const detected = detectRunCommand(readScripts(sidecarCfg.targetDir));
	if (!detected) {
		return;
	}
	const pick = await vscode.window.showInformationMessage(
		`Frontend Debugger: use "${detected}" as the run command for the browser session?`,
		'Use It', 'Not Now',
	);
	if (pick === 'Use It') {
		await cfg.update('runCommand', detected, vscode.ConfigurationTarget.Workspace);
	}
}
