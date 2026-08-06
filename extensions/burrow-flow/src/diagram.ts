/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// diagram.ts — the pure wire-diagram renderer: one Flow in, one HTML body
// string out. Layout is a left-to-right DAG — nodes become absolutely
// positioned <div>s (easy hovers/buttons), edges an SVG layer underneath.
// No 'vscode' import so the node test can require out/diagram.js directly.

import { edgesOf, EdgeRel, Flow, FlowEdge, FlowNode, hasRelations, MW } from './model';

const COL_W = 240;
// Wide enough for a verb to sit in the gutter without touching either box, and
// no wider. The verbs are a closed set of five; the longest, `unresolved`,
// measures 69px in the panel's own font, so this leaves ~11px of air each side.
// The gutter was 70 before there was anything in it — every extra pixel here is
// multiplied by the column count on a panel that is already narrower than the
// diagrams it shows.
const COL_GAP = 92;
const NODE_H = 54;
const ROW_GAP = 18;
const PAD = 16;
const REL_H = 16;

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
	/** Children of this node that are not on screen — the chevron's count. */
	readonly hidden: number;
}

interface PlacedEdge {
	readonly edge: FlowEdge;
	readonly x1: number;
	readonly y1: number;
	readonly x2: number;
	readonly y2: number;
	/** Where the verb sits. The curve is a symmetric cubic, so its midpoint is
	 *  the midpoint of its ends — no path sampling needed. */
	readonly mx: number;
	readonly my: number;
}

interface Layout {
	readonly placed: Placed[];
	readonly edges: PlacedEdge[];
	readonly width: number;
	readonly height: number;
}

/**
 * Which nodes are on screen.
 *
 * `expanded` holds the indexes whose children are shown. A node is visible when
 * it has no parent, or when some visible EXPANDED parent points at it — so the
 * default (`defaultExpanded`, the roots) is the handler and one level under it.
 * The rest is behind a chevron, because a route with 45 hops drawn all at once
 * is a picture nobody reads, labelled or not.
 */
export function defaultExpanded(flow: Flow): Set<number> {
	const nodes = flow.nodes ?? [];
	const hasParent = new Set(edgesOf(flow).map(e => e.to));
	return new Set(nodes.map((_, idx) => idx).filter(idx => !hasParent.has(idx)));
}

function visibleSet(flow: Flow, expanded: ReadonlySet<number>): Set<number> {
	const nodes = flow.nodes ?? [];
	const children = new Map<number, number[]>();
	const parented = new Set<number>();
	for (const edge of edgesOf(flow)) {
		children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
		parented.add(edge.to);
	}
	const visible = new Set<number>();
	const queue: number[] = [];
	nodes.forEach((_, idx) => {
		if (!parented.has(idx)) {
			visible.add(idx);
			queue.push(idx);
		}
	});
	while (queue.length) {
		const idx = queue.shift()!;
		if (!expanded.has(idx)) {
			continue;
		}
		for (const child of children.get(idx) ?? []) {
			if (!visible.has(child)) {
				visible.add(child);
				queue.push(child);
			}
		}
	}
	return visible;
}

/**
 * Column per BFS depth from the parentless roots; table nodes always last.
 *
 * Only the visible subgraph is laid out — depth, columns and canvas size are all
 * measured over what is actually drawn, so expanding a box grows the canvas
 * rather than leaving a gap where a hidden column was.
 */
