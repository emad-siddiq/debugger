/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// breakpoints.ts — breakpoint management as a POPOVER, not a permanent pane (IX,
// architecture task 05.1: "Breakpoints management moves to a popover … it's
// configuration, not hot state, and doesn't deserve permanent space"). The pane
// is retired in core patch 0009; this is the surface that replaces it.
//
// The design draws it hanging off the scheme bar's 🐞 menu. The extension API has
// no supported way to add a button to that pre-launch bar, so the entry points are
// a command (palette + keybinding) and a 🐞 item on the debug toolbar while a
// session runs. A QuickPick with per-item buttons IS the native popover the design
// asks for — transient, keyboard-driven, no permanent real estate.

import {
	Breakpoint,
	FunctionBreakpoint,
	QuickPickItem,
	QuickPickItemButtonEvent,
	Range,
	Selection,
	SourceBreakpoint,
	TextEditorRevealType,
	ThemeIcon,
	Uri,
	commands,
	debug,
	window,
	workspace,
} from 'vscode';
import { AdapterCapabilities } from './capabilities';

interface BreakpointItem extends QuickPickItem {
	readonly bp: Breakpoint;
}

const EDIT = { iconPath: new ThemeIcon('edit'), tooltip: 'Condition, hit count, log message' };
const TOGGLE = { iconPath: new ThemeIcon('circle-slash'), tooltip: 'Enable / disable' };
const REMOVE = { iconPath: new ThemeIcon('trash'), tooltip: 'Remove' };
const ADD_FUNCTION = { iconPath: new ThemeIcon('symbol-function'), tooltip: 'Break on a function by name' };
const CLEAR_ALL = { iconPath: new ThemeIcon('clear-all'), tooltip: 'Remove all breakpoints' };

/**
 * What the adapter said it can do. Set by the caller from the debug tracker, so
 * the edit sheet greys a field with a measured reason instead of offering one
 * the adapter will drop in silence.
 */
let capabilities = new AdapterCapabilities();

/** Register the command; returns the disposable for the caller to track. */
export function registerBreakpointsCommand(observed?: AdapterCapabilities) {
	if (observed) {
		capabilities = observed;
	}
	return commands.registerCommand('burrow.breakpoints.manage', manageBreakpoints);
}

async function manageBreakpoints(): Promise<void> {
	const pick = window.createQuickPick<BreakpointItem>();
	pick.title = 'Breakpoints';
	pick.placeholder = 'Select a breakpoint to reveal it · buttons to enable/disable or remove';
	pick.matchOnDescription = true;

	// Kept live so the picker reflects toggles the user makes from inside it, and
	// any set/cleared in the editor while it is open.
	const populate = () => {
		const items = debug.breakpoints.map(toItem).sort(byLocation);
		pick.items = items;
		pick.buttons = items.length ? [ADD_FUNCTION, CLEAR_ALL] : [ADD_FUNCTION];
		if (items.length === 0) {
			pick.placeholder = 'No breakpoints set. Use the ƒ button to break on a function by name.';
		}
	};
	populate();

	const sub = debug.onDidChangeBreakpoints(populate);

	pick.onDidTriggerItemButton((e: QuickPickItemButtonEvent<BreakpointItem>) => {
		if (e.button === TOGGLE) {
			toggleEnabled(e.item.bp);
		} else if (e.button === REMOVE) {
			debug.removeBreakpoints([e.item.bp]);
		} else if (e.button === EDIT) {
			// The sheet takes over the screen, so this picker steps aside and comes
			// back — two stacked QuickPicks lose keyboard focus to each other.
			pick.hide();
			void editBreakpoint(e.item.bp).then(() => manageBreakpoints());
		}
		// onDidChangeBreakpoints repopulates; no manual refresh needed.
	});

	pick.onDidTriggerButton(button => {
		if (button === ADD_FUNCTION) {
			pick.hide();
			void addFunctionBreakpoint().then(() => manageBreakpoints());
		} else if (button === CLEAR_ALL && debug.breakpoints.length) {
			debug.removeBreakpoints(debug.breakpoints);
		}
	});

	pick.onDidAccept(async () => {
		const item = pick.selectedItems[0];
		pick.hide();
		if (item) {
			await reveal(item.bp);
		}
	});

	pick.onDidHide(() => {
		sub.dispose();
		pick.dispose();
	});

	pick.show();
}

