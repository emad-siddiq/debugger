/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

// The panel's size states (docs/plans/03 §8), and an honest count of them.
//
// The plan asked for three — docked, half screen, full screen — behind one
// command. Two shipped. **Full** is the workbench's own maximized secondary
// side bar, which is exact, and Esc comes back from it; the plan sketched Focus
// Mode for this, but Focus Mode HIDES the side bars, which would take the agent
// off screen instead of filling the screen with it.
//
// **Half** is not here, and the reason is worth writing down so nobody spends
// the afternoon again. An extension cannot name a part to resize: the only
// levers are `Increase/Decrease Editor Width`, which act on whichever part has
// focus, in fixed 60px steps. Focus cannot be aimed at this panel either — a
// webview's iframe is rendered in an overlay container, NOT inside the part it
// appears in, so with the cursor in the agent panel the workbench resizes the
// editor instead and the panel gets squeezed to its 170px minimum: the exact
// opposite of the button. Focusing the editor first and shrinking it does not
// hand the width over either. A half state wants one small core-side command
// (`layoutService.resizePart(AUXILIARYBAR_PART, …)` in `src/vs/sessions`) —
// which is a work order of its own, not something to fake from out here.

export type PanelSize = 'docked' | 'full';

export class PanelSizer {

	private state: PanelSize = 'docked';

	get size(): PanelSize {
		return this.state;
	}

	async cycle(): Promise<PanelSize> {
		await this.set(this.state === 'docked' ? 'full' : 'docked');
		return this.state;
	}

	async set(next: PanelSize): Promise<void> {
		if (next === this.state) {
			return;
		}
		await run(next === 'full' ? 'workbench.action.maximizeAuxiliaryBar' : 'workbench.action.restoreAuxiliaryBar');
		this.state = next;
	}

	/** Esc in the panel: leave full screen if that is where we are, and say so,
	 *  so the caller knows whether Esc still has its usual job to do. */
	async collapseFromFull(): Promise<boolean> {
		if (this.state !== 'full') {
			return false;
		}
		await this.set('docked');
		return true;
	}
}

async function run(command: string): Promise<void> {
	try {
		await vscode.commands.executeCommand(command);
	} catch {
		// Layout is a nicety: a workbench that will not resize must never stop
		// the panel from answering questions.
	}
}
