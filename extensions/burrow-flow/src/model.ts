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
	};
	readonly tables?: Record<string, string>;
	readonly flows: Flow[];
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

/** The flow's handler node, when analysis resolved one. */
export function handlerOf(flow: Flow): FlowNode | undefined {
	return flow.nodes.find(n => n.kind === 'handler');
}
