/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Miniature-artist mode — the STAGE.
//
// A mode, not a layout tweak: you enter it, the workbench rearranges around one
// component rendering center-stage, and you leave it and get your workbench back.
// The arrangement it asks for (WO-MA-R1 target geometry) is
//
//     +-------------+---------------------------------+------------------+
//     | component   |                                 |  OrderRow.tsx    |
//     | tree (thin) |      <component center-stage>   +------------------+
//     |  (sidebar)  |      [props|breakpoints] dock   |  OrderRow.css    |
//     +-------------+---------------------------------+------------------+
//
// which is the ORDINARY isolation trio with its columns transposed: the canvas
// takes column one, the source and stylesheet stack on the right (or stand
// beside each other there, under `sourceSplit: sideBySide`). The tree is
// the existing Components view in the sidebar, not an editor group, so the
// editor grid is two top-level groups and the nested one holds the pair.
//
// The mode does NOT open that tree, and `enter` explains why — under
// `sessions.layout.perActivityEditorSets` a composite switch swaps the editor
// set out from under the canvas. The tree is where it always was; the mode
// simply leaves the sidebar alone, as it leaves all chrome alone.
//
// Everything here is layer 4. The one element of the target geometry that has no
// extension-level host — a breadcrumb bar spanning the whole stage — is drawn
// inside the canvas webview instead (isolation.ts `buildPreviewHtml`), which is
// why this file has no bar of its own. See .claude/reports/miniature-artist/
// 03-stage-layout.md §3.1 for why that is not a shortcut but the only option
// short of a sixteenth core patch against a ledger that is full.

import * as vscode from 'vscode';
import { SourceSplit, trioLayoutTree } from './trioLogic';

/** Set on the workbench so `when` clauses can tell stage mode from ordinary
 *  isolation. Named for the setting, not the command, because that is what a
 *  reader greps for. */
const STAGE_CONTEXT = 'burrow.frontendDebugger.stage';

let stageOn = false;

/**
 * The editor grid as it was before we touched it, from `vscode.getEditorLayout`.
 *
 * This is the whole reason mode entry is safe. The grid is the ONE part of the
 * workbench an extension can both read and write — chrome visibility is not
 * (`sideBarVisible` / `auxiliaryBarVisible` / `panelVisible` are `when`-clause
 * context keys with no read API), which is why this mode deliberately does not
 * hide any chrome. It cannot promise to give back what it cannot read, so it
 * does not take it. `designLayout` remains for anyone who wants the full-bleed
 * canvas and accepts ⌘B as the way home.
 */
let savedLayout: unknown;

/** Whether stage mode is on. Read by isolation.ts to pick the geometry. */
export function stageActive(): boolean {
	return stageOn;
}

/**
 * How the source and its stylesheet are split — `stacked` (source above the
 * stylesheet) or `sideBySide` (source beside it, a vertical divider between the
 * two). Read per call rather than cached: the setting can change while a
 * component is isolated, and the next rearrange must honour it.
 */
export function sourceSplit(): SourceSplit {
	return vscode.workspace.getConfiguration('burrow.frontendDebugger').get<SourceSplit>('sourceSplit', 'stacked') === 'sideBySide'
		? 'sideBySide'
		: 'stacked';
}

/** The editor-group tree for the isolation trio: the mode and the setting,
 *  handed to the pure geometry in trioLogic.ts (which is where the reasoning —
 *  and the column-numbering contract `trioColumns` below depends on — lives). */
export function trioLayout(hasCss: boolean): unknown {
	return trioLayoutTree(hasCss, stageOn, sourceSplit());
}

/** Which view column each member of the trio belongs in. Mirrors `trioLayout`
 *  — deliberately independent of the split: every shape `trioLayoutTree`
 *  returns numbers the trio the same way. */
export function trioColumns(hasCss: boolean): { tsx: vscode.ViewColumn; css: vscode.ViewColumn; preview: vscode.ViewColumn } {
	if (stageOn) {
		return { tsx: vscode.ViewColumn.Two, css: vscode.ViewColumn.Three, preview: vscode.ViewColumn.One };
	}
	return {
		tsx: vscode.ViewColumn.One,
		css: vscode.ViewColumn.Two,
		preview: hasCss ? vscode.ViewColumn.Three : vscode.ViewColumn.Beside,
	};
}

/**
 * Wire the stage commands up. `rearrange` re-opens the current component so the
 * trio lands in the new columns — passed in rather than imported so this file
 * never depends on isolation.ts, which depends on this one.
 */
