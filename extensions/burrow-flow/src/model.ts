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
	/** Schema 2 writes objects; a flows.json from before it wrote [from, to]. */
	readonly edges: FlowEdge[] | [number, number][];
	readonly tables?: string[];
	readonly status: 'traced' | 'partial' | 'unknown';
}

/** What one box DOES to the next. flowscan knows this exactly at the moment it
 *  builds the edge; before schema 2 it was thrown away. */
export type EdgeRel = 'calls' | 'executes' | 'reads' | 'writes' | 'unresolved';

export interface FlowEdge {
	readonly from: number;
	readonly to: number;
	/** Absent only on a flows.json written before schema 2. */
	readonly rel?: EdgeRel;
	/** The CALL SITE — the line that joins the two boxes, not either box's own. */
	readonly file?: string;
	readonly line?: number;
	readonly col?: number;
}

export interface MW {
	readonly label: string;
	readonly file?: string;
	readonly line?: number;
	/** >0 when registered inside an if/switch. Entries sharing a `branch` with
	 *  different `arm`s are alternatives — at most one of them runs. */
	readonly branch?: number;
	readonly arm?: number;
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

/**
 * The flow's edges, in one shape, never null.
 *
 * Two shapes reach here. Schema 2 writes `{from, to, rel, file, line}`; anything
 * traced before it wrote a bare `[from, to]` pair — and a pre-schema-2
 * flows.json is not hypothetical, because the cached one in this extension's
 * storage is what the tree and the diagram are built from at activation, before
 * anybody presses Refresh. So the first diagram after an update is drawn from
 * the old shape.
 *
 * An old edge keeps `rel` UNDEFINED rather than being given a plausible one.
 * Guessing "calls" would put a sentence on the screen that the user cannot
 * check and that is wrong for every query→table edge — which is the defect this
 * whole feature exists to remove, reintroduced one layer down.
 */
export function edgesOf(flow: Flow | undefined): readonly FlowEdge[] {
	const edges = flow?.edges;
	if (!Array.isArray(edges)) {
		return [];
	}
	return edges.map(edge => Array.isArray(edge) ? { from: edge[0], to: edge[1] } : edge);
}

/** Whether anything in this flow can be labelled — false for an older trace. */
export function hasRelations(flow: Flow | undefined): boolean {
	return edgesOf(flow).some(edge => !!edge.rel);
}

/**
 * How many leading middlewares every route in the project shares.
 *
 * The root router's stack runs on everything — in merkle that is 5 to 13 chips
 * repeated identically on 134 of 235 routes, which is most of the header on
 * most routes and tells a reader nothing about the route they opened. The
 * shared part is exactly the longest common PREFIX of the chains, because
 * middleware order is inherited outermost-first: what differs is always at the
 * end, and what a route adds for itself is what a reader came to see.
 *
 * Fewer than two routes means nothing is established as shared, so it is 0 and
 * every chip stays visible.
 */
export function sharedMiddlewareDepth(flows: readonly Flow[]): number {
	if (flows.length < 2) {
		return 0;
	}
	const chains = flows.map(flow => (flow.middleware ?? []).map(mw => mw.label));
	const shortest = chains.reduce((min, c) => Math.min(min, c.length), Infinity);
	let depth = 0;
	while (depth < shortest && chains.every(c => c[depth] === chains[0][depth])) {
		depth++;
	}
	return depth;
}

/** The flow's handler node, when analysis resolved one. */
export function handlerOf(flow: Flow): FlowNode | undefined {
	return (flow.nodes ?? []).find(n => n.kind === 'handler');
}
