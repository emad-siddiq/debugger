/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import {
	ExtensionContext,
	Hover,
	HoverProvider,
	MarkdownString,
	Position,
	ProviderResult,
	TextDocument,
	TextEditor,
	commands,
	languages,
	window,
} from 'vscode';
import { detachable } from './toolSurface';
import { DOCS_VIEW_TYPE, DocViewer } from './viewer';
import { parseDocTarget } from './godoc';
import { GoplsWebPage, GoplsWebPanel, WEB_VIEW_TYPE } from './webPanel';
import { registerBrowseCommand } from './browse';

// burrow-go-docs — offline Go docs + hover → fullscreen viewer (architecture
// task 07). This FIRST SLICE ships the core deliverable: the `burrow.goDocs.open`
// command shells the workspace's own Go toolchain (`go doc <pkg>` / `<pkg>.<sym>`)
// and renders the result in a maximized, Esc/✕-dismissable webview editor tab
// (viewer.ts) that restores the launching editor + cursor on close. Parsing and
// HTML rendering are the vscode-free, unit-tested core (godoc.ts); the toolchain
// call is the lone child_process boundary (runner.ts). A lightweight hover adds
// the design's "Open Go docs ⤢" affordance. Deferred to later slices: the
// prebuilt stdlib bundle, dependency indexer, gopls-canonicalized symbols, and
// ⌘K fuzzy search (the slice's search box re-runs `go doc` directly).

const GO = 'go';

/** Identifier-ish token the doc commands seed from (allows `pkg/path` and dots). */
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_./]*/;

/**
 * Activate the extension: register the open command, its keybinding target, and
 * the hover affordance.
 * @param context The extension context whose subscriptions own our disposables.
 */
export function activate(context: ExtensionContext): void {
	const viewer = new DocViewer();
	// gopls' own web views (webPanel.ts) sit beside the offline reader rather than
	// replacing it: this one is prettier and cross-linked, that one works with no
	// server running and renders in Burrow's own type. Neither subsumes the other.
	const web = new GoplsWebPanel();
	context.subscriptions.push(
		viewer,
		web,
		// Called by burrow-go-base when gopls asks the editor to open one of its
		// pages. Not in the palette — its argument is a parsed page object, so a
		// reader invoking it by hand has nothing useful to pass.
		commands.registerCommand('burrow.goDocs.openWeb', (page: GoplsWebPage) => web.show(page)),
		// Pop out / dock (patches/0016). Reference on a second monitor is the whole
		// point of a docs pane, so both readers register.
		detachable(DOCS_VIEW_TYPE),
		detachable(WEB_VIEW_TYPE),
		registerBrowseCommand(),
		// NO `claimSurface` here, and the claim it used to make was `files`.
		//
		// The claim predates patch 0014. Its job — tidy this tab when another tool
		// takes over the editor area — is now the per-rail editor sets', and two
		// mechanisms on one tab do not compose: the viewer has no rail of its own,
		// so it lives in the set of whichever rail was active when you opened it,
		// while the claim closed it 300 ms after ANY switch to a rail that is not
		// "files". Returning to its own rail revived it and the sweep shot it
		// again. Measured by P2-12, 2026-07-29: three failures, all this.
		//
		// burrow-scratch's step page reached the same conclusion for the same
		// reason (see the comment beside its own missing claim).
		//
		// Panel persistence (WO-60): the viewer comes back at the symbol you were
		// reading, with its back stack, and re-renders offline.
		viewer.register(),
		commands.registerCommand('burrow.goDocs.open', (arg?: unknown) =>
			openDocs(viewer, typeof arg === 'string' ? arg : undefined)),
		languages.registerHoverProvider(GO, new GoDocHoverProvider()),
	);
}

export function deactivate(): void {
	// The viewer and its listeners are disposed via context.subscriptions.
}

/**
 * Resolve a target and open the viewer. With no argument, prompts (seeded from the
 * identifier under the cursor); with a string argument (from the hover link),
 * opens it directly.
 * @param viewer The shared doc viewer.
 * @param initial A pre-resolved target string, or undefined to prompt.
 */
async function openDocs(viewer: DocViewer, initial?: string): Promise<void> {
	let input = initial;
	if (!input) {
		const editor = window.activeTextEditor;
		const seed = editor && editor.document.languageId === GO ? wordUnderCursor(editor) : undefined;
		input = await window.showInputBox({
			title: 'Go Docs',
			prompt: 'Package or symbol — e.g. net/http · fmt.Println · net/http.Request.ParseForm',
			value: seed ?? '',
			ignoreFocusOut: true,
		});
	}
	if (!input) {
		return;
	}
	const target = parseDocTarget(input);
	if (target) {
		await viewer.open(target);
	}
}

/** The identifier under the editor's cursor, if any. */
function wordUnderCursor(editor: TextEditor): string | undefined {
	const range = editor.document.getWordRangeAtPosition(editor.selection.active, IDENTIFIER);
	return range ? editor.document.getText(range) : undefined;
}

/**
 * A minimal hover that appends the design's "Open Go docs ⤢" affordance. It runs
 * alongside gopls's own hover (the workbench merges hovers) and links to
 * `burrow.goDocs.open` with the hovered identifier as the seed.
 */
class GoDocHoverProvider implements HoverProvider {
	provideHover(document: TextDocument, position: Position): ProviderResult<Hover> {
		const range = document.getWordRangeAtPosition(position, IDENTIFIER);
		if (!range) {
			return undefined;
		}
		const word = document.getText(range);
		if (!word) {
			return undefined;
		}
		const arg = encodeURIComponent(JSON.stringify(word));
		const md = new MarkdownString(`[Open Go docs ⤢](command:burrow.goDocs.open?${arg} "Open the offline Go docs viewer")`);
		md.isTrusted = true;
		return new Hover(md, range);
	}
}
