/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// webActions.ts — which of gopls' `source.*` code actions open a web view, and
// what to call them.
//
// gopls' documentation, assembly and free-symbols views are code actions. That
// means the only way to reach any of them today is to notice a lightbulb, on the
// line you happen to be standing on, with no way to ask "what can I read about
// this?" — the same discoverability gap the Refactor door closes for refactorings.
//
// The Refactor door deliberately does NOT list these: they open a page rather
// than editing anything, and mixing "extract this function" with "browse the
// assembly" in one list makes both harder to find. They get their own door here.
//
// Pure — imports nothing from 'vscode' — so out/webActions.js is a clean
// CommonJS module the standalone tests require directly.

/** The `source.*` kinds that open one of gopls' web views, with the label to show. */
export const BROWSE_KINDS: ReadonlyArray<{ readonly kind: string; readonly label: string; readonly detail: string }> = [
	{ kind: 'source.doc', label: 'Documentation', detail: 'The rendered package documentation, cross-linked' },
	{ kind: 'source.assembly', label: 'Assembly', detail: 'The compiled assembly for the enclosing function' },
	{ kind: 'source.freesymbols', label: 'Free Symbols', detail: 'Symbols the selection uses from outside it' },
];

/**
 * The shape this module needs from a code action — plain strings, deliberately
 * not vscode's `CodeAction`. A `CodeAction.kind` is a `CodeActionKind` object,
 * and taking one here would drag the 'vscode' import into a module whose whole
 * point is being testable without it. The caller flattens; this file decides.
 */
export interface ActionLike {
	readonly kind?: string;
	readonly title: string;
}

/** One offer in the browse list, pointing back at the caller's own action by index. */
export interface BrowseOffer {
	/** Index into the array the caller passed, so it keeps its own objects. */
	readonly index: number;
	readonly label: string;
	readonly detail: string;
}

/**
 * Picks the browsable actions out of everything a provider offered, in
 * {@link BROWSE_KINDS} order rather than the provider's — so Documentation is
 * always first and the list does not reshuffle between two adjacent lines.
 *
 * Matching is on whole dotted segments: `source.doc` must not claim a future
 * `source.documentation`, which is a different action with a similar name.
 */
export function browseOffers(actions: readonly ActionLike[]): BrowseOffer[] {
	const offers: BrowseOffer[] = [];
	for (const { kind, label, detail } of BROWSE_KINDS) {
		for (let index = 0; index < actions.length; index++) {
			if (!matchesKind(actions[index].kind, kind)) {
				continue;
			}
			// gopls titles these well — "Browse documentation for type Rect" says more
			// than "Documentation" does, so the action's own title is the detail line
			// and the family name is the label.
			offers.push({ index, label, detail: actions[index].title || detail });
		}
	}
	return offers;
}

/** True when `value` is `kind` or a dotted child of it. */
function matchesKind(value: string | undefined, kind: string): boolean {
	if (!value) {
		return false;
	}
	return value === kind || value.startsWith(`${kind}.`);
}
