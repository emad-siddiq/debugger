/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../nls.js';
import { INativeHostService } from '../../../platform/native/common/native.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import { Action2, MenuId } from '../../../platform/actions/common/actions.js';
import { Categories } from '../../../platform/action/common/actionCommonCategories.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchEnvironmentService } from '../../services/environment/common/environmentService.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { IsDevelopmentContext } from '../../../platform/contextkey/common/contextkeys.js';
import { KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { INativeWorkbenchEnvironmentService } from '../../services/environment/electron-browser/environmentService.js';
import { URI } from '../../../base/common/uri.js';
import { getActiveWindow } from '../../../base/browser/dom.js';
import { IProgressService, ProgressLocation } from '../../../platform/progress/common/progress.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../services/statusbar/browser/statusbar.js';
import { INotificationService } from '../../../platform/notification/common/notification.js'; // BURROW patch 0011
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js'; // BURROW patch 0011
import { IPoint } from '../../../platform/window/common/window.js'; // BURROW patch 0011

export class ToggleDevToolsAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.toggleDevTools',
			title: localize2('toggleDevTools', 'Toggle Developer Tools'),
			category: Categories.Developer,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 50,
				when: IsDevelopmentContext,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyI }
			},
			menu: {
				id: MenuId.MenubarHelpMenu,
				group: '5_tools',
				order: 1
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);

		return nativeHostService.toggleDevTools({ targetWindowId: getActiveWindow().vscodeWindowId });
	}
}

export class ConfigureRuntimeArgumentsAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.configureRuntimeArguments',
			title: localize2('configureRuntimeArguments', 'Configure Runtime Arguments'),
			category: Categories.Preferences,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const environmentService = accessor.get(IWorkbenchEnvironmentService);

		await editorService.openEditor({
			resource: environmentService.argvResource,
			options: { pinned: true }
		});
	}
}

export class ReloadWindowWithExtensionsDisabledAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.reloadWindowWithExtensionsDisabled',
			title: localize2('reloadWindowWithExtensionsDisabled', 'Reload with Extensions Disabled'),
			category: Categories.Developer,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(INativeHostService).reload({ disableExtensions: true });
	}
}

export class OpenUserDataFolderAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.revealUserDataFolder',
			title: localize2('revealUserDataFolder', 'Reveal User Data Folder'),
			category: Categories.Developer,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		const environmentService = accessor.get(INativeWorkbenchEnvironmentService);

		return nativeHostService.showItemInFolder(URI.file(environmentService.userDataPath).fsPath);
	}
}

/**
 * BURROW patch 0011 — the instrument, not the fix.
 *
 * Burrow has no title bar, so it pins the macOS traffic lights itself
 * (`window.trafficLightPosition`). Where they actually land was unmeasurable for
 * three rounds of guessing: they are native views outside the web contents, and
 * `screencapture -l` refuses an occluded window. `getWindowButtonPosition()`
 * answers it directly, and `setWindowButtonPosition()` moves them on the LIVE
 * window, so tuning the pin no longer costs a rebuild per guess.
 *
 * Debug-only: these write nothing. The durable value stays the setting, which
 * the main process reads at window creation.
 */
export class ShowWindowButtonPositionAction extends Action2 {

	constructor() {
		super({
			id: 'burrow.debug.getWindowButtonPosition',
			title: localize2('burrowGetWindowButtonPosition', 'Burrow: Show macOS Window Button Position'),
			category: Categories.Developer,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<IPoint | null> {
		const nativeHostService = accessor.get(INativeHostService);
		const notificationService = accessor.get(INotificationService);

		const position = await nativeHostService.getWindowButtonPosition();
		notificationService.info(position
			? localize('burrowWindowButtonPosition', "macOS window buttons at x={0}, y={1}.", position.x, position.y)
			: localize('burrowWindowButtonPositionNone', "macOS is placing the window buttons itself (no pin on this window)."));

		return position;
	}
}

export class SetWindowButtonPositionAction extends Action2 {

	constructor() {
		super({
			id: 'burrow.debug.setWindowButtonPosition',
			title: localize2('burrowSetWindowButtonPosition', 'Burrow: Move macOS Window Buttons'),
			category: Categories.Developer,
			f1: true
		});
	}

	/**
	 * `position` may be passed by a caller (`x,y`, or `null` to hand placement
	 * back to macOS); with no argument it is asked for. Lasts as long as the
	 * window does — to keep a value, put it in `window.trafficLightPosition`.
	 */
	override async run(accessor: ServicesAccessor, position?: IPoint | null): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		const quickInputService = accessor.get(IQuickInputService);

		if (position === undefined) {
			const answer = await quickInputService.input({
				prompt: localize('burrowSetWindowButtonPositionPrompt', "Window button position as 'x,y' — empty hands placement back to macOS"),
				placeHolder: '0,0'
			});

			if (answer === undefined) {
				return; // cancelled
			}

			const [x, y] = answer.split(',').map(part => parseInt(part.trim(), 10));
			position = (Number.isFinite(x) && Number.isFinite(y)) ? { x, y } : null;
		}

		return nativeHostService.setWindowButtonPosition(position ?? null);
	}
}

export class ShowGPUInfoAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.showGPUInfo',
			title: localize2('showGPUInfo', 'Show GPU Info'),
			category: Categories.Developer,
			f1: true
		});
	}

	run(accessor: ServicesAccessor) {
		const nativeHostService = accessor.get(INativeHostService);
		nativeHostService.openGPUInfoWindow();
	}
}