/** One editable field of a breakpoint, as a row in the edit sheet. */
interface FieldItem extends QuickPickItem {
	readonly field: 'condition' | 'hitCondition' | 'logMessage';
}

const FIELD_PROMPT: Record<FieldItem['field'], { label: string; prompt: string; placeholder: string }> = {
	condition: {
		label: '$(symbol-boolean) Condition',
		prompt: 'Break only when this Go expression is true. Empty clears it.',
		placeholder: 'i > 10 && err != nil',
	},
	hitCondition: {
		label: '$(symbol-numeric) Hit count',
		prompt: 'Break only after this many hits. Empty clears it.',
		placeholder: '5',
	},
	logMessage: {
		label: '$(output) Log message',
		prompt: 'Log this instead of breaking. {expressions} are interpolated. Empty clears it.',
		placeholder: 'reached with n={n}',
	},
};

/**
 * The edit sheet: condition, hit count and log message for one breakpoint.
 *
 * This is what patch 0009 left without a door. Retiring the stock Breakpoints
 * pane moved management into this popover, but the popover could only reveal,
 * toggle and remove — so the three fields it *displayed* could not be set from
 * anywhere in Burrow at all.
 *
 * A field the adapter cannot drive is listed and disabled with the reason on the
 * row, never hidden and never silently accepted: the workbench takes an
 * unsupported hit count without complaint and the adapter drops it, which is the
 * worst of both.
 */
async function editBreakpoint(bp: Breakpoint): Promise<void> {
	const rows: FieldItem[] = (['condition', 'hitCondition', 'logMessage'] as const).map(field => {
		const { label } = FIELD_PROMPT[field];
		const current = bp[field];
		const support = capabilities.support(field);
		return {
			field,
			label,
			description: current || undefined,
			detail: support.supported
				? (support.reason ? `— ${support.reason}` : undefined)
				: `$(circle-slash) ${support.reason}`,
		};
	});

	const chosen = await window.showQuickPick(rows, {
		title: describe(bp),
		placeHolder: 'Which field?',
	});
	if (!chosen) {
		return;
	}

	const support = capabilities.support(chosen.field);
	if (!support.supported) {
		void window.showInformationMessage(
			`${support.reason}. The field is left alone rather than set to something that would be dropped.`,
		);
		return;
	}

	const { prompt, placeholder } = FIELD_PROMPT[chosen.field];
	const value = await window.showInputBox({
		title: describe(bp),
		prompt,
		placeHolder: placeholder,
		value: bp[chosen.field] ?? '',
	});
	if (value === undefined) {
		return; // dismissed; an empty string is a deliberate clear
	}
	replace(bp, { [chosen.field]: value.trim() || undefined });
}

/**
 * Adds a breakpoint on a function by name — `main.run`, `(*Server).Handle`.
 *
 * Specified in 04-delve-debugging-engine.md as "function-by-symbol" and never
 * built. Delve advertises `supportsFunctionBreakpoints`, so this is a name and
 * a request; the value is stopping in a function you have not opened, which is
 * the whole point of not having to find the file first.
 */
async function addFunctionBreakpoint(): Promise<void> {
	const support = capabilities.support('functionBreakpoint');
	if (!support.supported) {
		void window.showInformationMessage(`${support.reason}.`);
		return;
	}
	const name = await window.showInputBox({
		title: 'Break on function',
		prompt: 'A Go function name as Delve spells it — package-qualified, methods on the receiver type.',
		placeHolder: 'main.run  ·  (*Server).Handle  ·  net/http.ListenAndServe',
	});
	const trimmed = name?.trim();
	if (!trimmed) {
		return;
	}
	debug.addBreakpoints([new FunctionBreakpoint(trimmed)]);
}

