/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// plan.js — a THROWAWAY dry run of OPTION D: the route is the act's goal, and
// the act's content is the transitive reference closure of what that goal
// needs. Option C's route-slice-only spine is withdrawn (R8) because 96% of its
// acts could not close.
//
// It changes nothing. It reads:
//   - flows.json   (flowscan — unchanged this session)
//   - decls.json   (godecls/, this directory: spans, refs, per-decl imports,
//                   per-line refs, cycle report)
//   - the burrow-scratch extension's COMPILED planModel/scan, read-only, so the
//     filler ordering and file metadata are the real ones.
//
// and emits option-d-plan.dryrun.{json,md}.
//
// Usage:
//   node plan.js --reference <project> --flows <flows.json> --decls <decls.json> [--out <dir>]

'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
const { scaffoldFor } = require('./scaffold');

const doc = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
const decls = JSON.parse(fs.readFileSync(DECLS, 'utf8'));

const scanned = scanProject(REFERENCE);
const today = planModel.buildPlan(scanned.files, { name: path.basename(REFERENCE), reference: REFERENCE });
const todayOrder = today.stages.flatMap((s) => s.steps);
const stepOf = (id) => today.steps[id];
const linesOf = (id) => (stepOf(id) ? stepOf(id).lines : 0);

const BACKEND_DIR = path.resolve(doc.backend);
const PREFIX = path.relative(REFERENCE, BACKEND_DIR).split(path.sep).join('/');
const proj = (rel) => `${PREFIX}/${rel}`;

// ---------------------------------------------------------------------------
// The declaration graph
// ---------------------------------------------------------------------------

const key = (d) => `${d.file}:${d.line}`;
const declByKey = new Map(decls.decls.map((d) => [key(d), d]));
const byFile = new Map();
for (const d of decls.decls) {
	if (!byFile.has(d.file)) {
		byFile.set(d.file, []);
	}
	byFile.get(d.file).push(d);
}
for (const [, list] of byFile) {
	list.sort((a, b) => a.line - b.line);
}

/** The innermost top-level declaration containing `line`. */
function enclosing(file, line) {
	let best;
	for (const d of byFile.get(file) || []) {
		if (d.line <= line && line <= d.endLine) {
			best = d;
		}
	}
	return best;
}

/** Declaration -> declarations it references, inside the module only. */
const adj = new Map();
for (const [k, refs] of Object.entries(decls.refs)) {
	const out = new Set();
	for (const r of refs || []) {
		if (r.ext || !r.file) {
			continue;
		}
		const owner = enclosing(r.file, r.line);
		if (owner && key(owner) !== k) {
			out.add(key(owner));
		}
	}
	adj.set(k, [...out]);
}

/**
 * Transitive closure with a visited set. godecls reports **0 declaration-level
 * reference cycles** in merkle, but the guard stays: Go permits them (a type
 * whose method returns that type, two mutually recursive helpers), and a DFS
 * without one would not terminate on a project that has them.
 */
function closureOf(seeds) {
	const seen = new Set();
	const stack = [...seeds];
	while (stack.length) {
		const v = stack.pop();
		if (seen.has(v) || !declByKey.has(v)) {
			continue;
		}
		seen.add(v);
		for (const w of adj.get(v) || []) {
			if (!seen.has(w)) {
				stack.push(w);
			}
		}
	}
	return seen;
}

/** Declarations referenced on one source line — how a mount or a registration
 *  pulls its middleware in without being special-cased (R12). */