export class ShowContentTracingAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.showContentTracing',
			title: localize2('showContentTracing', 'Show Content Tracing'),
			category: Categories.Developer,
			f1: true
		});
	}

	run(accessor: ServicesAccessor) {
		const nativeHostService = accessor.get(INativeHostService);
		nativeHostService.openContentTracingWindow();
	}
}

let activeTracingEntry: IStatusbarEntryAccessor | undefined;

const tracingCategories = [
	'content',
	'renderer_host',
	'browser',
	'renderer',
	'blink',
	'blink.user_timing',
	'netlog',
	'net',
	'v8',
	'disabled-by-default-v8.cpu_profiler',
	'disabled-by-default-v8.compile',
	'disabled-by-default-v8.gc',
	'disabled-by-default-v8.gc_stats',
	'disabled-by-default-devtools.timeline',
	'disabled-by-default-network',
	'disabled-by-default-net',
];

async function startTracingSession(accessor: ServicesAccessor, options: { readonly enableHeapProfiling: boolean }): Promise<void> {
	const nativeHostService = accessor.get(INativeHostService);
	const statusbarService = accessor.get(IStatusbarService);

	const categories = [...tracingCategories];
	if (options.enableHeapProfiling) {
		categories.push('disabled-by-default-memory-infra');
	}

	await nativeHostService.startTracing(categories.join(','), { enableHeapProfiling: options.enableHeapProfiling });

	activeTracingEntry?.dispose();
	activeTracingEntry = statusbarService.addEntry({
		name: localize('startTracing.name', "Performance Trace"),
		text: '$(record) ' + localize('startTracing.recording', "Recording trace (click to stop)"),
		ariaLabel: localize('startTracing.ariaLabel', "Recording performance trace. Click to stop recording."),
		tooltip: localize('startTracing.tooltip', "Click to stop recording"),
		kind: 'error',
		command: StopTracing.ID
	}, 'status.tracing', StatusbarAlignment.LEFT, -Number.MAX_VALUE);
}

export class StartTracing extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.startTracing',
			title: localize2('startTracing', 'Start Tracing'),
			category: Categories.Developer,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await startTracingSession(accessor, { enableHeapProfiling: false });
	}
}

export class StartHeapTracing extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.startHeapTracing',
			title: localize2('startHeapTracing', 'Start Heap Tracing'),
			category: Categories.Developer,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await startTracingSession(accessor, { enableHeapProfiling: true });
	}
}

export class StopTracing extends Action2 {

	static readonly ID = 'workbench.action.stopTracing';

	constructor() {
		super({
			id: StopTracing.ID,
			title: localize2('stopTracing', 'Stop Tracing'),
			category: Categories.Developer,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		const environmentService = accessor.get(INativeWorkbenchEnvironmentService);
		const dialogService = accessor.get(IDialogService);
		const progressService = accessor.get(IProgressService);

		if (!activeTracingEntry && !environmentService.args.trace) {
			const { confirmed } = await dialogService.confirm({
				message: localize('stopTracing.message', "No tracing session is in progress. Use 'Developer: Start Tracing' or launch with a '--trace' argument to begin tracing."),
				primaryButton: localize({ key: 'stopTracing.button', comment: ['&& denotes a mnemonic'] }, "&&Relaunch and Enable Tracing"),
			});

			if (confirmed) {
				return nativeHostService.relaunch({ addArgs: ['--trace'] });
			}

			return;
		}

		await progressService.withProgress({
			location: ProgressLocation.Dialog,
			title: localize('stopTracing.title', "Creating trace file..."),
			cancellable: false,
			detail: localize('stopTracing.detail', "This can take up to one minute to complete.")
		}, () => nativeHostService.stopTracing());

		activeTracingEntry?.dispose();
		activeTracingEntry = undefined;
	}
}