export function layout(flow: Flow, expanded: ReadonlySet<number>): Layout {
	// `?? []` is not defensive programming for its own sake: a route whose
	// handler calls no store method has no edges, and any producer that writes
	// JSON from a nil list (flowscan did) sends `null`. Iterating that threw
	// before a single node was drawn, so the whole diagram was lost to the one
	// case that needed no diagram at all.
	const nodes = flow.nodes ?? [];
	const visible = visibleSet(flow, expanded);
	const edges = edgesOf(flow).filter(e => visible.has(e.from) && visible.has(e.to));

	const depth = new Array<number>(nodes.length).fill(0);
	// Relax edges until depths settle (edge lists are tiny — no need for a queue).
	let changed = true;
	while (changed) {
		changed = false;
		for (const { from, to } of edges) {
			if (depth[to] < depth[from] + 1) {
				depth[to] = depth[from] + 1;
				changed = true;
			}
		}
	}
	const maxDepth = nodes.reduce((max, _, idx) => visible.has(idx) ? Math.max(max, depth[idx]) : max, 0);

	// Children that stayed off screen. A child visible through some OTHER
	// expanded parent is on screen, so it is not counted as hidden here.
	const hiddenCount = new Map<number, number>();
	for (const edge of edgesOf(flow)) {
		if (visible.has(edge.from) && !visible.has(edge.to)) {
			hiddenCount.set(edge.from, (hiddenCount.get(edge.from) ?? 0) + 1);
		}
	}

	const placed: Placed[] = [];
	const at = new Map<number, Placed>();
	const rowsPerCol = new Map<number, number>();
	nodes.forEach((node, idx) => {
		if (!visible.has(idx)) {
			return;
		}
		const col = node.kind === 'table' ? maxDepth : depth[idx];
		const row = rowsPerCol.get(col) ?? 0;
		rowsPerCol.set(col, row + 1);
		const entry: Placed = {
			node,
			idx,
			x: PAD + col * (COL_W + COL_GAP),
			y: PAD + row * (NODE_H + ROW_GAP),
			hidden: hiddenCount.get(idx) ?? 0,
		};
		placed.push(entry);
		at.set(idx, entry);
	});

	// Two verbs on the same spot would overprint. Rows are unique per column so
	// this is rare, but a self-column edge or a shared midpoint would do it.
	const taken = new Set<string>();
	const placedEdges: PlacedEdge[] = [];
	for (const edge of edges) {
		const a = at.get(edge.from);
		const b = at.get(edge.to);
		if (!a || !b) {
			continue;
		}
		const x1 = a.x + COL_W;
		const y1 = a.y + NODE_H / 2;
		const x2 = b.x;
		const y2 = b.y + NODE_H / 2;
		const mx = (x1 + x2) / 2;
		let my = (y1 + y2) / 2;
		while (taken.has(`${Math.round(mx)}:${Math.round(my)}`)) {
			my += REL_H;
		}
		taken.add(`${Math.round(mx)}:${Math.round(my)}`);
		placedEdges.push({ edge, x1, y1, x2, y2, mx, my });
	}

	const width = PAD * 2 + (maxDepth + 1) * COL_W + maxDepth * COL_GAP;
	const height = PAD * 2 + Math.max(1, ...rowsPerCol.values()) * (NODE_H + ROW_GAP);
	return { placed, edges: placedEdges, width, height };
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

/**
 * What a click on the box itself does — shown on every node, because the
 * commonest question about this panel was "why can't I click on each part".
 * Most nodes DO open their source; the ones that have no source (a table is a
 * row in the database, not a line of Go) say what they open instead.
 */
function clickHint(node: FlowNode): string {
	if (node.kind === 'table') {
		return 'Click: open this table in Data';
	}
	if (node.file) {
		return `Click: open ${node.file}${node.line ? ':' + node.line : ''}`;
	}
	return 'No source to open — flowscan could not place this hop';
}

/**
 * The buttons were a bare ▶ and a bare ●, which read as play and record. They
 * are neither. Labelled, and every one of them is captioned in the ? sheet.
 */
function nodeActions(node: FlowNode): string {
	if (node.kind === 'query') {
		return '<button class="act" data-act="query" title="Run this SQL in the Data view">run in Data</button>';
	}
	if (node.kind === 'table') {
		return '<button class="act" data-act="table" title="Open this table in the Data view">open in Data</button>';
	}
	if (node.kind === 'handler') {
		return '<button class="act" data-act="breakpoint" title="Set a breakpoint on this handler, so the next request that hits this route stops here">break here</button>';
	}
	return '';
}

/**
 * The chevron. Its own hit target, because the box body already opens the
 * source and the help sheet promises that it does.
 *
 * Bottom-right: the title owns the top-left, `.act` owns the top-right.
 */
function nodeChevron(placed: Placed): string {
	if (!placed.hidden) {
		return '';
	}
	const what = placed.hidden === 1 ? '1 more hop' : `${placed.hidden} more hops`;
	return `<button class="chev" data-node="${placed.idx}" title="Show ${what} below ${escapeHtml(placed.node.label)}">`
		+ `▸&#8202;${placed.hidden}</button>`;
}

/** What each verb on a curve means. The five are a closed set. */
export const REL_LEGEND: readonly { readonly rel: EdgeRel; readonly what: string }[] = [
	{ rel: 'calls', what: 'a Go call — the box on the left invokes the one on the right' },
	{ rel: 'executes', what: 'that function runs this SQL statement' },
	{ rel: 'reads', what: 'the statement selects from or joins this table' },
	{ rel: 'writes', what: 'the statement inserts, updates, deletes or truncates it' },
	{ rel: 'unresolved', what: 'flowscan recognised the hop and could not follow it — the box says why' },
];

const REL_SENTENCE: Record<EdgeRel, (from: string, to: string) => string> = {
	calls: (from, to) => `${from} calls ${to}`,
	executes: (from, to) => `${from} runs this ${to}`,
	reads: (_from, to) => `this statement reads ${to}`,
	writes: (_from, to) => `this statement writes ${to}`,
	unresolved: (from, to) => `${from} reaches ${to}, and flowscan could not follow it`,
};

/** The hover sentence for one curve, and where clicking it lands. */
function edgeTitle(edge: FlowEdge, from: FlowNode, to: FlowNode): string {
	const rel = edge.rel;
	const sentence = rel
		? REL_SENTENCE[rel](from.label, to.label)
		: `${from.label} → ${to.label}`;
	const where = edge.file
		? `Click: open ${edge.file}${edge.line ? ':' + edge.line : ''}`
		: 'No call site recorded — re-run the trace to label this one';
	return `${sentence}\n${where}`;
}

/** The colour key. Every left border in the diagram is one of these. */
export const LEGEND: readonly { readonly kind: string; readonly label: string; readonly what: string }[] = [
	{ kind: 'handler', label: 'handler', what: 'the Go function this route runs' },
	{ kind: 'store', label: 'store', what: 'a data-access method the handler calls' },
	{ kind: 'query', label: 'SQL', what: 'a statement that method runs' },
	{ kind: 'table', label: 'table', what: 'a table that SQL reads or writes' },
	{ kind: 'unknown', label: 'unresolved', what: 'a hop flowscan could not follow — dashed, and it says why' },
];

function chip(mw: MW, alternatives: number): string {
	const where = `${mw.file ?? ''}${mw.line ? ':' + mw.line : ''}`;
	// An arm of an if/else is not a link in the chain, and saying nothing about
	// that is how three mutually exclusive CORS middlewares came to be drawn as
	// if they stacked. The chip says which choice it belongs to; the count says
	// how many ways that choice can go.
	const conditional = mw.branch
		? `  —  registered inside an if/switch, one of ${alternatives} alternatives here, and at most one of them runs`
		: '';
	return `<span class="chip${mw.branch ? ' cond' : ''}" data-file="${escapeHtml(mw.file ?? '')}" data-line="${mw.line ?? 0}"`
		+ ` title="${escapeHtml(where + conditional)}">${mw.branch ? '?&#8202;' : ''}${escapeHtml(mw.label)}</span>`;
}

/**
 * The middleware, folded.
 *
 * `shared` is how many leading chips every route in the project carries. Those
 * are the root router's stack: true, identical everywhere, and so not what
 * anybody opened this route to find out. They collapse behind a count; what the
 * route adds for itself stays in view. Everything is still one click away, and
 * a `<details>` does that natively — no script, and nothing to round-trip.
 */
function middlewareRow(flow: Flow, shared: number): string {
	const all = flow.middleware ?? [];
	if (!all.length) {
		return '';
	}
	// Never fold away the whole row: a route with nothing of its own would be
	// left with a count and no sign of what it counted.
	const fold = Math.min(shared, Math.max(0, all.length - 1));
	const armsIn = new Map<number, number>();
	for (const mw of all) {
		if (mw.branch) {
			armsIn.set(mw.branch, (armsIn.get(mw.branch) ?? 0) + 1);
		}
	}
	const render = (list: readonly MW[]) => list.map(mw => chip(mw, armsIn.get(mw.branch ?? 0) ?? 1)).join('');
	const own = render(all.slice(fold));
	if (!fold) {
		return `<div class="chiprow"><span class="chiplabel" title="Middleware that runs before the handler, in order. Click one to open where it is mounted.">before the handler:</span><div class="chips">${own}</div></div>`;
	}
	return `<details class="mwrow"><summary title="The first ${fold} run on every route in this project — the root router's stack. Click to see them in order.">`
		+ `<span class="chiplabel">before the handler:</span>`
		+ `<span class="mwcount">${fold} shared</span>${own}</summary>`
		+ `<div class="chips shared">${render(all.slice(0, fold))}</div></details>`;
}

/** The call site, on whichever half of the edge the click lands. */
function edgeData(edge: FlowEdge): string {
	return `data-file="${escapeHtml(edge.file ?? '')}" data-line="${edge.line ?? 0}" data-col="${edge.col ?? 0}"`;
}

/**
 * Render the diagram body for one flow. The host page supplies CSS + the
 * message script.
 *
 * `expanded` is REQUIRED, and deliberately so. It was optional, defaulting to
 * `defaultExpanded(flow)`, and the panel's own re-render forgot to pass its
 * set — so every chevron click round-tripped to the host, re-rendered, and
 * redrew the default. The button did nothing, silently, and no unit test could
 * see it: this function was being called correctly, by a caller that imports
 * `vscode` and so cannot be driven from the node tests. Making the parameter
 * required moves that from "a live run might notice" to "it does not compile".
 * A caller that wants the default asks for it by name.
 */
export function renderFlow(flow: Flow, expanded: ReadonlySet<number>, sharedMw: number): string {
	const { placed, edges: drawn, width, height } = layout(flow, expanded);
	const nodeAt = flow.nodes ?? [];

	// One arrowhead per relation so the marker can be tinted with its verb. The
	// curves had no direction marker at all, so which way a hop ran could only
	// be inferred from the columns.
	const defs = REL_LEGEND.map(item =>
		`<marker id="a-${item.rel}" class="arrow ${item.rel}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 8 4 L 0 8 z"/></marker>`
	).join('') + '<marker id="a-plain" class="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 8 4 L 0 8 z"/></marker>';

	const edgePaths = drawn.map(({ edge, x1, y1, x2, y2 }) => {
		const mx = (x1 + x2) / 2;
		const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
		const rel = edge.rel ?? '';
		const title = escapeHtml(edgeTitle(edge, nodeAt[edge.from], nodeAt[edge.to]));
		// The hit path is invisible and fat: a 1.4px curve is not a click target.
		return `<path class="edgehit" d="${d}" ${edgeData(edge)}><title>${title}</title></path>`
			+ `<path class="edge ${rel}" d="${d}" marker-end="url(#a-${rel || 'plain'})"/>`;
	}).join('');

	// The verbs. HTML rather than SVG <text> so they get the page's font, an
	// opaque background the curve cannot strike through, and the same click
	// handling as every other target on the page.
	const relPills = drawn.filter(({ edge }) => edge.rel).map(({ edge, mx, my }) =>
		`<div class="rel ${edge.rel}" style="left:${Math.round(mx)}px;top:${Math.round(my)}px" ${edgeData(edge)}`
		+ ` title="${escapeHtml(edgeTitle(edge, nodeAt[edge.from], nodeAt[edge.to]))}">${escapeHtml(edge.rel!)}</div>`
	).join('');

	const chips = middlewareRow(flow, sharedMw);

	const nodes = placed.map(p => {
		const n = p.node;
		const dataPos = `data-file="${escapeHtml(n.file ?? '')}" data-line="${n.line ?? 0}" data-col="${n.col ?? 0}"`;
		const dataExtra = n.kind === 'query'
			? ` data-sql="${escapeHtml(n.sql ?? '')}"`
			: n.kind === 'table' ? ` data-table="${escapeHtml(n.label)}"` : '';
		const detail = n.kind === 'query' ? escapeHtml(n.sql ?? '') : escapeHtml(`${n.file ?? ''}${n.line ? ':' + n.line : ''}`);
		const title = `${detail}${detail ? '\n' : ''}${clickHint(n)}`;
		const dead = n.kind !== 'table' && !n.file ? ' dead' : '';
		return `<div class="node ${n.kind}${dead}" style="left:${p.x}px;top:${p.y}px;width:${COL_W}px" ${dataPos}${dataExtra} title="${escapeHtml(title)}">${nodeBody(n)}${nodeActions(n)}${nodeChevron(p)}</div>`;
	}).join('');

	const legend = LEGEND.map(item =>
		`<span class="key ${item.kind}" title="${escapeHtml(item.what)}">${escapeHtml(item.label)}</span>`
	).join('') + REL_LEGEND.map(item =>
		`<span class="relkey ${item.rel}" title="${escapeHtml(item.what)}">${escapeHtml(item.rel)}</span>`
	).join('');

	// An older trace has no verbs to draw. Say so, rather than leave a reader
	// wondering why the curves on this route are the only bare ones.
	const stale = drawn.length && !hasRelations(flow)
		? '<div class="stale">These curves are from a trace made before Burrow labelled them. '
		+ '<b>Refresh Flows</b> to see what each one is.</div>'
		: '';

	const statusBadge = `<span class="badge ${flow.status}" title="${flow.status === 'traced'
		? 'flowscan followed this route all the way to the tables it touches'
		: flow.status === 'partial'
			? 'flowscan followed part of this route — some hops are missing or approximate'
			: 'flowscan found the route registration but could not follow it any further'}">${flow.status}</span>`;
	return `
<div class="head">
	<span class="method ${flow.method.toLowerCase()}">${escapeHtml(flow.method)}</span>
	<span class="path">${escapeHtml(flow.path)}</span>
	${statusBadge}
	<span class="reg" data-file="${escapeHtml(flow.file)}" data-line="${flow.line}" title="Where this route is registered. Click to open it.">${escapeHtml(flow.file)}:${flow.line}</span>
	<span class="info" tabindex="0" role="note" aria-label="What this diagram shows">ⓘ<span class="infopop">Everything
		this route runs, left to right: the Go handler, the store methods it calls, the SQL those run, and
		the tables that SQL touches. <b>Click any box</b> to open it, and <b>click a curve</b> to open the
		line where one box leads to the next. A box showing <b>▸&#8202;3</b> has hops under it that are not
		drawn yet.</span></span>
	<button class="helpbtn" id="helpbtn" title="What am I looking at?">?</button>
</div>
${stale}
${chips}
<div class="legend">${legend}</div>
<div class="canvas" style="width:${width}px;height:${height}px">
	<svg class="edges" width="${width}" height="${height}"><defs>${defs}</defs>${edgePaths}</svg>
	${nodes}
	${relPills}
</div>`;
}
