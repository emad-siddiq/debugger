/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, TextDocument, Uri, commands, languages, window, workspace } from 'vscode';
import { HttpCodeLensProvider } from './codelens';
import { convertPostmanCollection } from './postman';
import { RequestsProvider } from './requestsTree';
import { announceOnVisible, claimSurface } from './toolSurface';
import { HTTP_WORKBENCH_VIEW_TYPE, HttpWorkbench } from './workbench';

// burrow-http — the HTTP workbench (architecture task 09), a file-backed Postman-class
// client. This FIRST SLICE ships the vertical spine of tasks 1–4: the pure `.http`
// parser/interpolator (httpFile.ts), a native-fetch send engine (send.ts), the response
// viewer (render.ts), a picker+response webview (workbench.ts) and an in-editor Send
// codelens (codelens.ts). Two commands drive it: `burrow.http.openWorkbench` reveals the
// panel for the active `.http` file; `burrow.http.send` sends one request (from the
// codelens, with a URI + line, or from the palette against the active editor).

const HTTP_SELECTOR = { scheme: 'file', pattern: '**/*.http' };

/** True when the document is a `.http` file (by language id or `.http` extension). */
function isHttpDocument(document: TextDocument): boolean {
	return document.languageId === 'http' || document.uri.path.endsWith('.http');
}

export function activate(context: ExtensionContext): void {
	const workbench = new HttpWorkbench();
	// The API view's Requests section (docs/plans/02 §3.5) — an index of the
	// workspace's .http files and what the last sends answered.
	const requests = new RequestsProvider();
	// Tool-surface isolation (docs/plans/02 §6).
	const requestsView = window.createTreeView(RequestsProvider.viewId, { treeDataProvider: requests });

	context.subscriptions.push(
		workbench,
		requests,
		requestsView,
		announceOnVisible('api', requestsView),
		claimSurface('api', { viewType: HTTP_WORKBENCH_VIEW_TYPE }),
		// Panel persistence (WO-60): the workbench comes back bound to its file
		// with its request picked, and with an empty response pane — restoring a
		// tab never sends anything.
		workbench.register(),
		commands.registerCommand('burrow.http.refreshRequests', () => requests.refresh()),
		languages.registerCodeLensProvider(HTTP_SELECTOR, new HttpCodeLensProvider()),

		// Reveal the workbench for the active `.http` editor.
		commands.registerCommand('burrow.http.openWorkbench', () => {
			const editor = window.activeTextEditor;
			if (!editor || !isHttpDocument(editor.document)) {
				void window.showInformationMessage('Open a .http file to use the HTTP workbench.');
				return;
			}
			workbench.open(editor.document);
		}),

		// Send one request. From the codelens: (uri, line). From the palette: no args,
		// so fall back to the active `.http` editor and open the picker.
		commands.registerCommand('burrow.http.send', async (uri?: Uri, line?: number) => {
			if (uri instanceof Uri && typeof line === 'number') {
				const document = await workspace.openTextDocument(uri);
				workbench.open(document, line);
				return;
			}
			const editor = window.activeTextEditor;
			if (!editor || !isHttpDocument(editor.document)) {
				void window.showInformationMessage('Open a .http file to send a request.');
				return;
			}
			workbench.open(editor.document);
		}),

		// Convert a Postman collection (+ sibling environment, if any) into a
		// `.http` file next to it and open it — repos like merkle document their
		// API as infra/test/*.postman_collection.json.
		commands.registerCommand('burrow.http.importPostman', async (uri?: Uri) => {
			const collectionUri = uri instanceof Uri ? uri : await pickCollection();
			if (!collectionUri) {
				return;
			}
			try {
				const collection = JSON.parse(Buffer.from(await workspace.fs.readFile(collectionUri)).toString('utf8'));
				const environment = await readSiblingEnvironment(collectionUri);
				const http = convertPostmanCollection(collection, environment);
				const target = Uri.file(collectionUri.fsPath.replace(/(\.postman_collection)?\.json$/i, '') + '.http');
				await workspace.fs.writeFile(target, Buffer.from(http, 'utf8'));
				const document = await workspace.openTextDocument(target);
				await window.showTextDocument(document);
			} catch (err) {
				void window.showErrorMessage(`Import Postman collection: ${err instanceof Error ? err.message : String(err)}`);
			}
		}),
	);
}

/** Pick a `*postman_collection.json` from the workspace (auto-picks a lone match). */
async function pickCollection(): Promise<Uri | undefined> {
	const found = await workspace.findFiles('**/*postman_collection.json', '**/node_modules/**', 10);
	if (found.length === 0) {
		void window.showInformationMessage('No *postman_collection.json found in this workspace.');
		return undefined;
	}
	if (found.length === 1) {
		return found[0];
	}
	const picked = await window.showQuickPick(
		found.map(f => ({ label: workspace.asRelativePath(f), uri: f })),
		{ placeHolder: 'Postman collection to convert' },
	);
	return picked?.uri;
}

/** The first `*postman_environment.json` in the collection's own folder, if any. */
async function readSiblingEnvironment(collection: Uri): Promise<object | undefined> {
	const dir = Uri.file(collection.fsPath.replace(/\/[^/]+$/, ''));
	try {
		const entries = await workspace.fs.readDirectory(dir);
		const sibling = entries.find(([name]) => /postman_environment\.json$/i.test(name));
		if (!sibling) {
			return undefined;
		}
		const raw = await workspace.fs.readFile(Uri.joinPath(dir, sibling[0]));
		return JSON.parse(Buffer.from(raw).toString('utf8'));
	} catch {
		return undefined;
	}
}

export function deactivate(): void {
	// The workbench panel and its listeners are disposed via context.subscriptions.
}
