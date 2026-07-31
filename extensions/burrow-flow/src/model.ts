/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// model.ts — the flows.json shapes (mirror of tools/flowscan/model.go) plus the
// pure helpers the tree and diagram share. No 'vscode' import: out/model.js is
// require()-able from the plain node tests.

export interface FlowsDoc {
	readonly schema: number;
	readonly backend: string;
	readonly rev: string;
	readonly generatedAt: string;
	readonly coverage: {
		readonly routes: number;
		readonly traced: number;
		readonly partial: number;
		readonly unknown: number;
		readonly unmatched?: string[];
		readonly extra?: string[];
		/**
		 * Routers flowscan RECOGNISED and could not follow (WO-77).
		 *
		 * Not routes. We do not know how many routes are behind one, so there is
		 * nothing to put in `unknown` — that state means "the route is real and the
		 * handler did not resolve", which presumes a route. This is one level up,
		 * and it is what separates "this app has 13 routes" from "I found 13 and
		 * there is a router in here I cannot read".
		 */
		readonly unfollowed?: Unfollowed[];
	};
	readonly tables?: Record<string, string>;
	readonly flows: Flow[];
}

export interface Unfollowed {
	readonly file: string;
	readonly line: number;
	readonly reason: string;
}

export interface Flow {
	readonly method: string;
	readonly path: string;
	readonly file: string;
	readonly line: number;
	readonly middleware?: MW[];
	readonly nodes: FlowNode[];
	readonly edges: [number, number][];
	readonly tables?: string[];
	readonly status: 'traced' | 'partial' | 'unknown';
}

export interface MW {
	readonly label: string;
	readonly file?: string;
	readonly line?: number;
}

export interface FlowNode {
	readonly kind: 'handler' | 'store' | 'query' | 'table' | 'unknown';
	readonly label: string;
	readonly file?: string;
	readonly line?: number;
	readonly col?: number;
	readonly sql?: string;
	readonly sqlKind?: 'read' | 'write';
	readonly tables?: string[];
	readonly partial?: boolean;
	readonly reason?: string;
}

/** Group /api/validators/chains under "validators"; non-/api paths under "(public)". */
export function groupOf(routePath: string): string {
	const m = /^\/api\/(?<domain>[^/]+)/.exec(routePath);
	return m?.groups?.domain ?? '(public)';
}

/** Bucket flows by domain, preserving flow order inside each group. */
export function groupFlows(flows: Flow[]): Map<string, Flow[]> {
	const groups = new Map<string, Flow[]>();
	for (const flow of flows) {
		const name = groupOf(flow.path);
		const list = groups.get(name);
		if (list) {
			list.push(flow);
		} else {
			groups.set(name, [flow]);
		}
	}
	return groups;
}

/**
 * The document's flows, never null.
 *
 * A nil Go slice marshals to `null`, not `[]`, and flowscan emits `"flows": null`
 * whenever it found nothing — which is every library, every stdlib-mux service, and
 * our own scaffold. It already normalises `edges` and `nodes` for this exact reason
 * and does not normalise the top-level list.
 *
 * So `doc?.flows.length` throws on the one case that matters. It threw silently
 * inside the refresh handler for the whole of a zero-route run, taking the
 * "no routes found" notification and the rail's state with it — invisible until a
 * repository with no routes was driven, because merkle always had 235.
 */
export function flowsOf(doc: FlowsDoc | undefined): readonly Flow[] {
	return doc?.flows ?? [];
}

/** Routers the last trace could not follow. Never undefined. */
export function unfollowedOf(doc: FlowsDoc | undefined): readonly Unfollowed[] {
	return doc?.coverage?.unfollowed ?? [];
}

/**
 * The sentence the rail shows above the tree.
 *
 * The whole point of the state: a user must be able to tell "this app has N
 * routes" from "I found N and there is a router I cannot read". So the count of
 * unfollowed routers is never silent, and the first one is named with its file
 * and line, because "somewhere" is not actionable.
 */
export function railMessage(routes: number, unfollowed: readonly Unfollowed[]): string | undefined {
	if (!unfollowed.length) {
		return undefined;
	}
	const n = unfollowed.length;
	const first = unfollowed[0];
	const more = n > 1 ? `  (+${n - 1} more)` : '';
	return `${routes} route${routes === 1 ? '' : 's'} traced, and ${n} router${n === 1 ? '' : 's'} `
		+ `that could not be followed — so there may be more.\n`
		+ `${first.file}:${first.line} — ${first.reason}${more}`;
}

/** The flow's handler node, when analysis resolved one. */
export function handlerOf(flow: Flow): FlowNode | undefined {
	return (flow.nodes ?? []).find(n => n.kind === 'handler');
}
