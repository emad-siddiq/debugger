/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// plan.js — a THROWAWAY dry run of the Option C curriculum ordering, written to
// answer one question with evidence rather than argument: if the spine of the
// rebuild is flowscan's route slices instead of a whole-repo topological sort,
// where do main.go, router.go and app.go actually land?
//
// It changes nothing. It imports the burrow-scratch extension's COMPILED
// planModel/scan (read-only) so the file metadata and the filler ordering are
// the real ones and not a re-implementation, reads a flows.json produced by
// flowscan, and emits option-c-plan.dryrun.{json,md}.
//
// Usage:
//   node plan.js --reference <project> --flows <flows.json> [--out <dir>]
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
const OUT_DIR = path.resolve(arg('out', __dirname));
const EXT_OUT = path.resolve(__dirname, '../../../extensions/burrow-scratch/out');

for (const [label, p] of [['reference', REFERENCE], ['flows', FLOWS], ['burrow-scratch out', EXT_OUT]]) {
	if (!fs.existsSync(p)) {
		console.error(`plan.js: ${label} not found at ${p}`);
		process.exit(2);
	}
}

const { scanProject } = require(path.join(EXT_OUT, 'scan.js'));
const planModel = require(path.join(EXT_OUT, 'planModel.js'));

// ---------------------------------------------------------------------------
// Act 0 — the hand-authored skeleton
// ---------------------------------------------------------------------------

// The one part of the curriculum that cannot come from the reference, because
// the twenty-line main.go a developer writes on day one does not exist in it.
// Everything variable is read from the real project; nothing is invented.

/** Module path, from the backend's own go.mod. */
function modulePath(backendDir) {
	const gomod = path.join(backendDir, 'go.mod');
	const m = /^module\s+(\S+)/m.exec(fs.readFileSync(gomod, 'utf8'));
	return m ? m[1] : undefined;
}

/**
 * Listen port. merkle takes it from $PORT and falls back to a literal in
 * config.go; that literal is the port a fresh skeleton should bind. Found by
 * pattern rather than hardcoded so the fixture stays target-agnostic.
 * Returns { port, file, line } or undefined.
 */
function listenPort(backendDir) {
	const config = path.join(backendDir, 'config.go');
	if (!fs.existsSync(config)) {
		return undefined;
	}
	const lines = fs.readFileSync(config, 'utf8').split('\n');
	for (let i = 0; i < lines.length; i++) {
		const m = /\bPort\s*=\s*"(\d+)"/.exec(lines[i]);
		if (m) {
			return { port: m[1], file: 'backend/config.go', line: i + 1 };
		}
	}
	return undefined;
}

function act0(backendPrefix, module, port) {
	const f = (p) => `${backendPrefix}/${p}`;
	return [
		{
			kind: 'generate',
			file: f('go.mod'),
			title: 'go mod init',
			cmd: `go mod init ${module}`,
			why: 'The toolchain writes this file. Typing it out teaches nothing except the format of a file you will never edit by hand.',
		},
		{
			kind: 'write',
			file: f('main.go'),
			title: 'main.go — the smallest program that runs',
			skeleton: true,
			why: 'func main, a log line, exit. It compiles and it does nothing, which is the point: everything after this is an addition to something that already works.',
		},
		{
			kind: 'write',
			file: f('app.go'),
			title: 'app.go — an http.Server on a port',
			skeleton: true,
			why: `Bind :${port} and serve. Still no routes — a 404 from your own server is the first real feedback loop.`,
		},
		{
			kind: 'write',
			file: f('router.go'),
			title: 'router.go — one literal route',
			skeleton: true,
			why: 'A chi mux with GET /healthz returning 200. This file is the spine: every act from here adds exactly one line to it.',
		},
		{
			kind: 'verify',
			title: 'go build ./...',
			cmd: 'go build ./...',
			why: 'The first green check.',
		},
		{
			kind: 'verify',
			title: 'curl the health route',
			cmd: `curl -s -o /dev/null -w '%{http_code}' localhost:${port}/healthz`,
			why: 'Ends evening one with a running server answering a request. Under the topological plan this moment arrives at step 606.',
		},
	];
}

// ---------------------------------------------------------------------------
// Slices
// ---------------------------------------------------------------------------

const KIND_RANK = { table: 0, store: 1, query: 2, handler: 3, unknown: 4 };