function lineSeeds(file, line) {
	const out = [];
	for (const r of decls.lineRefs[`${file}:${line}`] || []) {
		if (r.ext || !r.file) {
			continue;
		}
		const owner = enclosing(r.file, r.line);
		if (owner) {
			out.push(key(owner));
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Scaffold — the block structure an accreted line cannot stand without
// ---------------------------------------------------------------------------

const textCache = new Map();
function refLines(rel) {
	if (!textCache.has(rel)) {
		const abs = path.join(BACKEND_DIR, rel);
		textCache.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\n') : []);
	}
	return textCache.get(rel);
}

/** Every line that must exist for an accreted line to stand — see scaffold.js. */
const scaffoldCache = new Map();
function scaffoldLines(rel, line) {
	const ck = `${rel}:${line}`;
	if (scaffoldCache.has(ck)) {
		return scaffoldCache.get(ck);
	}
	const d = enclosing(rel, line);
	const out = d
		? { decl: d, lines: scaffoldFor(refLines(rel), d, line) }
		: { decl: undefined, lines: [line] };
	scaffoldCache.set(ck, out);
	return out;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** SQL statement span of a CREATE TABLE. */
function tableSpan(rel, line) {
	const lines = refLines(rel);
	for (let i = line; i < lines.length; i++) {
		if (/^\s*\)\s*;?\s*$/.test(lines[i]) || /\)\s*;\s*$/.test(lines[i])) {
			return { start: line, end: i + 1 };
		}
	}
	return { start: line, end: line };
}

/** What one route asks for: its accreted lines, its tables, and its seeds. */
function routeOf(flow) {
	const accreted = [];
	for (const m of flow.middleware || []) {
		if (m.file && m.line) {
			accreted.push({ role: 'mount', file: m.file, line: m.line, label: m.label });
		}
	}
	accreted.push({ role: 'register', file: flow.file, line: flow.line, label: `${flow.method} ${flow.path}` });

	const seeds = new Set();
	const handler = flow.nodes.find((n) => n.kind === 'handler');
	if (handler && handler.file && handler.line) {
		const d = enclosing(handler.file, handler.line);
		if (d) {
			seeds.add(key(d));
		}
	}
	// Everything the act will physically write must have its references closed —
	// the accreted line, and every scaffold line that holds it up.
	for (const a of accreted) {
		const sc = scaffoldLines(a.file, a.line);
		a.scaffold = sc;
		for (const l of sc.lines) {
			for (const s of lineSeeds(a.file, l)) {
				seeds.add(s);
			}
		}
	}
	const tables = [];
	for (const n of flow.nodes) {
		if (n.kind === 'table' && n.file && n.line) {
			const span = tableSpan(n.file, n.line);
			tables.push({ file: n.file, label: n.label, ...span });
		}
	}
	return {
		route: `${flow.method} ${flow.path}`, method: flow.method, path: flow.path,
		status: flow.status, seeds, accreted, tables,
		nodeKind: new Map(flow.nodes.filter((n) => n.file && n.line).map((n) => {
			const d = enclosing(n.file, n.line);
			return [d ? key(d) : `${n.file}:${n.line}`, n.kind];
		})),
	};
}

const routes = doc.flows.map(routeOf);
for (const r of routes) {
	r.full = closureOf(r.seeds);
	r.fullLines = [...r.full].reduce((n, k) => n + (declByKey.get(k).endLine - declByKey.get(k).line + 1), 0);
}
// R5: static, computed once against an empty world, ascending, ties by path.
routes.sort((a, b) => a.full.size - b.full.size || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : 1));

// ---------------------------------------------------------------------------
// Acts
// ---------------------------------------------------------------------------

const MODULE = (/^module\s+(\S+)/m.exec(fs.readFileSync(path.join(BACKEND_DIR, 'go.mod'), 'utf8')) || [])[1];
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
const PORT = listenPort();
const port = PORT ? PORT.port : '8080';

const ACT0 = [
	{ kind: 'generate', file: proj('go.mod'), title: 'go mod init', cmd: `go mod init ${MODULE}`,
		why: 'The toolchain writes this file. Typing it teaches nothing but the format of a file you will never edit by hand.' },
	{ kind: 'write', file: proj('main.go'), title: 'main.go — the smallest program that runs', skeleton: true, fixtureLines: 14,
		why: 'func main, call serve, exit non-zero on error. It compiles and does nothing, which is the point.' },
	{ kind: 'write', file: proj('app.go'), title: 'app.go — an http.Server on a port', skeleton: true, fixtureLines: 24,
		why: `Bind :${port} and serve. Still no routes — a 404 from your own server is the first real feedback loop.` },
	{ kind: 'write', file: proj('router.go'), title: 'router.go — one literal route', skeleton: true, fixtureLines: 17,
		why: 'A chi mux with GET /healthz returning 200.' },
	{ kind: 'verify', title: 'go build ./...', cmd: 'go build ./...', why: 'The first green check.' },
	{ kind: 'verify', title: 'curl the health route', cmd: `curl -s -o /dev/null -w '%{http_code}' localhost:${port}/healthz`,
		why: 'Ends evening one with a running server answering a request.' },
];

// Pedagogical order inside an act. Go is order-independent within a package, so
// this is for the reader, not the compiler.
const BUCKET = { table: 0, type: 1, const: 1, var: 1, helper: 2, store: 3, query: 4, handler: 5 };
function bucketOf(k, route) {
	const d = declByKey.get(k);
	const nodeKind = route.nodeKind.get(k);
	if (nodeKind === 'handler' || nodeKind === 'store' || nodeKind === 'query') {
		return BUCKET[nodeKind];
	}
	if (d.kind === 'type' || d.kind === 'const' || d.kind === 'var') {
		return BUCKET.type;
	}
	return BUCKET.helper;
}

const acts = [];
const writtenDecls = new Set();
const writtenLines = new Set();      // "file:line" — accreted and scaffold
const writtenTables = new Set();
const covered = new Map();           // project file -> [[s,e],…]
const touched = new Set();
const firstStep = new Map();
let stepIndex = 0;

function cover(projFile, s, e) {
	if (!covered.has(projFile)) {
		covered.set(projFile, []);
	}
	covered.get(projFile).push([s, e]);
	touched.add(projFile);
	if (!firstStep.has(projFile)) {
		firstStep.set(projFile, stepIndex);
	}
}

const act0Steps = ACT0.map((s) => {
	stepIndex++;
	const out = { index: stepIndex, ...s };
	if (s.file) {
		out.refLines = linesOf(s.file);
		touched.add(s.file);
		if (!firstStep.has(s.file)) {
			firstStep.set(s.file, stepIndex);
		}
	}
	return out;
});
acts.push({ act: 0, title: 'A server that answers', kind: 'skeleton', handAuthored: true, steps: act0Steps });

routes.forEach((route, i) => {
	const steps = [];

	for (const t of route.tables) {
		const tk = `${t.file}:${t.start}`;
		if (writtenTables.has(tk)) {
			continue;
		}
		writtenTables.add(tk);
		cover(proj(t.file), t.start, t.end);
		stepIndex++;
		steps.push({ index: stepIndex, kind: 'table', role: 'symbol', file: proj(t.file),
			line: t.start, label: t.label, span: t.end - t.start + 1, bucket: 0 });
	}

	const fresh = [...route.full].filter((k) => !writtenDecls.has(k));
	fresh.sort((a, b) => {
		const ba = bucketOf(a, route), bb = bucketOf(b, route);
		if (ba !== bb) {
			return ba - bb;
		}
		const da = declByKey.get(a), db = declByKey.get(b);
		return da.file < db.file ? -1 : da.file > db.file ? 1 : da.line - db.line;
	});
	for (const k of fresh) {
		writtenDecls.add(k);
		const d = declByKey.get(k);
		cover(proj(d.file), d.line, d.endLine);
		stepIndex++;
		steps.push({
			index: stepIndex, kind: route.nodeKind.get(k) || d.kind, role: 'symbol',
			file: proj(d.file), line: d.line, endLine: d.endLine,
			label: d.recv ? `(${d.recv}).${d.name}` : d.name,
			span: d.endLine - d.line + 1, bucket: bucketOf(k, route), declKind: d.kind,
		});
	}

	for (const a of route.accreted) {
		const lk = `${a.file}:${a.line}`;
		if (writtenLines.has(lk)) {
			continue;
		}
		writtenLines.add(lk);
		const write = [a.line];
		for (const l of a.scaffold.lines) {
			if (l !== a.line && !writtenLines.has(`${a.file}:${l}`)) {
				writtenLines.add(`${a.file}:${l}`);
				write.push(l);
			}
		}
		for (const l of write) {
			cover(proj(a.file), l, l);
		}
		stepIndex++;
		steps.push({
			index: stepIndex, kind: a.role, role: a.role, file: proj(a.file), line: a.line,
			label: a.label, span: write.length, scaffold: write.length - 1,
			gained: a.role === 'register' ? [`registers ${a.label}`] : [`mounts ${a.label}`],
		});
	}

	acts.push({
		act: i + 1, title: route.route, kind: 'route', status: route.status,
		closure: route.full.size, closureLines: route.fullLines,
		freshDecls: fresh.length,
		freshLines: steps.reduce((n, s) => n + s.span, 0),
		steps,
	});
});

const ROUTE_ACTS = acts.length - 1;

// ---------------------------------------------------------------------------
// Completion + filler
// ---------------------------------------------------------------------------

function coveredCount(projFile) {
	const set = new Set();
	for (const [s, e] of covered.get(projFile) || []) {
		for (let i = s; i <= e; i++) {
			set.add(i);
		}
	}
	return set.size;
}

function fillerKind(id) {
	const k = stepOf(id) ? stepOf(id).kind : planModel.kindOf(id);
	if (k === 'lock' || /(^|\/)go\.sum$/.test(id)) {
		return 'generate';
	}
	if (/\.(md|puml)$/.test(id)) {
		return 'copy';       // R6
	}
	return 'write';
}

const completions = [];
for (const file of [...touched].sort()) {
	const total = linesOf(file);
	const done = coveredCount(file);
	if (!total || done >= total) {
		continue;
	}
	completions.push({ file, refLines: total, written: done, remaining: total - done });
}
const completionByFile = new Map(completions.map((c) => [c.file, c]));

const tail = [];
for (const id of todayOrder) {
	stepIndex++;
	if (completionByFile.has(id)) {
		const c = completionByFile.get(id);
		tail.push({ index: stepIndex, kind: 'complete', file: id, refLines: c.refLines, written: c.written, remaining: c.remaining, done: 'reference diff' });
	} else if (touched.has(id)) {
		stepIndex--;
	} else {
		tail.push({ index: stepIndex, kind: fillerKind(id), file: id, stage: stepOf(id).stage, refLines: linesOf(id) });
	}
}
const completionSteps = tail.filter((s) => s.kind === 'complete');
const fillerSteps = tail.filter((s) => s.kind !== 'complete');

// ---------------------------------------------------------------------------
// Imports per file, derived from R11's per-declaration import sets
// ---------------------------------------------------------------------------

const fileImports = {};    // project file -> [{path, local}]
for (const k of writtenDecls) {
	const d = declByKey.get(k);
	const pf = proj(d.file);
	fileImports[pf] = fileImports[pf] || {};
	for (const imp of decls.imports[k] || []) {
		fileImports[pf][imp.path] = imp;
	}
}
// Accreted and scaffold lines need imports too: `r.Use(middleware.JWT(…))`.
for (const lk of writtenLines) {
	const [file, line] = [lk.slice(0, lk.lastIndexOf(':')), Number(lk.slice(lk.lastIndexOf(':') + 1))];
	const pf = proj(file);
	const own = (enclosing(file, line) || {}).pkg;
	fileImports[pf] = fileImports[pf] || {};
	for (const r of decls.lineRefs[lk] || []) {
		if (r.pkg === own) {
			continue;
		}
		const spelled = (decls.fileImps[file] || []).find((i) => i.path === r.pkg);
		if (spelled) {
			fileImports[pf][r.pkg] = spelled;
		}
	}
}
for (const pf of Object.keys(fileImports)) {
	fileImports[pf] = Object.values(fileImports[pf]).sort((a, b) => (a.path < b.path ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const routeActs = acts.slice(1);
const stat = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
	return { mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1), median: at(0.5), p90: at(0.9), max: s[s.length - 1] };
};
const declStats = stat(routeActs.map((a) => a.freshDecls));
const lineStats = stat(routeActs.map((a) => a.freshLines));
const under300 = routeActs.filter((a) => a.freshLines <= 300).length;

const thresholds = [
	{ n: 1, text: 'median act ≤ 10 declarations', value: declStats.median, limit: 10, pass: declStats.median <= 10 },
	{ n: 2, text: 'median act ≤ 150 reference lines', value: lineStats.median, limit: 150, pass: lineStats.median <= 150 },
	{ n: 3, text: '≥ 90% of acts ≤ 300 reference lines', value: +((under300 / routeActs.length) * 100).toFixed(1), limit: 90, pass: under300 / routeActs.length >= 0.9 },
];

const totalSteps = stepIndex;
const landmarks = ['main.go', 'app.go', 'router.go'].map((base) => {
	const file = proj(base);
	const at = firstStep.get(file);
	const todayAt = todayOrder.indexOf(file) + 1;
	return { file, optionD: { step: at, pct: +((at / totalSteps) * 100).toFixed(1) }, today: { step: todayAt, pct: +((todayAt / todayOrder.length) * 100).toFixed(1) } };
});

const json = {
	version: 3, option: 'D', unit: 'symbol',
	generatedFrom: { reference: REFERENCE, flows: FLOWS, decls: DECLS, flowsRev: doc.rev, module: MODULE },
	port: PORT ? { value: port, source: PORT.source } : { value: port, source: 'TODO — not found; hardcoded' },
	cycles: decls.cycles ? decls.cycles.length : 0,
	counts: {
		acts: acts.length, routeActs: ROUTE_ACTS, steps: totalSteps, act0Steps: act0Steps.length,
		routeSteps: routeActs.reduce((n, a) => n + a.steps.length, 0),
		completionSteps: completionSteps.length, fillerSteps: fillerSteps.length,
		todaySteps: todayOrder.length, touchedFiles: touched.size, revisitSteps: 0,
	},
	thresholds, declStats, lineStats,
	fullClosure: { decls: stat(routes.map((r) => r.full.size)), lines: stat(routes.map((r) => r.fullLines)) },
	landmarks,
	completions: completions.sort((a, b) => b.remaining - a.remaining),
	fileImports,
	acts, completionSteps, filler: fillerSteps,
};
fs.writeFileSync(path.join(OUT_DIR, 'option-d-plan.dryrun.json'), JSON.stringify(json, null, '\t') + '\n');

const out = [];
const w = (s = '') => out.push(s);
w('# Option D — dry run (route as goal, reference closure as content)');
w();
w(`From \`${path.basename(FLOWS)}\` (flowscan rev \`${doc.rev}\`) and \`${path.basename(DECLS)}\` `
	+ `(${decls.decls.length} declarations, ${json.cycles} reference cycles, ${decls.loadErrors} load errors), against \`${REFERENCE}\`.`);
w();
w('## Kill thresholds (R13)');
w();
w('| # | threshold | measured | verdict |');
w('|---:|---|---:|---|');
for (const t of thresholds) {
	w(`| ${t.n} | ${t.text} | ${t.value} | ${t.pass ? '**PASS**' : '**FAIL**'} |`);
}
w('| 4 | 236 of 236 acts pass `go build ./...` | see materialise.js | — |');
w();
w('## Totals');
w();
w(`acts **${acts.length}** · steps **${totalSteps}** (act 0: ${act0Steps.length}, route: ${json.counts.routeSteps}, `
	+ `completion: ${completionSteps.length}, filler: ${fillerSteps.length}) · revisit steps **0**`);
w();
w('| file | Option D | | today | |');
w('|---|---:|---:|---:|---:|');
for (const l of landmarks) {
	w(`| \`${l.file}\` | step ${l.optionD.step} | ${l.optionD.pct}% | step ${l.today.step} | ${l.today.pct}% |`);
}
w();
w(`Module \`${MODULE}\` from \`${PREFIX}/go.mod\`. Port \`${port}\` from `
	+ (PORT ? `\`${PORT.source}\`.` : '**nowhere — hardcoded, TODO**.'));
w();

for (const a of acts.slice(0, 9)) {
	w(`## Act ${a.act} — ${a.title}`);
	w();
	if (a.act === 0) {
		w('Hand-authored; the part of the curriculum that is not in the reference.');
		w();
		w('| # | kind | file / command | fixture | ref lines | why |');
		w('|---:|---|---|---:|---:|---|');
		for (const s of a.steps) {
			w(`| ${s.index} | ${s.kind} | ${s.file ? `\`${s.file}\`${s.skeleton ? ' *(skeleton)*' : ''}` : `\`${s.cmd}\``} | ${s.fixtureLines || '—'} | ${s.refLines || '—'} | ${s.why} |`);
		}
	} else {
		w(`${a.steps.length} step(s) · ${a.freshDecls} fresh declaration(s) · ${a.freshLines} reference line(s) · `
			+ `closure ${a.closure} decls / ${a.closureLines} lines · status \`${a.status}\``);
		w();
		w('| # | kind | file | line | symbol | span |');
		w('|---:|---|---|---:|---|---:|');
		for (const s of a.steps) {
			const span = s.scaffold ? `${s.span} *(+${s.scaffold} scaffold)*` : `${s.span}`;
			w(`| ${s.index} | ${s.kind} | \`${s.file}\` | ${s.line}${s.endLine ? `–${s.endLine}` : ''} | \`${s.label}\` | ${span} |`);
		}
	}
	w();
}

w('## Fresh work per act');
w();
w('| | mean | median | p90 | max |');
w('|---|---:|---:|---:|---:|');
w(`| declarations | ${declStats.mean} | ${declStats.median} | ${declStats.p90} | ${declStats.max} |`);
w(`| reference lines | ${lineStats.mean} | ${lineStats.median} | ${lineStats.p90} | ${lineStats.max} |`);
w();
w(`Full closure against an empty world (the ordering key, not the act content): `
	+ `decls median ${json.fullClosure.decls.median}, max ${json.fullClosure.decls.max}; `
	+ `lines median ${json.fullClosure.lines.median}, max ${json.fullClosure.lines.max}.`);
w();
w('## Completion');
w();
w(`${completionSteps.length} file(s) incomplete after the last act; **${completions.reduce((n, c) => n + c.remaining, 0)}** unaccounted reference lines.`);
w();
w('| file | ref lines | written | remaining |');
w('|---|---:|---:|---:|');
for (const c of completions.slice(0, 20)) {
	w(`| \`${c.file}\` | ${c.refLines} | ${c.written} | ${c.remaining} |`);
}
w();
fs.writeFileSync(path.join(OUT_DIR, 'option-d-plan.dryrun.md'), out.join('\n'));

console.error(`plan.js: ${acts.length} acts, ${totalSteps} steps `
	+ `(${json.counts.routeSteps} route, ${completionSteps.length} completion, ${fillerSteps.length} filler)`);
for (const t of thresholds) {
	console.error(`plan.js: threshold ${t.n} — ${t.text}: ${t.value} → ${t.pass ? 'PASS' : 'FAIL'}`);
}
