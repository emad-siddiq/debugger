/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { hasSamples } from './gallery';
import { parsePropsSchema, preferredExport, PropSpec } from './propsSkeleton';
import { decideTrio, TrioState } from './trioLogic';
import { makeTypeResolver } from './typeResolver';

// Component-isolation workbench (the Framer-like view). Opens the component's
// REAL source in an editor column (left) and an isolated live preview in a
// webview beside it (right). The preview iframes the target Vite's `__isolate`
// harness (see tools/frontend-debugger/server/inspectorPlugin.js), which mounts
// ONE component alone with a minimal provider shell. Editing the real file →
// save → Vite Fast Refresh → the preview re-renders. Props are edited in ONE
// place — the harness's own props panel (a required-props SKELETON parsed from
// the component's props type seeds the first render; the harness mirrors its
// live props up after every render for Save-as-sample). The harness's 🎯
// Inspect mode sends `reveal` (open the clicked part's JSX + CSS lines) and
// `isolate` (enter a child component) envelopes handled here, and its
// Breakpoints tab sends `revealCss` (open an `@media` block where it was
// authored). Isolating
// component B replaces component A's source/CSS tabs (dirty editors are kept),
// so the editor area always shows exactly one component. The three surfaces are
// ONE workbench in both directions: they open together, and closing any one of
// them closes the other two (see "the trio's lifecycle" below).

/** Where the running sidecar's target dev server lives + the fs allowlist anchor. */
export interface IsolateTarget {
	readonly targetOrigin: string;   // http://127.0.0.1:<targetPort>
	readonly targetBase: string;     // e.g. /watch/app/
	readonly targetDir: string;      // target frontend root (allowlist anchor)
	readonly uiPort: number;         // sidecar UI/API port (samples write-back)
}

/** A request to isolate a component: a file (abs or target-relative), an
 *  optional preferred export, and optional seed props (from a live capture). */
export interface IsolateArgs {
	readonly file: string;
	readonly export?: string;
	readonly props?: unknown;
}

interface IsolateEnvelope {
	readonly __burrowIso?: number;
	readonly type?: string;
	readonly detail?: string | string[] | Record<string, unknown>;
}

let preview: vscode.WebviewPanel | undefined;

// State for the CURRENTLY-isolated component, reset on each isolation:
// the live props the harness mirrors up after every render (the Save-as-sample
// payload), the absolute source + colocated-CSS paths (tab replacement and the
// reveal targets), and the label the envelope handler uses (module-level so
// the ONE panel listener — registered at creation only — always names the
// current component, not a stale one). `isolationGeneration` fences async
// reveal work: responses landing after a re-isolation are dropped.
let currentProps: Record<string, unknown> | undefined;
let currentFile: string | undefined;
let currentCss: string | undefined;
let currentTargetDir: string | undefined;
let currentUiPort = 0;
let currentLabel = '';
let currentExport: string | undefined;
let isolationGeneration = 0;

/** The canvas chrome the harness last reported: stage width, background index,
 *  which dock tab, dock height. Seeded back through the isolate URL so the
 *  workbench comes back looking the way it was left (WO-60). */
export interface IsolateChrome {
	readonly w?: number;
	readonly bg?: number;
	readonly tab?: string;
	readonly panelH?: number;
}
let currentChrome: IsolateChrome | undefined;

export const ISOLATION_VIEW_TYPE = 'burrow.frontendIsolation';

/** What a revived preview carries. The props are the component's OWN inputs,
 *  not data from a server, and they are what makes a restored canvas render the
 *  thing you were looking at rather than an empty skeleton. Capped, because a
 *  panel's state is not a place to keep an unbounded object. */
interface IsolationPanelState {
	/** Target-relative, e.g. `src/primitives/badge/Badge.tsx`. */
	readonly file?: string;
	readonly export?: string;
	readonly props?: Record<string, unknown>;
	readonly chrome?: IsolateChrome;
}

/** Serialized-props ceiling. Beyond this the canvas restores with the type
 *  skeleton instead — a smaller lie than truncating an object mid-key. */
const MAX_PROPS_BYTES = 16_000;

// The trio's lifecycle (see registerIsolationTabs). `trioSeen` is the baseline
// the tab diff runs against; `isolating` is a COUNTER, not a flag, because the
// 🎯 drill-in re-enters openIsolation through the command while one is already
// in flight; `tearingDown` is the cascade's own re-entrance guard; and
// `layoutIsOurs` records that WE set the editor layout, so teardown only ever
// resets a layout this file created.
const TRIO_SETTLE_MS = 150;
let trioSeen: TrioState = { tsx: false, css: false, preview: false };
let trioTimer: ReturnType<typeof setTimeout> | undefined;
let closedColumns: (number | undefined)[] = [];
let openedColumns = new Set<number | undefined>();
let isolating = 0;
let tearingDown = false;
let layoutIsOurs = false;

/** "One component = its tabs only" is opt-out; a user who set `tidyTabs: false`
 *  said leave my tabs alone, and that governs the trio cascade too. */
function tidyEnabled(): boolean {
	return vscode.workspace.getConfiguration('burrow.frontendDebugger').get<boolean>('tidyTabs', true);
}

/**
 * Reveal the component's source on the left and an isolated preview on the
 * right. Reuses the single preview panel across calls (re-pointing it at the
 * new component). No-ops with a warning if the file is not under the target's
 * `src/` (the isolation harness only serves modules from there).
 *
 * The body is wrapped so the trio's tab listener can tell OUR churn (opening
 * three surfaces, closing the previous pair, re-laying out the columns) from a
 * user closing a tab. The guard has to span the whole function — the new source
 * is opened BEFORE the stale pair is closed, and setEditorLayout fires more tab
 * events after that — and no early return may escape it, hence the wrapper
 * rather than a flag set inline.
 */
