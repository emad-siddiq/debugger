/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// materialise.js — write Option D's acts into a scratch folder, cumulatively,
// and run `go build ./...` after each. This is threshold 4, and it is the only
// one that cannot be argued with.
//
// What it emits per file:
//   - the reference's own package clause
//   - an import block derived from R11's per-declaration import sets, unioned
//     over everything currently written in that file and filtered to what the
//     emitted text actually names (an unused import is a compile error, so an
//     over-broad union would fail for the wrong reason)
//   - the written declarations, verbatim, in source order
//   - accreted lines with their scaffold: the block openers and closers that
//     hold a route registration up, also verbatim
//
// Act 0's fixture is prepended to the same files. Its declarations are named so
// they cannot collide with the reference's (`serve`, `newRouter`); if a
// reference declaration of the same name ever arrives, the fixture's is dropped.
//
// Usage:
//   node materialise.js --reference <p> --plan option-d-plan.dryrun.json \
//                       --decls decls.json --out <dir> [--acts N] [--every N]

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { scaffoldFor } = require('./scaffold');

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const REFERENCE = path.resolve(arg('reference', path.join(process.env.HOME || '', 'Projects/merkle')));
const PLAN = path.resolve(arg('plan', path.join(__dirname, 'option-d-plan.dryrun.json')));
const DECLS = path.resolve(arg('decls', path.join(__dirname, 'decls.json')));
const OUT = path.resolve(arg('out', path.join(__dirname, 'materialised')));
const LAST = Number(arg('acts', '235'));
const VERBOSE_TO = Number(arg('verbose', '20'));
const GO = arg('go', 'go');

const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
const decls = JSON.parse(fs.readFileSync(DECLS, 'utf8'));
const PREFIX = plan.landmarks[0].file.split('/')[0];
const BACKEND = path.join(REFERENCE, PREFIX);

// ---------------------------------------------------------------------------
// Act 0 — the hand-authored skeleton
// ---------------------------------------------------------------------------

const FIXTURE = {
	'main.go': {
		name: 'main',
		imports: [{ path: 'log/slog', local: 'slog' }, { path: 'os', local: 'os' }],
		text: `func main() {
	if err := serve(); err != nil {
		slog.Error("exit", "err", err)
		os.Exit(1)
	}
}`,
	},
	'app.go': {
		name: 'serve',
		imports: [{ path: 'log/slog', local: 'slog' }, { path: 'net/http', local: 'http' }, { path: 'os', local: 'os' }],
		text: `// serve binds the port and answers until the process is killed.
func serve() error {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	srv := &http.Server{
		Addr:    ":" + port,
		Handler: newRouter(),
	}
	slog.Info("listening", "port", port)
	return srv.ListenAndServe()
}`,
	},
	'router.go': {
		name: 'newRouter',
		imports: [{ path: 'net/http', local: 'http' }, { path: 'github.com/go-chi/chi/v5', local: 'chi' }],
		text: `// newRouter builds the mux. Every act from here adds a line to it.
func newRouter() http.Handler {
	r := chi.NewRouter()
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	return r
}`,
	},
};

// ---------------------------------------------------------------------------
// Reference access
// ---------------------------------------------------------------------------

const cache = new Map();
function refLines(rel) {
	if (!cache.has(rel)) {
		const abs = path.join(BACKEND, rel);
		cache.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\n') : []);
	}
	return cache.get(rel);
}
function packageClause(rel) {
	for (const line of refLines(rel)) {
		if (/^package\s+\w+/.test(line)) {
			return line.trim();
		}
	}
	return 'package main';
}

