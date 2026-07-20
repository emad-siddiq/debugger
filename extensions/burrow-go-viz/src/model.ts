/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { DebugSession, DebugStackFrame, DebugThread, debug } from 'vscode';
import { parseByteValues } from './hexdump';

// model.ts — the narrow DAP read path this visualizer needs (architecture task
// 06.1: "visualizers are webview components with a narrow query API; they never own
// DAP connections"). It REUSES the burrow-go-inspect model concepts — a
// path/frame-addressed read over the session VS Code already manages, with the
// windowed indexed `variables` fetch task 05 established — without re-implementing
// DAP: every read is a `customRequest` on the existing session. It deliberately
// does not duplicate the full InspectorModel; it exposes only "resolve an
// expression to a []byte and page its bytes off DAP".

/** The subset of a DAP `Variable`/`evaluate` response the visualizer reads. */
export interface VizVariable {
	readonly value: string;
	readonly type?: string;
	readonly variablesReference: number;
	readonly indexedVariables?: number;
}

/** A resolved byte payload plus the facts the registry matches on. */
export interface BytePayload {
	/** dlv's static type string for the resolved value. */
	readonly type: string;
	/** The bytes fetched (windowed to `max`), parsed 0–255. */
	readonly bytes: number[];
	/** Total byte length dlv reports, so the view can note a truncated window. */
	readonly total: number;
	/** Whether the fetched window is the whole value. */
	readonly complete: boolean;
}

/** dlv only reslices a large collection when the `variables` filter is exactly this (task 05). */
const INDEXED = 'indexed';

export class VizModel {

	constructor(private readonly session: DebugSession) { }

	/** The focused frame id: the active stack item, else the stopped thread's top frame. */
	async activeFrameId(): Promise<number | undefined> {
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
	 * Evaluate an expression in a frame (DAP `evaluate`, `context: 'watch'` — the
	 * no-side-effect context task 04 mandates) and map it to a `VizVariable`. Returns
	 * `undefined` when dlv rejects the expression in this frame.
	 */
	async evaluate(expression: string, frameId: number): Promise<VizVariable | undefined> {
		try {
			const res = await this.request('evaluate', { expression, frameId, context: 'watch' });
			if (!res) {
				return undefined;
			}
			return {
				value: res.result ?? '',
				type: res.type,
				variablesReference: res.variablesReference ?? 0,
				indexedVariables: res.indexedVariables,
			};
		} catch {
			return undefined; // invalid-in-this-frame — caller reports it.
		}
	}

	/**
	 * Page a resolved byte-slice variable's indexed children (each a `uint8` element)
	 * with the load-bearing `indexed` filter so dlv actually reslices past its
	 * 64-element default. Windowed to `max` bytes — the first slice fetches a bounded
	 * head rather than a 50k-byte body (task 06.7's true windowing is a later slice;
	 * the cap keeps the stop event unblocked). Returns `undefined` when the variable
	 * has no children to page.
	 */
	async bytesFromVariable(variable: VizVariable, max: number): Promise<BytePayload | undefined> {
		if (variable.variablesReference <= 0) {
			return undefined;
		}
		const total = variable.indexedVariables ?? 0;
		const count = total > 0 ? Math.min(total, max) : max;
		const res = await this.request('variables', {
			variablesReference: variable.variablesReference,
			filter: INDEXED,
			start: 0,
			count,
		});
		const children: VizVariable[] = res?.variables ?? [];
		const bytes = parseByteValues(children.map(c => c.value));
		return {
			type: variable.type ?? '',
			bytes,
			total: total > 0 ? total : bytes.length,
			complete: total === 0 || bytes.length >= total,
		};
	}

	private async stoppedThreadId(item: DebugThread | DebugStackFrame | undefined): Promise<number | undefined> {
		if ((item instanceof DebugThread || item instanceof DebugStackFrame) && item.session.id === this.session.id) {
			return item.threadId;
		}
		const res = await this.request('threads', undefined);
		return res?.threads?.[0]?.id;
	}

	// The DAP boundary is dynamically typed; `customRequest` returns `Thenable<any>`.
	// Keep the `any` contained here and read typed shapes at each call site.
	private async request(command: string, args: unknown): Promise<any> {
		return this.session.customRequest(command, args as object);
	}
}
