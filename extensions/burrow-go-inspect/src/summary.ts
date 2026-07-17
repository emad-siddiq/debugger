/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// summary.ts — the type-aware one-line summary renderer for Go values (IX,
// architecture task 05.3: "summary renderer registry, per-Go-type rules"). Pure
// and synchronous: it maps a single DAP `Variable` (name/value/type + the
// DAP-standard child counts) to a compact one-liner so the inspector rarely
// needs to drill at all. It leans on `type` (stable) and
// `indexedVariables`/`namedVariables` (DAP-standard) and only lightly condenses
// dlv's `value` string — never a fragile full reparse. Anything that needs to
// fetch children (pointer auto-deref, error chains) lives one level up in the
// model; this file stays fetch-free so it is trivially unit-tested.

/** The subset of the DAP `Variable` the renderer reads from. */
export interface DapVariable {
	readonly name: string;
	readonly value: string;
	readonly type?: string;
	readonly variablesReference: number;
	readonly namedVariables?: number;
	readonly indexedVariables?: number;
	readonly evaluateName?: string;
}

/** Broad Go kind a value classifies as — drives the row icon and summary shape. */
export type GoKind =
	| 'slice' | 'array' | 'map' | 'struct' | 'pointer'
	| 'string' | 'bytes' | 'error' | 'time' | 'duration' | 'chan'
	| 'bool' | 'number' | 'nil' | 'other';

export interface Summary {
	/** The type-aware one-line summary (e.g. `[]Metric len=1204 cap=2048`). */
	readonly text: string;
	/** Whether the value has children worth drilling into. */
	readonly expandable: boolean;
	/** The classified kind (row icon + tests). */
	readonly kind: GoKind;
}

const MAX = 80;

const NUMBER_TYPES = new Set([
	'int', 'int8', 'int16', 'int32', 'int64',
	'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
	'float32', 'float64', 'complex64', 'complex128', 'byte', 'rune',
]);

