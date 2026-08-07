/*---------------------------------------------------------------------------------------------
 *  Burrow: extension-published control chips for the local chat input.
 *
 *  Upstream lets an extension contribute chat-input pickers only for chat *session types*
 *  it owns (`chatSessionsProvider` option groups); the local panel has none, and
 *  `contributes.menus` titles are static, so a chip whose label tracks state is out of
 *  reach for an extension. This is the generic host for that: an extension publishes a
 *  small map of groups, core renders up to four dropdown chips from it, and a pick is
 *  handed straight back to the extension.
 *
 *  Nothing here is Claude-specific — burrow-chat owns every semantic. The bridge:
 *    burrow.chat.controls.publish(payload)   extension → core, on every state change
 *    burrow.chat.controls.pick(group, item, session)   core → extension, on click
 *    burrow.chat.controls.activeSession()    extension → core, which tab is focused
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { renderLabelWithIcons } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable, IDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun, IObservable, observableValue } from '../../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction, IActionWidgetDropdownOptions } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../../../platform/instantiation/common/extensions.js';
import { createDecorator, ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { localChatSessionType } from '../../../common/chatSessionsService.js';
import { IChatWidgetService } from '../../chat.js';
import { ChatInputPickerActionViewItem, IChatInputPickerOptions } from './chatInputPickerActionItem.js';
import type { MenuItemAction } from '../../../../../../platform/actions/common/actions.js';

/** How many chips core is willing to render. Each needs its own statically-registered action. */
export const BURROW_CONTROL_SLOTS = 4;

export interface IBurrowControlChipItem {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
}

export interface IBurrowControlChipGroup {
	readonly id: string;
	/** The chip's live label — already formatted by the publisher, e.g. "Effort: high". */
	readonly label: string;
	/** The same state, abbreviated for a narrow chat input, e.g. "high". */
	readonly shortLabel?: string;
	readonly tooltip: string;
	readonly selected: string;
	readonly items: readonly IBurrowControlChipItem[];
}

export interface IBurrowControlsPayload {
	/** Groups for any session the publisher has no specific state for. */
	readonly default: readonly IBurrowControlChipGroup[];
	/** Per-session overrides, keyed by `sessionResource.toString()`. */
	readonly sessions: { readonly [sessionResource: string]: readonly IBurrowControlChipGroup[] };
}

const EMPTY_PAYLOAD: IBurrowControlsPayload = { default: [], sessions: {} };

export const IBurrowChatControlsService = createDecorator<IBurrowChatControlsService>('burrowChatControlsService');

export interface IBurrowChatControlsService {
	readonly _serviceBrand: undefined;
	readonly payload: IObservable<IBurrowControlsPayload>;
	publish(payload: IBurrowControlsPayload): void;
	/** The groups a chip row should show for one chat tab. */
	groupsFor(sessionResource: URI | undefined): readonly IBurrowControlChipGroup[];
}

const slotKeys: RawContextKey<boolean>[] = [];
for (let i = 0; i < BURROW_CONTROL_SLOTS; i++) {
	slotKeys.push(new RawContextKey<boolean>(`burrowChatControlsSlot${i}`, false, {
		type: 'boolean',
		description: localize('burrowChatControlsSlot', "True when an extension has published a control chip for this slot."),
	}));
}

class BurrowChatControlsService extends Disposable implements IBurrowChatControlsService {
	declare readonly _serviceBrand: undefined;

	private readonly _payload = observableValue<IBurrowControlsPayload>('burrowChatControls', EMPTY_PAYLOAD);
	readonly payload: IObservable<IBurrowControlsPayload> = this._payload;

	private readonly slots: IContextKey<boolean>[];

	constructor(@IContextKeyService contextKeyService: IContextKeyService) {
		super();
		this.slots = slotKeys.map(key => key.bindTo(contextKeyService));
	}

	publish(payload: IBurrowControlsPayload): void {
		const next: IBurrowControlsPayload = {
			default: payload?.default ?? [],
			sessions: payload?.sessions ?? {},
		};
		this._payload.set(next, undefined);
		// A slot exists as soon as the default row has a group for it; per-session rows
		// are the same shape, so the default row is the honest source of chip count.
		for (let i = 0; i < BURROW_CONTROL_SLOTS; i++) {
			this.slots[i].set(i < next.default.length);
		}
	}

	groupsFor(sessionResource: URI | undefined): readonly IBurrowControlChipGroup[] {
		const payload = this._payload.get();
		const forSession = sessionResource ? payload.sessions[sessionResource.toString()] : undefined;
		return forSession ?? payload.default;
	}
}

registerSingleton(IBurrowChatControlsService, BurrowChatControlsService, InstantiationType.Delayed);

// --- the bridge ---------------------------------------------------------------------------------

