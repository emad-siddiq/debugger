/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, ExtensionContext, Tab, TabInputCustom, TabInputText, TabInputWebview, Uri, commands, window, workspace } from 'vscode';
import { TabFacts, selectTabsToClose } from './toolsLogic';

// Tool-surface isolation (docs/plans/02 §6, WO-23 "window parts").
//
// Each rail tool (Data, API, Components, Run, …) opens editor-area surfaces —
// query grids, response panes, isolation previews, the Test Lab. Left alone
// they outlive the tool: switching Data → Components leaves the Data tabs
// behind, and an hour of browsing ends in twenty stale tabs.
//
// The contract: a tool registers ("claims") every transient surface it opens,
// and announces itself when one of its views becomes visible ("activated").
// When the active tool changes, the PREVIOUS tools' registered transient tabs
// are closed — unless the user has claimed a tab back by making it dirty or
// pinning it. Nothing unregistered is ever touched: an explicit registry, not
// heuristics, so this can never eat a tab it doesn't own.
//
// Tool extensions reach the API via
//   extensions.getExtension('burrow.burrow-core')?.exports.tools
// (the same cross-extension `exports` pattern the agent context engine uses).

/** A surface a tool opened: a text/custom editor by uri, or a webview panel by viewType. */
export type SurfaceMarker = { readonly uri: Uri } | { readonly viewType: string };

export interface BurrowToolsApi {
	/**
	 * Announce that `toolId`'s rail view became visible. Call from the view's
	 * `onDidChangeVisibility` (visible === true). Debounced: rapid rail-surfing
	 * only acts on where the user lands.
	 */
	activated(toolId: string): void;
	/**
	 * Register a transient surface owned by `toolId`. Claim every surface the
	 * tool opens, at the moment it opens it; re-claiming the same marker is a
	 * cheap no-op. Returns a Disposable that withdraws the claim (the tab, if
	 * open, is then never touched again).
	 */
	claim(toolId: string, marker: SurfaceMarker): Disposable;
}

/** Stable string key for a marker — also what the close-filter matches tabs against. */
export function markerKey(marker: SurfaceMarker): string {
	return 'uri' in marker ? `text:${marker.uri.toString()}` : `webview:${marker.viewType}`;
}

/** Map a live workbench tab to the facts the decision core wants. */
function tabFacts(tab: Tab): TabFacts {
	let key: string | undefined;
	const input = tab.input;
	if (input instanceof TabInputText) {
		key = `text:${input.uri.toString()}`;
	} else if (input instanceof TabInputWebview) {
		// The workbench prefixes panel viewTypes (e.g. `mainThreadWebview-burrow.db.grid`);
		// normalize back to the extension-visible viewType for matching.
		key = `webview:${input.viewType.replace(/^mainThreadWebview-/, '')}`;
	} else if (input instanceof TabInputCustom) {
		key = `webview:${input.viewType}`;
	}
	return { key, isDirty: tab.isDirty, isPinned: tab.isPinned };
}

const SWITCH_DEBOUNCE_MS = 300;

/** Wire the registry up; returns the API object for burrow-core's `exports`. */
export function createToolsApi(context: ExtensionContext): BurrowToolsApi {
	const claims = new Map<string, Set<string>>();
	let activeToolId: string | undefined;
	let pending: ReturnType<typeof setTimeout> | undefined;

	const enabled = () => workspace.getConfiguration('burrow.workbench').get<boolean>('tidyToolTabs', true);

	async function closeTransientTabs(forActiveTool: string): Promise<void> {
		const allTabs = window.tabGroups.all.flatMap((group) => group.tabs);
		const indices = selectTabsToClose(claims, forActiveTool, allTabs.map(tabFacts));
		if (!indices.length) {
			return;
		}
		try {
			await window.tabGroups.close(indices.map((i) => allTabs[i]), false);
		} catch {
			// A tab may have vanished between snapshot and close (user closed it,
			// panel disposed itself). Losing one sweep is fine — the next switch
			// sweeps again; never surface an error for housekeeping.
		}
	}

	const api: BurrowToolsApi = {
		activated: (toolId: string) => {
			if (toolId === activeToolId) {
				return;
			}
			activeToolId = toolId;
			if (!enabled()) {
				return;
			}
			// Debounce so rapid rail-surfing closes nothing until the user lands.
			if (pending !== undefined) {
				clearTimeout(pending);
			}
			pending = setTimeout(() => {
				pending = undefined;
				// Close against the CURRENT active tool — it may have changed since scheduling.
				if (activeToolId !== undefined) {
					void closeTransientTabs(activeToolId);
				}
			}, SWITCH_DEBOUNCE_MS);
		},
		claim: (toolId: string, marker: SurfaceMarker) => {
			const key = markerKey(marker);
			let keys = claims.get(toolId);
			if (!keys) {
				keys = new Set();
				claims.set(toolId, keys);
			}
			keys.add(key);
			return new Disposable(() => claims.get(toolId)?.delete(key));
		},
	};

	context.subscriptions.push(
		new Disposable(() => {
			if (pending !== undefined) {
				clearTimeout(pending);
			}
		}),
		// Manual sweep: close every registered transient that isn't the active
		// tool's. Works today, before any tool adopts activated(); also the
		// user's "tidy up now" button regardless of the setting.
		commands.registerCommand('burrow.tools.closeTransientTabs', () => closeTransientTabs(activeToolId ?? '')),
	);

	return api;
}
