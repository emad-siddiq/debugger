/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { hasSamples } from './gallery';
import { parsePropsSchema, preferredExport, PropSpec } from './propsSkeleton';
import { stageActive, trioColumns, trioLayout } from './stage';
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
	/** Where to mount it, for a component that reads the route. Absent → whatever
	 *  route was last set for this file, else the harness's own choice. */
	readonly route?: string;
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

/**
 * Which rung of the props provenance ladder this render is standing on.
 *
 * The ladder is *live capture ▸ colocated samples ▸ `SAMPLE_PROPS` ▸ synthesized
 * ▸ empty* (04-capture-replay.md §3.2a). Only the top and the fourth rung are
 * decided here — the middle two are the harness's own fallback, so `'samples'`
 * says "a samples file exists and the harness will pick from it", which is what
 * the extension can honestly claim without asking the harness.
 */
type PropsRung = 'capture' | 'samples' | 'synth' | 'none';
let currentPropsRung: PropsRung = 'none';

/**
 * The other half of the seam: which data the target's `/api` is answering with.
 *
 * NOT polled here. `ModeStatus` (status.ts) owns the one poller against the
 * sidecar's `GET /api/mode` and pushes every answer in through
 * `setSeamDataMode` — a second poller would be a second clock, and the two
 * would disagree for up to the ten seconds between ticks.
 */
type SeamDataMode = 'mock' | 'live' | 'flipping' | 'unknown';
let currentDataMode: SeamDataMode = 'unknown';

/**
 * The third input: where the component is mounted (see `routeChipHtml`).
 *
 * `currentRouteAware` is read off the source — whether the module reads the
 * route at all — and decides whether the chip appears. `currentRoute` is what a
 * person typed for it, or undefined for the harness's own choice (a
 * `sampleRoute` export, else `/`).
 *
 * Typed routes are remembered PER FILE for the session rather than reset on
 * every isolation, because drilling into a child and coming back is one gesture
 * and losing the route to it would make the chip feel broken. Not persisted to
 * disk: a route is scaffolding for the thing you are looking at now, and a
 * stale one restored a week later (pointing at a seeded id that no longer
 * exists) would be worse than `/`.
 */
let currentRoute: string | undefined;
let currentRouteAware = false;
const routeByFile = new Map<string, string>();

/**
 * Tell the seam bar where the harness actually mounted the component.
 *
 * Same in-place patch as `setSeamDataMode`, and for the same reason: repainting
 * the panel HTML would reset `iframe.src` and reload the canvas, which for this
 * message would mean the harness reporting its route caused a reload that made
 * it report its route again.
 */
function setSeamRoute(route: string): void {
	if (route === (currentRoute ?? '/')) {
		return;
	}
	currentRoute = route;
	void preview?.webview.postMessage({ __burrowIsoBar: 1, chip: 'route', ...routeChipState() });
}

/** Does this module read the route? Cheap and deliberately shallow — the chip
 *  it gates is informational, and the cost of a false positive is one chip
 *  reading `route: /` on a component that did not need it. */
function readsRoute(source: string): boolean {
	return /\buse(Params|Location|SearchParams|Match|Routes)\b/.test(source);
}

/**
 * Tell the seam bar the target's data mode.
 *
 * Patches the chip in place over `postMessage` rather than re-rendering the
 * panel HTML. Re-rendering would reset `iframe.src` and reload the canvas, so a
 * background poll every ten seconds would throw away the component's state on
 * every tick — the mode pill's own refresh would become a canvas flicker.
 */
