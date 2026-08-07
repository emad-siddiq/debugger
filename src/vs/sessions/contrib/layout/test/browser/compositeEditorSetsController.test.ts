/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { StorageScope, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import { IPaneComposite } from '../../../../../workbench/common/panecomposite.js';
import { ViewContainerLocation } from '../../../../../workbench/common/views.js';
import { IPaneCompositePartService } from '../../../../../workbench/services/panecomposite/browser/panecomposite.js';
import { CompositeEditorSetsController } from '../../browser/compositeEditorSetsController.js';
import { SESSIONS_FILES_CONTAINER_ID } from '../../../files/browser/files.contribution.js';
import { createTestHarness, ITestLayoutHarness, makeSession } from './layoutControllerTestUtils.js';

suite('CompositeEditorSetsController', () => {

	const store = new DisposableStore();
	let harness: ITestLayoutHarness;
	let onDidPaneCompositeOpen: Emitter<{ composite: IPaneComposite; viewContainerLocation: ViewContainerLocation }>;

	function createController(options: { enabled?: boolean } = {}): CompositeEditorSetsController {
		harness = createTestHarness(store);
		if (options.enabled === false) {
			(harness.instaService.get(IConfigurationService) as TestConfigurationService)
				.setUserConfiguration('sessions.layout.perActivityEditorSets', false);
		}
		onDidPaneCompositeOpen = store.add(new Emitter<{ composite: IPaneComposite; viewContainerLocation: ViewContainerLocation }>());
		const emitter = onDidPaneCompositeOpen;
		harness.instaService.stub(IPaneCompositePartService, new class extends mock<IPaneCompositePartService>() {
			override readonly onDidPaneCompositeOpen = emitter.event;
		});
		return store.add(harness.instaService.createInstance(CompositeEditorSetsController));
	}

	function openComposite(id: string, location = ViewContainerLocation.Sidebar): void {
		onDidPaneCompositeOpen.fire({
			composite: new class extends mock<IPaneComposite>() {
				override getId() { return id; }
			},
			viewContainerLocation: location,
		});
	}

	teardown(() => store.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	test('[C2] switching icons saves the outgoing set and applies the incoming one', async () => {
		createController();
		harness.visibleEditorsList = [{}];

		openComposite('burrow-frontend'); // baseline — no swap
		harness.applyWorkingSetCalls = [];

		openComposite('burrow-db');
		await timeout(0);

		// Outgoing (Components) editors were saved; incoming (Database) has no
		// set yet, so the editor area is cleared.
		assert.deepStrictEqual(harness.applyWorkingSetCalls, ['empty']);

		// Back to Components: its saved set is applied.
		harness.applyWorkingSetCalls = [];
		openComposite('burrow-frontend');
		await timeout(0);
		assert.deepStrictEqual(harness.applyWorkingSetCalls, [
			{ id: 'composite-working-set:global::burrow-frontend', name: 'composite-working-set:global::burrow-frontend' },
		]);
	});

	test('[C2] applies under editor-part auto-visibility suppression', async () => {
		createController();
		harness.visibleEditorsList = [{}];
		openComposite('burrow-frontend');

		let suppressedDuringApply = false;
		harness.onApplyWorkingSet = () => { suppressedDuringApply = harness.editorPartAutoVisibilitySuppressionDepth > 0; };
		openComposite(SESSIONS_FILES_CONTAINER_ID, ViewContainerLocation.AuxiliaryBar);
		await timeout(0);

		assert.strictEqual(suppressedDuringApply, true, 'icon switches must never toggle editor-part visibility');
	});

	test('[C1] non-participating composites never swap', async () => {
		createController();
		harness.visibleEditorsList = [{}];
		openComposite('burrow-frontend');
		harness.applyWorkingSetCalls = [];

		openComposite('workbench.sessions.auxiliaryBar.changesContainer', ViewContainerLocation.AuxiliaryBar);
		openComposite('some.other.viewlet');
		await timeout(0);

		assert.deepStrictEqual(harness.applyWorkingSetCalls, [], 'non-allowlisted composites must not swap editor sets');
	});

	test('[C1] participates under the id extension containers are really registered with', async () => {
		createController();
		harness.visibleEditorsList = [{}];

		// The manifest says `burrow-db`, but viewsExtensionPoint registers the
		// container as `workbench.view.extension.burrow-db` and that is the id the
		// composite event carries. Matching only the manifest id made this whole
		// feature dead on arrival — every rail looked non-participating.
		openComposite('workbench.view.extension.burrow-frontend');
		harness.applyWorkingSetCalls = [];

		openComposite('workbench.view.extension.burrow-db');
		await timeout(0);
		assert.deepStrictEqual(harness.applyWorkingSetCalls, ['empty']);

		harness.applyWorkingSetCalls = [];
		openComposite('workbench.view.explorer');
		await timeout(0);
		assert.deepStrictEqual(harness.applyWorkingSetCalls, ['empty'], 'Explorer owns a section too');
	});

	test('[C1] code lenses over the Explorer set never swap it away', async () => {
		createController();
		harness.visibleEditorsList = [{}];
		openComposite('workbench.view.explorer');
		harness.applyWorkingSetCalls = [];

		// Search, SCM and Debug operate on the files the Explorer set is showing;
		// hiding those files when you click into a search result would be absurd.
		openComposite('workbench.view.search');
		openComposite('workbench.view.scm');
		openComposite('workbench.view.debug');
		openComposite('workbench.view.extension.someone-elses-extension');
		await timeout(0);

		assert.deepStrictEqual(harness.applyWorkingSetCalls, []);
	});

	test('[C2] re-opening the current icon is a no-op', async () => {
		createController();
		harness.visibleEditorsList = [{}];
		openComposite('burrow-frontend');
		harness.applyWorkingSetCalls = [];

		openComposite('burrow-frontend');
		await timeout(0);

		assert.deepStrictEqual(harness.applyWorkingSetCalls, []);
	});

	test('[C3] a session switch re-baselines without swapping, and restore-noise keeps the anchor', async () => {
		createController();
		harness.visibleEditorsList = [{}];

		const session1 = makeSession(URI.parse('session:1'));
		const session2 = makeSession(URI.parse('session:2'));

		harness.activeSessionObs.set(session1, undefined);
		openComposite('burrow-frontend'); // baseline for session 1
		openComposite('burrow-db');       // real switch within session 1
		await timeout(0);

		// Session switch: the base controller owns the editor area now.
		harness.applyWorkingSetCalls = [];
		harness.activeSessionObs.set(session2, undefined);

		// Restore-driven composite open (aux bar re-opening Files) must not swap.
		openComposite(SESSIONS_FILES_CONTAINER_ID, ViewContainerLocation.AuxiliaryBar);
		await timeout(0);
		assert.deepStrictEqual(harness.applyWorkingSetCalls, [], 'restore-driven composite opens must not swap editor sets');

		// Returning to session 1 re-baselines to its remembered icon (Database):
		// a click on Database is then a no-op, a click on Components swaps.
		harness.activeSessionObs.set(session1, undefined);
		openComposite('burrow-db');
		await timeout(0);
		assert.deepStrictEqual(harness.applyWorkingSetCalls, [], 'the remembered icon must be the re-baseline anchor');

		openComposite('burrow-frontend');
		await timeout(0);
		assert.deepStrictEqual(harness.applyWorkingSetCalls, [
			{ id: 'composite-working-set:session:1::burrow-frontend', name: 'composite-working-set:session:1::burrow-frontend' },
		]);
	});

	test('[C4] suppressed while multiple sessions are visible', async () => {
		createController();
		harness.visibleEditorsList = [{}];
		openComposite('burrow-frontend');
		harness.applyWorkingSetCalls = [];

		const session1 = makeSession(URI.parse('session:1'));
		const session2 = makeSession(URI.parse('session:2'));
		harness.visibleSessionsObs.set([session1, session2], undefined);

		openComposite('burrow-db');
		await timeout(0);

		assert.deepStrictEqual(harness.applyWorkingSetCalls, [], 'no swaps while the editor area is shared across sessions');
	});

	test('[C2] an icon left with no editors clears the editor area on return', async () => {
		createController();

		// Components has editors; Database is opened and left empty.
		harness.visibleEditorsList = [{}];
		openComposite('burrow-frontend');
		openComposite('burrow-db');
		await timeout(0);

		// Leave Database with NO visible editors, go to Components…
		harness.visibleEditorsList = [];
		harness.applyWorkingSetCalls = [];
		openComposite('burrow-frontend');
		await timeout(0);
		assert.deepStrictEqual(harness.applyWorkingSetCalls, [
			{ id: 'composite-working-set:global::burrow-frontend', name: 'composite-working-set:global::burrow-frontend' },
		]);

		// …and back to Database: its explicit 'empty' sentinel clears the area.
		harness.visibleEditorsList = [{}];
		harness.applyWorkingSetCalls = [];
		openComposite('burrow-db');
		await timeout(0);
		assert.deepStrictEqual(harness.applyWorkingSetCalls, ['empty']);
	});

	test('setting off disables all swaps', async () => {
		createController({ enabled: false });
		harness.visibleEditorsList = [{}];

		openComposite('burrow-frontend');
		openComposite('burrow-db');
		await timeout(0);

		assert.deepStrictEqual(harness.applyWorkingSetCalls, []);
	});

	test('[C6] persists sets + anchors on shutdown and reloads them', async () => {
		createController();
		harness.visibleEditorsList = [{}];

		const session1 = makeSession(URI.parse('session:1'));
		harness.activeSessionObs.set(session1, undefined);
		openComposite('burrow-frontend');
		openComposite('burrow-db');
		await timeout(0);

		harness.storageService.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);
		const raw = harness.storageService.get('sessions.compositeEditorSets', StorageScope.WORKSPACE);
		assert.ok(raw, 'state should be persisted');
		const state = JSON.parse(raw!);
		assert.deepStrictEqual(state.lastComposite, [{ session: 'session:1', compositeId: 'burrow-db' }]);
		const keys = state.sets.map((s: { key: string }) => s.key).sort();
		assert.deepStrictEqual(keys, ['session:1::burrow-db', 'session:1::burrow-frontend']);
	});
});