/** A one-line name for a breakpoint, for a sheet title. */
function describe(bp: Breakpoint): string {
	if (bp instanceof SourceBreakpoint) {
		return `${labelFor(bp.location.uri)}:${bp.location.range.start.line + 1}`;
	}
	if (bp instanceof FunctionBreakpoint) {
		return bp.functionName;
	}
	return 'Breakpoint';
}

/**
 * Replaces a breakpoint with a copy carrying `changes`.
 *
 * Every field on a Breakpoint is readonly, so there is no in-place edit: the old
 * one is removed and a new one added. Everything not named in `changes` is
 * carried across, which is why this takes a patch rather than a whole
 * breakpoint — a field dropped here reads to the user as the debugger forgetting
 * their condition.
 */
function replace(bp: Breakpoint, changes: Partial<Pick<Breakpoint, 'condition' | 'hitCondition' | 'logMessage'>> & { enabled?: boolean }): void {
	const enabled = changes.enabled ?? bp.enabled;
	const condition = 'condition' in changes ? changes.condition : bp.condition;
	const hitCondition = 'hitCondition' in changes ? changes.hitCondition : bp.hitCondition;
	const logMessage = 'logMessage' in changes ? changes.logMessage : bp.logMessage;

	const replacement = bp instanceof SourceBreakpoint
		? new SourceBreakpoint(bp.location, enabled, condition, hitCondition, logMessage)
		: bp instanceof FunctionBreakpoint
			? new FunctionBreakpoint(bp.functionName, enabled, condition, hitCondition, logMessage)
			: undefined;
	if (replacement) {
		debug.removeBreakpoints([bp]);
		debug.addBreakpoints([replacement]);
	}
}

/** Flip a breakpoint's enabled flag, keeping everything else. */
function toggleEnabled(bp: Breakpoint): void {
	replace(bp, { enabled: !bp.enabled });
}

function toItem(bp: Breakpoint): BreakpointItem {
	const enabled = bp.enabled;
	const label = bp instanceof SourceBreakpoint
		? `$(${enabled ? 'debug-breakpoint' : 'debug-breakpoint-disabled'}) ${labelFor(bp.location.uri)}:${bp.location.range.start.line + 1}`
		: bp instanceof FunctionBreakpoint
			? `$(symbol-function) ${bp.functionName}`
			: '$(debug-breakpoint) breakpoint';
	const conditions = [
		bp.condition && `when ${bp.condition}`,
		bp.hitCondition && `hits ${bp.hitCondition}`,
		bp.logMessage && `log "${bp.logMessage}"`,
		!enabled && 'disabled',
	].filter(Boolean).join(' · ');
	return { label, description: conditions || undefined, bp, buttons: [EDIT, TOGGLE, REMOVE] };
}

/** A workspace-relative path when we can, the basename otherwise. */
function labelFor(uri: Uri): string {
	const rel = workspace.asRelativePath(uri, false);
	return rel || uri.path.split('/').pop() || uri.path;
}

/** Source breakpoints sort by file then line; function breakpoints trail, by name. */
function byLocation(a: BreakpointItem, b: BreakpointItem): number {
	const sa = a.bp instanceof SourceBreakpoint ? a.bp : undefined;
	const sb = b.bp instanceof SourceBreakpoint ? b.bp : undefined;
	if (sa && sb) {
		return sa.location.uri.path.localeCompare(sb.location.uri.path) || sa.location.range.start.line - sb.location.range.start.line;
	}
	if (sa) {
		return -1;
	}
	if (sb) {
		return 1;
	}
	return a.label.localeCompare(b.label);
}

/** Open the editor at a source breakpoint; function breakpoints have no location. */
async function reveal(bp: Breakpoint): Promise<void> {
	if (!(bp instanceof SourceBreakpoint)) {
		return;
	}
	const editor = await window.showTextDocument(bp.location.uri);
	const line = bp.location.range.start.line;
	editor.selection = new Selection(line, 0, line, 0);
	editor.revealRange(new Range(line, 0, line, 0), TextEditorRevealType.InCenter);
}