CommandsRegistry.registerCommand('burrow.chat.controls.publish', (accessor: ServicesAccessor, payload: IBurrowControlsPayload) => {
	accessor.get(IBurrowChatControlsService).publish(payload);
});

CommandsRegistry.registerCommand('burrow.chat.controls.activeSession', (accessor: ServicesAccessor) => {
	return accessor.get(IChatWidgetService).lastFocusedWidget?.viewModel?.model.sessionResource?.toString();
});

// --- the chips ----------------------------------------------------------------------------------

/**
 * One statically-registered action per slot. Their titles never render — the view item
 * draws the published label — but they are what puts a chip in the toolbar at all.
 */
class BurrowControlSlotAction extends Action2 {
	static id(slot: number): string { return `burrow.chat.controls.slot${slot}`; }
	constructor(slot: number) {
		super({
			id: BurrowControlSlotAction.id(slot),
			title: localize2('burrowChatControls.slot', "Claude Control"),
			f1: false,
			precondition: ChatContextKeys.enabled,
			menu: [{
				id: MenuId.ChatInputSecondary,
				group: 'navigation',
				// Between the workspace pickers (0.6) and the built-in Approvals picker (1),
				// which is where the agent-host chips sit.
				order: 0.71 + slot / 100,
				when: ContextKeyExpr.and(
					ChatContextKeys.chatSessionType.isEqualTo(localChatSessionType),
					slotKeys[slot],
				),
			}],
		});
	}
	override async run(): Promise<void> { /* the action view item owns the interaction */ }
}

for (let slot = 0; slot < BURROW_CONTROL_SLOTS; slot++) {
	registerAction2(class extends BurrowControlSlotAction { constructor() { super(slot); } });
}

export function isBurrowControlSlotAction(id: string): number | undefined {
	for (let slot = 0; slot < BURROW_CONTROL_SLOTS; slot++) {
		if (id === BurrowControlSlotAction.id(slot)) { return slot; }
	}
	return undefined;
}

const GROUP_ICONS: Record<string, ThemeIcon> = {
	effort: Codicon.symbolEvent,
	thinking: Codicon.lightbulb,
	permissionMode: Codicon.shield,
	agent: Codicon.person,
};

export class BurrowControlChipActionViewItem extends ChatInputPickerActionViewItem {

	constructor(
		action: MenuItemAction,
		private readonly slot: number,
		private readonly sessionResource: () => URI | undefined,
		pickerOptions: IChatInputPickerOptions,
		@IBurrowChatControlsService private readonly controlsService: IBurrowChatControlsService,
		@ICommandService commandService: ICommandService,
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		const options: Omit<IActionWidgetDropdownOptions, 'label' | 'labelRenderer'> = {
			actionProvider: {
				getActions: (): IActionWidgetDropdownAction[] => {
					const group = this.group();
					if (!group) { return []; }
					return group.items.map(item => ({
						...action,
						id: `${group.id}.${item.id}`,
						label: item.label,
						tooltip: '',
						hover: item.description ? { content: item.description } : undefined,
						enabled: true,
						checked: item.id === group.selected,
						run: async () => {
							await commandService.executeCommand(
								'burrow.chat.controls.pick',
								group.id,
								item.id,
								this.sessionResource()?.toString(),
							);
							if (this.element) { this.renderLabel(this.element); }
						},
					} satisfies IActionWidgetDropdownAction));
				},
			},
			reporter: { id: 'BurrowControlChip', name: 'BurrowControlChip', includeOptions: true },
		};

		super(action, options, pickerOptions, actionWidgetService, keybindingService, contextKeyService, telemetryService);

		this._register(autorun(reader => {
			this.controlsService.payload.read(reader);
			if (this.element) { this.renderLabel(this.element); }
		}));
	}

	private group(): IBurrowControlChipGroup | undefined {
		return this.controlsService.groupsFor(this.sessionResource())[this.slot];
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('burrow-control-chip-item');
	}

	protected override renderLabel(element: HTMLElement): IDisposable | null {
		this.setAriaLabelAttributes(element);
		const group = this.group();
		if (!group) {
			dom.reset(element);
			return null;
		}
		element.title = group.tooltip;
		element.setAttribute('aria-label', group.label);

		// Unlike the mode picker, a control chip never collapses to a bare icon: four
		// similar codicons in a row say nothing, and the whole point of the chip is to
		// show the current value. Narrow input ⇒ the abbreviated value instead.
		const icon = GROUP_ICONS[group.id];
		const compact = this.pickerOptions.compact.get();
		const text = compact ? (group.shortLabel ?? group.label) : group.label;
		const labelElements = [];
		if (icon) { labelElements.push(...renderLabelWithIcons(`$(${icon.id})`)); }
		labelElements.push(dom.$('span.chat-input-picker-label', undefined, text));
		dom.reset(element, ...labelElements);
		return null;
	}
}
