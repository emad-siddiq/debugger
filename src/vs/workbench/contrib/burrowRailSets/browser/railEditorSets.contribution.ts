/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { registerWorkbenchContribution2, WorkbenchPhase, type IWorkbenchContribution } from '../../../common/contributions.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { IEditorGroupsService, IEditorWorkingSet } from '../../../services/editor/common/editorGroupsService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';

export const PER_RAIL_EDITOR_SETS_SETTING = 'burrow.workbench.perRailEditorSets';

const STORAGE_KEY = 'burrow.railEditorSets';

/**
 * Rail icons that own a section, and therefore own a set of editor tabs:
 * Explorer plus every `burrow-*` view container (Run, API, Data, Components,
 * Docker — future burrow rails join automatically).
 *
 * Deliberately NOT participating: Search, Source Control, Run and Debug,
 * Extensions. Those are lenses over the code the Explorer set already holds —
 * swapping the editor area out from under a search result or a diff would hide
 * the very file you clicked into.
 *
 * The prefix match is the whole point of this function. Extension-contributed
 * view containers are registered as `workbench.view.extension.<id>`
 * (`viewsExtensionPoint.ts`), never as the bare id from the manifest — matching
 * `burrow-*` alone silently excludes every Burrow rail.
 */
function participates(compositeId: string): boolean {
	return compositeId === 'workbench.view.explorer' ||
		compositeId.startsWith('workbench.view.extension.burrow-');
}

interface IStoredState {
	readonly sets?: readonly { readonly key: string; readonly workingSet: IEditorWorkingSet | 'empty' }[];
}

/**
 * Per-rail editor working sets: switching between participating rail icons saves
 * the editors showing under the outgoing icon and restores the incoming icon's
 * own set. Each section gets its own tabs, and going back brings yours with you.
 *
 * See `railEditorSets.md` for the rules this implements.
 */
export class RailEditorSetsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.burrowRailEditorSets';

	/** `<compositeId>` → that rail's saved editor set. */
	private readonly _setsByKey = new Map<string, IEditorWorkingSet | 'empty'>();

	private _currentKey: string | undefined;
	private _applying = false;
	private readonly _sequencer = new Sequencer();

	constructor(
		@IPaneCompositePartService paneCompositePartService: IPaneCompositePartService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IStorageService private readonly _storageService: IStorageService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();

		this._loadState();

		// Seed the current rail from the one the workbench has ALREADY restored.
		// This contribution runs at `AfterRestored`, by which time the restored
		// sidebar composite is open and its `onDidPaneCompositeOpen` has been and
		// gone — so the first event we would otherwise see is the user's own first
		// click, and treating that as the baseline swallows it (WO-60b).
		// `getLastActivePaneCompositeId` reads the part's persisted id rather than
		// the live composite, so it also answers when the sidebar is hidden at
		// restore: the editors on screen still belong to the rail we were left on.
		const restoredKey = paneCompositePartService.getLastActivePaneCompositeId(ViewContainerLocation.Sidebar);
		if (participates(restoredKey)) {
			this._currentKey = restoredKey;
		}

		this._register(this._storageService.onWillSaveState(() => this._saveState()));

		this._register(paneCompositePartService.onDidPaneCompositeOpen(({ composite, viewContainerLocation }) => {
			if (viewContainerLocation !== ViewContainerLocation.Sidebar) {
				return;
			}
			this._onRailOpen(composite.getId());
		}));
	}

	private _enabled(): boolean {
		return this._configurationService.getValue<boolean>(PER_RAIL_EDITOR_SETS_SETTING) !== false;
	}

	private _onRailOpen(compositeId: string): void {
		if (!participates(compositeId) || this._applying || !this._enabled()) {
			return;
		}
		if (!this._currentKey) {
			// Restored onto a rail that owns no editor set (Search, Source Control,
			// or a fresh part with no persisted id). There is no outgoing set to
			// save, and the visible editors belong to no rail — applying over them
			// would close tabs nothing could bring back. Baseline and swap nothing.
			this._currentKey = compositeId;
			return;
		}
		if (compositeId === this._currentKey) {
			return;
		}
		const previousKey = this._currentKey;
		this._currentKey = compositeId;
		void this._sequencer.queue(async () => {
			this._save(previousKey);
			await this._apply(compositeId);
		});
	}

	private _save(key: string): void {
		const existing = this._setsByKey.get(key);
		if (existing && existing !== 'empty') {
			this._editorGroupsService.deleteWorkingSet(existing);
		}
		// Main part only, both in the test and in the save. Floating windows are
		// the user's, not a rail's: a rail holding nothing but a popped-out panel
		// is empty as far as the editor area is concerned, and recording the
		// floating window into this set would let a later reload restore it under
		// whichever rail happened to save last. See patches/0014 and 0016.
		if (this._editorGroupsService.mainPart.groups.some(group => group.count > 0)) {
			this._setsByKey.set(key, this._editorGroupsService.saveWorkingSet(`rail-working-set:${key}`, { mainOnly: true }));
		} else {
			// Remember emptiness explicitly, so returning to this rail clears the
			// editor area instead of inheriting the previous rail's tabs.
			this._setsByKey.set(key, 'empty');
		}
	}

	private async _apply(key: string): Promise<void> {
		const workingSet = this._setsByKey.get(key) ?? 'empty';
		this._applying = true;
		try {
			// `preserveAuxiliaryWindows`: a rail click is not a gesture aimed at the
			// second monitor. Without it, `'empty'` — the set every rail the user
			// has not visited yet resolves to — closes every floating window.
			await this._editorGroupsService.applyWorkingSet(workingSet, { preserveFocus: true, preserveAuxiliaryWindows: true });
		} finally {
			this._applying = false;
		}
	}

	// --- persistence ---

	private _loadState(): void {
		const raw = this._storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return;
		}
		try {
			for (const entry of (JSON.parse(raw) as IStoredState).sets ?? []) {
				this._setsByKey.set(entry.key, entry.workingSet);
			}
		} catch {
			this._storageService.remove(STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}

	private _saveState(): void {
		// Fold the live editors into the current rail's set, so a reload restores
		// per-rail state as-left. The working-set handles are persisted by the
		// editor part itself.
		if (this._currentKey && this._enabled()) {
			this._save(this._currentKey);
		}
		if (!this._setsByKey.size) {
			this._storageService.remove(STORAGE_KEY, StorageScope.WORKSPACE);
			return;
		}
		const state: IStoredState = { sets: [...this._setsByKey].map(([key, workingSet]) => ({ key, workingSet })) };
		this._storageService.store(STORAGE_KEY, JSON.stringify(state), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}

registerWorkbenchContribution2(RailEditorSetsContribution.ID, RailEditorSetsContribution, WorkbenchPhase.AfterRestored);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'burrow',
	order: 100,
	title: localize('burrow.workbench', "Burrow"),
	type: 'object',
	properties: {
		[PER_RAIL_EDITOR_SETS_SETTING]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('burrow.perRailEditorSets', "Give each rail icon that owns a section (Explorer, Run, API, Data, Components) its own set of editor tabs: switching rails saves the tabs you were on and restores that rail's own. Search, Source Control and Run and Debug are lenses over the same files and never swap the editor area. Editors with unsaved changes are never closed by a switch — they carry over until you save them."),
		},
	},
});
