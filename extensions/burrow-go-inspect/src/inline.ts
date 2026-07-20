/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import {
	InlineValue,
	InlineValueContext,
	InlineValueText,
	InlineValuesProvider,
	Range,
	TextDocument,
	debug,
	workspace,
} from 'vscode';
import { InspectorModel } from './model';
import { declaredNamesOnLine } from './inlinemap';

// inline.ts — inline value decorations (IX, architecture task 05.7: "active-frame
// ghost values with the same summary renderer; setting-gated").
//
// We implement the workbench's `InlineValuesProvider` rather than painting our own
// editor decorations: core already owns the hard parts — ghost-text styling, the
// active-frame lifecycle, clearing on continue — and it re-requests values on every
// stop. That also makes the feature honestly composable with the user's
// `debug.inlineValues` setting instead of fighting it.
//
// The values come from the SAME model + summary renderer as the inspector, so a
// ghost value and its inspector row can never disagree.

/** Ghost text is a glance, not the value pane: summaries are clipped hard. */
const INLINE_MAX = 40;

/** Guard against a pathological line (`a, b, c, d, e := …`) crowding the editor. */
const MAX_PER_LINE = 4;

function clip(text: string): string {
	return text.length > INLINE_MAX ? text.slice(0, INLINE_MAX - 1) + '…' : text;
}

export class BurrowInlineValuesProvider implements InlineValuesProvider {

	constructor(private readonly models: Map<string, InspectorModel>) { }

	async provideInlineValues(document: TextDocument, viewPort: Range, context: InlineValueContext): Promise<InlineValue[]> {
		if (!workspace.getConfiguration('burrow.inspector').get<boolean>('inlineValues', true)) {
			return [];
		}
		const session = debug.activeDebugSession;
		const model = session && this.models.get(session.id);
		if (!model) {
			return [];
		}

		const values = await this.frameValues(model, context.frameId);
		if (values.size === 0) {
			return [];
		}

		// Only lines at or above the stopped line have executed in this frame; ghosting
		// a value next to a line that has not run yet would be a lie.
		const last = Math.min(viewPort.end.line, context.stoppedLocation.end.line);
		const out: InlineValue[] = [];
		for (let line = viewPort.start.line; line <= last; line++) {
			const names = declaredNamesOnLine(document.lineAt(line).text);
			for (const name of names.slice(0, MAX_PER_LINE)) {
				const summary = values.get(name);
				if (summary !== undefined) {
					out.push(new InlineValueText(document.lineAt(line).range, `${name} = ${clip(summary)}`));
				}
			}
		}
		return out;
	}

	/** name → summary for every top-level value in the frame's scopes (no drilling). */
	private async frameValues(model: InspectorModel, frameId: number): Promise<Map<string, string>> {
		const values = new Map<string, string>();
		try {
			for (const scope of await model.scopes(frameId)) {
				if (scope.expensive) {
					continue; // Globals/Registers — never worth a per-keystroke DAP round trip.
				}
				for (const node of await model.children(scope.variablesReference, [scope.name])) {
					values.set(node.variable.name, node.summary.text);
				}
			}
		} catch {
			// The session can vanish mid-request (continue/terminate); no ghosts is the
			// right answer, and throwing here would surface as a provider error toast.
		}
		return values;
	}
}
