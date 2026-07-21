/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, commands, window, workspace } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import { resolveTsLsp } from './tslsp';

// burrow-ts-base is the Full-Stack-Debugger frontend counterpart of burrow-go-base:
// a minimal language client that starts `typescript-language-server` (the community
// server that drives tsserver) so hover, go-to-definition, find-references and
// rename work in the merkle React frontend's .ts/.tsx. The TS *grammar* is provided
// by the (restored) built-in typescript-basics; this extension provides the smarts.
// The server + its `typescript` are bundled (see dirs.ts), so it is turnkey; when
// the open project ships its own server we prefer that (tslsp.ts resolution order).

const RESTART_COMMAND = 'burrow.ts.restartLanguageServer';

// Single window, single client — no per-workspace map (mirrors burrow-go-base).
let client: LanguageClient | undefined;

/** node_modules/.bin roots to probe: each workspace folder, then the extension's own. */
function binRoots(context: ExtensionContext): string[] {
	const roots = (workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
	roots.push(context.extensionPath); // bundled fallback — turnkey without a project install
	return roots;
}

/**
 * Resolves `typescript-language-server`, starts a {@link LanguageClient} against
 * it over stdio, and registers the client plus the restart command. If the
 * server is not found, shows a single actionable message and returns without
 * registering a client (no repeating nag, no auto-install).
 */
export async function activate(context: ExtensionContext): Promise<void> {
	context.subscriptions.push(commands.registerCommand(RESTART_COMMAND, () => restart(context)));

	const serverPath = resolveTsLsp(process.env, { binRoots: binRoots(context) });
	if (!serverPath) {
		void window.showErrorMessage(
			'Burrow: the TypeScript language server was not found. Reinstall Burrow (it bundles one), install `typescript-language-server` in your project, or set BURROW_TS_LSP_PATH, then run "Burrow: Restart TypeScript Language Server".',
		);
		return;
	}

	await start(serverPath);
	context.subscriptions.push({ dispose: () => void stop() });
}

/**
 * Builds and starts a `typescript-language-server`-backed client. Unlike gopls,
 * this server WANTS the `--stdio` flag: `TransportKind.stdio` makes
 * vscode-languageclient append it, so we set the transport and pass no explicit
 * args. `run` and `debug` are identical — there is no separate debug build.
 */
async function start(serverPath: string): Promise<void> {
	const serverOptions: ServerOptions = {
		run: { command: serverPath, args: [], transport: TransportKind.stdio },
		debug: { command: serverPath, args: [], transport: TransportKind.stdio },
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ scheme: 'file', language: 'typescript' },
			{ scheme: 'file', language: 'typescriptreact' },
			{ scheme: 'file', language: 'javascript' },
			{ scheme: 'file', language: 'javascriptreact' },
		],
	};

	client = new LanguageClient('burrowTs', 'Burrow TypeScript Language Server', serverOptions, clientOptions);
	await client.start();
}

/** Stops the running client (if any) and clears the module reference. */
async function stop(): Promise<void> {
	const current = client;
	client = undefined;
	if (current) {
		await current.stop();
	}
}

/**
 * Restarts the language server: stop, re-resolve the binary (so a freshly
 * installed one is picked up), and start again. Surfaces the same single
 * actionable message if it is still missing.
 */
async function restart(context: ExtensionContext): Promise<void> {
	await stop();
	const serverPath = resolveTsLsp(process.env, { binRoots: binRoots(context) });
	if (!serverPath) {
		void window.showErrorMessage('Burrow: the TypeScript language server was not found. Reinstall Burrow, install it in your project, or set BURROW_TS_LSP_PATH.');
		return;
	}
	await start(serverPath);
}

/** Stops the language client on extension shutdown. */
export async function deactivate(): Promise<void> {
	await stop();
}
