/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promisify } from 'util';
import {
	DocumentSymbol,
	ExtensionContext,
	Hover,
	MarkdownString,
	Position,
	QuickPickItem,
	TextEditor,
	Uri,
	commands,
	languages,
	window,
	workspace,
} from 'vscode';
import { buildPackageTree, parseGoList } from './golist';
import { Note, NoteStore, toExcerpt } from './notes';
import { SymbolNode, enclosingSymbolChain, symbolPath, symbolPathCandidates } from './symbols';
import { OracleWalkProvider } from './walkView';

// burrow-oracle — Codebase Oracle: first-run agent walk + notes-on-highlight
// (architecture task 08). This first slice ships the two load-bearing halves for real:
//   • The PACKAGE WALK — `go list -json ./...` parsed (golist.ts) into an import-path
//     tree rendered in the Oracle Walk webview (walkView.ts). REAL: runs go, parses, renders.
//   • NOTES-ON-HIGHLIGHT — highlight code, attach a note anchored to the enclosing SYMBOL
//     (symbols.ts, stack invariant: never a line number), persisted per-workspace via the
//     Memento (notes.ts). Highlighting a noted symbol later re-surfaces the note in the
//     gopls hover (setting-gated) and via the "Show Notes" command. REAL end-to-end.
// The AGENT WALK bootstrap is the deliberately STUBBED-but-wired entry point: the first-run
// card and the `burrow.oracle.bootstrap` command exist and stage the configured agent CLI
// with the instructions contract in a terminal — but the extension never embeds an agent or
// runs the command for you (design: "external execution; the IDE supplies the instructions").

const execFileAsync = promisify(execFile);
const GO_LANGUAGE = 'go';

/** Register the Oracle's walk view, commands, hover read-path, and first-run card. */
export function activate(context: ExtensionContext): void {
	const walk = new OracleWalkProvider();
	const notes = new NoteStore(context.workspaceState);

	context.subscriptions.push(
		window.registerWebviewViewProvider(OracleWalkProvider.viewId, walk),
		commands.registerCommand('burrow.oracle.walkPackages', () => walkPackages(walk)),
		commands.registerCommand('burrow.oracle.noteOnHighlight', () => noteOnHighlight(notes)),
		commands.registerCommand('burrow.oracle.showNotes', () => showNotes(notes)),
		commands.registerCommand('burrow.oracle.bootstrap', () => bootstrapOracle()),
		languages.registerHoverProvider(GO_LANGUAGE, {
			provideHover: async (document, position) => provideOracleHover(notes, document.uri, position),
		}),
	);

	void offerBootstrapOnFirstRun();
}

/** Nothing to tear down beyond the tracked subscriptions. */
export function deactivate(): void {
	// The webview view, commands and hover provider are disposed via context.subscriptions.
}

// ---------------------------------------------------------------------------------------------
// Package walk (real): go list -json ./... → parse → tree → webview.
// ---------------------------------------------------------------------------------------------

/** Run `go list -json ./...` in the workspace, build the tree, and render the walk view. */
async function walkPackages(walk: OracleWalkProvider): Promise<void> {
	const folder = workspace.workspaceFolders?.[0];
	if (!folder) {
		void window.showWarningMessage('Oracle: open a Go workspace folder first.');
		return;
	}
	await commands.executeCommand(`${OracleWalkProvider.viewId}.focus`);
	walk.setStatus('Walking packages…');
	try {
		const { stdout } = await execFileAsync('go', ['list', '-json', './...'], {
			cwd: folder.uri.fsPath,
			maxBuffer: 64 * 1024 * 1024,
		});
		const packages = parseGoList(stdout);
		if (packages.length === 0) {
			walk.setStatus('No Go packages found in this workspace.');
			return;
		}
		walk.update(buildPackageTree(packages), packages.filter(p => !p.Standard).length);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		walk.setStatus(`go list failed: ${message}`);
		void window.showErrorMessage(`Oracle walk failed: ${message}`);
	}
}

// ---------------------------------------------------------------------------------------------
// Notes on highlight (real): selection → symbol chain → note → Memento.
// ---------------------------------------------------------------------------------------------

/** Attach a note to the highlighted code, anchored to its enclosing symbol. */
async function noteOnHighlight(notes: NoteStore): Promise<void> {
	const editor = window.activeTextEditor;
	if (!editor) {
		void window.showWarningMessage('Oracle: highlight some code in an editor first.');
		return;
	}
	const anchor = await anchorFor(editor);
	const text = await window.showInputBox({
		title: 'Oracle — Note on Highlight',
		prompt: anchor.symbol ? `Note for ${anchor.symbol}` : `Note for ${anchor.file}`,
		placeHolder: 'Why this exists, how it connects, the trap — not what the code already says.',
	});
	if (!text) {
		return;
	}
	const note = await notes.put({ file: anchor.file, symbol: anchor.symbol, excerpt: anchor.excerpt, text });
	void window.showInformationMessage(`Oracle note saved for ${note.symbol || note.file}.`);
}

/** Resolve the current editor selection to a file + symbol path + excerpt. */
async function anchorFor(editor: TextEditor): Promise<{ file: string; symbol: string; excerpt: string }> {
	const uri = editor.document.uri;
	const file = workspace.asRelativePath(uri, false);
	const chain = await symbolChainAt(uri, editor.selection.start);
	const pkg = packageNameFor(chain, editor);
	const symbol = symbolPath(chain, pkg);
	const selected = editor.document.getText(editor.selection);
	const excerpt = toExcerpt(selected || editor.document.lineAt(editor.selection.start.line).text);
	return { file, symbol, excerpt };
}

