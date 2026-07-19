/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// watchmap.ts — pure mapping from a DAP `evaluate` response body to a `DapVariable`
// (IX, architecture task 05.6 Watch: "same summary renderer as the inspector"), so
// a watched expression flows through the exact `summarize()` path a scope variable
// does. vscode-free like summary.ts / literal.ts → unit-testable standalone.

import { DapVariable } from './summary';

/** The subset of a DAP `evaluate` response the Watch view reads. */
export interface DapEvaluateBody {
	readonly result: string;
	readonly type?: string;
	readonly variablesReference?: number;
	readonly namedVariables?: number;
	readonly indexedVariables?: number;
}

/**
 * Map a DAP `evaluate` body to a `DapVariable` named for its expression, so the
 * inspector's summary renderer applies unchanged. Returns `undefined` for a
 * missing/invalid body (no string `result`) — the Watch view grays those out
 * instead of erroring.
 */
export function watchVariableFrom(expression: string, body: DapEvaluateBody | undefined): DapVariable | undefined {
	if (!body || typeof body.result !== 'string') {
		return undefined;
	}
	return {
		name: expression,
		value: body.result,
		type: body.type,
		variablesReference: body.variablesReference ?? 0,
		namedVariables: body.namedVariables,
		indexedVariables: body.indexedVariables,
		evaluateName: expression,
	};
}
