/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, commands, window } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import { resolveGopls } from './gopls';

// burrow-go-base is the first slice of architecture task 03: a minimal, from-scratch
// gopls language client — deliberately NOT a vendored golang/vscode-go — so it stays
// cheap to re-pin against each 1.128-era API. It has one job: start the host `gopls`
// as an LSP server over stdio so hover, go-to-definition, find-references and
// goimports format-on-save work in-tree, and so burrow-go-nav's
// `executeWorkspaceSymbolProvider` calls actually resolve. Tool management (a pinned
// gopls installed by Burrow) is slice 2; here gopls is resolved from the host.

const RESTART_COMMAND = 'burrow.go.restartLanguageServer';

// Module-scoped so the restart command and deactivate() can reach the running
// client. Single window, single client — no need for a per-workspace map.
let client: LanguageClient | undefined;

/**
 * Resolves the host `gopls`, builds a {@link LanguageClient} that spawns it over
 * stdio, starts it, and registers the client plus the restart command as
 * disposables. If no `gopls` is found, shows a single actionable message and
 * returns without registering anything — no repeating nag, no auto-install
 * prompt (tool management is architecture task 03, slice 2).
 */
export async function activate(context: ExtensionContext): Promise<void> {
	const goplsPath = resolveGopls(process.env);
	if (!goplsPath) {
		// One actionable message, shown once at activation. We do not poll, retry,
		// or offer to install — the tool manager owns provisioning in slice 2.
		void window.showErrorMessage(
			'Burrow: gopls (the Go language server) was not found. Install it with `go install golang.org/x/tools/gopls@latest`, or set BURROW_GOPLS_PATH to its location, then run "Burrow: Restart Go Language Server".',
		);
		// Still register the restart command so the user can retry after installing.
		context.subscriptions.push(commands.registerCommand(RESTART_COMMAND, restart));
		return;
	}

	context.subscriptions.push(commands.registerCommand(RESTART_COMMAND, restart));
	await start(goplsPath);
	// Stop the client when the extension is deactivated / subscriptions dispose.
	context.subscriptions.push({ dispose: () => void stop() });
}

/**
 * Builds and starts a gopls-backed language client. `gopls` with no subcommand
 * defaults to `serve` (LSP over stdio), so we spawn it with no args. `run` and
 * `debug` are identical — there is no separate debug build of gopls to point at.
 *
 * `transport` is deliberately OMITTED, not set to `TransportKind.stdio`. For an
 * `Executable`, vscode-languageclient appends `--stdio` to argv when transport is
 * that kind (node/main.js) — a flag the node-based language servers expect but a
 * native `gopls` binary rejects ("flag provided but not defined: -stdio"), which
 * kills the connection during `initialize`. With transport undefined the client
 * spawns the command and talks over its raw stdio, which is exactly gopls' model.
 */
async function start(goplsPath: string): Promise<void> {
	const serverOptions: ServerOptions = {
		run: { command: goplsPath, args: [] },
		debug: { command: goplsPath, args: [] },
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ scheme: 'file', language: 'go' },
			{ scheme: 'file', pattern: '**/go.mod' },
			{ scheme: 'file', pattern: '**/go.sum' },
			{ scheme: 'file', pattern: '**/go.work' },
		],
	};

	client = new LanguageClient('burrowGo', 'Burrow Go Language Server', serverOptions, clientOptions);
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
 * Restarts the language server: stop the current client, re-resolve `gopls`
 * (so a freshly installed binary is picked up), and start again. Surfaces the
 * same single actionable message if `gopls` is still missing.
 */
async function restart(): Promise<void> {
	await stop();
	const goplsPath = resolveGopls(process.env);
	if (!goplsPath) {
		void window.showErrorMessage(
			'Burrow: gopls (the Go language server) was not found. Install it with `go install golang.org/x/tools/gopls@latest`, or set BURROW_GOPLS_PATH to its location.',
		);
		return;
	}
	await start(goplsPath);
}

/** Stops the language client on extension shutdown. */
export async function deactivate(): Promise<void> {
	await stop();
}
