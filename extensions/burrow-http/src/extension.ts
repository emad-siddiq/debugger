/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, TextDocument, Uri, commands, languages, window, workspace } from 'vscode';
import { HttpCodeLensProvider } from './codelens';
import { HttpWorkbench } from './workbench';

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

	context.subscriptions.push(
		workbench,
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
	);
}

export function deactivate(): void {
	// The workbench panel and its listeners are disposed via context.subscriptions.
}
