/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// plan.js — a THROWAWAY dry run of the Option C curriculum at SYMBOL
// granularity, plus the import-closure check that decides whether the ordering
// is buildable at all.
//
// It changes nothing. It reads:
//   - flows.json   (flowscan, with the R2 table→CREATE TABLE line change)
//   - decls.json   (godecls/, this directory: declaration spans + resolved refs)
//   - the burrow-scratch extension's COMPILED planModel/scan, read-only, so the
//     file metadata and the filler ordering are the real ones and not a
//     re-implementation that could quietly disagree.
//
// and emits option-c-plan.dryrun.{json,md} plus option-c-closure.dryrun.json.
//
// Usage:
//   node plan.js --reference <project> --flows <flows.json> --decls <decls.json> [--out <dir>]
//
// Nothing here is a proposal for how the extension should be built. It is a
// measurement harness; the numbers it prints are the deliverable.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const REFERENCE = path.resolve(arg('reference', path.join(process.env.HOME || '', 'Projects/merkle')));
const FLOWS = path.resolve(arg('flows', path.join(__dirname, 'flows.json')));
const DECLS = path.resolve(arg('decls', path.join(__dirname, 'decls.json')));
const OUT_DIR = path.resolve(arg('out', __dirname));
const EXT_OUT = path.resolve(__dirname, '../../../extensions/burrow-scratch/out');

for (const [label, p] of [['reference', REFERENCE], ['flows', FLOWS], ['decls', DECLS], ['burrow-scratch out', EXT_OUT]]) {
	if (!fs.existsSync(p)) {
		console.error(`plan.js: ${label} not found at ${p}`);
		process.exit(2);
	}
}

const { scanProject } = require(path.join(EXT_OUT, 'scan.js'));
const planModel = require(path.join(EXT_OUT, 'planModel.js'));

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const doc = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
const decls = JSON.parse(fs.readFileSync(DECLS, 'utf8'));

const scanned = scanProject(REFERENCE);
const today = planModel.buildPlan(scanned.files, { name: path.basename(REFERENCE), reference: REFERENCE });
const todayOrder = today.stages.flatMap((s) => s.steps);
const stepOf = (id) => today.steps[id];
const linesOf = (id) => (stepOf(id) ? stepOf(id).lines : 0);

// flows.json and decls.json paths are backend-relative; the plan's are project-relative.
const BACKEND_DIR = path.resolve(doc.backend);
const PREFIX = path.relative(REFERENCE, BACKEND_DIR).split(path.sep).join('/');
const proj = (rel) => `${PREFIX}/${rel}`;

// ---------------------------------------------------------------------------
// Act 0 — the hand-authored skeleton
// ---------------------------------------------------------------------------

/** Module path, from the backend's own go.mod. */
function modulePath() {
	const m = /^module\s+(\S+)/m.exec(fs.readFileSync(path.join(BACKEND_DIR, 'go.mod'), 'utf8'));
	return m ? m[1] : undefined;
}

/**
 * Listen port. merkle takes it from $PORT and falls back to a literal in
 * config.go; that literal is the port a fresh skeleton should bind. Found by
 * pattern rather than hardcoded so the fixture stays target-agnostic.
 */
function listenPort() {
	const config = path.join(BACKEND_DIR, 'config.go');
	if (!fs.existsSync(config)) {
		return undefined;
	}
	const lines = fs.readFileSync(config, 'utf8').split('\n');
	for (let i = 0; i < lines.length; i++) {
		const m = /\bPort\s*=\s*"(\d+)"/.exec(lines[i]);
		if (m) {
			return { port: m[1], source: `${PREFIX}/config.go:${i + 1}` };
		}
	}
	return undefined;
}

const MODULE = modulePath();
const PORT = listenPort();
const port = PORT ? PORT.port : '8080';

/** The six steps that cannot come from the reference, because the twenty-line
 *  main.go a developer writes on day one does not exist in it. */