export async function openIsolation(context: vscode.ExtensionContext, target: IsolateTarget, args: IsolateArgs): Promise<void> {
	isolating++;
	try {
		await openIsolationInner(context, target, args);
	} finally {
		// Re-baseline only once the workbench has settled: every tab event our own
		// opening caused is the NEW normal, never a vanish. Releasing `isolating`
		// in the same tick would let a late $acceptTabOperation land unguarded.
		setTimeout(() => {
			trioSeen = snapshotTrio();
			closedColumns = [];
			openedColumns.clear();
			isolating--;
		}, TRIO_SETTLE_MS);
	}
}

async function openIsolationInner(context: vscode.ExtensionContext, target: IsolateTarget, args: IsolateArgs): Promise<void> {
	const rel = resolveSrcRel(target.targetDir, args.file);
	if (!rel) {
		void vscode.window.showWarningMessage('Frontend Debugger: can only isolate components under the target\'s src/ folder.');
		return;
	}

	const abs = path.join(target.targetDir, rel);
	const previousFile = currentFile;
	const previousCss = currentCss;
	// Tab-tidy (docs/plans/04 §5.2): the isolation trio is a *workspace*, not a
	// growing pile — twenty components should not leave twenty tab pairs behind.
	// Opening as preview tabs makes the workbench itself do most of the work
	// (one preview tab per group, self-replacing, and your first keystroke pins
	// it), so the explicit close below only has to catch what that misses.
	const tidy = tidyEnabled();

	// Left: the real editor. Keeps focus so you can start editing immediately.
	try {
		const doc = await vscode.workspace.openTextDocument(abs);
		await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: tidy });
	} catch (err) {
		void vscode.window.showWarningMessage(`Frontend Debugger: cannot open ${rel} — ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	const cssAbs = findColocatedCss(abs);
	if (cssAbs) {
		try {
			const cssDoc = await vscode.workspace.openTextDocument(cssAbs);
			await vscode.window.showTextDocument(cssDoc, { viewColumn: vscode.ViewColumn.Two, preview: tidy, preserveFocus: true });
		} catch {
			// the stylesheet row is optional
		}
	}

	// One component = its tabs only: with the new component's editors open,
	// close the PREVIOUS component's source/CSS tabs (dirty and pinned editors
	// survive, shared files are kept). Ordered before setEditorLayout — closing
	// can collapse a group and renumber view columns.
	if (tidy) {
		await closeStaleComponentTabs([previousFile, previousCss], new Set([abs, cssAbs].filter((p): p is string => !!p)));
	}

	// Framer-mode "design" layout: an even split — the developer's half on the
	// left, the designer's half on the right. When the component has a colocated
	// stylesheet the left column splits evenly again into source (top) | CSS
	// (bottom), so the four quadrants are equal and markup, styles and the live
	// component are all on one screen. Best-effort — a project that can't set the
	// layout still gets the plain columns.
	try {
		await vscode.commands.executeCommand('vscode.setEditorLayout', cssAbs
			? { orientation: 0, groups: [{ groups: [{ size: 0.5 }, { size: 0.5 }], size: 0.5 }, { size: 0.5 }] }
			: { orientation: 0, groups: [{ size: 0.5 }, { size: 0.5 }] });
		// Only a layout WE set may be reset on teardown — a user who arranged
		// their own columns and then isolated into them is never re-flattened.
		layoutIsOurs = true;
	} catch {
		// layout is a nicety, not a requirement
	}

	// Opt-in only (docs/plans/04 §5.1): isolating a component arranges the
	// columns, it does not take your file tree away. Hiding chrome is Focus
	// Mode's job and Focus Mode gives it back on Esc, whereas this path could
	// not — the workbench exposes no visibility query, so ⌘B / ⌘J were the only
	// way home. Left as a setting for anyone who wants the old Framer-style
	// full-bleed canvas; both columns stay visible either way (no group maximize).
	if (vscode.workspace.getConfiguration('burrow.frontendDebugger').get<boolean>('designLayout', false)) {
		for (const command of ['workbench.action.closeSidebar', 'workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel']) {
			try {
				await vscode.commands.executeCommand(command);
			} catch {
				// chrome-hiding is cosmetic — never block the isolation itself
			}
		}
	}

	// Right: the isolated preview webview.
	const stem = defaultLabel(rel);
	let source: string | undefined;
	try {
		source = fs.readFileSync(abs, 'utf8');
	} catch {
		source = undefined;
	}
	// A gallery click carries no export. When the file has a basename-matching
	// named export and no default, name it explicitly — the harness's fallback
	// (first PascalCase export) can pick the wrong one in a multi-export file.
	let exportName = args.export;
	if (!exportName && source) {
		exportName = preferredExport(source, stem);
	}
	// The typed props schema drives the harness's live props panel; its
	// skeleton (required members, imported types resolved one hop) is the
	// auto-applied seed when there is no capture and no samples file — the
	// first click renders the component instead of a missing-props stack.
	const schema = source ? parsePropsSchema(source, stem, makeTypeResolver(abs, target.targetDir)) : undefined;
	let props = sanitizeProps(args.props);
	// Where the props the harness is about to render came from, so it can label
	// the preview honestly: a live capture from the running app, or values this
	// extension synthesized from the types.
	let propsSource: 'capture' | 'synth' | undefined = Object.keys(props).length ? 'capture' : undefined;
	if (!Object.keys(props).length && schema && schema.required.length && !hasSamples(path.dirname(abs), path.basename(abs))) {
		props = schema.skeleton;
		propsSource = 'synth';
	}
	const url = buildIsolateUrl(target, rel, exportName, props, schema?.specs, propsSource, currentChrome);
	const label = exportName || stem;

	// New component → the previous component's state no longer applies. The
	// harness re-reports `samples`/`props` for this one as it loads.
	currentProps = undefined;
	currentFile = abs;
	currentCss = cssAbs;
	currentTargetDir = target.targetDir;
	currentUiPort = target.uiPort;
	currentLabel = label;
	currentExport = exportName;
	isolationGeneration++;

	const previewColumn = cssAbs ? vscode.ViewColumn.Three : vscode.ViewColumn.Beside;
	if (!preview) {
		preview = vscode.window.createWebviewPanel(
			ISOLATION_VIEW_TYPE,
			`Preview — ${label}`,
			{ viewColumn: previewColumn, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		// The webview closing is one of the three ways into the SAME teardown: it
		// takes the source and CSS with it. onDidDispose is the only route that
		// fires for every way a webview can die (the X, Close All, a core tool
		// sweep), so it stays the trigger and teardownIsolation does the work.
		preview.onDidDispose(() => { void teardownIsolation(); }, undefined, context.subscriptions);
		// ONE listener for the panel's life. It reads module state (currentLabel),
		// so re-isolations must NOT register another — that used to multiply every
		// envelope by the number of isolations.
		preview.webview.onDidReceiveMessage((msg: IsolateEnvelope) => handleEnvelope(msg), undefined, context.subscriptions);
	} else {
		preview.title = `Preview — ${label}`;
		preview.reveal(previewColumn, true);
	}
	preview.webview.html = buildPreviewHtml(target.targetOrigin, url);
}

/**
 * "One component = its tabs only": close the previous component's source/CSS
 * tabs across every group.
 *
 * Three kinds of tab survive, and the reasons differ. **Dirty** ones because
 * closing them would discard unsaved work — that is announced, since a tab
 * staying put when you expected it to go is otherwise just confusing.
 * **Pinned** ones because pinning is the explicit "keep this across tools"
 * gesture (burrow-core's tab registry uses the same rule). And files the NEW
 * component also uses, e.g. a shared stylesheet. The preview webview is never
 * a text input, so it is untouched.
 */
async function closeStaleComponentTabs(stale: readonly (string | undefined)[], keep: ReadonlySet<string>, why: 'stale' | 'teardown' = 'stale'): Promise<void> {
	const staleSet = new Set(stale.filter((p): p is string => !!p && !keep.has(p)));
	if (!staleSet.size) {
		return;
	}
	const mine = vscode.window.tabGroups.all
		.flatMap((group) => group.tabs)
		.filter((tab) => tab.input instanceof vscode.TabInputText && staleSet.has(tab.input.uri.fsPath));
	const kept = mine.filter((tab) => tab.isDirty);
	if (kept.length) {
		const names = kept.map((tab) => path.basename((tab.input as vscode.TabInputText).uri.fsPath)).join(', ');
		// On teardown the asymmetry needs saying out loud: the rest of the
		// workbench went away and this one file did not.
		vscode.window.setStatusBarMessage(why === 'teardown'
			? `Isolation: closed the preview — kept ${names} (unsaved changes)`
			: `Isolation: kept ${names} — unsaved changes`, 4000);
	}
	const tabs = mine.filter((tab) => !tab.isDirty && !tab.isPinned);
	if (!tabs.length) {
		return;
	}
	try {
		await vscode.window.tabGroups.close(tabs, true);
	} catch {
		// leftover tabs are clutter, not a failure — never block the isolation
	}
}

// ---- the trio's lifecycle --------------------------------------------------
// Source, stylesheet and preview are ONE workbench: closing any of the three
// closes the other two. Without this, closing the preview left two orphan
// editors and closing the source left a canvas rendering a file you were no
// longer looking at.
//
// The detection cannot trust the event payload. `onDidChangeTabs` reports no
// close REASON, and opens and closes arrive as separate events, so a group
// merge (isolating a component with no stylesheet drops 3 groups to 2), our own
// re-isolation, and a genuine close are indistinguishable as they land. So the
// event only SCHEDULES; after a settle window we re-read the workbench and diff
// against the last baseline, which makes the first two cases self-cancelling —
// the editors are back by the time we look. Only a preview tab being swapped
// for another file still shows a true vanish, and `openedColumns` catches that.

/** The preview panel's tab. The workbench prefixes panel viewTypes; strip it
 *  rather than matching the prefixed literal (same normalization as
 *  burrow-core's tabFacts) so this survives that being an implementation
 *  detail. */
function isIsolationTab(tab: vscode.Tab): boolean {
	return tab.input instanceof vscode.TabInputWebview
		&& tab.input.viewType.replace(/^mainThreadWebview-/, '') === 'burrow.frontendIsolation';
}

function isTrioTab(tab: vscode.Tab): boolean {
	if (isIsolationTab(tab)) {
		return true;
	}
	return tab.input instanceof vscode.TabInputText
		&& (tab.input.uri.fsPath === currentFile || tab.input.uri.fsPath === currentCss);
}

/** Is this path open in ANY group? A file split across two groups is still
 *  open when one of them closes. */
function isPathOpen(p: string | undefined): boolean {
	return !!p && vscode.window.tabGroups.all.some((group) => group.tabs.some(
		(tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === p));
}

function snapshotTrio(): TrioState {
	return { tsx: isPathOpen(currentFile), css: isPathOpen(currentCss), preview: !!preview };
}

function onTabsChanged(e: vscode.TabChangeEvent): void {
	if (!preview || isolating || tearingDown || !tidyEnabled()) {
		return;
	}
	for (const tab of e.opened) {
		openedColumns.add(tab.group.viewColumn);
	}
	const closed = e.closed.filter(isTrioTab);
	if (!closed.length) {
		return;
	}
	// `tab.group` on a closed tab is still a live ext-host object, but the group
	// itself may be gone — compare view COLUMNS, never identity.
	for (const tab of closed) {
		closedColumns.push(tab.group.viewColumn);
	}
	if (trioTimer) {
		clearTimeout(trioTimer);
	}
	trioTimer = setTimeout(() => void reconcileTrio(), TRIO_SETTLE_MS);
}

async function reconcileTrio(): Promise<void> {
	trioTimer = undefined;
	if (!preview || isolating || tearingDown) {
		return;
	}
	const verdict = decideTrio(trioSeen, snapshotTrio(), closedColumns, openedColumns);
	closedColumns = [];
	openedColumns.clear();
	trioSeen = snapshotTrio();
	if (verdict === 'teardown') {
		await teardownIsolation();
	}
	// idle / replaced / gone: the re-baseline above is the whole response. A
	// replaced member simply drops out of the trio, so closing either survivor
	// still cascades.
}

/**
 * The ONE close path. Every route in — the webview disposing, a source or CSS
 * tab closing — lands here, and this is the only place trio state is torn down.
 *
 * State is cleared BEFORE any closing happens, so the tab events our own closes
 * raise (and the onDidDispose that `panel.dispose()` fires re-entrantly) find
 * `preview === undefined` and return at the first line of onTabsChanged.
 *
 * Dirty and pinned editors survive, as everywhere else in this file — but the
 * preview closes regardless. A WebviewPanel cannot be un-disposed, so letting a
 * dirty file veto the cascade would restore the exact orphan bug on the most
 * common path of all: you edited the file, so of course it is dirty.
 */
async function teardownIsolation(): Promise<void> {
	if (tearingDown) {
		return;
	}
	tearingDown = true;
	const panel = preview;
	const tsx = currentFile;
	const css = currentCss;
	preview = undefined;
	currentProps = undefined;
	currentFile = undefined;
	currentCss = undefined;
	currentLabel = '';
	trioSeen = { tsx: false, css: false, preview: false };
	closedColumns = [];
	openedColumns.clear();
	// Drop in-flight reveal work: a provenance response landing now would open a
	// file into a workbench that no longer exists.
	isolationGeneration++;
	if (trioTimer) {
		clearTimeout(trioTimer);
		trioTimer = undefined;
	}
	try {
		panel?.dispose();
		await closeStaleComponentTabs([tsx, css], new Set(), 'teardown');
		await resetLayoutIfEmpty();
	} finally {
		tearingDown = false;
	}
}

/** Collapse the isolation grid — but ONLY if we set it and nothing else is
 *  open. Deliberately not `editorLayoutSingle`/`joinAllGroups`: those merge the
 *  user's own editors, which is the disturbance this is avoiding. */
async function resetLayoutIfEmpty(): Promise<void> {
	if (!layoutIsOurs) {
		return;
	}
	layoutIsOurs = false;
	if (vscode.window.tabGroups.all.some((group) => group.tabs.length > 0)) {
		return;
	}
	try {
		await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}] });
	} catch {
		// layout is a nicety, not a requirement
	}
}

/** Wire the trio cascade up. Call once from activate; push the result into
 *  `context.subscriptions`.
 *
 *  This used to sweep away any preview tab left by a previous window, because
 *  there was no serializer and the workbench's revive attempt left dead chrome
 *  no handle owned. There is one now (WO-60), so an orphan is a thing to
 *  restore, not to bin. */
export function registerIsolationTabs(): vscode.Disposable {
	return vscode.Disposable.from(
		vscode.window.tabGroups.onDidChangeTabs(onTabsChanged),
		new vscode.Disposable(() => {
			if (trioTimer) {
				clearTimeout(trioTimer);
				trioTimer = undefined;
			}
		}),
	);
}

// ---- persistence (WO-60) ---------------------------------------------------

/** The current workbench as a state blob, target-relative so it survives the
 *  project being checked out somewhere else. */
function isolationState(): IsolationPanelState {
	const rel = currentFile && currentTargetDir
		? path.relative(currentTargetDir, currentFile).split(path.sep).join('/')
		: undefined;
	let props = currentProps;
	if (props && JSON.stringify(props).length > MAX_PROPS_BYTES) {
		// Too big to keep. Dropping them is honest — the harness will re-derive a
		// skeleton from the component's types, exactly as on a first isolate.
		props = undefined;
	}
	return { file: rel && !rel.startsWith('..') ? rel : undefined, export: currentExport, props, chrome: currentChrome };
}

/** Hand the current state to the panel's shim, which owns `setState`. */
function pushIsolationState(): void {
	void preview?.webview.postMessage({ __burrowIsoState: 1, state: isolationState() });
}

/**
 * Bring the isolation workbench back with the rail, a reload and a relaunch
 * (WO-60).
 *
 * Deliberately NOT by calling `openIsolation`: that opens editors, closes the
 * previous component's tabs and re-lays out the columns, which is right when a
 * person asks for a component and wrong during a window restore — the workbench
 * is already putting the source and stylesheet back by itself. So this paints
 * the canvas, adopts the panel, re-baselines the trio, and stops.
 *
 * If the dev server is not running the canvas cannot render anything, and
 * Burrow does not start one because a tab came back. The panel says which
 * component it is for and offers the button that starts it.
 */
export function registerIsolationPanel(
	context: vscode.ExtensionContext,
	resolve: () => IsolateTarget | undefined,
	targetDir: () => string,
): vscode.Disposable {
	return vscode.window.registerWebviewPanelSerializer(ISOLATION_VIEW_TYPE, {
		deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: unknown): Promise<void> => {
			const saved = (state ?? {}) as IsolationPanelState;
			preview?.dispose();
			preview = panel;
			panel.onDidDispose(() => { void teardownIsolation(); }, undefined, context.subscriptions);
			panel.webview.onDidReceiveMessage((msg: IsolateEnvelope) => handleEnvelope(msg), undefined, context.subscriptions);

			const target = resolve();
			const rel = typeof saved.file === 'string' ? saved.file : undefined;
			currentChrome = saved.chrome;
			currentExport = typeof saved.export === 'string' ? saved.export : undefined;
			currentProps = undefined;
			const stem = rel ? (rel.split('/').pop() ?? rel).replace(/\.[jt]sx?$/, '') : 'component';
			currentLabel = currentExport || stem;
			panel.title = `Preview — ${currentLabel}`;

			if (!target || !rel) {
				// The canvas cannot render, but the BUTTON still has to work — so the
				// component is resolved from the configured target anyway. Without
				// this the Start button had nothing to reopen and did nothing.
				const dir = targetDir();
				currentTargetDir = dir || undefined;
				currentFile = rel && dir ? path.join(dir, rel) : undefined;
				currentCss = currentFile ? findColocatedCss(currentFile) : undefined;
				panel.webview.html = disconnectedPreviewHtml(rel, currentLabel, currentFile ? 'nosidecar' : 'nofile', saved);
			} else {
				const abs = path.join(target.targetDir, rel);
				currentFile = abs;
				currentCss = findColocatedCss(abs);
				currentTargetDir = target.targetDir;
				currentUiPort = target.uiPort;
				const props = isRecord(saved.props) ? saved.props : {};
				const url = buildIsolateUrl(target, rel, currentExport, props, undefined, Object.keys(props).length ? 'capture' : undefined, currentChrome);
				panel.webview.html = buildPreviewHtml(target.targetOrigin, url, saved);
			}
			// The restore is the new normal: whatever the workbench put back is the
			// baseline the trio cascade diffs against from here.
			isolationGeneration++;
			trioSeen = snapshotTrio();
			closedColumns = [];
			openedColumns.clear();
		},
	});
}

/**
 * The canvas cannot render: either no dev server is running in this window, or
 * the component the panel was for is not resolvable. Says which, and offers the
 * one click that fixes it (WO-60, "grey with a reason").
 */
function disconnectedPreviewHtml(rel: string | undefined, label: string, why: 'nosidecar' | 'nofile', seed: IsolationPanelState): string {
	const nonce = getNonce();
	const reason = why === 'nosidecar'
		? 'The dev server that serves the isolation canvas is not running in this window. Burrow does not start one because a tab was restored — starting it is a deliberate act.'
		: 'This preview did not record which component it was showing, so there is nothing to put back on the canvas.';
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'">
	<style>
		body { margin: 0; padding: 18px 22px; font: var(--vscode-font-size) var(--vscode-font-family);
			color: var(--vscode-foreground); background: var(--vscode-editor-background); }
		h3 { font-size: 13px; margin: 0 0 8px; }
		p { max-width: 62ch; line-height: 1.55; opacity: .8; font-size: 12px; }
		code { font-family: var(--vscode-editor-font-family); }
		button { font: inherit; font-size: 12px; padding: 3px 11px; border: 0; border-radius: 4px; cursor: pointer;
			color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
	</style>
</head>
<body>
	<h3>${escapeAttr(label)}</h3>
	<p>${escapeAttr(reason)}</p>
	${rel ? `<p><code>${escapeAttr(rel)}</code></p>` : ''}
	${why === 'nosidecar' ? '<button id="start">Start the dev server and isolate it</button>' : ''}
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	vscode.setState(${JSON.stringify(seed)});
	const btn = document.getElementById('start');
	if (btn) { btn.addEventListener('click', () => vscode.postMessage({ __burrowIso: 1, type: 'restore' })); }
	window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { vscode.postMessage({ __burrowIso: 1, type: 'exitFocus' }); } });
</script>
</body>
</html>`;
}

/** Escape text interpolated into the disconnected page. */
function escapeAttr(text: string): string {
	return text.replace(/[&<>"']/g, (ch) => (
		ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
	));
}

/**
 * Persist the preview's live props as a named sample in the component's
 * colocated `<Component>.samples.ts` (created if absent, merged if present),
 * written through the sidecar's allowlisted POST /api/source. The next
 * isolation then renders the first sample by default — a tuned prop set
 * becomes durable, the Framer "set sample props once" workflow.
 */
export async function saveSample(): Promise<void> {
	if (!preview || !currentFile || !currentTargetDir || !currentProps || !Object.keys(currentProps).length) {
		void vscode.window.showInformationMessage('Frontend Debugger: isolate a component (with props applied) first.');
		return;
	}
	const uiPort = currentUiPort;
	if (!uiPort) {
		void vscode.window.showInformationMessage('Frontend Debugger: the sidecar is not running.');
		return;
	}
	const name = await vscode.window.showInputBox({
		title: `Save Props as Sample — ${currentLabel}`,
		value: 'Default',
		prompt: 'Sample name (a key in the samples map).',
		validateInput: (text) => (/^[^'\\]+$/.test(text.trim()) && text.trim() ? undefined : 'Name must be non-empty, without quotes or backslashes.'),
	});
	if (name === undefined) {
		return;
	}
	const stemAbs = currentFile.replace(/\.[jt]sx?$/, '');
	const existingAbs = ['ts', 'tsx', 'js', 'jsx'].map((ext) => `${stemAbs}.samples.${ext}`).find((p) => fs.existsSync(p));
	const targetAbs = existingAbs ?? `${stemAbs}.samples.ts`;
	const rel = path.relative(currentTargetDir, targetAbs).split(path.sep).join('/');
	const entry = `'${name.trim()}': ${JSON.stringify(currentProps, null, 2).replace(/\n/g, '\n  ')},`;

	let content: string;
	if (existingAbs) {
		const current = fs.readFileSync(existingAbs, 'utf8');
		// Insert after the samples map's opening brace (samples named export or a
		// default-exported object) — conservative merge; anything unrecognized is
		// opened for a manual edit instead of a risky rewrite.
		const open = /(export\s+const\s+samples[^=]*=\s*\{|export\s+default\s*\{)/.exec(current);
		if (!open) {
			void vscode.window.showWarningMessage(`Frontend Debugger: couldn't find the samples map in ${path.basename(existingAbs)} — opening it instead.`);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(existingAbs));
			return;
		}
		const at = open.index + open[0].length;
		content = `${current.slice(0, at)}\n  ${entry}${current.slice(at)}`;
	} else {
		content = [
			`// DEV-ONLY: sample prop-sets for ${currentLabel} — the Burrow isolation`,
			`// workbench lists these in its Pick Sample Props picker and renders the`,
			`// first one by default. String value 'ƒ' marks a function prop (stubbed).`,
			`export const samples = {`,
			`  ${entry}`,
			`};`,
			``,
		].join('\n');
	}

	try {
		const res = await fetch(`http://127.0.0.1:${uiPort}/api/source`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ file: rel, content }),
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({})) as { error?: string };
			throw new Error(body.error || `HTTP ${res.status}`);
		}
	} catch (err) {
		void vscode.window.showErrorMessage(`Frontend Debugger: saving the sample failed — ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	vscode.window.setStatusBarMessage(`Isolation: saved sample '${name.trim()}' beside ${currentLabel}`, 4000);
	// The gallery badge and the harness's sample list both key off the file.
	void vscode.commands.executeCommand('burrow.frontendDebugger.refreshComponents');
	void preview.webview.postMessage({ __burrowIsoCmd: 1, type: 'reload' });
}

function handleEnvelope(msg: IsolateEnvelope): void {
	if (!msg || msg.__burrowIso !== 1) {
		return;
	}
	if (msg.type === 'exitFocus') {
		// Esc bridge (docs/plans/01 §4): the harness owns the focused document, so
		// the keystroke reaches the workbench only by this route.
		void vscode.commands.executeCommand('burrow.focus.exit');
		return;
	}
	if (msg.type === 'restore') {
		// The disconnected canvas's own button. Clicking it IS the request to
		// start the dev server, so the full isolate flow runs from here.
		if (currentFile) {
			void vscode.commands.executeCommand('burrow.frontendDebugger.isolate', vscode.Uri.file(currentFile));
		}
		return;
	}
	if (msg.type === 'samples') {
		// The harness found a colocated <Component>.samples.* — its own panel
		// renders the picker; nothing to cache on the extension side anymore.
		return;
	}
	if (msg.type === 'reveal' && isRecord(msg.detail)) {
		// 🎯 Inspect click: open the part's JSX line + its defining CSS rule.
		void revealPick(msg.detail);
		return;
	}
	if (msg.type === 'revealCss' && isRecord(msg.detail) && typeof msg.detail.selector === 'string') {
		// Breakpoints tab click: open the @media block where it was authored.
		void revealMediaBlock(String(msg.detail.selector), typeof msg.detail.media === 'string' ? msg.detail.media : '');
		return;
	}
	if (msg.type === 'isolate' && isRecord(msg.detail) && typeof msg.detail.file === 'string') {
		// 🎯 Inspect drill-in: enter the child component. Route through the
		// public command so the full flow (sidecar ensure, tab replacement,
		// layout) runs. The harness already gates on a src/-relative stamp.
		if (currentTargetDir) {
			const abs = path.join(currentTargetDir, msg.detail.file);
			if (resolveSrcRel(currentTargetDir, abs)) {
				void vscode.commands.executeCommand('burrow.frontendDebugger.isolate', vscode.Uri.file(abs));
			}
		}
		return;
	}
	if (msg.type === 'chrome' && isRecord(msg.detail)) {
		// The canvas chrome changed (viewport preset, background, dock tab or its
		// height). Kept module-side and pushed into the panel's own state, so a
		// rail switch, a reload or a relaunch brings the same canvas back.
		const d = msg.detail;
		currentChrome = {
			w: typeof d.w === 'number' ? d.w : undefined,
			bg: typeof d.bg === 'number' ? d.bg : undefined,
			tab: typeof d.tab === 'string' ? d.tab : undefined,
			panelH: typeof d.panelH === 'number' ? d.panelH : undefined,
		};
		pushIsolationState();
		return;
	}
	if (msg.type === 'props' && msg.detail && typeof msg.detail === 'object' && !Array.isArray(msg.detail)) {
		// The harness mirrors its live props (JSON-safe, 'ƒ' markers intact) after
		// every render — the seed for editProps.
		currentProps = msg.detail;
		pushIsolationState();
		return;
	}
	if (msg.type === 'saveSample') {
		// The panel's 💾 button — persist through the native flow (name prompt +
		// allowlisted write-back). The posted props ARE the latest props mirror,
		// but take them anyway in case the render report is still in flight.
		if (msg.detail && typeof msg.detail === 'object' && !Array.isArray(msg.detail)) {
			currentProps = msg.detail;
		}
		void saveSample();
		return;
	}
	if (msg.type === 'renderError' && typeof msg.detail === 'string') {
		// Surface once — the preview already shows the stack inline; this makes a
		// silently-broken component obvious without staring at the canvas.
		vscode.window.setStatusBarMessage(`Isolation: ${currentLabel} render error`, 4000);
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 🎯 Inspect reveal: the clicked part's stamped JSX location opens (selected)
 * in the source column, and its defining CSS rule — resolved through the
 * sidecar's POST /api/css/provenance from the element's classes — opens in the
 * CSS column. Every reveal keeps focus in the preview (`preserveFocus`), and
 * async work is fenced by `isolationGeneration` so a re-isolation mid-flight
 * drops stale responses instead of revealing the wrong component's files.
 */
async function revealPick(detail: Record<string, unknown>): Promise<void> {
	const generation = isolationGeneration;
	const targetDir = currentTargetDir;
	const file = typeof detail.file === 'string' ? detail.file : '';
	if (!targetDir || !file) {
		return;
	}
	const rel = resolveSrcRel(targetDir, path.join(targetDir, file));
	if (!rel) {
		return;
	}
	const abs = path.join(targetDir, rel);
	const line = typeof detail.line === 'number' ? detail.line : 1;
	const col = typeof detail.col === 'number' ? detail.col : 1;
	try {
		const doc = await vscode.workspace.openTextDocument(abs);
		const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, col - 1));
		if (generation !== isolationGeneration) {
			return;
		}
		await vscode.window.showTextDocument(doc, {
			viewColumn: vscode.ViewColumn.One,
			// A part inside a CHILD component peeks its file; the isolated
			// component's own file stays a pinned tab.
			preview: abs !== currentFile,
			preserveFocus: true,
			selection: new vscode.Range(pos, pos),
		});
	} catch {
		// the JSX side is best-effort; still try the CSS side
	}

	const classes = Array.isArray(detail.classes) ? detail.classes.filter((c): c is string => typeof c === 'string' && !!c) : [];
	if (!classes.length) {
		return;
	}
	// Prefer a rule from the component's own stylesheet — a class also styled by
	// a theme file should reveal where the component defines it.
	const results = await cssProvenance(rel, classes.map((c) => ({ selector: `.${c}` })));
	const hit = results.find((r) => r.origin === 'component') ?? results[0];
	if (hit?.file) {
		await revealCssAt(hit.file, hit.line ?? 1, generation);
	}
}

/**
 * Breakpoints-tab click: reveal where an `@media` block was authored. The CSSOM
 * cannot say — Vite's dev style node names the module that imported the CSS,
 * which for a manifest-style `index.css` is never the file the rule lives in —
 * so the harness sends a selector from inside the block and the sidecar's
 * provenance lookup (which matches on selector AND media) finds the source.
 * Lands on the rule, one line inside the block that was clicked.
 */
async function revealMediaBlock(selector: string, media: string): Promise<void> {
	const generation = isolationGeneration;
	const rel = currentTargetDir && currentFile ? resolveSrcRel(currentTargetDir, currentFile) : undefined;
	const results = await cssProvenance(rel, [{ selector, media }]);
	if (!results[0]?.file) {
		vscode.window.setStatusBarMessage(`Isolation: no source found for ${media}`, 3000);
		return;
	}
	await revealCssAt(results[0].file, results[0].line ?? 1, generation);
}

interface CssProvenanceHit {
	readonly found?: boolean;
	readonly file?: string | null;
	readonly line?: number | null;
	readonly origin?: string;
}

/** Ask the sidecar which authored file:line defines each rule (POST
 *  /api/css/provenance). Returns only the hits; unreachable sidecar → none. */
async function cssProvenance(componentFile: string | undefined, rules: readonly { selector: string; media?: string }[]): Promise<CssProvenanceHit[]> {
	if (!currentUiPort || !rules.length) {
		return [];
	}
	try {
		const res = await fetch(`http://127.0.0.1:${currentUiPort}/api/css/provenance`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ componentFile: componentFile ?? null, rules }),
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) {
			return [];
		}
		const body = await res.json() as { results?: CssProvenanceHit[] };
		return (body.results ?? []).filter((r) => r.found && r.file);
	} catch {
		// no matching rule / sidecar unreachable — callers degrade quietly
		return [];
	}
}

/**
 * Open a stylesheet in the CSS column at one line, focus staying in the
 * preview. Both surfaces that reveal CSS come through here — the 🎯 pick and
 * the Breakpoints tab — so the allowlist, the column, and the pin-vs-peek rule
 * are decided in one place. `file` may be absolute or target-relative; anything
 * outside the target's `src/` is refused.
 */
async function revealCssAt(file: string, line: number, generation: number): Promise<void> {
	const targetDir = currentTargetDir;
	const rel = targetDir ? resolveSrcRel(targetDir, file) : undefined;
	if (!targetDir || !rel) {
		return;
	}
	const abs = path.join(targetDir, rel);
	try {
		const doc = await vscode.workspace.openTextDocument(abs);
		if (generation !== isolationGeneration) {
			return;
		}
		const pos = new vscode.Position(Math.max(0, line - 1), 0);
		await vscode.window.showTextDocument(doc, {
			viewColumn: vscode.ViewColumn.Two,
			// The isolated component's own stylesheet keeps its tab; any other
			// sheet is a peek.
			preview: abs !== currentCss,
			preserveFocus: true,
			selection: new vscode.Range(pos, pos),
		});
	} catch {
		// a stylesheet that moved out from under the preview is not an error
	}
}

/** Resolve a caller path to a target-relative `src/…` path, or undefined if it
 *  escapes the target's src/ (mirrors the sidecar's api.js safe()). */
function resolveSrcRel(targetDir: string, file: string): string | undefined {
	if (!file || !targetDir) {
		return undefined;
	}
	const abs = path.isAbsolute(file) ? file : path.resolve(targetDir, file);
	const srcRoot = path.join(targetDir, 'src');
	if (abs !== srcRoot && !abs.startsWith(srcRoot + path.sep)) {
		return undefined;
	}
	return path.relative(targetDir, abs).split(path.sep).join('/');
}

/** Drop the in-page agent's element/container placeholders ("«…»") so a seeded
 *  props object is JSON-safe. Function placeholders ("ƒ name") are KEPT — the
 *  harness renders them as no-op stubs, so a captured callback prop still
 *  satisfies the component instead of going missing. */
function sanitizeProps(raw: unknown): Record<string, unknown> {
	if (!raw || typeof raw !== 'object') {
		return {};
	}
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === 'string' && value.startsWith('«')) {
			continue;
		}
		out[key] = value;
	}
	return out;
}

