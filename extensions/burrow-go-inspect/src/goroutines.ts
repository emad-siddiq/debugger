/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// goroutines.ts — what a DAP `threads` response can honestly tell us about Go
// goroutines (IX, architecture task 05.2: the Frames view's goroutine header +
// switcher). Pure and synchronous, so it is unit-tested directly.
//
// dlv maps goroutines onto DAP threads and encodes everything it will tell us
// into the thread NAME:
//
//     "* [Go 1] main.gauntlet (Thread 11291594)"
//     "[Go 7] sync.(*Mutex).Lock"
//     "[Go 2] runtime.gopark"
//
// `*` marks the selected goroutine and the function is dlv's `UserCurrent()` —
// the innermost frame in the user's own code, which is why a mutex waiter reads
// as `sync.(*Mutex).Lock` rather than `runtime.gopark`.
//
// What is NOT available: the goroutine's scheduler state and wait reason. dlv
// has both (`api.Goroutine.Status`, `WaitReason`) but does not surface them over
// DAP — `onThreadsRequest` builds this string and discards the rest. Rather than
// invent a state, we classify by what the function name genuinely implies and
// leave the real state table to task 06's goroutine visualizer, which can talk
// to dlv's native API.

/** The subset of a DAP `Thread` we read. */
export interface DapThread {
	readonly id: number;
	readonly name: string;
}

/**
 * How a goroutine is classified for grouping and counts. This is a claim about
 * where the goroutine is, not about the Go scheduler's own state.
 */
export type GoroutineKind = 'current' | 'user' | 'system';

export interface Goroutine {
	/** DAP thread id — what `stackTrace` and the focus command take. */
	readonly id: number;
	/** Go's own goroutine number, when dlv encoded one (`[Go 7]` → 7). */
	readonly goId: number | undefined;
	/** dlv's `UserCurrent()` function for this goroutine. */
	readonly func: string;
	/** The goroutine the debugger has selected — where the stop happened. */
	readonly current: boolean;
	readonly kind: GoroutineKind;
	/** What the function implies the goroutine is doing, when it implies anything. */
	readonly waiting: string | undefined;
}

/** Runtime/scheduler internals — goroutines the user did not write and rarely wants. */
function isSystemFunc(func: string): boolean {
	return /^runtime[./]/.test(func) || func === '' || /^runtime\b/.test(func);
}

/**
 * A hint at what a parked goroutine is parked on, read off the innermost user
 * frame. Deliberately conservative: these are the cases where the function name
 * IS the answer, not a guess dressed up as one.
 */
function waitingFrom(func: string): string | undefined {
	if (/^sync\.\(\*Mutex\)\.Lock$/.test(func) || /^sync\.\(\*RWMutex\)\./.test(func)) {
		return 'mutex';
	}
	if (/^sync\.\(\*WaitGroup\)\.Wait$/.test(func)) {
		return 'waitgroup';
	}
	if (/^time\.Sleep$/.test(func)) {
		return 'sleep';
	}
	if (/^runtime\.(?:chanrecv|chansend|selectgo)/.test(func)) {
		return 'chan';
	}
	if (/^(?:internal\/poll|net)\./.test(func)) {
		return 'i/o';
	}
	return undefined;
}

/** Parse one dlv thread name. Anything unparseable still yields a usable row. */
export function parseGoroutine(thread: DapThread): Goroutine {
	const name = thread.name ?? '';
	const current = name.trimStart().startsWith('*');
	const match = /\[Go (\d+)[^\]]*\]\s*(.*)$/.exec(name);
	const goId = match ? Number(match[1]) : undefined;
	// Strip the trailing " (Thread N)" — the OS thread is not what we key on, and
	// showing it in a compact row costs more width than it is worth.
	const func = (match ? match[2] : name.replace(/^\*\s*/, '')).replace(/\s*\(Thread \d+\)\s*$/, '').trim();
	return {
		id: thread.id,
		goId,
		func,
		current,
		kind: current ? 'current' : isSystemFunc(func) ? 'system' : 'user',
		waiting: waitingFrom(func),
	};
}

/**
 * Goroutines in the order the switcher shows them: the current one, then the
 * user's own, then runtime internals — "interesting first", per task 05.2.
 * Stable within each group by Go id so the list does not reshuffle between stops.
 */
export function orderGoroutines(threads: readonly DapThread[]): Goroutine[] {
	const rank: Record<GoroutineKind, number> = { current: 0, user: 1, system: 2 };
	return threads
		.map(parseGoroutine)
		.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.goId ?? a.id) - (b.goId ?? b.id));
}

/** Badge counts for the switcher header. */
export function countByKind(goroutines: readonly Goroutine[]): { user: number; system: number; total: number } {
	// The current goroutine is one of the user's — it is ranked separately for
	// ordering, not excluded from the population being counted.
	const system = goroutines.filter(g => g.kind === 'system').length;
	return { user: goroutines.length - system, system, total: goroutines.length };
}

/** The compact label for a goroutine row: `[Go 7] sync.(*Mutex).Lock · mutex`. */
export function goroutineLabel(g: Goroutine): string {
	const id = g.goId === undefined ? `Thread ${g.id}` : `Go ${g.goId}`;
	return `[${id}] ${g.func}${g.waiting ? ` · ${g.waiting}` : ''}`;
}

/** Case-insensitive substring match over the parts a user would search by. */
export function matchesGoroutine(g: Goroutine, query: string): boolean {
	const q = query.trim().toLowerCase();
	return q === '' || goroutineLabel(g).toLowerCase().includes(q) || String(g.goId ?? '').includes(q);
}