const ACT0 = [
	{
		kind: 'generate', file: proj('go.mod'), title: 'go mod init',
		cmd: `go mod init ${MODULE}`,
		why: 'The toolchain writes this file. Typing it out teaches nothing except the format of a file you will never edit by hand.',
	},
	{
		kind: 'write', file: proj('main.go'), title: 'main.go — the smallest program that runs',
		skeleton: true, fixtureLines: 12,
		why: 'func main, a log line, exit. It compiles and does nothing, which is the point: everything after is an addition to something that already works.',
	},
	{
		kind: 'write', file: proj('app.go'), title: 'app.go — an http.Server on a port',
		skeleton: true, fixtureLines: 26,
		why: `Bind :${port} and serve. Still no routes — a 404 from your own server is the first real feedback loop.`,
	},
	{
		kind: 'write', file: proj('router.go'), title: 'router.go — one literal route',
		skeleton: true, fixtureLines: 16,
		why: 'A chi mux with GET /healthz returning 200. This file is the spine: every act from here adds one line to it.',
	},
	{ kind: 'verify', title: 'go build ./...', cmd: 'go build ./...', why: 'The first green check.' },
	{
		kind: 'verify', title: 'curl the health route',
		cmd: `curl -s -o /dev/null -w '%{http_code}' localhost:${port}/healthz`,
		why: 'Ends evening one with a running server answering a request.',
	},
];

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------
//
// R1 keys a step (kind, file, line). Real data adds a wrinkle the ruling could
// not have known: a `query` node's line sits INSIDE the handler or store method
// that issues it — 413 of merkle's 618 query nodes do. Typing the enclosing
// declaration types the query with it, so a second step for the query would be
// the no-op the file unit was withdrawn for, one level down.
//
// So: the step KEY stays (kind, file, line) as ruled, and what a step WRITES is
// the enclosing unit — the top-level declaration for Go, the CREATE TABLE
// statement for a table. A node landing in a unit an earlier step already wrote
// produces no step. Registration and mount steps are exempt: those are single
// accreted lines, not declarations, and R2's "one step against the registration
// site" depends on them staying line-level.

const declsByFile = new Map();
for (const d of decls.decls) {
	if (!declsByFile.has(d.file)) {
		declsByFile.set(d.file, []);
	}
	declsByFile.get(d.file).push(d);
}
for (const [, list] of declsByFile) {
	list.sort((a, b) => a.start - b.start);
}

/** The innermost top-level declaration containing `line`, or undefined. */
function enclosing(file, line) {
	let best;
	for (const d of declsByFile.get(file) || []) {
		if (d.start <= line && line <= d.end) {
			best = d;
		}
	}
	return best;
}

const sqlText = new Map();
function migrationLines(rel) {
	if (!sqlText.has(rel)) {
		const abs = path.join(BACKEND_DIR, rel);
		sqlText.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\n') : []);
	}
	return sqlText.get(rel);
}

/** The span of a CREATE TABLE statement: from its line to the `);` that closes it. */
function tableSpan(rel, line) {
	const lines = migrationLines(rel);
	for (let i = line; i < lines.length; i++) {
		if (/^\s*\)\s*;?\s*$/.test(lines[i]) || /\)\s*;\s*$/.test(lines[i])) {
			return { start: line, end: i + 1 };
		}
	}
	return { start: line, end: line };
}

/**
 * The unit a node writes: `{ file, start, end, label }` in PROJECT-relative
 * terms, or undefined when the node has no position at all.
 */
function unitOf(node) {
	if (!node.file || !node.line) {
		return undefined;
	}
	if (node.kind === 'table') {
		const span = tableSpan(node.file, node.line);
		return { file: proj(node.file), start: span.start, end: span.end, label: node.label, declKey: undefined };
	}
	const d = enclosing(node.file, node.line);
	if (!d) {
		return { file: proj(node.file), start: node.line, end: node.line, label: node.label, declKey: undefined };
	}
	return { file: proj(d.file), start: d.start, end: d.end, label: d.name, declKey: `${d.file}:${d.start}` };
}

const UNIT_RANK = { table: 0, store: 1, query: 2, handler: 3 };