function buildIsolateUrl(target: IsolateTarget, rel: string, exportName: string | undefined, props: Record<string, unknown>, specs?: PropSpec[], propsSource?: 'capture' | 'synth', chrome?: IsolateChrome): string {
	const base = target.targetBase.endsWith('/') ? target.targetBase : `${target.targetBase}/`;
	const q = new URLSearchParams();
	q.set('module', rel);
	// The canvas chrome, so a restored (or re-isolated) preview keeps the
	// viewport, the background and the dock you set (WO-60).
	if (chrome && Object.keys(chrome).length) {
		q.set('chrome', JSON.stringify(chrome));
	}
	if (exportName) {
		q.set('export', exportName);
	}
	if (Object.keys(props).length) {
		q.set('props', JSON.stringify(props));
	}
	if (specs?.length) {
		q.set('schema', JSON.stringify(specs));
	}
	// Provenance for the harness's chip. Only meaningful alongside `props` —
	// without it the harness decides for itself (samples ▸ SAMPLE_PROPS ▸ empty).
	if (propsSource && Object.keys(props).length) {
		q.set('propsSource', propsSource);
	}
	return `${target.targetOrigin}${base}__isolate?${q.toString()}`;
}

/** The component's colocated stylesheet: `<Stem>.css` beside it, else the
 *  directory's single `.css` file (merkle's one-component-per-dir layout). */
