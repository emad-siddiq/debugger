/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, Uri, commands, window, workspace } from 'vscode';
import {
	DidChangeConfigurationNotification,
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
} from 'vscode-languageclient/node';
import { resolveGopls } from './gopls';
import { buildGoplsSettings } from './settings';

// burrow-go-base is architecture task 03's language-client slice: a minimal,
// from-scratch gopls client — deliberately NOT a vendored golang/vscode-go — so it
// stays cheap to re-pin against each 1.128-era API. It starts the host `gopls` as an
// LSP server over stdio so hover, go-to-definition, find-references and goimports
// format-on-save work in-tree, and so burrow-go-nav's
// `executeWorkspaceSymbolProvider` calls actually resolve.
//
// It also carries gopls' settings, which is the second half of the same job and was
// missing until `settings.ts` existed: gopls' analysers, code lenses and inlay hints
// are all configuration, so a client that passes no configuration ships a language
// server with most of itself switched off. See `settings.ts` for what is passed and
// why, and the `middleware.workspace.configuration` hook below for how gopls asks.
//
// Tool management (a pinned gopls installed by Burrow rather than resolved from the
// host) is still a later slice.

const RESTART_COMMAND = 'burrow.go.restartLanguageServer';

/** The workbench section every gopls setting is read from. */
const CONFIG_SECTION = 'burrow.go';

/** The section name gopls asks for in its `workspace/configuration` pulls. */
const GOPLS_SECTION = 'gopls';

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

	// gopls caches the answer to each `workspace/configuration` pull, so editing a
	// `burrow.go.*` setting changes nothing until the server is told the cache is
	// stale. The LSP way to say that is an empty didChangeConfiguration, after
	// which gopls re-pulls and the middleware below answers with the new values —
	// which is why a setting takes effect without "Restart Go Language Server".
	context.subscriptions.push(
		workspace.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration(CONFIG_SECTION)) {
				return;
			}
			void client?.sendNotification(DidChangeConfigurationNotification.type, { settings: {} });
		}),
	);

	// Stop the client when the extension is deactivated / subscriptions dispose.
	context.subscriptions.push({ dispose: () => void stop() });
}

/**
 * Reads the `burrow.go` settings for one scope and maps them to what gopls
 * understands. `scopeUri` is gopls' own per-folder scope, so a multi-root
 * workspace gets each folder's settings rather than the first folder's twice.
 */
function goplsSettingsFor(scopeUri: string | undefined): Record<string, unknown> {
	const resource = scopeUri ? Uri.parse(scopeUri) : undefined;
	const config = workspace.getConfiguration(CONFIG_SECTION, resource);
	return buildGoplsSettings(key => config.get(key));
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
		// What gopls reads at `initialize`, before it can pull anything. It has no
		// scope yet, so this is the workspace-wide answer; the middleware below
		// refines it per folder once gopls starts asking.
		initializationOptions: goplsSettingsFor(undefined),
		middleware: {
			workspace: {
				// gopls does not read `initializationOptions` and stop there — it pulls
				// `workspace/configuration` for the section "gopls" whenever its cache
				// is cold. The default handler would answer from
				// `workspace.getConfiguration('gopls')`, a section Burrow does not
				// contribute, so gopls would be told "{}" and every setting below
				// would be silently ignored. This is the seam that carries them.
				configuration: async (params, token, next) => {
					if (params.items.every(item => item.section === GOPLS_SECTION)) {
						return params.items.map(item => goplsSettingsFor(item.scopeUri));
					}
					// A mixed batch is not ours to answer wholesale: let the default
					// handler resolve the rest, then overwrite only our own entries.
					// `next` may hand back a ResponseError instead of an array, in
					// which case there is nothing to fall back to but null.
					const answered = await next(params, token);
					const fallback = Array.isArray(answered) ? answered : [];
					return params.items.map((item, index) =>
						item.section === GOPLS_SECTION ? goplsSettingsFor(item.scopeUri) : fallback[index] ?? null,
					);
				},
			},
		},
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