export function registerStage(
	deps: { currentFile: () => string | undefined; rearrange: (file: string) => Promise<void> },
): vscode.Disposable {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
	item.command = 'burrow.frontendDebugger.exitStage';
	item.tooltip = 'Miniature-artist mode is on — click to leave and restore your previous editor layout';

	const paint = (label: string | undefined): void => {
		if (!stageOn) {
			item.hide();
			return;
		}
		// Deliberately NOT the target diagram's "merkle-api :8080 · seeded ✓ · pg
		// reset: <mechanism>" row. The frontend debugger does not know the app's
		// backend, and the recon established that merkle has no deterministic
		// reset at all (01-execution-model.md §4.2) — so two of those three fields
		// would be decoration. This says what the stage actually knows.
		item.text = label ? `$(device-camera) Stage — ${label}` : '$(device-camera) Stage';
		item.show();
	};

	const setContext = async (): Promise<void> => {
		try {
			await vscode.commands.executeCommand('setContext', STAGE_CONTEXT, stageOn);
		} catch {
			// a missing context key costs a menu item, never the mode itself
		}
	};

	const enter = async (): Promise<void> => {
		if (stageOn) {
			return;
		}
		// Read the grid BEFORE the first rearrange, and only on a clean entry —
		// re-entering while already staged would overwrite the real snapshot with
		// the stage's own layout and strand the user in it.
		try {
			savedLayout = await vscode.commands.executeCommand('vscode.getEditorLayout');
		} catch {
			savedLayout = undefined;
		}
		stageOn = true;
		await setContext();

		// The thin left column of the target diagram is the existing Components
		// tree, and entering the mode used to reveal it with
		// `burrowComponents.focus`. It does NOT any more, because that call
		// destroys the very thing the mode exists to show.
		//
		// `sessions.layout.perActivityEditorSets` (default TRUE) gives each
		// activity-bar icon its own set of editor tabs and swaps the set on every
		// composite switch. Focusing the Components view IS a composite switch, so
		// the incoming set — empty, on a profile that has never opened that icon —
		// replaces the trio, and the canvas webview is disposed with its group.
		// Measured 2026-08-06 on a wiped user-data-dir, 3/3 runs: `enter:start
		// preFile=Badge.tsx` … 155 ms … `$onDidDisposeWebviewPanel` →
		// `teardownIsolation` … `enter:file=undefined`, leaving one empty group.
		// Warm profiles never showed it, because the composite was already open
		// and the switch was a no-op.
		//
		// So the mode reveals nothing. Whichever icon you entered from stays, and
		// the tree is one click away as it always was.

		const file = deps.currentFile();
		if (file) {
			await deps.rearrange(file);
		}
		paint(file ? labelOf(file) : undefined);
	};

	const exit = async (): Promise<void> => {
		if (!stageOn) {
			return;
		}
		stageOn = false;
		await setContext();
		const file = deps.currentFile();
		if (file) {
			// Put the trio back the ordinary way round first, so the restore below
			// is laying a saved grid over a grid of the same shape.
			await deps.rearrange(file);
		}
		if (savedLayout) {
			try {
				await vscode.commands.executeCommand('vscode.setEditorLayout', savedLayout);
			} catch {
				// the grid is a nicety; never trap the user in the mode over it
			}
		}
		savedLayout = undefined;
		paint(undefined);
	};

	// The canvas moves from component to component without the mode changing, so
	// the pill needs a nudge from whoever isolated. There is no workbench event
	// for "the isolation canvas changed" to subscribe to instead.
	paintPill = () => paint(labelOfOrUndefined(deps.currentFile()));

	return vscode.Disposable.from(
		item,
		vscode.commands.registerCommand('burrow.frontendDebugger.enterStage', () => enter()),
		vscode.commands.registerCommand('burrow.frontendDebugger.exitStage', () => exit()),
		vscode.commands.registerCommand('burrow.frontendDebugger.toggleStage', () => (stageOn ? exit() : enter())),
		new vscode.Disposable(() => {
			// Deactivation leaves no stage behind: a stale `stageOn` would give the
			// next activation the transposed geometry with no way to turn it off.
			stageOn = false;
			savedLayout = undefined;
			paintPill = () => undefined;
		}),
	);
}

/** Set by `registerStage`; nothing outside this file touches it. */
let paintPill: () => void = () => undefined;

/** Repaint the stage pill — call after the canvas changes component. No-op
 *  until `registerStage` has run, and while the mode is off. */
export function refreshStagePill(): void {
	paintPill();
}

function labelOf(file: string): string {
	const base = file.split(/[\\/]/).pop() ?? file;
	return base.replace(/\.[jt]sx?$/, '');
}

function labelOfOrUndefined(file: string | undefined): string | undefined {
	return file ? labelOf(file) : undefined;
}
