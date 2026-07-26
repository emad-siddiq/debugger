/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// diagram.ts — the pure wire-diagram renderer: one Flow in, one HTML body
// string out. Layout is a left-to-right DAG — nodes become absolutely
// positioned <div>s (easy hovers/buttons), edges an SVG layer underneath.
// No 'vscode' import so the node test can require out/diagram.js directly.

import { Flow, FlowNode } from './model';

const COL_W = 240;
const COL_GAP = 70;
const NODE_H = 54;
const ROW_GAP = 18;
const PAD = 16;

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, ch => (
		ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
	));
}

interface Placed {
	readonly node: FlowNode;
	readonly idx: number;
	readonly x: number;
	readonly y: number;
}

/** Column per BFS depth from the parentless roots; table nodes always last. */
export function layout(flow: Flow): { placed: Placed[]; width: number; height: number } {
	// `?? []` is not defensive programming for its own sake: a route whose
	// handler calls no store method has no edges, and any producer that writes
	// JSON from a nil list (flowscan did) sends `null`. Iterating that threw
	// before a single node was drawn, so the whole diagram was lost to the one
	// case that needed no diagram at all.
	const nodes = flow.nodes ?? [];
	const edges = flow.edges ?? [];
	const depth = new Array<number>(nodes.length).fill(0);
	// Relax edges until depths settle (edge lists are tiny — no need for a queue).
	let changed = true;
	while (changed) {
		changed = false;
		for (const [from, to] of edges) {
			if (depth[to] < depth[from] + 1) {
				depth[to] = depth[from] + 1;
				changed = true;
			}
		}
	}
	const maxDepth = depth.reduce((a, b) => Math.max(a, b), 0);
	const placed: Placed[] = [];
	const rowsPerCol = new Map<number, number>();
	nodes.forEach((node, idx) => {
		const col = node.kind === 'table' ? maxDepth : depth[idx];
		const row = rowsPerCol.get(col) ?? 0;
		rowsPerCol.set(col, row + 1);
		placed.push({
			node,
			idx,
			x: PAD + col * (COL_W + COL_GAP),
			y: PAD + row * (NODE_H + ROW_GAP),
		});
	});
	const width = PAD * 2 + (maxDepth + 1) * COL_W + maxDepth * COL_GAP;
	const height = PAD * 2 + Math.max(1, ...rowsPerCol.values()) * (NODE_H + ROW_GAP);
	return { placed, width, height };
}

function nodeBody(node: FlowNode): string {
	const label = escapeHtml(node.label);
	switch (node.kind) {
		case 'handler':
			return `<div class="title">ƒ ${label}</div><div class="sub">${escapeHtml(node.file ?? '')}</div>`;
		case 'store':
			return `<div class="title">◆ ${label}</div><div class="sub">${escapeHtml(node.file ?? '')}</div>`;
		case 'query': {
			const badge = node.sqlKind === 'write' ? '<span class="badge write">write</span>' : '<span class="badge read">read</span>';
			const partial = node.partial ? '<span class="badge partial">partial</span>' : '';
			return `<div class="title">${label} ${badge}${partial}</div><div class="sub sql">${escapeHtml(node.sql ?? '')}</div>`;
		}
		case 'table':
			return `<div class="title">▤ ${label}</div><div class="sub">${escapeHtml(node.file ?? '')}</div>`;
		default:
			return `<div class="title">? ${label}</div><div class="sub">${escapeHtml(node.reason ?? '')}</div>`;
	}
}

function nodeActions(node: FlowNode): string {
	if (node.kind === 'query') {
		return '<button class="act" data-act="query" title="Run in DB Explorer">▶ db</button>';
	}
	if (node.kind === 'table') {
		return '<button class="act" data-act="table" title="Open in DB Explorer">▶ db</button>';
	}
	if (node.kind === 'handler') {
		return '<button class="act" data-act="breakpoint" title="Arm symbol breakpoint">●</button>';
	}
	return '';
}

/** Render the diagram body for one flow. The host page supplies CSS + the message script. */
export function renderFlow(flow: Flow): string {
	const { placed, width, height } = layout(flow);
	const byIdx = new Map(placed.map(p => [p.idx, p]));

	const edges = (flow.edges ?? []).map(([from, to]) => {
		const a = byIdx.get(from);
		const b = byIdx.get(to);
		if (!a || !b) {
			return '';
		}
		const x1 = a.x + COL_W;
		const y1 = a.y + NODE_H / 2;
		const x2 = b.x;
		const y2 = b.y + NODE_H / 2;
		const mx = (x1 + x2) / 2;
		return `<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}"/>`;
	}).join('');

	const chips = (flow.middleware ?? []).map(mw =>
		`<span class="chip" data-file="${escapeHtml(mw.file ?? '')}" data-line="${mw.line ?? 0}" title="${escapeHtml(mw.file ?? '')}:${mw.line ?? ''}">${escapeHtml(mw.label)}</span>`
	).join('');

	const nodes = placed.map(p => {
		const n = p.node;
		const dataPos = `data-file="${escapeHtml(n.file ?? '')}" data-line="${n.line ?? 0}" data-col="${n.col ?? 0}"`;
		const dataExtra = n.kind === 'query'
			? ` data-sql="${escapeHtml(n.sql ?? '')}"`
			: n.kind === 'table' ? ` data-table="${escapeHtml(n.label)}"` : '';
		const title = n.kind === 'query' ? escapeHtml(n.sql ?? '') : escapeHtml(`${n.file ?? ''}${n.line ? ':' + n.line : ''}`);
		return `<div class="node ${n.kind}" style="left:${p.x}px;top:${p.y}px;width:${COL_W}px" ${dataPos}${dataExtra} title="${title}">${nodeBody(n)}${nodeActions(n)}</div>`;
	}).join('');

	const statusBadge = `<span class="badge ${flow.status}">${flow.status}</span>`;
	return `
<div class="head">
	<span class="method ${flow.method.toLowerCase()}">${escapeHtml(flow.method)}</span>
	<span class="path">${escapeHtml(flow.path)}</span>
	${statusBadge}
	<span class="reg" data-file="${escapeHtml(flow.file)}" data-line="${flow.line}" title="registration site">${escapeHtml(flow.file)}:${flow.line}</span>
</div>
${chips ? `<div class="chips">${chips}</div>` : ''}
<div class="canvas" style="width:${width}px;height:${height}px">
	<svg class="edges" width="${width}" height="${height}">${edges}</svg>
	${nodes}
</div>`;
}
