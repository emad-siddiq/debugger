/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// capabilities.ts — what the debug adapter said it can do, remembered.
//
// The breakpoint popover offers condition, hit count and log message. Delve
// implements two of those three, and the workbench does not say so: an
// unsupported field is accepted by the UI, sent, and dropped by the adapter in
// silence, so a hit count set on a Go breakpoint simply never applies and
// nothing anywhere explains why.
//
// The house rule is grey-with-a-reason: never omit the row, never fake it, say
// what cannot be driven and why. That needs a fact rather than a guess, and the
// fact is in the adapter's own `initialize` response — which the tracker in
// extension.ts already sees go past. This module remembers it.
//
// Measured against Delve 1.25.2 (`dlv dap`), for the record:
//   ✓ supportsConditionalBreakpoints      ✗ supportsHitConditionalBreakpoints
//   ✓ supportsLogPoints                   ✗ supportsDataBreakpoints (watchpoints)
//   ✓ supportsFunctionBreakpoints         ✗ supportsRestartFrame (drop frame)
//   ✓ supportsSetVariable                 ✗ supportsGotoTargetsRequest (set next statement)
//   ✓ exceptionBreakpointFilters: none advertised
// Nothing here hardcodes that list — it is what this module expects to observe,
// and the point is that a re-pinned Delve changes the answer without changing
// the code.
//
// Pure: no `vscode` import, so out/capabilities.js is unit-tested standalone.

/** The subset of DAP's `Capabilities` the breakpoint surface depends on. */
export interface DapCapabilities {
	readonly supportsConditionalBreakpoints?: boolean;
	readonly supportsHitConditionalBreakpoints?: boolean;
	readonly supportsLogPoints?: boolean;
	readonly supportsFunctionBreakpoints?: boolean;
	readonly supportsDataBreakpoints?: boolean;
	readonly exceptionBreakpointFilters?: readonly unknown[];
}

/** A breakpoint field the popover can offer. */
export type BreakpointFeature = 'condition' | 'hitCondition' | 'logMessage' | 'functionBreakpoint';

/** Whether a field can be driven, and — when it cannot — why not. */
export interface FeatureSupport {
	/** False only when an adapter has been observed and said no. */
	readonly supported: boolean;
	/** Set when `supported` is false, or when nothing has been observed yet. */
	readonly reason?: string;
}

const CAPABILITY_OF: Record<BreakpointFeature, keyof DapCapabilities> = {
	condition: 'supportsConditionalBreakpoints',
	hitCondition: 'supportsHitConditionalBreakpoints',
	logMessage: 'supportsLogPoints',
	functionBreakpoint: 'supportsFunctionBreakpoints',
};

const HUMAN: Record<BreakpointFeature, string> = {
	condition: 'conditional breakpoints',
	hitCondition: 'hit-count breakpoints',
	logMessage: 'logpoints',
	functionBreakpoint: 'function breakpoints',
};

/**
 * Remembers the last `initialize` response seen from a debug adapter.
 *
 * The last one rather than the live one on purpose: breakpoints are configured
 * before a session starts, which is exactly when there is no session to ask. A
 * fact from the previous run of the same adapter is the best available answer,
 * and it is still a fact.
 */
export class AdapterCapabilities {
	private observed: DapCapabilities | undefined;
	private adapterName = 'The debug adapter';

	/**
	 * Records a DAP `initialize` response body. Anything that is not one is
	 * ignored, so the caller can hand over every message it sees.
	 */
	record(body: unknown): void {
		if (typeof body !== 'object' || body === null || Array.isArray(body)) {
			return;
		}
		this.observed = body as DapCapabilities;
	}

	/**
	 * Names the adapter for the reason strings, e.g. `Delve 1.25.2`.
	 *
	 * Separate from {@link record} on purpose: the name arrives in a later output
	 * event than the capabilities, and folding the two together would let a name
	 * update overwrite the capability body with nothing — leaving every field
	 * greyed with a reason that says the adapter cannot do what it just said it
	 * could.
	 */
	nameAdapter(adapterName: string): void {
		this.adapterName = adapterName;
	}

	/** True once any adapter has told us what it can do. */
	get known(): boolean {
		return this.observed !== undefined;
	}

	/**
	 * Whether a breakpoint field can actually be driven.
	 *
	 * Before anything has been observed the answer is "supported, but
	 * unconfirmed" — offering the field is right (the workbench does), and the
	 * reason says the claim has not been checked yet rather than pretending it
	 * has.
	 */
	support(feature: BreakpointFeature): FeatureSupport {
		if (!this.observed) {
			return { supported: true, reason: 'not yet confirmed — no debug session has run in this window' };
		}
		if (this.observed[CAPABILITY_OF[feature]] === true) {
			return { supported: true };
		}
		return {
			supported: false,
			reason: `${this.adapterName} does not support ${HUMAN[feature]}`,
		};
	}
}

/**
 * Reads an adapter's name and version out of DAP traffic, for the reason string.
 *
 * Delve announces itself in the `initialized`-adjacent output event rather than
 * anywhere structured, so this reads the common shape and falls back to the
 * plain name — a reason that says "Delve" is worth having even when the version
 * cannot be found.
 */
export function adapterNameFrom(text: string | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	const m = /Delve Debugger[\s\S]*?Version:\s*([\d.]+)/.exec(text) ?? /\bdlv\b.*?([\d]+\.[\d]+\.[\d]+)/.exec(text);
	return m ? `Delve ${m[1]}` : undefined;
}