/** Collapse whitespace and cap length with an ellipsis. */
function truncate(s: string, n = MAX): string {
	const t = s.replace(/\s+/g, ' ').trim();
	return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** First captured integer in dlv's value string (tolerant of alternated groups). */
function readNumber(re: RegExp, value: string): number | undefined {
	const m = re.exec(value);
	if (!m) {
		return undefined;
	}
	for (let i = 1; i < m.length; i++) {
		if (m[i] !== undefined) {
			return Number(m[i]);
		}
	}
	return undefined;
}

/** The hex address dlv prints for pointers/refs, if present. */
function readAddress(value: string): string | undefined {
	const m = /0x[0-9a-fA-F]+/.exec(value);
	return m ? m[0] : undefined;
}

/** Drop a leading `type ` prefix dlv puts before composite bodies. */
function stripType(value: string, type: string): string {
	return value.startsWith(type) ? value.slice(type.length).trim() : value;
}

function isNumberType(type: string): boolean {
	return NUMBER_TYPES.has(type);
}

/** Format an int64 nanosecond count the way Go's `time.Duration.String()` does (approximately). */
function humanizeDuration(ns: number): string {
	if (ns === 0) {
		return '0s';
	}
	const sign = ns < 0 ? '-' : '';
	const n = Math.abs(ns);
	if (n < 1e3) {
		return `${sign}${n}ns`;
	}
	if (n < 1e6) {
		return `${sign}${trimFloat(n / 1e3)}µs`;
	}
	if (n < 1e9) {
		return `${sign}${trimFloat(n / 1e6)}ms`;
	}
	const totalSeconds = n / 1e9;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	let out = '';
	if (hours > 0) {
		out += `${hours}h`;
	}
	if (hours > 0 || minutes > 0) {
		out += `${minutes}m`;
	}
	out += `${trimFloat(seconds)}s`;
	return sign + out;
}

function trimFloat(x: number): string {
	return Number.isInteger(x) ? String(x) : String(Number(x.toFixed(3)));
}

/**
 * A compact `{a: 1, b: 2, …}` brief from a composite's already-fetched children
 * — used by the model to render a pointer's one-level deref (task 05) without
 * making the renderer itself fetch. Pure, so it is unit-tested directly.
 */
export function briefFromChildren(children: readonly DapVariable[], max = 3): string {
	if (children.length === 0) {
		return '{}';
	}
	const parts = children.slice(0, max).map(c => `${c.name}: ${truncate(c.value, 18)}`);
	return `{${parts.join(', ')}${children.length > max ? ', …' : ''}}`;
}

/**
 * Classify a Go value and produce its one-line summary. Matchers are ordered by
 * specificity: nil and the named types (`time.*`, `error`) win before the broad
 * structural rules (pointer, map, slice, struct).
 */
export function summarize(v: DapVariable): Summary {
	const type = v.type ?? '';
	const value = v.value ?? '';
	const expandable = v.variablesReference > 0;

	// nil reads as "nil" whatever the static type (nil pointer/interface/map/slice).
	if (value === 'nil' || value === '<nil>') {
		return { text: 'nil', expandable: false, kind: 'nil' };
	}

	// time.Duration is an int64 of nanoseconds — humanize it synchronously.
	if (type === 'time.Duration') {
		const ns = Number(value);
		return { text: Number.isFinite(ns) && value !== '' ? humanizeDuration(ns) : truncate(value), expandable, kind: 'duration' };
	}
	// time.Time: classify + pass through. Rich humanization (UTC/local/unix
	// toggles) is a task 06 visualizer, not a summary-line concern.
	if (type === 'time.Time') {
		return { text: truncate(value || 'time.Time'), expandable, kind: 'time' };
	}

	// error: dlv renders the dynamic error string into `value` already; the full
	// Unwrap() chain view is task 06.
	if (type === 'error' || /(?:^|\.)error$/.test(type)) {
		return { text: truncate(value || 'error'), expandable, kind: 'error' };
	}

	// Pointer: base summary is `*T <addr>`. The model may deref one level and
	// rewrite this as `*T → {…}` (it can fetch children; the renderer cannot).
	if (type.startsWith('*')) {
		const addr = readAddress(value);
		return { text: addr ? `${type} ${addr}` : type, expandable, kind: 'pointer' };
	}

	// map[K]V — count from DAP named/indexed vars, else parsed from the value.
	if (/^map\[/.test(type)) {
		const n = v.namedVariables ?? v.indexedVariables ?? readNumber(/\((\d+)\)|len:\s*(\d+)/, value);
		return { text: n === undefined ? type : `${type} (${n})`, expandable, kind: 'map' };
	}

	// []byte / []uint8 — a byte string; hex/JSON/base64 views are task 06.
	if (type === '[]byte' || type === '[]uint8') {
		const n = v.indexedVariables ?? readNumber(/len:\s*(\d+)/, value);
		return { text: n === undefined ? '[]byte' : `[]byte len=${n}`, expandable, kind: 'bytes' };
	}

	// Slice []T — len from indexedVariables, cap parsed from dlv's value string.
	if (/^\[\]/.test(type)) {
		const len = v.indexedVariables ?? readNumber(/len:\s*(\d+)/, value);
		const cap = readNumber(/cap:\s*(\d+)/, value);
		let text = type;
		if (len !== undefined) {
			text += ` len=${len}`;
		}
		if (cap !== undefined) {
			text += ` cap=${cap}`;
		}
		return { text, expandable, kind: 'slice' };
	}

	// Array [N]T — the length is already in the type.
	if (/^\[\d+\]/.test(type)) {
		return { text: type, expandable, kind: 'array' };
	}

	// chan T — buffer occupancy + parked goroutines are a task 06 visualizer.
	if (/^(?:<-)?chan\b/.test(type)) {
		return { text: truncate(value ? `${type} ${stripType(value, type)}`.trim() : type), expandable, kind: 'chan' };
	}

	if (type === 'string') {
		return { text: truncate(value || '""'), expandable, kind: 'string' };
	}
	if (type === 'bool') {
		return { text: value, expandable: false, kind: 'bool' };
	}
	if (isNumberType(type)) {
		return { text: value, expandable: false, kind: 'number' };
	}

	// Struct (pkg.Name with fields) — condense dlv's `pkg.Name {…}` to the body.
	if (expandable) {
		const body = stripType(value, type);
		return { text: truncate(body || `${type} {…}`), expandable: true, kind: 'struct' };
	}

	// Fallback: whatever dlv gave us, capped.
	return { text: truncate(value || type), expandable, kind: 'other' };
}
