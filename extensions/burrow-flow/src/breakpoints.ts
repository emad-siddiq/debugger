/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// breakpoints.ts — symbol-anchored breakpoints, ported behavior-for-behavior
// from the retiring nodewatch-debugger extension (extension/src/routesTree.ts).
// The anchor is the handler SYMBOL via gopls DocumentSymbols (retried — gopls
// needs a beat after a cold open), falling back to a FunctionBreakpoint that
// fires by name. No line numbers are ever stored — flows.json line positions
// are used only to reveal, never to anchor.

import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Match gopls document symbols against a handler label. Top-level funcs come
 * back as `CreateNode`; methods as `(*H).CreateNode` — compare the bare name.
 */
export function findHandlerSymbol(symbols: vscode.DocumentSymbol[], handler: string): vscode.DocumentSymbol | null {
	const want = handler.split('.').pop() || handler;
	for (const s of symbols) {
		const bare = s.name.replace(/^\([^)]*\)\.?\s*/, '');
		if (
			(s.kind === vscode.SymbolKind.Function || s.kind === vscode.SymbolKind.Method) &&
			(bare === want || s.name === want || s.name.endsWith('.' + want))
		) {
			return s;
		}
		const inner = findHandlerSymbol(s.children || [], handler);
		if (inner) {
			return inner;
		}
	}
	return null;
}

async function documentSymbolsWithRetry(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
	for (let attempt = 0; attempt < 4; attempt++) {
		const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
			'vscode.executeDocumentSymbolProvider',
			uri,
		);
		if (symbols && symbols.length) {
			return symbols;
		}
		await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
	}
	return [];
}

/** Open a backend-relative file and reveal the named symbol (or a line fallback). */
export async function openSymbol(backendDir: string, file: string, symbolLabel: string, fallbackLine?: number): Promise<vscode.TextEditor | undefined> {
	const uri = vscode.Uri.file(path.join(backendDir, file));
	let doc: vscode.TextDocument;
	try {
		doc = await vscode.workspace.openTextDocument(uri);
	} catch {
		void vscode.window.showWarningMessage(`File not found: ${file} — refresh the flows?`);
		return undefined;
	}
	const editor = await vscode.window.showTextDocument(doc, { preview: false });
	const symbol = findHandlerSymbol(await documentSymbolsWithRetry(uri), symbolLabel);
	if (symbol) {
		editor.revealRange(symbol.selectionRange, vscode.TextEditorRevealType.InCenter);
		editor.selection = new vscode.Selection(symbol.selectionRange.start, symbol.selectionRange.start);
	} else if (fallbackLine && fallbackLine > 0) {
		const pos = new vscode.Position(fallbackLine - 1, 0);
		editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
		editor.selection = new vscode.Selection(pos, pos);
	}
	return editor;
}

/** Arm a breakpoint anchored to the handler symbol; FunctionBreakpoint fallback. */
export async function armSymbolBreakpoint(backendDir: string, file: string, handlerLabel: string): Promise<void> {
	const uri = vscode.Uri.file(path.join(backendDir, file));
	let editor: vscode.TextEditor | undefined;
	try {
		const doc = await vscode.workspace.openTextDocument(uri);
		editor = await vscode.window.showTextDocument(doc, { preview: false });
	} catch {
		void vscode.window.showWarningMessage(`Handler file not found: ${file} — refresh the flows?`);
		return;
	}
	const symbol = findHandlerSymbol(await documentSymbolsWithRetry(uri), handlerLabel);
	if (symbol) {
		const pos = symbol.selectionRange.start;
		editor.revealRange(symbol.selectionRange, vscode.TextEditorRevealType.InCenter);
		editor.selection = new vscode.Selection(pos, pos);
		vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(uri, pos))]);
		void vscode.window.showInformationMessage(`Breakpoint armed on ${handlerLabel} (${file})`);
	} else {
		const name = handlerLabel.split('.').pop() || handlerLabel;
		vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint(name)]);
		void vscode.window.showInformationMessage(
			`Function breakpoint armed on ${name} (symbols unavailable — is gopls still indexing?)`,
		);
	}
}
