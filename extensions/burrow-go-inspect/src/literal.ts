/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// literal.ts — "copy as Go literal" for the inspector's value pane (IX,
// architecture task 05.5: value pane "copy-as-Go-literal / copy-JSON"). Pure and
// synchronous like summary.ts (no vscode import → unit-testable standalone). It
// reconstructs the paste-into-code literal from the DAP variable that dlv already
// hands us: scalars/strings are exact; composites pass through dlv's own value
// rendering (a faithful-enough literal at this slice — full recursive
// reconstruction from the child model is a later IX slice, task 06's copy-out).

import { DapVariable, GoKind, summarize } from './summary';

/** dlv renders a Go string already double-quoted; detect that so we don't double it. */
function isQuoted(s: string): boolean {
	return s.length >= 2 && s.startsWith('"') && s.endsWith('"');
}

/**
 * Best-effort Go source literal for a single value, suitable for pasting back
 * into code. Exact for `nil`, strings, bools, and numbers; composites (struct,
 * slice, map, pointer, …) fall back to dlv's own value string, which is already
 * close to Go syntax.
 */
export function toGoLiteral(v: DapVariable): string {
	const value = v.value ?? '';
	const kind: GoKind = summarize(v).kind;
	switch (kind) {
		case 'nil':
			return 'nil';
		case 'string':
			// dlv usually quotes strings; quote it ourselves only when it didn't.
			return isQuoted(value) ? value : JSON.stringify(value);
		case 'bool':
		case 'number':
			return value.trim();
		default:
			// struct / slice / array / map / pointer / chan / error / time —
			// dlv's value string is the closest literal we have without a child walk.
			return value.trim();
	}
}