/** One route's symbols, in build order, plus its mounts and registration. */
function sliceOf(flow) {
	const units = [];
	const seen = new Set();
	const ordered = [...flow.nodes]
		.map((n, i) => ({ n, i }))
		.sort((a, b) => (UNIT_RANK[a.n.kind] ?? 9) - (UNIT_RANK[b.n.kind] ?? 9) || a.i - b.i);
	for (const { n } of ordered) {
		const u = unitOf(n);
		if (!u) {
			continue;
		}
		const key = `${u.file}:${u.start}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		units.push({ ...u, key, nodeKind: n.kind, nodeLine: n.line, nodeCol: n.col, nodeLabel: n.label, sql: n.sql });
	}
	return {
		route: `${flow.method} ${flow.path}`,
		method: flow.method,
		path: flow.path,
		status: flow.status,
		units,
		mounts: (flow.middleware || []).filter((m) => m.file).map((m) => ({ ...m, projFile: proj(m.file) })),
		reg: { file: proj(flow.file), line: flow.line },
		unresolved: flow.nodes.filter((n) => !n.file).map((n) => ({ label: n.label, reason: n.reason })),
		// R5: slice size counted in DISTINCT SYMBOLS, computed once, before any
		// act runs. The registration is one; mounts are not (they belong to the
		// chain, not the route).
		size: units.length + 1,
	};
}

const slices = doc.flows.map(sliceOf);
slices.sort((a, b) => a.size - b.size || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : 1));

// ---------------------------------------------------------------------------
// Coverage — which reference lines the plan has actually written
// ---------------------------------------------------------------------------

const covered = new Map();   // project file -> [ [start,end], … ]

function cover(file, start, end) {
	if (!covered.has(file)) {
		covered.set(file, []);
	}
	covered.get(file).push([start, end]);
}

function coveredLineCount(file) {
	const lines = new Set();
	for (const [s, e] of covered.get(file) || []) {
		for (let i = s; i <= e; i++) {
			lines.add(i);
		}
	}
	return lines.size;
}

function isCovered(file, line) {
	for (const [s, e] of covered.get(file) || []) {
		if (s <= line && line <= e) {
			return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Build the plan
// ---------------------------------------------------------------------------

const acts = [];
const writtenUnits = new Set();      // "file:start"
const writtenLines = new Set();      // "file:line" for accreted lines
const seenMount = new Set();
const touchedFiles = new Set();
const firstStep = new Map();         // project file -> step index of first appearance
let stepIndex = 0;

function note(file) {
	touchedFiles.add(file);
	if (!firstStep.has(file)) {
		firstStep.set(file, stepIndex);
	}
}

// --- Act 0 ---------------------------------------------------------------
const act0Steps = ACT0.map((s) => {
	stepIndex++;
	const out = { index: stepIndex, ...s };
	if (s.file) {
		out.refLines = linesOf(s.file);
		note(s.file);
		// A skeleton is fixture content, not reference content: it covers no
		// reference lines. That is exactly why app.go needs a completion act.
	}
	return out;
});
acts.push({ act: 0, title: 'A server that answers', kind: 'skeleton', handAuthored: true, steps: act0Steps });

// --- Acts 1..n -----------------------------------------------------------
slices.forEach((slice, i) => {
	const actIndex = i + 1;
	const steps = [];
	const perFile = new Map();

	// 1 — mount points this route is the first to introduce.
	for (const m of slice.mounts) {
		const key = `${m.label}@${m.projFile}:${m.line}`;
		if (seenMount.has(key)) {
			continue;
		}
		seenMount.add(key);
		const lineKey = `${m.projFile}:${m.line}`;
		if (writtenLines.has(lineKey)) {
			continue;
		}
		writtenLines.add(lineKey);
		cover(m.projFile, m.line, m.line);
		stepIndex++;
		note(m.projFile);
		steps.push({
			index: stepIndex, kind: 'mount', role: 'mount', file: m.projFile, line: m.line,
			label: m.label, span: 1, gained: [`mounts ${m.label}`],
		});
		perFile.set(m.projFile, true);
	}

	// 2 — the route's own symbols, in build order, skipping units already written.
	for (const u of slice.units) {
		if (writtenUnits.has(u.key)) {
			continue;
		}
		writtenUnits.add(u.key);
		cover(u.file, u.start, u.end);
		stepIndex++;
		note(u.file);
		steps.push({
			index: stepIndex, kind: u.nodeKind, role: 'symbol', file: u.file,
			line: u.nodeLine, col: u.nodeCol, label: u.nodeLabel,
			unit: { label: u.label, start: u.start, end: u.end },
			span: u.end - u.start + 1,
			sql: u.sql,
		});
	}

	// 3 — the terminal: the one line that registers the route. Line-level, so
	//     always fresh, so an act whose handler already exists is exactly one step.
	const regKey = `${slice.reg.file}:${slice.reg.line}`;
	if (!writtenLines.has(regKey)) {
		writtenLines.add(regKey);
		cover(slice.reg.file, slice.reg.line, slice.reg.line);
		stepIndex++;
		note(slice.reg.file);
		steps.push({
			index: stepIndex, kind: 'register', role: 'register', file: slice.reg.file,
			line: slice.reg.line, label: slice.route, span: 1, gained: [`registers ${slice.route}`],
		});
	} else {
		const prior = steps.find((s) => s.file === slice.reg.file && s.line === slice.reg.line);
		if (prior) {
			prior.gained = [...(prior.gained || []), `registers ${slice.route}`];
		}
	}

	acts.push({
		act: actIndex, title: slice.route, kind: 'route', status: slice.status,
		sliceSymbols: slice.size, unresolved: slice.unresolved, steps,
	});
});

const ROUTE_ACTS = acts.length - 1;

// --- Completion acts (R4) ------------------------------------------------
// Every file some act touched but no act finished. Placed at the file's own
// topological position, interleaved with the filler that follows.

function kindFor(id) {
	const k = stepOf(id) ? stepOf(id).kind : planModel.kindOf(id);
	if (k === 'lock' || /(^|\/)go\.sum$/.test(id)) {
		return 'generate';       // nothing a toolchain writes is a `write` step
	}
	if (k === 'doc' || /\.(md|puml)$/.test(id)) {
		return 'copy';           // R6
	}
	return 'write';
}

const completions = [];
for (const file of [...touchedFiles].sort()) {
	const total = linesOf(file);
	const done = coveredLineCount(file);
	if (!total || done >= total) {
		continue;
	}
	completions.push({ file, refLines: total, written: done, remaining: total - done });
}
const completionByFile = new Map(completions.map((c) => [c.file, c]));

// --- Filler + completion, in today's topological order --------------------
const tail = [];
for (const id of todayOrder) {
	if (completionByFile.has(id)) {
		stepIndex++;
		const c = completionByFile.get(id);
		tail.push({
			index: stepIndex, kind: 'complete', file: id, refLines: c.refLines,
			written: c.written, remaining: c.remaining, done: 'reference diff',
		});
		continue;
	}
	if (touchedFiles.has(id)) {
		continue;   // written in full by its acts
	}
	stepIndex++;
	tail.push({ index: stepIndex, kind: kindFor(id), file: id, stage: stepOf(id).stage, refLines: linesOf(id) });
}
const fillerSteps = tail.filter((s) => s.kind !== 'complete');
const completionSteps = tail.filter((s) => s.kind === 'complete');

// ---------------------------------------------------------------------------
// Part 1 — import closure, act by act
// ---------------------------------------------------------------------------
//
// Under a topological plan "nothing is written before what it imports" is a
// theorem. Option C discards it. This replays the acts in order and asks, for
// every declaration an act writes, which of the package-level objects it
// references live at a line no act so far has written.

const closureCovered = new Map();
function closureCover(file, s, e) {
	if (!closureCovered.has(file)) {
		closureCovered.set(file, []);
	}
	closureCovered.get(file).push([s, e]);
}
function closureHas(file, line) {
	for (const [s, e] of closureCovered.get(file) || []) {
		if (s <= line && line <= e) {
			return true;
		}
	}
	return false;
}

const closure = [];
for (const a of acts) {
	// Act 0's skeleton is fixture content; it references nothing from the
	// reference, and it establishes go.mod/main.go/app.go/router.go as existing
	// but empty. Nothing to resolve.
	const writes = a.steps.filter((s) => s.role === 'symbol' && s.unit);
	for (const s of writes) {
		closureCover(s.file, s.unit.start, s.unit.end);
	}
	for (const s of a.steps.filter((s) => s.role !== 'symbol')) {
		closureCover(s.file, s.line, s.line);
	}
	const missing = [];
	for (const s of writes) {
		const rel = s.file.slice(PREFIX.length + 1);
		const d = enclosing(rel, s.unit.start);
		const refs = d ? decls.refs[`${rel}:${d.start}`] || [] : [];
		for (const r of refs) {
			if (r.ext || !r.file) {
				continue;   // stdlib or third party — `go mod tidy` resolves it
			}
			const pf = proj(r.file);
			if (closureHas(pf, r.line)) {
				continue;
			}
			missing.push({ from: `${s.file}:${s.unit.start}`, name: r.name, pkg: r.pkg, file: pf, line: r.line });
		}
	}
	const pkgs = new Set(missing.map((m) => m.pkg));
	closure.push({ act: a.act, title: a.title, writes: writes.length, unresolved: missing.length, packages: [...pkgs].sort(), missing });
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const totalSteps = stepIndex;
const routeSteps = acts.slice(1).flatMap((a) => a.steps);
const spanOf = (s) => s.span || 1;
const freshPerAct = acts.slice(1).map((a) => ({
	symbols: a.steps.length,
	lines: a.steps.reduce((n, s) => n + spanOf(s), 0),
}));
const stat = (xs) => {
	const s = [...xs].sort((x, y) => x - y);
	return { mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1), median: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
};

const landmarks = ['main.go', 'app.go', 'router.go'].map((base) => {
	const file = proj(base);
	const at = firstStep.get(file);
	const todayAt = todayOrder.indexOf(file) + 1;
	return {
		file,
		symbol: { step: at, of: totalSteps, pct: +((at / totalSteps) * 100).toFixed(1) },
		today: { step: todayAt, of: todayOrder.length, pct: +((todayAt / todayOrder.length) * 100).toFixed(1) },
	};
});

const tableNodes = doc.flows.flatMap((f) => f.nodes).filter((n) => n.kind === 'table');
const tableStats = { total: tableNodes.length, withLine: tableNodes.filter((n) => n.line).length };

// Accreted lines (registrations, mounts) cannot stand outside a function, so
// materialisation needs to know which declaration holds each one.
const enclosingOfLine = {};
for (const a of acts) {
	for (const s of a.steps) {
		if (s.role === 'symbol' || !s.file || !s.line || !s.file.startsWith(`${PREFIX}/`)) {
			continue;
		}
		const d = enclosing(s.file.slice(PREFIX.length + 1), s.line);
		if (d) {
			enclosingOfLine[`${s.file}:${s.line}`] = { name: d.name, start: d.start, end: d.end };
		}
	}
}

const json = {
	version: 2,
	unit: 'symbol',
	enclosing: enclosingOfLine,
	generatedFrom: { reference: REFERENCE, flows: FLOWS, decls: DECLS, flowsRev: doc.rev, module: MODULE },
	port: PORT ? { value: port, source: PORT.source } : { value: port, source: 'TODO — not found; hardcoded' },
	counts: {
		acts: acts.length,
		routeActs: ROUTE_ACTS,
		steps: totalSteps,
		act0Steps: act0Steps.length,
		routeSteps: routeSteps.length,
		completionSteps: completionSteps.length,
		fillerSteps: fillerSteps.length,
		todaySteps: todayOrder.length,
		touchedFiles: touchedFiles.size,
		revisitSteps: 0,
	},
	tableStats,
	landmarks,
	freshPerAct: { symbols: stat(freshPerAct.map((f) => f.symbols)), lines: stat(freshPerAct.map((f) => f.lines)) },
	act1Lines: freshPerAct[0].lines,
	completions: completions.sort((a, b) => b.remaining - a.remaining),
	acts,
	completionSteps,
	filler: fillerSteps,
};

fs.writeFileSync(path.join(OUT_DIR, 'option-c-plan.dryrun.json'), JSON.stringify(json, null, '\t') + '\n');
fs.writeFileSync(path.join(OUT_DIR, 'option-c-closure.dryrun.json'), JSON.stringify({
	version: 1,
	note: 'Unresolved = a package-level object referenced by a symbol this act writes, declared at a line no act <= N has written. Stdlib and third-party refs excluded.',
	acts: closure,
}, null, '\t') + '\n');

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const out = [];
const w = (s = '') => out.push(s);
const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`;

w('# Option C — dry run, symbol unit');
w();
w(`Generated by \`build/burrow/scratch-planner-dryrun/plan.js\` from \`${path.basename(FLOWS)}\` (flowscan rev \`${doc.rev}\`)`);
w(`and \`${path.basename(DECLS)}\` (${decls.decls.length} declarations, ${decls.loadErrors} load errors), against \`${REFERENCE}\`.`);
w('Nothing was written to the reference and nothing in the extension was changed.');
w();
w('## Totals');
w();
w('| | symbol unit | file unit (last run) | today |');
w('|---|---:|---:|---:|');
w(`| acts | ${acts.length} (1 + ${ROUTE_ACTS}) | 236 | — |`);
w(`| steps | ${totalSteps} | 2941 | ${todayOrder.length} |`);
w(`| … Act 0 | ${act0Steps.length} | 6 | — |`);
w(`| … route acts | ${routeSteps.length} | 975 | — |`);
w(`| … completion | ${completionSteps.length} | 0 | — |`);
w(`| … filler | ${fillerSteps.length} | 1960 | — |`);
w(`| revisit steps | 0 | 618 | — |`);
w();
w('## Where the landmarks land');
w();
w('| file | symbol unit | | today | |');
w('|---|---:|---:|---:|---:|');
for (const l of landmarks) {
	w(`| \`${l.file}\` | step ${l.symbol.step} | ${l.symbol.pct}% | step ${l.today.step} | ${l.today.pct}% |`);
}
w();
w(`Module \`${MODULE}\` from \`${PREFIX}/go.mod\`. Port \`${port}\` from `
	+ (PORT ? `\`${PORT.source}\`.` : '**nowhere — hardcoded, TODO**.'));
w(`Table nodes resolving to a \`CREATE TABLE\` line: **${tableStats.withLine} of ${tableStats.total}** `
	+ `(${pct(tableStats.withLine, tableStats.total)}).`);
w();

for (const a of acts.slice(0, 9)) {
	w(`## Act ${a.act} — ${a.title}`);
	w();
	if (a.act === 0) {
		w('Hand-authored. This is the part of the curriculum that is not in the reference.');
		w();
		w('| # | kind | file / command | fixture lines | ref lines | why |');
		w('|---:|---|---|---:|---:|---|');
		for (const s of a.steps) {
			const what = s.file ? `\`${s.file}\`${s.skeleton ? ' *(skeleton)*' : ''}` : `\`${s.cmd}\``;
			w(`| ${s.index} | ${s.kind} | ${what} | ${s.fixtureLines || '—'} | ${s.refLines || '—'} | ${s.why} |`);
		}
	} else {
		const lines = a.steps.reduce((n, s) => n + spanOf(s), 0);
		w(`${a.steps.length} step(s) · ${lines} reference line(s) · slice ${a.sliceSymbols} symbols · status \`${a.status}\``);
		w();
		w('| # | kind | file | line:col | symbol | span | note |');
		w('|---:|---|---|---:|---|---:|---|');
		for (const s of a.steps) {
			const pos = s.col ? `${s.line}:${s.col}` : `${s.line}`;
			const sym = s.unit ? `\`${s.unit.label}\` (${s.unit.start}–${s.unit.end})` : `\`${s.label}\``;
			w(`| ${s.index} | ${s.kind} | \`${s.file}\` | ${pos} | ${sym} | ${spanOf(s)} | ${(s.gained || []).join('; ') || (s.sql ? '`' + s.sql.slice(0, 60) + '`' : '—')} |`);
		}
		if (a.unresolved.length) {
			w();
			w(`Unresolved nodes (no file): ${a.unresolved.map((u) => `\`${u.label}\``).join(', ')}`);
		}
	}
	w();
}

w('## Completion steps (R4)');
w();
w(`${completionSteps.length} file(s) were written by at least one act and are not complete.`);
w(`Total unaccounted reference lines: **${completions.reduce((n, c) => n + c.remaining, 0)}**.`);
w();
w('| file | ref lines | written by acts | remaining |');
w('|---|---:|---:|---:|');
for (const c of completions.slice(0, 20)) {
	w(`| \`${c.file}\` | ${c.refLines} | ${c.written} | ${c.remaining} |`);
}
w();
w('## Filler');
w();
w(`${fillerSteps.length} steps, in today's topological order, interleaved with the completion steps.`);
const byKind = {};
for (const f of fillerSteps) {
	byKind[f.kind] = (byKind[f.kind] || 0) + 1;
}
w(Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `\`${k}\` ${n}`).join(' · '));
w();

fs.writeFileSync(path.join(OUT_DIR, 'option-c-plan.dryrun.md'), out.join('\n'));

const failing = closure.filter((c) => c.unresolved > 0).length;
console.error(`plan.js: ${acts.length} acts, ${totalSteps} steps `
	+ `(${routeSteps.length} route, ${completionSteps.length} completion, ${fillerSteps.length} filler)`);
console.error(`plan.js: closure — ${failing} of ${ROUTE_ACTS} route acts have unresolved references `
	+ `(${pct(failing, ROUTE_ACTS)})`);
