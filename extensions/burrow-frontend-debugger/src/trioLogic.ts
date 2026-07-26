/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The pure half of the isolation trio's lifecycle: no `vscode` import, so the
// cascade decision is unit-testable with plain node (test/trio.test.js).
// ./isolation.ts owns the workbench wiring. Same split burrow-core uses for
// toolsLogic.ts / tools.ts, and for the same reason: the decision here is timing
// -sensitive and there is no extension-host test harness to catch it otherwise.

/** Which members of the trio are on screen right now. */
export interface TrioState {
	readonly tsx: boolean;
	readonly css: boolean;
	readonly preview: boolean;
}

/**
 * - `idle`     nothing of ours vanished — do nothing.
 * - `replaced` every member that vanished had its group take a new tab in the
 *              same settle window: the workbench swapped a preview tab, it was
 *              not a close. Re-baseline, cascade nothing.
 * - `gone`     the whole trio is already off screen (Close All, window
 *              shutdown). Reset state; there is nothing left to close.
 * - `teardown` a member was genuinely closed — close the survivors.
 */
export type TrioVerdict = 'idle' | 'replaced' | 'gone' | 'teardown';

/**
 * Pure decision core. `prev` is the baseline taken when the trio last settled,
 * `now` is a fresh read of the workbench; `closedColumns` are the view columns
 * of the trio tabs seen in `onDidChangeTabs.closed` during the window, and
 * `openedColumns` every column that received a tab in the same window.
 *
 * The diff — not the event payload — is what decides. `onDidChangeTabs` reports
 * no close REASON and fires opens and closes as separate events, so a group
 * merge, a re-isolation and a real close all look identical as they arrive;
 * re-reading after the dust settles makes the first two self-cancelling. Only
 * the third case, a preview tab being swapped for another file, still shows a
 * true vanish, which is what `openedColumns` is here to catch.
 */
export function decideTrio(
	prev: TrioState,
	now: TrioState,
	closedColumns: readonly (number | undefined)[],
	openedColumns: ReadonlySet<number | undefined>,
): TrioVerdict {
	const vanished = (prev.tsx && !now.tsx) || (prev.css && !now.css) || (prev.preview && !now.preview);
	if (!vanished) {
		return 'idle';
	}
	if (!now.tsx && !now.css && !now.preview) {
		return 'gone';
	}
	// An undefined column can't be matched against an opened one, so it counts as
	// "not replaced" — failing safe toward the cascade the user asked for.
	if (closedColumns.length > 0 && closedColumns.every((c) => c !== undefined && openedColumns.has(c))) {
		return 'replaced';
	}
	return 'teardown';
}