const declAt = new Map();   // "file:line" -> decl
for (const d of decls.decls) {
	declAt.set(`${d.file}:${d.line}`, d);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

if (fs.existsSync(OUT)) {
	fs.rmSync(OUT, { recursive: true, force: true });
}
fs.mkdirSync(OUT, { recursive: true });

const state = new Map();   // backend-relative file -> { decls:Set<line>, lines:Set<line> }
function st(rel) {
	if (!state.has(rel)) {
		state.set(rel, { decls: new Set(), lines: new Set() });
	}
	return state.get(rel);
}

function emit(rel) {
	const s = state.get(rel);
	const lines = refLines(rel);
	const blocks = [];
	for (const start of s.decls) {
		const d = declAt.get(`${rel}:${start}`);
		blocks.push({ at: start, text: lines.slice(d.line - 1, d.endLine).join('\n') });
	}
	// An accreted line inside a declaration the closure already wrote in full is
	// redundant — emitting both produces the same function twice.
	const whole = [...s.decls].map((start) => declAt.get(`${rel}:${start}`));
	const accreted = [...s.lines]
		.filter((l) => !whole.some((d) => d.line <= l && l <= d.endLine))
		.sort((a, b) => a - b);
	// Group runs of accreted lines by their enclosing declaration, so two
	// registrations in different functions do not fuse into one broken block.
	const groups = new Map();
	for (const l of accreted) {
		const d = [...declAt.values()].find((x) => x.file === rel && x.line <= l && l <= x.endLine);
		const gk = d ? d.line : `@${l}`;
		if (!groups.has(gk)) {
			groups.set(gk, []);
		}
		groups.get(gk).push(l);
	}
	for (const [gk, ls] of groups) {
		blocks.push({ at: typeof gk === 'number' ? gk : ls[0], text: ls.map((l) => lines[l - 1]).join('\n') });
	}
	blocks.sort((a, b) => a.at - b.at);

	const fixture = FIXTURE[rel];
	const useFixture = fixture && ![...s.decls].some((start) => declAt.get(`${rel}:${start}`).name === fixture.name);
	const body = (useFixture ? [fixture.text] : []).concat(blocks.map((b) => b.text)).join('\n\n');

	// Imports: R11's sets for what is written, plus the imports the accreted and
	// scaffold lines need, filtered to what the text actually names.
	const want = new Map();
	if (useFixture) {
		for (const i of fixture.imports) {
			want.set(i.path, i);
		}
	}
	const own = (declAt.get(`${rel}:${[...s.decls][0]}`) || {}).pkg;
	for (const start of s.decls) {
		for (const i of decls.imports[`${rel}:${start}`] || []) {
			want.set(i.path, i);
		}
	}
	for (const l of s.lines) {
		for (const r of decls.lineRefs[`${rel}:${l}`] || []) {
			if (r.pkg === own) {
				continue;
			}
			const spelled = (decls.fileImps[rel] || []).find((i) => i.path === r.pkg);
			if (spelled) {
				want.set(spelled.path, spelled);
			}
		}
	}
	const used = [...want.values()].filter((i) =>
		new RegExp(`\\b${i.local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\.`).test(body));

	const head = [packageClause(rel), ''];
	if (used.length) {
		head.push('import (');
		for (const i of used.sort((a, b) => (a.path < b.path ? -1 : 1))) {
			head.push(`\t${i.alias ? i.local + ' ' : ''}"${i.path}"`);
		}
		head.push(')', '');
	}

	const abs = path.join(OUT, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, head.join('\n') + body + '\n');
}

function run(cmd) {
	try {
		return { code: 0, out: execSync(cmd, { cwd: OUT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
	} catch (e) {
		return { code: e.status ?? -1, out: `${e.stdout || ''}${e.stderr || ''}`.trim() };
	}
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

const results = [];
const t0 = Date.now();

for (const name of Object.keys(FIXTURE)) {
	st(name);
	emit(name);
}
run(`${GO} mod init ${plan.generatedFrom.module}`);
results.push({ act: 0, title: plan.acts[0].title, tidy: run(`GOFLAGS=-mod=mod ${GO} mod tidy`), build: run(`${GO} build ./...`) });

for (const a of plan.acts.filter((x) => x.act >= 1 && x.act <= LAST)) {
	const touched = new Set();
	for (const step of a.steps) {
		const rel = step.file.slice(PREFIX.length + 1);
		if (!rel.endsWith('.go')) {
			// migrations — materialised, but irrelevant to `go build`
			const abs = path.join(OUT, rel);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.appendFileSync(abs, refLines(rel).slice(step.line - 1, step.line - 1 + step.span).join('\n') + '\n\n');
			continue;
		}
		const s = st(rel);
		if (step.role === 'symbol') {
			s.decls.add(step.line);
		} else {
			// the accreted line plus the scaffold recorded with it
			for (const l of scaffoldOf(rel, step)) {
				s.lines.add(l);
			}
		}
		touched.add(rel);
	}
	for (const rel of touched) {
		emit(rel);
	}
	const tidy = run(`GOFLAGS=-mod=mod ${GO} mod tidy`);
	const build = run(`${GO} build ./...`);
	results.push({ act: a.act, title: a.title, tidy, build });
	if (a.act % 25 === 0) {
		console.error(`  … act ${a.act}: ${results.filter((r) => r.build.code !== 0).length} failure(s) so far, ${Math.round((Date.now() - t0) / 1000)}s`);
	}
}

/** The lines that must be written for an accreted line to stand — scaffold.js. */
function scaffoldOf(rel, step) {
	const d = [...declAt.values()].find((x) => x.file === rel && x.line <= step.line && step.line <= x.endLine);
	return d ? scaffoldFor(refLines(rel), d, step.line) : [step.line];
}

fs.writeFileSync(path.join(__dirname, 'option-d-builds.dryrun.json'), JSON.stringify(results, null, '\t') + '\n');

const failed = results.filter((r) => r.build.code !== 0);
for (const r of results.filter((r) => r.act <= VERBOSE_TO)) {
	console.log(`\n=== Act ${r.act} — ${r.title} — go build ./... → ${r.build.code === 0 ? 'PASS' : `FAIL (exit ${r.build.code})`} ===`);
	console.log(r.build.out || '(no output)');
}
console.log(`\n${results.length - failed.length} of ${results.length} acts PASS · ${failed.length} FAIL · ${Math.round((Date.now() - t0) / 1000)}s`);
if (failed.length) {
	console.log('failing acts: ' + failed.map((r) => r.act).join(', '));
}
