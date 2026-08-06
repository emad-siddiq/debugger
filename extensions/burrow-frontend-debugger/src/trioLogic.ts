/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The pure half of the isolation trio: its close cascade and its editor-group
// geometry. No `vscode` import, so both are unit-testable with plain node
// (test/trio.test.js). ./isolation.ts and ./stage.ts own the workbench wiring —
// the columns each surface goes in stay there, because they are typed as
// `vscode.ViewColumn`. Same split burrow-core uses for
// toolsLogic.ts / tools.ts, and for the same reason: the decision here is timing
// -sensitive and there is no extension-host test harness to catch it otherwise.

/**
 * How the source and its colocated stylesheet share the editor half of the
 * workbench — `burrow.frontendDebugger.sourceSplit`.
 *
 * - `stacked`     the source sits ABOVE the stylesheet (one on top of the
 *                 other, divided by a horizontal line). The default.
 * - `sideBySide`  the source sits BESIDE the stylesheet (two columns, divided
 *                 by a vertical line), so a long rule list and a long component
 *                 are both readable without scrolling past each other.
 */
export type SourceSplit = 'stacked' | 'sideBySide';

/**
 * The editor-group tree for the isolation trio — the pure half of stage.ts's
 * `trioLayout`, which is a thin wrapper that reads the mode and the setting.
 *
 * Nested groups are load-bearing and are documented upstream: "A layout
 * representing 3 rows and 1 column in which the second row has 2 columns:
 * `{ orientation: 1, groups: [{}, { groups: [{}, {}] }, {}] }`"
 * (`vscode.setEditorLayout` metadata, editorCommands.ts). A nested group runs
 * PERPENDICULAR to its parent, which is why `stacked` — a top-to-bottom pair —
 * is the nested shape and `sideBySide` is three plain top-level columns.
 *
 * Column numbering follows the tree depth-first, left to right, and every shape
 * below numbers the trio the same way (source before stylesheet before canvas,
 * or canvas first on the stage). That is what lets `trioColumns` stay one
 * decision for all four shapes — change the order here and it must change too.
 */
export function trioLayoutTree(hasCss: boolean, stage: boolean, split: SourceSplit): unknown {
	if (stage) {
		// Canvas first, so it owns column one. 0.62/0.38 rather than an even
		// split: the component is the subject, the source is the reference.
		if (!hasCss) {
			return { orientation: 0, groups: [{ size: 0.62 }, { size: 0.38 }] };
		}
		return split === 'sideBySide'
			? { orientation: 0, groups: [{ size: 0.62 }, { size: 0.19 }, { size: 0.19 }] }
			: { orientation: 0, groups: [{ size: 0.62 }, { groups: [{ size: 0.5 }, { size: 0.5 }], size: 0.38 }] };
	}
	// The ordinary isolation arrangement: developer's half left, designer's half
	// right. With a stylesheet that left half is either four equal quadrants
	// (stacked) or two narrow columns beside the canvas (sideBySide) — the canvas
	// keeps its half either way.
	if (!hasCss) {
		return { orientation: 0, groups: [{ size: 0.5 }, { size: 0.5 }] };
	}
	return split === 'sideBySide'
		? { orientation: 0, groups: [{ size: 0.25 }, { size: 0.25 }, { size: 0.5 }] }
		: { orientation: 0, groups: [{ groups: [{ size: 0.5 }, { size: 0.5 }], size: 0.5 }, { size: 0.5 }] };
}

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