function findColocatedCss(componentAbs: string): string | undefined {
	const dir = path.dirname(componentAbs);
	const stemCss = path.join(dir, path.basename(componentAbs).replace(/\.[jt]sx?$/, '.css'));
	if (fs.existsSync(stemCss)) {
		return stemCss;
	}
	try {
		const css = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));
		return css.length === 1 ? path.join(dir, css[0]) : undefined;
	} catch {
		return undefined;
	}
}

function defaultLabel(rel: string): string {
	const base = rel.split('/').pop() || rel;
	return base.replace(/\.[jt]sx?$/, '');
}

/**
 * The preview canvas (Framer-mode T3): a clean, full-bleed iframe pointed at the
 * isolation harness — NO in-webview toolbar clone. Controls (reload, props,
 * samples) live in the native workbench (editor-title command / T4 sample
 * picker), so the surface reads as an editor pane, not a webview widget.
 *
 * The iframe is the target origin (a separate document), so this shim (a) relays
 * the harness's `__burrowIso` ready/renderError envelopes up to the extension
 * and (b) relays native commands (reload/props) FROM the extension DOWN to the
 * harness as `__burrowIsoCmd`.
 */
function buildPreviewHtml(origin: string, isoUrl: string, seed: IsolationPanelState = isolationState()): string {
	const nonce = getNonce();
	const safeUrl = isoUrl.replace(/"/g, '&quot;');
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'">
	<style>
		html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: var(--vscode-editor-background, #1e1e1e); }
		iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
	</style>
</head>
<body>
	<iframe id="frame" src="${safeUrl}" allow="clipboard-read; clipboard-write"></iframe>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const frame = document.getElementById('frame');
		const origin = '${origin}';
		// Native commands (reload/props) arrive from the extension and are relayed
		// down to the harness in the iframe.
		window.addEventListener('message', (e) => {
			const d = e.data;
			if (!d) { return; }
			// WO-60: the shim is the only thing in this panel that can call
			// setState, and the state it writes is the extension's — the harness
			// lives at another origin and never sees it.
			if (d.__burrowIsoState === 1) { vscode.setState(d.state); return; }
			if (d.__burrowIsoCmd === 1) {
				if (frame.contentWindow) { frame.contentWindow.postMessage(d, '*'); }
				return;
			}
			// The harness's ready/renderError envelopes bubble up to the extension.
			if (e.origin === origin && d.__burrowIso === 1) { vscode.postMessage(d); }
		});
		// Seeded by the host on every (re-)paint so the blob is never empty, even
		// if the harness never reports anything.
		vscode.setState(${JSON.stringify(seed)});
	</script>
</body>
</html>`;
}

/** Relay a native "reload the preview" command down to the harness. No-op if no
 *  preview is open. Used by the `burrow.frontendDebugger.reloadPreview` command. */
export function reloadPreview(): void {
	void preview?.webview.postMessage({ __burrowIsoCmd: 1, type: 'reload' });
}

/** The absolute source path of the currently-isolated component, if a preview
 *  is open — "Show in App" resolves its target from this when fired from the
 *  isolation preview's title bar (a webview panel has no editor Uri). */
export function currentIsolationFile(): string | undefined {
	return preview ? currentFile : undefined;
}

/** What is on the isolation canvas right now, for other extensions to READ.
 *  The agent panel (burrow-agent, docs/plans/03 §3) puts it in its context
 *  envelope so "why is this misaligned?" needs no file names typed. Read-only
 *  by construction: a copy of module state, no handles, no setters. */
export function currentIsolation(): { file: string; label: string; props?: Record<string, unknown> } | undefined {
	return preview && currentFile ? { file: currentFile, label: currentLabel, props: currentProps } : undefined;
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
