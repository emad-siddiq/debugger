/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, runOnChange } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { observableConfigValue } from '../../../../platform/observable/common/platformObservableUtils.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { IEditorGroupsService, IEditorWorkingSet } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IPaneCompositePartService } from '../../../../workbench/services/panecomposite/browser/panecomposite.js';
import { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { SESSIONS_FILES_CONTAINER_ID } from '../../files/browser/files.contribution.js';

export const PER_ACTIVITY_EDITOR_SETS_SETTING = 'sessions.layout.perActivityEditorSets';

const STORAGE_KEY = 'sessions.compositeEditorSets';

/**
 * Rail icons that own a section, and therefore own a set of editor tabs:
 * Explorer plus every `burrow-*` view container (Run, API, Data, Components,
 * Docker — future burrow icons join automatically), and the sessions Files
 * container in the AuxiliaryBar.
 *
 * Deliberately NOT participating: Search, Source Control, Run and Debug,
 * Extensions. Those are lenses over the code the Explorer set already holds —
 * swapping the editor area out from under a search result or a diff would hide
 * the very file you clicked into. Composites the layout controllers open
 * programmatically (Changes, the sessions list) are excluded for the same
 * reason they always were: they are not user navigation.
 *
 * The prefix match is the whole point of this function. Extension-contributed
 * view containers are registered as `workbench.view.extension.<id>`
 * (`viewsExtensionPoint.ts`), never as the bare id from the manifest — matching
 * `burrow-*` alone silently excluded every Burrow rail, which is what made this
 * feature look dead on arrival.
 */
const PARTICIPATING_COMPOSITES: ReadonlySet<string> = new Set([
	'workbench.view.explorer',
	SESSIONS_FILES_CONTAINER_ID,
]);

function participates(compositeId: string): boolean {
	return PARTICIPATING_COMPOSITES.has(compositeId) ||
		compositeId.startsWith('workbench.view.extension.burrow-') ||
		compositeId.startsWith('burrow-');
}

interface IStoredState {
	readonly sets?: readonly { readonly key: string; readonly workingSet: IEditorWorkingSet | 'empty' }[];
	readonly lastComposite?: readonly { readonly session: string; readonly compositeId: string }[];
}

/**
 * Per-activity-icon editor working sets: switching between participating
 * left-menu icons saves the current editor tabs under the outgoing icon and
 * restores the incoming icon's own set — separate "workspaces" per icon, so
 * tabs opened from the Components icon never bleed into Database or Files.
 * See [compositeEditorSetsController.md](./compositeEditorSetsController.md).
 *
 * Scoping: session working sets (BaseLayoutController [B2]) are the OUTER
 * scope; icon sets nest inside a session (keys are `session::compositeId`).
 * On a session switch this controller stays quiescent — the base controller
 * restores that session's editors — and re-baselines to the icon that was
 * active for the incoming session, so the two never fight over the editor
 * area. Dirty editors survive swaps (`applyWorkingSet` excludes them from
 * closing) but carry over into the incoming set — documented behavior.
 */
export class CompositeEditorSetsController extends Disposable {

	/** `<session-or-global>::<compositeId>` → that icon's saved editor set. */
	private readonly _setsByKey = new Map<string, IEditorWorkingSet | 'empty'>();
	/** Which icon's set the editor area currently shows, per session — the
	 *  re-baseline anchor after a session switch or reload. */
	private readonly _lastCompositeBySession = new Map<string, string>();

	private _currentKey: string | undefined;
	/**
	 * Set on startup, session switches, and multi-visible transitions: the next
	 * composite event only re-baselines `_currentKey` (the editors on screen
	 * were put there by the workbench/base-controller restore, not by an icon
	 * click) instead of saving/applying.
	 */
	private _pendingRebaseline = true;
	private _applying = false;
	private readonly _sequencer = new Sequencer();
	private readonly _enabledObs;

	constructor(
		@IAgentWorkbenchLayoutService private readonly _layoutService: IAgentWorkbenchLayoutService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@ISessionsManagementService sessionManagementService: ISessionsManagementService,
		@IPaneCompositePartService paneCompositePartService: IPaneCompositePartService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly _editorService: IEditorService,
		@IStorageService private readonly _storageService: IStorageService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();

		this._enabledObs = observableConfigValue(PER_ACTIVITY_EDITOR_SETS_SETTING, true, configurationService);

		this._loadState();
		this._register(this._storageService.onWillSaveState(() => this._saveState()));

		// A session switch hands the editor area to the base controller's
		// working-set restore: remember which icon owned the outgoing session's
		// editors, then go quiescent until the next composite event re-baselines.
		this._register(runOnChange(this._sessionsService.activeSession, (_session, previousSession) => {
			if (previousSession && this._currentKey?.startsWith(`${previousSession.resource.toString()}::`)) {
				this._lastCompositeBySession.set(previousSession.resource.toString(), compositeIdOfKey(this._currentKey));
			}
			this._invalidate();
		}));

		// Multiple visible sessions share one editor area — mirror the base
		// controller's [B5] suppression and re-baseline when collapsing back.
		this._register(autorun(reader => {
			if (this._sessionsService.visibleSessions.read(reader).length > 1) {
				this._invalidate();
			}
		}));

		this._register(paneCompositePartService.onDidPaneCompositeOpen(({ composite, viewContainerLocation }) => {
			if (viewContainerLocation !== ViewContainerLocation.Sidebar && viewContainerLocation !== ViewContainerLocation.AuxiliaryBar) {
				return;
			}
			this._onCompositeOpen(composite.getId());
		}));

		// Removed/archived sessions take their icon sets with them.
		this._register(sessionManagementService.onDidChangeSessions(e => {
			const archived = e.changed.filter(session => session.isArchived.read(undefined));
			for (const session of [...e.removed, ...archived]) {
				this._deleteSessionSets(session.resource);
			}
		}));
	}

	private _invalidate(): void {
		this._pendingRebaseline = true;
		this._currentKey = undefined;
	}

	private _sessionScope(): string {
		return this._sessionsService.activeSession.get()?.resource.toString() ?? 'global';
	}

	private _onCompositeOpen(compositeId: string): void {
		if (!participates(compositeId) || this._applying || !this._enabledObs.get()) {
			return;
		}
		if (this._sessionsService.visibleSessions.get().length > 1) {
			this._invalidate();
			return;
		}
		const scope = this._sessionScope();
		if (this._pendingRebaseline || !this._currentKey) {
			// The editors on screen belong to the icon that was active when this
			// session's working set was captured — NOT necessarily the composite
			// this (possibly restore-driven) event names, e.g. the aux bar
			// re-opening Files during a session restore. Anchor to the remembered
			// icon and swap nothing; a real user click fires another event and
			// goes through the normal save/apply path below.
			const anchor = this._lastCompositeBySession.get(scope) ?? compositeId;
			this._currentKey = `${scope}::${anchor}`;
			this._pendingRebaseline = false;
			return;
		}
		const key = `${scope}::${compositeId}`;
		if (key === this._currentKey) {
			return;
		}
		const previousKey = this._currentKey;
		this._currentKey = key;
		this._lastCompositeBySession.set(scope, compositeId);
		void this._sequencer.queue(async () => {
			this._save(previousKey);
			await this._apply(key);
		});
	}

	private _save(key: string): void {
		const existing = this._setsByKey.get(key);
		if (existing && existing !== 'empty') {
			this._editorGroupsService.deleteWorkingSet(existing);
		}
		if (this._editorService.visibleEditors.length > 0) {
			this._setsByKey.set(key, this._editorGroupsService.saveWorkingSet(`composite-working-set:${key}`));
		} else {
			// Remember emptiness explicitly so returning to this icon clears the
			// editor area instead of inheriting the previous icon's tabs.
			this._setsByKey.set(key, 'empty');
		}
	}

	private async _apply(key: string): Promise<void> {
		const workingSet = this._setsByKey.get(key) ?? 'empty';
		this._applying = true;
		// An icon switch must never toggle the editor part's visibility — it only
		// swaps the tabs inside it (mirrors the base controller's suppression).
		const suppression = this._layoutService.suppressEditorPartAutoVisibility();
		try {
			await this._editorGroupsService.applyWorkingSet(workingSet, { preserveFocus: true });
		} finally {
			suppression.dispose();
			this._applying = false;
		}
	}

	private _deleteSessionSets(sessionResource: URI): void {
		const prefix = `${sessionResource.toString()}::`;
		for (const [key, workingSet] of [...this._setsByKey]) {
			if (key.startsWith(prefix)) {
				if (workingSet !== 'empty') {
					this._editorGroupsService.deleteWorkingSet(workingSet);
				}
				this._setsByKey.delete(key);
			}
		}
		this._lastCompositeBySession.delete(sessionResource.toString());
	}

	// --- persistence ---

	private _loadState(): void {
		const raw = this._storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return;
		}
		try {
			const state = JSON.parse(raw) as IStoredState;
			for (const entry of state.sets ?? []) {
				this._setsByKey.set(entry.key, entry.workingSet);
			}
			for (const entry of state.lastComposite ?? []) {
				this._lastCompositeBySession.set(entry.session, entry.compositeId);
			}
		} catch {
			this._storageService.remove(STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}

	private _saveState(): void {
		// Fold the live editors into the current icon's set so a reload restores
		// per-icon state as-left (the working-set handles themselves are persisted
		// by the editor part).
		if (this._currentKey && this._enabledObs.get() && this._sessionsService.visibleSessions.get().length <= 1) {
			this._save(this._currentKey);
		}
		if (!this._setsByKey.size && !this._lastCompositeBySession.size) {
			this._storageService.remove(STORAGE_KEY, StorageScope.WORKSPACE);
			return;
		}
		const state: IStoredState = {
			sets: [...this._setsByKey].map(([key, workingSet]) => ({ key, workingSet })),
			lastComposite: [...this._lastCompositeBySession].map(([session, compositeId]) => ({ session, compositeId })),
		};
		this._storageService.store(STORAGE_KEY, JSON.stringify(state), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}

function compositeIdOfKey(key: string): string {
	return key.slice(key.lastIndexOf('::') + 2);
}
