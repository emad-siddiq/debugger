/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { DebugSession, DebugStackFrame, DebugThread, debug } from 'vscode';
import { DapVariable, Summary, briefFromChildren, summarize } from './summary';
import { watchVariableFrom } from './watchmap';
import { DapThread } from './goroutines';
import { DapFrame } from './framerows';

// model.ts — the path-addressed value model over one debug session's DAP
// connection (IX, architecture task 05.3: "path-addressed value model over DAP,
// scopes → variables with paging, change-diffing between stops"). It owns no DAP
// connection: every read is a `customRequest` on the session VS Code already
// manages. Nodes are keyed by their name-path (stable across stops, unlike
// dlv's per-stop `variablesReference`) so values can be diffed between stops.

/** Large collections page this many at a time (task 05: "slices/maps show 100 at a time"). */
export const PAGE_SIZE = 100;

/** Deep enough for any Go stack worth reading; the fold rows keep it legible. */
const MAX_FRAMES = 200;

/** The subset of a DAP `Scope` we surface as inspector roots. */
export interface DapScope {
	readonly name: string;
	readonly variablesReference: number;
	readonly expensive?: boolean;
	readonly namedVariables?: number;
	readonly indexedVariables?: number;
}

/** A rendered value: the raw DAP variable, its summary, its path, and whether it changed. */
export interface InspectorNode {
	readonly variable: DapVariable;
	readonly path: readonly string[];
	readonly summary: Summary;
	readonly changed: boolean;
}

/** Path segments join with a unit-separator so a name containing a dot can't collide. */
const SEP = '␟';

export class InspectorModel {

	// Two value snapshots keyed by name-path: `snapshot` is the previous stop,
	// `pending` accumulates the current one. The roll happens lazily on the first
	// read after a `stopped` event (see rollIfNewStop) so it can't race the two
	// refresh triggers (stopped event vs. active-frame change).
	private snapshot = new Map<string, string>();
	private pending = new Map<string, string>();
	private stopSeq = 0;
	private rolledSeq = 0;

	constructor(private readonly session: DebugSession) { }

	/** The tracker calls this on every DAP `stopped` event; the next read rolls the snapshot. */
	onStopped(): void {
		this.stopSeq++;
	}

	private rollIfNewStop(): void {
		if (this.rolledSeq !== this.stopSeq) {
			this.snapshot = this.pending;
			this.pending = new Map<string, string>();
			this.rolledSeq = this.stopSeq;
		}
	}

	/** The focused frame id: the active stack item, else the stopped thread's top frame. */
	async activeFrameId(): Promise<number | undefined> {
		this.rollIfNewStop();
		const item = debug.activeStackItem;
		if (item instanceof DebugStackFrame && item.session.id === this.session.id) {
			return item.frameId;
		}
		const threadId = await this.stoppedThreadId(item);
		if (threadId === undefined) {
			return undefined;
		}
		const trace = await this.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
		return trace?.stackFrames?.[0]?.id;
	}

	/**
	 * Evaluate a watch expression in a frame (DAP `evaluate`, `context: 'watch'`),
	 * mapped to a `DapVariable` so the same summary renderer applies. Returns
	 * `undefined` when the expression is invalid in this frame (dlv rejects it) —
	 * the Watch view grays those out rather than erroring (task 05.6).
	 */
	async evaluate(expression: string, frameId: number): Promise<DapVariable | undefined> {
		this.rollIfNewStop();
		try {
			const res = await this.request('evaluate', { expression, frameId, context: 'watch' });
			return watchVariableFrom(expression, res);
		} catch {
			return undefined; // invalid-in-this-frame — caller grays it out.
		}
	}

	/** Every goroutine dlv knows about, as DAP threads (task 05.2). */
	async threads(): Promise<DapThread[]> {
		const res = await this.request('threads', undefined);
		return res?.threads ?? [];
	}

	/** One goroutine's call stack. */
	async stackTrace(threadId: number, levels = MAX_FRAMES): Promise<DapFrame[]> {
		const res = await this.request('stackTrace', { threadId, startFrame: 0, levels });
		return res?.stackFrames ?? [];
	}