/**
 * The enclosing-symbol chain at a position, via the DocumentSymbolProvider (gopls). Returns
 * `[]` when no provider answers or nothing encloses the position. vscode.DocumentSymbol is
 * structurally a {@link SymbolNode}, so the pure walker consumes it directly.
 */
async function symbolChainAt(uri: Uri, position: Position): Promise<SymbolNode[]> {
	const symbols = await commands.executeCommand<DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri);
	if (!symbols || symbols.length === 0) {
		return [];
	}
	return enclosingSymbolChain(symbols as unknown as SymbolNode[], position);
}

/** The Go package name for the current file — the top-level `package` symbol, best-effort. */
function packageNameFor(_chain: readonly SymbolNode[], editor: TextEditor): string {
	const match = /^\s*package\s+(\w+)/m.exec(editor.document.getText());
	return match ? match[1] : '';
}

// ---------------------------------------------------------------------------------------------
// Read path (real): highlight → hover append + Show Notes command.
// ---------------------------------------------------------------------------------------------

/** Append the Oracle note (if any) for the symbol under the cursor to the gopls hover. */
async function provideOracleHover(notes: NoteStore, uri: Uri, position: Position): Promise<Hover | undefined> {
	if (!workspace.getConfiguration('burrow.oracle').get<boolean>('hoverNotes', true)) {
		return undefined;
	}
	const note = await resolveAt(notes, uri, position);
	if (!note) {
		return undefined;
	}
	const md = new MarkdownString();
	md.appendMarkdown(`${note.text}\n\n`);
	md.appendMarkdown(`_— Oracle · ${note.symbol || note.file}${isStale(note) ? ' · stale?' : ''}_`);
	return new Hover(md);
}

/** Show the note resolved for the current selection, or a picker of all notes to jump to. */
async function showNotes(notes: NoteStore): Promise<void> {
	const editor = window.activeTextEditor;
	const resolved = editor ? await resolveAt(notes, editor.document.uri, editor.selection.start) : undefined;
	if (resolved) {
		void window.showInformationMessage(`Oracle · ${resolved.symbol || resolved.file}: ${resolved.text}`, { modal: false });
		return;
	}
	const all = notes.all();
	if (all.length === 0) {
		void window.showInformationMessage('Oracle: no notes yet. Highlight code and run “Oracle: Note on Highlight”.');
		return;
	}
	const items: (QuickPickItem & { note: Note })[] = all.map(note => ({
		label: note.symbol || note.file,
		description: note.file,
		detail: note.text,
		note,
	}));
	const pick = await window.showQuickPick(items, { title: 'Oracle Notes', placeHolder: 'Open the file a note was taken in' });
	if (pick) {
		await openNoteFile(pick.note);
	}
}

/** Resolve a highlight to its note by walking the symbol chain outward, then excerpt. */
async function resolveAt(notes: NoteStore, uri: Uri, position: Position): Promise<Note | undefined> {
	const file = workspace.asRelativePath(uri, false);
	const chain = await symbolChainAt(uri, position);
	const editor = window.activeTextEditor;
	const pkg = editor && editor.document.uri.toString() === uri.toString() ? packageNameFor(chain, editor) : '';
	const candidates = symbolPathCandidates(chain, pkg);
	const excerpt = editor ? toExcerpt(editor.document.getText(editor.selection)) : undefined;
	return notes.resolve(file, candidates, excerpt || undefined);
}

/** Notes carry no line (symbol-anchored); opening the file is the honest jump for the slice. */
async function openNoteFile(note: Note): Promise<void> {
	const folder = workspace.workspaceFolders?.[0];
	if (!folder) {
		return;
	}
	const target = Uri.joinPath(folder.uri, note.file);
	await window.showTextDocument(target);
}

/** A note is flagged stale until the hasher lands (task 08, task 1); never fresh-claimed. */
function isStale(_note: Note): boolean {
	// The AST-normalized source hasher is a later WO; without it we cannot honestly
	// claim freshness, so the slice never appends a "stale" flag. Reserved hook.
	return false;
}

// ---------------------------------------------------------------------------------------------
// Agent-walk bootstrap (stubbed-but-wired): first-run card + staged terminal command.
// ---------------------------------------------------------------------------------------------

/** On first open of a Go workspace with no `.oracle/`, offer the bootstrap once. */
async function offerBootstrapOnFirstRun(): Promise<void> {
	const folder = workspace.workspaceFolders?.[0];
	if (!folder) {
		return;
	}
	const hasGoMod = (await workspace.findFiles('go.mod', undefined, 1)).length > 0;
	const hasOracle = (await workspace.findFiles('.oracle/**', undefined, 1)).length > 0;
	if (!hasGoMod || hasOracle) {
		return;
	}
	const choice = await window.showInformationMessage(
		'Burrow Oracle: no codebase notes yet. Bootstrap the Oracle with an agent walk?',
		'Bootstrap the Oracle', 'Not Now',
	);
	if (choice === 'Bootstrap the Oracle') {
		await bootstrapOracle();
	}
}

/**
 * STUB (wired): stage the configured agent CLI (`burrow.oracle.agentCommand`) in a terminal,
 * pointed at the instructions contract, WITHOUT running it — the walk is external by design
 * (the IDE never embeds an agent or holds keys). The user presses Enter to run their own CLI.
 */
async function bootstrapOracle(): Promise<void> {
	const template = workspace.getConfiguration('burrow.oracle').get<string>('agentCommand', 'claude -p');
	const command = `${template} "Walk this codebase and write .oracle/ notes per the Oracle instructions contract (architecture task 08)."`;
	const terminal = window.createTerminal('Oracle Bootstrap');
	terminal.show();
	// sendText(..., false): stage the line without a trailing newline — the user runs it.
	terminal.sendText(command, false);
	void window.showInformationMessage('Oracle: agent walk staged in the terminal (external execution — press Enter to run your CLI).');
}