/**
 * The files one route needs, and how they are grouped.
 *
 * `mounts` are middleware mount SITES (app.go / router.go), not middleware
 * implementations — flowscan records where a middleware was mounted, not where
 * it is defined. `nodes` are the handler/store/query files plus the migration
 * that creates each table. `reg` is the registration site: the terminal.
 */
function sliceOf(flow, prefix) {
	const f = (p) => `${prefix}/${p}`;
	const nodes = [];
	const rankOf = new Map();
	for (const n of flow.nodes) {
		if (!n.file) {
			continue;
		}
		const file = f(n.file);
		const rank = KIND_RANK[n.kind] ?? 5;
		if (!rankOf.has(file) || rank < rankOf.get(file)) {
			rankOf.set(file, rank);
		}
		if (!nodes.includes(file)) {
			nodes.push(file);
		}
	}
	return {
		route: `${flow.method} ${flow.path}`,
		status: flow.status,
		reg: f(flow.file),
		mounts: (flow.middleware || []).filter((m) => m.file).map((m) => ({ ...m, file: f(m.file) })),
		nodes,
		rankOf,
		unresolved: flow.nodes.filter((n) => !n.file).map((n) => ({ label: n.label, reason: n.reason })),
		size: new Set([f(flow.file), ...nodes]).size,
	};
}

/**
 * Kahn over the slice, with the build-order tie-break the whole-repo sort
 * cannot express: a table before the query that reads it, the query before the
 * handler that runs it, the handler before the line that registers it.
 */