export function setSeamDataMode(mode: 'mock' | 'live' | 'flipping' | null): void {
	const next: SeamDataMode = mode ?? 'unknown';
	if (next === currentDataMode) {
		return;
	}
	currentDataMode = next;
	const [text, tip] = DATA_TEXT[next];
	void preview?.webview.postMessage({ __burrowIsoBar: 1, chip: 'data', dataMode: next, text, tip });
}

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

	// Where each member of the trio goes. Ordinary isolation puts the source in
	// column one; miniature-artist mode transposes the grid so the canvas does
	// (stage.ts `trioColumns`/`trioLayout` — one decision, written in one place).
	// `findColocatedCss` has to run before the columns are chosen: whether there
	// is a stylesheet changes the shape of the grid, not just its contents.
	const cssAbs = findColocatedCss(abs);
	const columns = trioColumns(!!cssAbs);

	// The real editor. Keeps focus so you can start editing immediately.
	try {
		const doc = await vscode.workspace.openTextDocument(abs);
		await vscode.window.showTextDocument(doc, { viewColumn: columns.tsx, preview: tidy });
	} catch (err) {
		void vscode.window.showWarningMessage(`Frontend Debugger: cannot open ${rel} — ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	if (cssAbs) {
		try {
			const cssDoc = await vscode.workspace.openTextDocument(cssAbs);
			await vscode.window.showTextDocument(cssDoc, { viewColumn: columns.css, preview: tidy, preserveFocus: true });
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
	// component are all on one screen. In miniature-artist mode the same tree is
	// transposed so the canvas leads. Best-effort — a project that can't set the
	// layout still gets the plain columns.
	try {
		await vscode.commands.executeCommand('vscode.setEditorLayout', trioLayout(!!cssAbs));
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
	const samplesExist = hasSamples(path.dirname(abs), path.basename(abs));
	if (!Object.keys(props).length && schema && schema.required.length && !samplesExist) {
		props = schema.skeleton;
		propsSource = 'synth';
	}
	// The same decision, named for the seam bar. `propsSource` is the wire field
	// the harness reads and only has two values; the rung is what a person needs
	// told, and it distinguishes "the harness has a samples file to fall back to"
	// from "nothing at all".
	currentPropsRung = propsSource ?? (samplesExist ? 'samples' : 'none');
	// The route: this call's, else the one last set for this file. A caller that
	// passes one is setting it, so it becomes the remembered value too.
	if (args.route) {
		routeByFile.set(abs, args.route);
	}
	currentRoute = args.route ?? routeByFile.get(abs);
	currentRouteAware = source ? readsRoute(source) : false;
	const url = buildIsolateUrl(target, rel, exportName, props, schema?.specs, propsSource, currentChrome, currentRoute);
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

	const previewColumn = columns.preview;
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
		// A group in a floating window is off limits (patches/0016). The user put
		// that file on a second monitor deliberately; isolating a different
		// component is not a reason to reach across and close it.
		.filter((group) => !group.isAuxiliaryWindow)
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
	currentPropsRung = 'none';
	// `routeByFile` deliberately survives: closing the trio is not "I no longer
	// want this component at /node/7", and re-isolating it should land where it
	// was left.
	currentRoute = undefined;
	currentRouteAware = false;
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
	if (msg.type === 'seam' && isRecord(msg.detail) && msg.detail.action === 'inApp') {
		// The stage bar's "in app ↗". No argument: showInApp resolves an
		// argument-less call to whatever is on the canvas, which is exactly what a
		// button drawn on that canvas means.
		//
		// Focus the canvas group first. The app panel opens at
		// `ViewColumn.Active`, and clicking inside a webview does NOT make its
		// group active — measured 2026-08-06: the app landed in the SOURCE group
		// next door. Revealing without preserveFocus makes the stage column the
		// active one, so composition arrives as a sibling tab of the isolation it
		// replaces, which is the point of the seam.
		void (async () => {
			preview?.reveal(preview.viewColumn, false);
			await vscode.commands.executeCommand('burrow.frontendDebugger.showInApp');
		})();
		return;
	}
	if (msg.type === 'seam' && isRecord(msg.detail) && msg.detail.action === 'flipMode') {
		// The data chip. Delegating to the command rather than POSTing /api/mode
		// from here keeps ONE flip path: the pill, the palette and the chip all
		// go through `ModeStatus.toggle`, which is also the thing that guards
		// against a second flip while one is in flight and announces the result
		// back to this bar.
		void vscode.commands.executeCommand('burrow.frontendDebugger.toggleMode');
		return;
	}
	if (msg.type === 'seam' && isRecord(msg.detail) && msg.detail.action === 'setRoute') {
		void setRouteInteractively();
		return;
	}
	if (msg.type === 'route' && isRecord(msg.detail) && typeof msg.detail.route === 'string') {
		// The route that actually won inside the harness. The extension only knows
		// the one it asked for; an author's `sampleRoute` export beats nothing at
		// all, and the bar must show what the component is really mounted at
		// rather than what was requested. The pattern list rides along because the
		// harness is the one that knows it (see `routePatterns`).
		if (Array.isArray(msg.detail.patterns)) {
			routePatterns = msg.detail.patterns.filter((p): p is string => typeof p === 'string');
		}
		setSeamRoute(msg.detail.route);
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

function buildIsolateUrl(target: IsolateTarget, rel: string, exportName: string | undefined, props: Record<string, unknown>, specs?: PropSpec[], propsSource?: 'capture' | 'synth', chrome?: IsolateChrome, route?: string): string {
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
	// Where to mount it. The sidecar re-validates this (`safeRoute` in
	// inspectorPlugin) — it ends up as an argument to the target app's own
	// `navigate()`, so the check that matters is the one on the server.
	if (route) {
		q.set('route', route);
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
/**
 * The breadcrumb that runs along the top of the stage.
 *
 * The target geometry draws this as a bar spanning tree + canvas + editors.
 * There is no extension-level host for that: 1.128 offers the status bar
 * (bottom, full width), per-group editor-title menus, per-view title menus and
 * webview HTML — and no banner API. Burrow additionally deleted its own title
 * bar (core patch 0011) and never built the toolbar host task 03 planned for it.
 * So the bar lives here, inside the canvas, spanning the centre column only.
 * That is the whole of the gap between the drawing and this implementation, and
 * it is a ruled trade rather than an oversight (03-stage-layout.md §3.1, §6).
 *
 * Rendered only in stage mode: ordinary isolation keeps the clean full-bleed
 * canvas T3 arrived at.
 */
function crumbHtml(): string {
	if (!stageActive() || !currentFile || !currentTargetDir) {
		return '';
	}
	// The project, not the target directory: merkle's target dir is
	// `<repo>/frontend`, so its basename is the word "frontend" on every
	// frontend in every repo. The workspace folder is what the person calls the
	// project. Falls back to the target dir when there is no folder open.
	const project = vscode.workspace.workspaceFolders?.[0]?.name ?? path.basename(currentTargetDir);
	const rel = path.relative(currentTargetDir, currentFile).split(path.sep).join('/');
	// Drop the leading `src/` and the filename: what is left is the component's
	// neighbourhood, which is the part a person navigates by.
	const dirs = rel.split('/').slice(0, -1).filter((seg) => seg !== 'src');
	const parts = [project, ...dirs, currentLabel || defaultLabel(rel)];
	const crumb = parts.map((p, i) => `<span class="${i === parts.length - 1 ? 'leaf' : 'seg'}">${escapeAttr(p)}</span>`).join('<span class="sep">›</span>');
	// The path goes in its own box so it is the thing that shrinks. As direct
	// flex children the segments would not: `white-space: nowrap` plus the
	// default `min-width: auto` makes each one incompressible, so a third chip
	// pushed the seam off the right edge of the panel instead of ellipsising the
	// path — measured at 491 px wide, where the route chip sat at x=575.
	return `<div id="crumb"><span id="path">${crumb}</span>${seamHtml()}</div>`;
}

/** What the provenance chip says, and the tooltip that explains it. Both derive
 *  from `currentPropsRung`, so the bar cannot claim a rung the URL did not use. */
const DATA_TEXT: Readonly<Record<'mock' | 'live' | 'flipping' | 'unknown', readonly [string, string]>> = {
	live: ['data: live', 'This component’s fetches reach the debugged backend. Click to go back to mock.'],
	mock: ['data: mock', 'devMock is answering /api — the numbers on the canvas are fixtures, not the app’s. Click to point the target at the debugged backend.'],
	flipping: ['data: …', 'Restarting the target dev server for the new mode.'],
	unknown: ['data: ?', 'The sidecar has not said which mode the target is in.'],
};

const RUNG_TEXT: Readonly<Record<PropsRung, readonly [string, string]>> = {
	capture: ['props: live', 'Props captured from this component running in the app (fiber.memoizedProps).'],
	samples: ['props: samples', 'No live capture — the harness is rendering from the colocated samples file.'],
	synth: ['props: synth', 'No live capture and no samples — these props were synthesized from the declared types.'],
	none: ['props: none', 'The component is rendering with no props supplied.'],
};

/**
 * The seam — the right-hand end of the stage bar.
 *
 * The WO asks for "one prop/data seam for moving between isolation and
 * composition", and it is two things that have to sit together: WHICH data this
 * render is standing on, and one step to the same component in the running app.
 * Separating them would be the actual failure — a canvas that shows synthesized
 * props while looking exactly like the app is the thing the stage must not do
 * quietly.
 *
 * The composition half is not new machinery: `burrow.frontendDebugger.showInApp`
 * already resolves "the thing on the canvas" when it is called with no argument
 * (extension.ts), and the SPA already navigates and locates (S3/S4 in
 * 05-debug-integration.md §4.4). This is that command given a place to be
 * pressed from inside the stage.
 *
 * WHY TWO CHIPS. "Where did this render come from" has two independent answers,
 * and the recon counted both populations: of merkle's 232 isolable components,
 * **98 (42.2 %) need only props and 122 (52.6 %) need a data path**
 * (00-index.md, R-C). A seam that named only the props rung would be silent for
 * the larger half — a container fetching devMock fixtures would look exactly
 * like the same container against the seeded backend. So `props:` answers for
 * the first population and `data:` for the second, and a component that is both
 * gets both told.
 *
 * The data chip is a BUTTON, unlike the props chip, because there is something
 * to do about it: `burrow.frontendDebugger.toggleMode` already flips the target
 * mock ↔ live. That flip is the data-side counterpart of "in app ↗" — the props
 * side steps to the running app, the data side brings the running app's backend
 * here.
 */
function seamHtml(): string {
	const [text, tip] = RUNG_TEXT[currentPropsRung];
	const [dText, dTip] = DATA_TEXT[currentDataMode];
	return `<div id="seam">`
		+ `<span class="chip rung-${currentPropsRung}" title="${escapeAttr(tip)}">${escapeAttr(text)}</span>`
		+ `<button id="datamode" class="chip data-${currentDataMode}" title="${escapeAttr(dTip)}">${escapeAttr(dText)}</button>`
		+ routeChipHtml()
		+ `<button id="inapp" title="Show this component in the running app">in app ↗</button>`
		+ `</div>`;
}

/**
 * The third chip, and the third input.
 *
 * Props and data are not the whole of "where did this render come from" for a
 * page component: WHERE it is mounted decides what `useParams()` hands it, and
 * the harness mounts at `/` unless told otherwise. Eleven merkle modules read
 * `useParams` and eighteen read the route at all (generator:
 * scratchpad/ma/routedeps.sh), and at `/` every one of them renders its
 * not-found or empty branch — which looks like a working isolation of a broken
 * component.
 *
 * Shown only when it has something to say: the component reads the route, or
 * someone has set one. For the 214 components that never look, a chip reading
 * `route: /` would be three more characters of noise on every canvas.
 *
 * Warning-coloured in exactly one case — route-aware and still at `/` — because
 * that is the case where the canvas is lying and nothing else on screen says so.
 */
function routeChipState(): { show: boolean; stale: boolean; text: string; tip: string } {
	const route = currentRoute ?? '/';
	const stale = currentRouteAware && route === '/';
	return {
		show: currentRouteAware || route !== '/',
		stale,
		text: `route: ${route}`,
		tip: stale
			? 'This component reads the route (useParams / useLocation) but is mounted at “/”, so it is rendering its empty branch. Click to mount it somewhere real.'
			: `Mounted at ${route}. Click to change where this component thinks it is.`,
	};
}

/** Always emitted, `hidden` when it has nothing to say. A chip that came and
 *  went with the HTML would have to be injected — and then re-bound — from a
 *  message; hiding one that is already there needs neither. */
function routeChipHtml(): string {
	const s = routeChipState();
	return `<button id="isoroute" class="chip route${s.stale ? ' route-stale' : ''}"${s.show ? '' : ' hidden'} title="${escapeAttr(s.tip)}">${escapeAttr(s.text)}</button>`;
}

/**
 * The `<Route path>` patterns the app declares, for the picker.
 *
 * Reported by the harness rather than scanned here: the harness is the thing
 * that MOUNTS through a pattern, and a picker offering choices the mounter does
 * not know would be a second opinion about the same fact. Empty until a preview
 * has loaded once, which is also the only time the chip can be clicked.
 */
let routePatterns: readonly string[] = [];

/** Why this string is not a place the harness can mount at. Mirrors the
 *  sidecar's `safeRoute`, which is the check that actually enforces it — this
 *  one exists to say so while the person is still typing. */
function routeProblem(value: string): string | undefined {
	if (!value.startsWith('/')) {
		return 'A route starts with “/”.';
	}
	if (value.startsWith('//') || value.startsWith('/\\')) {
		return 'That would navigate out of the app.';
	}
	if (/\s/.test(value)) {
		return 'A route has no spaces in it.';
	}
	if (/:[A-Za-z]/.test(value)) {
		return '“:id” is a pattern, not a place — fill in a real value.';
	}
	return undefined;
}

/** The route chip's click: pick a declared route, or type one, then re-isolate
 *  the same component there. Re-isolating rather than messaging the harness
 *  because the route is decided at mount — the URL is where it belongs. */
async function setRouteInteractively(): Promise<void> {
	const file = currentFile;
	if (!file) {
		return;
	}
	const current = currentRoute ?? '/';
	const declared = routePatterns;
	let chosen: string | undefined;
	if (declared.length) {
		type Item = vscode.QuickPickItem & { readonly route?: string };
		const items: Item[] = [
			{ label: '$(edit) Type a path…' },
			...declared.map((p): Item => ({
				label: p,
				route: p,
				description: p === current ? 'current' : (p.includes(':') ? 'needs a value' : ''),
			})),
		];
		const pick = await vscode.window.showQuickPick(items, {
			placeHolder: `Mount ${currentLabel} at…`,
			matchOnDescription: true,
		});
		if (!pick) {
			return;
		}
		chosen = pick.route;
	}
	// No picker, or a pattern was picked: a pattern is a template, so hand it
	// back with the parameter still in it for the person to fill in.
	if (chosen === undefined || /:[A-Za-z]/.test(chosen)) {
		chosen = await vscode.window.showInputBox({
			value: chosen ?? current,
			prompt: `Where should ${currentLabel} think it is?`,
			validateInput: routeProblem,
		});
	}
	if (!chosen) {
		return;
	}
	await vscode.commands.executeCommand('burrow.frontendDebugger.isolate', {
		file,
		export: currentExport,
		route: chosen,
	} satisfies IsolateArgs);
}

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
		/* Column, so the crumb takes its own height and the canvas takes the rest.
		   Without the flex context the iframe's 100% height would overflow by
		   exactly the height of the bar. */
		body { display: flex; flex-direction: column; }
		#crumb {
			flex: none; display: flex; align-items: center; gap: 6px;
			padding: 4px 10px; font: 11px var(--vscode-font-family, sans-serif);
			color: var(--vscode-descriptionForeground, #8b949e);
			background: var(--vscode-editor-background, #1e1e1e);
			border-bottom: 1px solid var(--vscode-panel-border, #2b3138);
			white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
		}
		#crumb #path {
			flex: 1 1 auto; min-width: 0;
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		#crumb .sep { opacity: 0.5; margin: 0 5px; }
		#crumb .leaf { color: var(--vscode-foreground, #e6edf3); }
		/* The seam sits at the far end: the path reads left, the state of the
		   render and the way out read right. auto margin rather than
		   space-between so a long path ellipsises into the seam instead of
		   pushing it off the bar. */
		#seam { margin-left: auto; display: flex; align-items: center; gap: 6px; flex: none; }
		#seam .chip {
			padding: 1px 6px; border-radius: 3px; font-size: 10px;
			border: 1px solid var(--vscode-panel-border, #2b3138);
			color: var(--vscode-descriptionForeground, #8b949e);
		}
		/* Only the two rungs that are NOT the running app get a colour. A live
		   capture is the expected case and says so by looking like everything
		   else; synth and none are the cases where the canvas is not the app. */
		#seam .rung-synth, #seam .rung-none, #seam .data-mock, #seam .route-stale {
			color: var(--vscode-editorWarning-foreground, #cca700);
			border-color: var(--vscode-editorWarning-foreground, #cca700);
		}
		/* data-mock is warned about by the same rule and for the same reason —
		   (no backticks in here: this whole block is inside a template literal,
		   and one would end the string) —
		   fixtures are not the app — even though mock is the default and a
		   perfectly good place to work. The chip is not saying "wrong", it is
		   saying "not the app", which is the one distinction the stage exists to
		   keep honest. */
		#seam button.chip {
			font: inherit; font-size: 10px; padding: 1px 6px; cursor: pointer;
			background: transparent;
		}
		#seam button.chip:hover { background: var(--vscode-toolbar-hoverBackground, #ffffff14); }
		#seam .data-unknown, #seam .data-flipping { opacity: 0.7; }
		/* route-stale shares the warning rule above: route-aware and mounted at
		   "/" is the case where the canvas renders a not-found branch and looks
		   like a working isolation of a broken component. A route that was
		   deliberately set is not a warning, so it stays plain. */
		#seam .route { max-width: 30%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		#seam button {
			font: inherit; padding: 1px 8px; border-radius: 3px; cursor: pointer;
			color: var(--vscode-button-secondaryForeground, #e6edf3);
			background: var(--vscode-button-secondaryBackground, #30363d);
			border: 1px solid transparent;
		}
		#seam button:hover { background: var(--vscode-button-secondaryHoverBackground, #3c444d); }
		iframe { display: block; flex: 1 1 auto; width: 100%; border: 0; background: #fff; min-height: 0; }
	</style>
</head>
<body>
	${crumbHtml()}
	<iframe id="frame" src="${safeUrl}" allow="clipboard-read; clipboard-write"></iframe>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const frame = document.getElementById('frame');
		const origin = '${origin}';
		// The seam's button. addEventListener rather than an onclick attribute:
		// the CSP here is nonce-only for scripts, so an inline handler would be
		// dropped silently — the same trap the style-src nonce set for inline
		// style attributes.
		const inapp = document.getElementById('inapp');
		if (inapp) {
			inapp.addEventListener('click', () => {
				vscode.postMessage({ __burrowIso: 1, type: 'seam', detail: { action: 'inApp' } });
			});
		}
		const datamode = document.getElementById('datamode');
		if (datamode) {
			datamode.addEventListener('click', () => {
				vscode.postMessage({ __burrowIso: 1, type: 'seam', detail: { action: 'flipMode' } });
			});
		}
		// Always in the DOM, hidden when the component does not care where it is
		// mounted — so this listener is bound once and stays bound.
		const isoroute = document.getElementById('isoroute');
		if (isoroute) {
			isoroute.addEventListener('click', () => {
				vscode.postMessage({ __burrowIso: 1, type: 'seam', detail: { action: 'setRoute' } });
			});
		}
		// Native commands (reload/props) arrive from the extension and are relayed
		// down to the harness in the iframe.
		window.addEventListener('message', (e) => {
			const d = e.data;
			if (!d) { return; }
			// WO-60: the shim is the only thing in this panel that can call
			// setState, and the state it writes is the extension's — the harness
			// lives at another origin and never sees it.
			if (d.__burrowIsoState === 1) { vscode.setState(d.state); return; }
			// The data and route chips, patched in place. Repainting the panel
			// HTML would reset the iframe src and reload the canvas — see
			// setSeamDataMode and setSeamRoute.
			if (d.__burrowIsoBar === 1) {
				if (d.chip === 'route') {
					if (isoroute) {
						isoroute.textContent = d.text;
						isoroute.title = d.tip;
						isoroute.className = 'chip route' + (d.stale ? ' route-stale' : '');
						isoroute.hidden = !d.show;
					}
					return;
				}
				if (datamode) {
					datamode.textContent = d.text;
					datamode.title = d.tip;
					datamode.className = 'chip data-' + d.dataMode;
				}
				return;
			}
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

/**
 * Close the whole trio and wait for the cascade to finish.
 *
 * Miniature-artist mode changes which column each surface belongs to, and the
 * only safe way to act on that is to rebuild. Moving them in place looks
 * cheaper and is not: `showTextDocument` into another column leaves the
 * original group empty, the workbench removes an empty group, the removal
 * renumbers the columns under the webview, and the webview goes down with the
 * group it was in — which disposes the panel and takes the whole trio with it
 * through `onDidDispose`. Measured 2026-08-06: entering the mode with the trio
 * open left one empty group and no canvas at all.
 *
 * So the mode toggle closes deliberately and re-isolates, which is a path the
 * cascade already understands. Costs one canvas reload per toggle.
 */
export async function closeIsolation(): Promise<void> {
	if (!preview) {
		return;
	}
	// Disposing fires onDidDispose → teardownIsolation, which closes the source
	// and stylesheet and collapses a grid we own. Awaiting the dispose is not
	// enough: teardown is async, so give the cascade a turn to finish before the
	// caller re-opens into the grid it is still tidying.
	preview.dispose();
	await new Promise((resolve) => setTimeout(resolve, TRIO_SETTLE_MS * 2));
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
