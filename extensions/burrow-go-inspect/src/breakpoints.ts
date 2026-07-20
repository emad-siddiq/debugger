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

interface BreakpointItem extends QuickPickItem {
	readonly bp: Breakpoint;
}

const TOGGLE = { iconPath: new ThemeIcon('circle-slash'), tooltip: 'Enable / disable' };
const REMOVE = { iconPath: new ThemeIcon('trash'), tooltip: 'Remove' };

/** Register the command; returns the disposable for the caller to track. */
export function registerBreakpointsCommand() {
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
		pick.buttons = items.length
			? [{ iconPath: new ThemeIcon('clear-all'), tooltip: 'Remove all breakpoints' }]
			: [];
		if (items.length === 0) {
			pick.placeholder = 'No breakpoints set.';
		}
	};
	populate();

	const sub = debug.onDidChangeBreakpoints(populate);

	pick.onDidTriggerItemButton((e: QuickPickItemButtonEvent<BreakpointItem>) => {
		if (e.button === TOGGLE) {
			toggleEnabled(e.item.bp);
		} else if (e.button === REMOVE) {
			debug.removeBreakpoints([e.item.bp]);
		}
		// onDidChangeBreakpoints repopulates; no manual refresh needed.
	});

	pick.onDidTriggerButton(() => {
		if (debug.breakpoints.length) {
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

/** Flip a breakpoint's enabled flag. `enabled` is readonly, so replace in place. */
function toggleEnabled(bp: Breakpoint): void {
	const replacement = bp instanceof SourceBreakpoint
		? new SourceBreakpoint(bp.location, !bp.enabled, bp.condition, bp.hitCondition, bp.logMessage)
		: bp instanceof FunctionBreakpoint
			? new FunctionBreakpoint(bp.functionName, !bp.enabled, bp.condition, bp.hitCondition, bp.logMessage)
			: undefined;
	if (replacement) {
		// Remove-then-add so the new one keeps everything but the enabled flag.
		debug.removeBreakpoints([bp]);
		debug.addBreakpoints([replacement]);
	}
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
	return { label, description: conditions || undefined, bp, buttons: [TOGGLE, REMOVE] };
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
