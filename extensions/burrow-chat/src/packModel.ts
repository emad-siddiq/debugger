/*---------------------------------------------------------------------------------------------
 *  Burrow: context-pack model — pure (no vscode import) so the node tests can
 *  require out/packModel.js, and so the budget math runs against the REAL
 *  serializer (plan chat/03 step 4.4: phase 4 renders with this same function,
 *  so the estimate and the output cannot diverge).
 *--------------------------------------------------------------------------------------------*/

export type Relation =
	'styles' | 'used-by' | 'renders' | 'props' |
	'handler' | 'sql' | 'table' | 'routes' | 'callers';

export interface Neighbor {
	relation: Relation;
	path: string;        // workspace-relative, forward slashes
	line?: number;
	detail?: string;     // ≤8 words, truncated to 40 chars by producers
}

export interface ContextPack {
	surface: string;
	primary: string[];           // rel paths, main first
	neighbors: Neighbor[];
	truncated: boolean;
}

/** Trim order when over budget: drop from the BOTTOM of this list (plan chat/03 step 4.1). */
export const RELATION_PRIORITY: Relation[] = [
	'styles', 'handler', 'sql', 'table', 'props', 'used-by', 'renders', 'routes', 'callers',
];

/** The exact phase-4 wire format. Returns '' for a pack with nothing to say. */
export function renderContextPack(pack: ContextPack): string {
	if (!pack.primary.length && !pack.neighbors.length) { return ''; }
	const lines = [
		`<context_pack surface="${pack.surface}" primary="${pack.primary.join(', ')}">`,
		...pack.neighbors.map(n => `${n.relation}: ${n.path}${n.line !== undefined ? `:${n.line}` : ''}${n.detail ? ` (${n.detail})` : ''}`),
	];
	if (pack.truncated) { lines.push('truncated: true'); }
	lines.push('</context_pack>');
	return lines.join('\n');
}

/**
 * Order, dedupe and budget the assembled neighbors into a final pack:
 * - relations appear in RELATION_PRIORITY order; within a relation, entries
 *   sort by path then line (byte-identical state ⇒ byte-identical pack);
 * - a path already in `primary` or `coveredPaths` (explicit user attachments)
 *   is dropped UNLESS the relation adds information (a line or a detail);
 * - over `budgetChars` (measured with the real serializer), entries drop from
 *   the bottom and `truncated` flips true.
 */
export function finalizePack(
	surface: string,
	primary: string[],
	neighbors: Neighbor[],
	budgetChars: number,
	coveredPaths: string[] = [],
): ContextPack {
	const covered = new Set([...primary, ...coveredPaths]);
	const seen = new Set<string>();
	const kept: Neighbor[] = [];
	for (const rel of RELATION_PRIORITY) {
		const group = neighbors
			.filter(n => n.relation === rel)
			.sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));
		for (const n of group) {
			const addsInformation = n.line !== undefined || !!n.detail;
			if (covered.has(n.path) && !addsInformation) { continue; }
			const key = `${n.relation}|${n.path}|${n.line ?? ''}|${n.detail ?? ''}`;
			if (seen.has(key)) { continue; }
			seen.add(key);
			kept.push(n);
		}
	}
	const pack: ContextPack = { surface, primary, neighbors: kept, truncated: false };
	while (kept.length && renderContextPack(pack).length > budgetChars) {
		kept.pop();
		pack.truncated = true;
	}
	return pack;
}

/** Phase-4 emission rule: nothing to emit when there are no neighbors and the
 *  primaries are already covered by explicit attachments. */
export function shouldEmitPack(pack: ContextPack, explicitPaths: string[]): boolean {
	if (pack.neighbors.length) { return true; }
	if (!pack.primary.length) { return false; }
	return !pack.primary.every(p => explicitPaths.includes(p));
}
