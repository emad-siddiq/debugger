/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The pure half of tool-surface isolation (docs/plans/02 §6): no `vscode`
// import, so the close decision is unit-testable with plain node
// (test/tools.test.js). ./tools.ts owns the workbench wiring.

/** The subset of tab state the close decision needs — plain data, unit-testable. */
export interface TabFacts {
	readonly key: string | undefined; // markerKey-shaped, or undefined for tab kinds we never touch
	readonly isDirty: boolean;
	readonly isPinned: boolean;
}

/**
 * Pure decision core: given every claim, the tool that is now active, and the
 * open tabs, pick the indices of tabs to close. A tab closes iff some
 * NON-active tool claimed it and the user has not made it dirty or pinned it.
 * (Claims of the active tool survive; unclaimed tabs always survive.)
 */
export function selectTabsToClose(claims: ReadonlyMap<string, ReadonlySet<string>>, activeToolId: string, tabs: readonly TabFacts[]): number[] {
	const closable = new Set<string>();
	for (const [toolId, keys] of claims) {
		if (toolId === activeToolId) {
			continue;
		}
		for (const key of keys) {
			closable.add(key);
		}
	}
	// A key the active tool ALSO claims stays open (shared surfaces belong to the survivor).
	for (const key of claims.get(activeToolId) ?? []) {
		closable.delete(key);
	}
	const out: number[] = [];
	for (let i = 0; i < tabs.length; i++) {
		const t = tabs[i];
		if (t.key !== undefined && closable.has(t.key) && !t.isDirty && !t.isPinned) {
			out.push(i);
		}
	}
	return out;
}
