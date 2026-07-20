/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// registry.ts — the type-matcher registry (architecture task 06.1: "exact type,
// kind, interface and pattern rules, priority-ordered; the inspector's value pane
// shows the best match with a `Viz ▾` switcher"). Pure and vscode-free: it decides
// WHICH visualizer(s) apply to a value from just the DAP-derived facts the task 05
// summary already knows (`type`, `kind`) — it neither fetches nor renders. The
// concrete renderer (hexdump.ts) and the webview mount (vizview.ts) live elsewhere;
// this file is the seam the inspector value pane calls into to pick a visualizer.

/**
 * The facts a matcher rules on — the subset of task 05's summary model that is a
 * pure classification (no DAP handles). `kind` is the summary's `GoKind`; `type`
 * is dlv's static type string. Both optional so a matcher can rule on either.
 */
export interface VizValue {
	/** dlv's static type string, e.g. `[]byte`, `time.Time`, `map[string]int`. */
	readonly type?: string;
	/** The task 05 summary's classified kind, e.g. `bytes`, `slice`, `time`. */
	readonly kind?: string;
}

/** A registered visualizer: its identity, its switcher label, and its match rule. */
export interface VizDescriptor {
	/** Stable id — the command/view the mount opens, e.g. `burrow.viz.hexdump`. */
	readonly id: string;
	/** The label shown in the value pane's `Viz ▾` switcher. */
	readonly label: string;
	/** Higher wins when several match; the inline default is the highest-priority match. */
	readonly priority: number;
	/** True when this visualizer can render the value. Pure — no side effects. */
	matches(value: VizValue): boolean;
}

/** True when a Go type is a byte slice (`[]byte` is an alias dlv also prints as `[]uint8`). */
export function isByteSlice(type: string | undefined): boolean {
	return type === '[]byte' || type === '[]uint8';
}

/**
 * The []byte / string hex-ASCII visualizer — the first slice's one real renderer.
 * Matches by summary kind (`bytes`, set by task 05's summarize()) OR by the raw
 * type, so it works whether the caller has a full summary or only a type string.
 */
export const hexdumpVisualizer: VizDescriptor = {
	id: 'burrow.viz.hexdump',
	label: 'Hex / ASCII',
	priority: 100,
	matches: value => value.kind === 'bytes' || isByteSlice(value.type),
};

// The live registry, seeded with the slice's one visualizer. Priority-ordered
// reads happen through matchVisualizers()/bestVisualizer(); registration is how
// later tasks (table, struct card, time humanizer) add their own without touching
// this file's matching logic.
const registry: VizDescriptor[] = [hexdumpVisualizer];

/**
 * Add a visualizer to the registry. Idempotent by id — re-registering the same id
 * replaces the prior descriptor rather than duplicating it, so activation is safe
 * to run more than once.
 */
export function registerVisualizer(descriptor: VizDescriptor): void {
	const at = registry.findIndex(d => d.id === descriptor.id);
	if (at >= 0) {
		registry[at] = descriptor;
	} else {
		registry.push(descriptor);
	}
}

/** Every visualizer that matches a value, highest priority first (the switcher's menu). */
export function matchVisualizers(value: VizValue): VizDescriptor[] {
	return registry
		.filter(d => d.matches(value))
		.sort((a, b) => b.priority - a.priority);
}

/** The visualizer the value pane mounts inline by default — the best match, or none. */
export function bestVisualizer(value: VizValue): VizDescriptor | undefined {
	return matchVisualizers(value)[0];
}

/** Whether ANY registered visualizer can render this value (drives the switcher's visibility). */
export function hasVisualizer(value: VizValue): boolean {
	return registry.some(d => d.matches(value));
}