	/** The goroutine the debugger has focused, if the active stack item names one. */
	activeThreadId(): number | undefined {
		const item = debug.activeStackItem;
		if ((item instanceof DebugThread || item instanceof DebugStackFrame) && item.session.id === this.session.id) {
			return item.threadId;
		}
		return undefined;
	}

	/** The non-expensive scopes (Arguments, Locals, …) of a frame. */
	async scopes(frameId: number): Promise<DapScope[]> {
		this.rollIfNewStop();
		const res = await this.request('scopes', { frameId });
		return res?.scopes ?? [];
	}

	/** All children of a composite value in one shot; `path` is the parent's name-path. */
	async children(variablesReference: number, path: readonly string[]): Promise<InspectorNode[]> {
		return this.fetch({ variablesReference }, path);
	}

	/**
	 * One page of a large indexed collection (task 05: "slices/maps show 100 at a
	 * time with next / jump-to-index").
	 *
	 * `filter: 'indexed'` is load-bearing, not decoration: dlv only reslices the
	 * underlying variable when the filter is exactly that (`onVariablesRequest` →
	 * `maybeLoadResliced`). An unfiltered `variables` request silently returns
	 * whatever the parent load left behind — 64 elements, `MaxArrayValues`' default
	 * — no matter what `start`/`count` say. That is the bug WO-9's 50k slice caught.
	 */
	async page(variablesReference: number, path: readonly string[], start = 0, count = PAGE_SIZE): Promise<InspectorNode[]> {
		return this.fetch({ variablesReference, filter: 'indexed', start, count }, path);
	}

	/** The `named` children — dlv's metadata rows, e.g. a map's `len()`. */
	async namedChildren(variablesReference: number, path: readonly string[]): Promise<InspectorNode[]> {
		return this.fetch({ variablesReference, filter: 'named' }, path);
	}

	private async fetch(args: object, path: readonly string[]): Promise<InspectorNode[]> {
		this.rollIfNewStop();
		const res = await this.request('variables', args);
		const vars: DapVariable[] = res?.variables ?? [];
		const nodes: InspectorNode[] = [];
		for (const v of vars) {
			nodes.push(await this.toNode(v, [...path, v.name]));
		}
		return nodes;
	}

	private async toNode(v: DapVariable, path: string[]): Promise<InspectorNode> {
		const key = path.join(SEP);
		this.pending.set(key, v.value);
		const changed = this.snapshot.has(key) && this.snapshot.get(key) !== v.value;
		let summary = summarize(v);
		if (summary.kind === 'pointer' && v.variablesReference > 0) {
			summary = await this.derefPointer(v, summary);
		}
		return { variable: v, path, summary, changed };
	}

	/** `*T <addr>` → `*T → {…}` by peeking one level (task 05: pointers auto-deref for their summary). */
	private async derefPointer(v: DapVariable, base: Summary): Promise<Summary> {
		try {
			const res = await this.request('variables', { variablesReference: v.variablesReference });
			const fields: DapVariable[] = res?.variables ?? [];
			if (fields.length === 0) {
				return base;
			}
			return { ...base, text: `${v.type} → ${briefFromChildren(fields)}` };
		} catch {
			return base; // deref is best-effort; a failed peek keeps the plain `*T <addr>`.
		}
	}

	private async stoppedThreadId(item: DebugThread | DebugStackFrame | undefined): Promise<number | undefined> {
		if (item instanceof DebugThread && item.session.id === this.session.id) {
			return item.threadId;
		}
		if (item instanceof DebugStackFrame && item.session.id === this.session.id) {
			return item.threadId;
		}
		const res = await this.request('threads', undefined);
		return res?.threads?.[0]?.id;
	}

	// The DAP boundary is dynamically typed; `customRequest` returns `Thenable<any>`.
	// Keep the `any` contained to this one method and read typed shapes at each
	// call site (scopes/variables/stackTrace responses).
	private async request(command: string, args: unknown): Promise<any> {
		return this.session.customRequest(command, args as object);
	}
}
