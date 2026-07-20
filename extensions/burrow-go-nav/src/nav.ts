/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// nav.ts — the Search-Everywhere QuickPick UI + command (architecture task 16,
// WO-3). It owns the live palette: parse-on-type via query.ts, resolve via
// resolver.ts, render kind icons + `import/path · file:line` detail, single-hit
// fast path on accept. Index building/caching is injected as `getIndex` so this
// file stays about the UI; the resolver does the gopls/`go list` work.

import { Disposable, QuickPickItem, commands, window } from 'vscode';
import { PackageIndex } from './packageindex';
import { parseQuery } from './query';
import { NavCandidate, jumpTo, resolveCandidates } from './resolver';

/** Supplies the (possibly still-warming) package index for the current workspace. */
export type IndexProvider = () => Promise<PackageIndex | undefined>;

/** A QuickPick row carrying the candidate it jumps to. */
interface NavItem extends QuickPickItem {
	readonly candidate: NavCandidate;
}

// Live gopls calls per keystroke are wasteful and racy; coalesce typing into one
// resolve after a short quiet period.
const DEBOUNCE_MS = 120;

/** Register `burrow.nav.goToSymbol`. `getIndex` yields the cached package index. */
export function registerGoToSymbolCommand(getIndex: IndexProvider): Disposable {
	return commands.registerCommand('burrow.nav.goToSymbol', () => goToSymbol(getIndex));
}

/** Open the Go-to-Symbol palette and drive it until the user accepts or dismisses. */
async function goToSymbol(getIndex: IndexProvider): Promise<void> {
	const pick = window.createQuickPick<NavItem>();
	pick.title = 'Go to Symbol';
	pick.placeholder = 'pkg.Symbol · pkg.Type.Method · pkg · or a bare symbol name';
	pick.matchOnDetail = true;
	// We rank and filter ourselves (qualified/package grammar); don't let the
	// QuickPick re-filter our items by the raw `pkg.Symbol` string.
	pick.matchOnDescription = false;

	// The index warms in the background; note when it isn't ready yet.
	let index: PackageIndex | undefined;
	void getIndex().then(resolved => {
		index = resolved;
		// Re-resolve so a query typed before the index landed picks up packages.
		if (pick.value) {
			schedule(pick.value);
		}
	});

	// A monotonically increasing token discards stale async resolves.
	let generation = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const run = async (value: string, token: number): Promise<void> => {
		const query = parseQuery(value);
		if (query.raw.length === 0) {
			pick.items = [];
			pick.busy = false;
			return;
		}
		const candidates = await resolveCandidates(query, index);
		if (token !== generation) {
			return; // a newer keystroke superseded this resolve
		}
		pick.items = candidates.map(toItem);
		pick.busy = false;
	};

	const schedule = (value: string): void => {
		const token = ++generation;
		pick.busy = value.trim().length > 0;
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => void run(value, token), DEBOUNCE_MS);
	};

	pick.onDidChangeValue(schedule);

	pick.onDidAccept(async () => {
		const item = pick.selectedItems[0];
		pick.hide();
		if (item) {
			await jumpTo(item.candidate);
		}
	});

	pick.onDidHide(() => {
		if (timer) {
			clearTimeout(timer);
		}
		pick.dispose();
	});

	pick.show();
}

/** Render a candidate as a QuickPick row. The label already carries its `$(icon)`. */
function toItem(candidate: NavCandidate): NavItem {
	return { label: candidate.label, detail: candidate.detail, candidate };
}
