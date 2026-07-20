/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// codelens.ts — the in-editor "Send Request" codelens (architecture task 09, task 3:
// the "in-editor face"). It parses the open `.http` document and drops a Send codelens
// on each `METHOD URL` line, wired to `burrow.http.send` with the document URI and the
// request's line so the workbench sends exactly that request.

import { CancellationToken, CodeLens, CodeLensProvider, Range, TextDocument } from 'vscode';
import { parseHttpFile } from './httpFile';

/** Emits a Send codelens above every request in a `.http` document. */
export class HttpCodeLensProvider implements CodeLensProvider {
	/**
	 * Parse `document` and return one Send codelens per request, anchored to the
	 * request line. The command carries the URI and line so the handler re-reads the
	 * live document rather than trusting a stale snapshot.
	 */
	public provideCodeLenses(document: TextDocument, _token: CancellationToken): CodeLens[] {
		const parsed = parseHttpFile(document.getText());
		return parsed.requests.map(request => new CodeLens(
			new Range(request.line, 0, request.line, 0),
			{
				title: '$(play) Send Request',
				command: 'burrow.http.send',
				arguments: [document.uri, request.line],
			},
		));
	}
}