function topoWithinSlice(files, rankOf, deps) {
	const present = new Set(files);
	const remaining = new Map(files.map((n) => [n, new Set([...(deps.get(n) || [])].filter((d) => d !== n && present.has(d)))]));
	const rank = (a, b) => (rankOf.get(a) ?? 9) - (rankOf.get(b) ?? 9) || (a < b ? -1 : a > b ? 1 : 0);
	const out = [];
	while (remaining.size) {
		let ready = [...remaining].filter(([, d]) => d.size === 0).map(([n]) => n).sort(rank);
		if (!ready.length) {
			ready = [[...remaining].sort(([a, da], [b, db]) => da.size - db.size || rank(a, b))[0][0]];
		}
		for (const n of ready) {
			out.push(n);
			remaining.delete(n);
		}
		for (const [, d] of remaining) {
			for (const n of ready) {
				d.delete(n);
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const scanned = scanProject(REFERENCE);
const today = planModel.buildPlan(scanned.files, { name: path.basename(REFERENCE), reference: REFERENCE });
const todayOrder = today.stages.flatMap((s) => s.steps);
const stepOf = (id) => today.steps[id];
const linesOf = (id) => (stepOf(id) ? stepOf(id).lines : 0);

const doc = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));

// flows.json paths are backend-relative; the plan's are project-relative.
const BACKEND_PREFIX = path.relative(REFERENCE, path.resolve(doc.backend)).split(path.sep).join('/');
const BACKEND_DIR = path.resolve(doc.backend);
const MODULE = modulePath(BACKEND_DIR);
const PORT = listenPort(BACKEND_DIR);
const port = PORT ? PORT.port : '8080';

// File-level dependency edges, from the plan's own analysis. Go imports are
// package-level, so a Go file depends on every plan file in an imported dir.
const filesByDir = new Map();
for (const id of todayOrder) {
	const dir = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '.';
	if (!filesByDir.has(dir)) {
		filesByDir.set(dir, []);
	}
	filesByDir.get(dir).push(id);
}
const deps = new Map();
for (const id of todayOrder) {
	const s = stepOf(id);
	const set = new Set(s.deps);
	for (const d of s.depStages) {
		for (const sib of filesByDir.get(d) || []) {
			set.add(sib);
		}
	}
	deps.set(id, set);
}

const slices = doc.flows.map((f) => sliceOf(f, BACKEND_PREFIX));
slices.sort((a, b) => a.size - b.size || (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));

const acts = [];
const written = new Map();          // file -> act index of first appearance
const appearsIn = new Map();        // file -> [act indexes]
const seenMount = new Set();
let stepIndex = 0;
const firstStepIndex = new Map();

function record(file, actIndex) {
	if (!appearsIn.has(file)) {
		appearsIn.set(file, []);
	}
	if (!appearsIn.get(file).includes(actIndex)) {
		appearsIn.get(file).push(actIndex);
	}
	if (!written.has(file)) {
		written.set(file, actIndex);
	}
	if (!firstStepIndex.has(file)) {
		firstStepIndex.set(file, stepIndex);
	}
}

// --- Act 0 ---------------------------------------------------------------
const zero = act0(BACKEND_PREFIX, MODULE, port);
const zeroSteps = zero.map((s) => {
	stepIndex++;
	const out = { index: stepIndex, ...s };
	if (s.file) {
		out.refLines = linesOf(s.file);
		record(s.file, 0);
	}
	return out;
});
acts.push({
	act: 0,
	title: 'A server that answers',
	kind: 'skeleton',
	hand_authored: true,
	steps: zeroSteps,
});

// --- Acts 1..n -----------------------------------------------------------
slices.forEach((slice, i) => {
	const actIndex = i + 1;
	const steps = [];
	const emitted = new Map();      // file -> step object, so a file appears once per act

	const push = (file, role, gained) => {
		if (emitted.has(file)) {
			const prior = emitted.get(file);
			if (gained && !prior.gained.includes(gained)) {
				prior.gained.push(gained);
			}
			return;
		}
		stepIndex++;
		const revisit = written.has(file);
		const step = {
			index: stepIndex,
			file,
			role,
			kind: revisit ? 'revisit' : kindFor(file),
			revisit,
			gained: gained ? [gained] : [],
			refLines: linesOf(file),
		};
		if (revisit) {
			step.firstWrittenInAct = written.get(file);
		}
		emitted.set(file, step);
		steps.push(step);
		record(file, actIndex);
	};

	// 1 — any middleware this route is the first to mount, on its mount site.
	for (const m of slice.mounts) {
		const key = `${m.label}@${m.file}:${m.line}`;
		if (seenMount.has(key)) {
			continue;
		}
		seenMount.add(key);
		push(m.file, 'mount', `mounts ${m.label}`);
	}

	// 2 — the route's own files, in build order.
	for (const file of topoWithinSlice(slice.nodes, slice.rankOf, deps)) {
		push(file, 'node', undefined);
	}

	// 3 — the terminal: the line that registers the route. Never duplicated:
	//     when the registration site is also a mount site (router.go), the
	//     existing step gains the route instead of a second step appearing.
	push(slice.reg, 'register', `registers ${slice.route}`);

	acts.push({
		act: actIndex,
		title: slice.route,
		kind: 'route',
		status: slice.status,
		sliceSize: slice.size,
		unresolved: slice.unresolved,
		steps,
	});
});

// --- Filler --------------------------------------------------------------
// Everything the routes never reach, in today's topological order, unchanged.

function kindFor(id) {
	const k = stepOf(id) ? stepOf(id).kind : planModel.kindOf(id);
	// Nothing a toolchain writes is a `write` step.
	return k === 'lock' || /(^|\/)(go\.sum)$/.test(id) ? 'generate' : 'write';
}

const fillerIds = todayOrder.filter((id) => !written.has(id));
const filler = fillerIds.map((id) => {
	stepIndex++;
	record(id, -1);
	return { index: stepIndex, file: id, kind: kindFor(id), stage: stepOf(id).stage, refLines: linesOf(id) };
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const totalSteps = stepIndex;
const totalActs = acts.length;
const revisited = [...appearsIn]
	.map(([file, list]) => ({ file, acts: list.filter((a) => a >= 0).length, first: written.get(file) }))
	.filter((r) => r.acts > 1)
	.sort((a, b) => b.acts - a.acts || (a.file < b.file ? -1 : 1));

const landmarks = ['main.go', 'app.go', 'router.go'].map((base) => {
	const file = `${BACKEND_PREFIX}/${base}`;
	const at = firstStepIndex.get(file);
	const todayAt = todayOrder.indexOf(file) + 1;
	return {
		file,
		optionC: { step: at, pct: +((at / totalSteps) * 100).toFixed(1) },
		today: { step: todayAt, of: todayOrder.length, pct: +((todayAt / todayOrder.length) * 100).toFixed(1) },
	};
});

const json = {
	version: 1,
	generatedFrom: { reference: REFERENCE, flows: FLOWS, flowsRev: doc.rev, module: MODULE },
	port: PORT ? { value: port, source: `${PORT.file}:${PORT.line}` } : { value: port, source: 'TODO — not found; hardcoded' },
	counts: {
		acts: totalActs,
		routeActs: totalActs - 1,
		steps: totalSteps,
		act0Steps: zeroSteps.length,
		routeSteps: totalSteps - zeroSteps.length - filler.length,
		fillerSteps: filler.length,
		todaySteps: todayOrder.length,
		reachableFiles: written.size - filler.length,
	},
	landmarks,
	revisited,
	acts,
	filler,
};

fs.writeFileSync(path.join(OUT_DIR, 'option-c-plan.dryrun.json'), JSON.stringify(json, null, '\t') + '\n');

// --- markdown ------------------------------------------------------------

const out = [];
const w = (s = '') => out.push(s);

w('# Option C — dry run');
w();
w(`Generated by \`build/burrow/scratch-planner-dryrun/plan.js\` from \`${path.basename(FLOWS)}\` (flowscan rev \`${doc.rev}\`)`);
w(`against \`${REFERENCE}\`. Nothing was written to the reference and nothing in the extension was changed.`);
w();
w('## Totals');
w();
w('| | Option C | today (topological) |');
w('|---|---:|---:|');
w(`| acts | ${totalActs} (1 skeleton + ${totalActs - 1} routes) | — |`);
w(`| steps | ${totalSteps} | ${todayOrder.length} |`);
w(`| … in Act 0 | ${zeroSteps.length} | — |`);
w(`| … in route acts | ${totalSteps - zeroSteps.length - filler.length} | — |`);
w(`| … in filler | ${filler.length} | — |`);
w();
w('## Where the landmarks land');
w();
w('| file | Option C | | today | |');
w('|---|---:|---:|---:|---:|');
for (const l of landmarks) {
	w(`| \`${l.file}\` | step ${l.optionC.step} | ${l.optionC.pct}% | step ${l.today.step} | ${l.today.pct}% |`);
}
w();
w(`Module path \`${MODULE}\` read from \`${BACKEND_PREFIX}/go.mod\`. Listen port \`${port}\` read from `
	+ (PORT ? `\`${PORT.file}:${PORT.line}\`.` : '**nowhere — hardcoded, TODO**.'));
w();

for (const a of acts.slice(0, 6)) {
	w(`## Act ${a.act} — ${a.title}`);
	w();
	if (a.act === 0) {
		w('Hand-authored. This is the part of the curriculum that is not in the reference.');
		w();
		w('| # | kind | file / command | ref lines | why |');
		w('|---:|---|---|---:|---|');
		for (const s of a.steps) {
			const what = s.file ? `\`${s.file}\`${s.skeleton ? ' *(skeleton)*' : ''}` : `\`${s.cmd}\``;
			w(`| ${s.index} | ${s.kind} | ${what} | ${s.refLines || '—'} | ${s.why} |`);
		}
	} else {
		w(`${a.steps.length} step(s) · slice ${a.sliceSize} files · status \`${a.status}\``);
		w();
		w('| # | kind | role | file | ref lines | gained |');
		w('|---:|---|---|---|---:|---|');
		for (const s of a.steps) {
			w(`| ${s.index} | ${s.kind} | ${s.role} | \`${s.file}\` | ${s.refLines} | ${s.gained.join('; ') || '—'} |`);
		}
		if (a.unresolved.length) {
			w();
			w(`Unresolved nodes (no file): ${a.unresolved.map((u) => `\`${u.label}\``).join(', ')}`);
		}
	}
	w();
}

w('## Revisited files');
w();
w(`${revisited.length} file(s) appear in more than one act.`);
w();
w('| file | acts | first written in act |');
w('|---|---:|---:|');
for (const r of revisited.slice(0, 25)) {
	w(`| \`${r.file}\` | ${r.acts} | ${r.first} |`);
}
if (revisited.length > 25) {
	w();
	w(`…and ${revisited.length - 25} more; the full list is in the JSON.`);
}
w();
w('## Filler');
w();
w(`${filler.length} steps, in today's topological order, appended after Act ${totalActs - 1}.`);
w(`Of these, ${filler.filter((f) => f.kind === 'generate').length} are \`generate\` (toolchain-written) rather than \`write\`.`);
w();

fs.writeFileSync(path.join(OUT_DIR, 'option-c-plan.dryrun.md'), out.join('\n'));

console.error(`plan.js: ${totalActs} acts, ${totalSteps} steps (${filler.length} filler) → ${OUT_DIR}/option-c-plan.dryrun.{json,md}`);
