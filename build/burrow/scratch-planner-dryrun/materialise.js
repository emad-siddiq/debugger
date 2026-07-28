/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// materialise.js — write Acts 0..N of the symbol-unit plan into a scratch
// folder for real, so `go build ./...` can answer the only question that
// matters about a curriculum: does it compile as you go?
//
// Deliberately GENEROUS to the plan, so that a failure is attributable to the
// ordering and not to this renderer:
//
//   - Each written symbol is the reference's own text, verbatim, for the whole
//     enclosing declaration.
//   - An accreted LINE (a route registration, a middleware mount) cannot stand
//     outside a function, so its enclosing declaration is emitted as a STUB —
//     signature, the accreted lines, closing brace — rather than skipped.
//   - Each file gets the reference's package clause and its import block,
//     filtered to the imports the emitted body actually names. Imports are a
//     mechanical consequence of typing a function; making the plan fail on them
//     would be testing the wrong thing.
//
// Usage:
//   node materialise.js --reference <project> --plan option-c-plan.dryrun.json \
//                       --out <scratch dir> --acts 5
//
// It writes only inside --out and reads the reference read-only.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const REFERENCE = path.resolve(arg('reference', path.join(process.env.HOME || '', 'Projects/merkle')));
const PLAN = path.resolve(arg('plan', path.join(__dirname, 'option-c-plan.dryrun.json')));
const OUT = path.resolve(arg('out', path.join(__dirname, 'materialised')));
const LAST_ACT = Number(arg('acts', '5'));
const GO = arg('go', 'go');

const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));

// ---------------------------------------------------------------------------
// Act 0 — the hand-authored skeleton, verbatim
// ---------------------------------------------------------------------------

const SKELETON = {
	'main.go': `// NodeWatch backend — a real-time node monitoring API.
package main

import (
	"log/slog"
	"os"
)

func main() {
	if err := Run(); err != nil {
		slog.Error("exit", "err", err)
		os.Exit(1)
	}
}
`,
	'app.go': `// app.go — the running server: what it is, and how it serves.
package main

import (
	"log/slog"
	"net/http"
	"os"
)

// App is the process: configuration, plus the routes it answers.
type App struct {
	Router http.Handler
}

// Run builds the app and serves until the process is killed.
func Run() error {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	a := &App{Router: NewRouter()}
	srv := &http.Server{
		Addr:    ":" + port,
		Handler: a.Router,
	}
	slog.Info("listening", "port", port)
	return srv.ListenAndServe()
}
`,
	'router.go': `// router.go — the mux. Every act from here adds one line to it.
package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// NewRouter builds the route table.
func NewRouter() http.Handler {
	r := chi.NewRouter()
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	return r
}
`,
};

// ---------------------------------------------------------------------------
// Reading the reference
// ---------------------------------------------------------------------------

const cache = new Map();
function refLines(projFile) {
	if (!cache.has(projFile)) {
		const abs = path.join(REFERENCE, projFile);
		cache.set(projFile, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\n') : undefined);
	}
	return cache.get(projFile);
}

/** The `package x` clause of a Go file. */
function packageClause(projFile) {
	for (const line of refLines(projFile) || []) {
		if (/^package\s+\w+/.test(line)) {
			return line.trim();
		}
	}
	return 'package main';
}

/** The file's import specs, as { local, pathSpec, raw }. */
function importsOf(projFile) {
	const lines = refLines(projFile) || [];
	const out = [];
	let inBlock = false;
	for (const line of lines) {
		const t = line.trim();
		if (!inBlock && /^import\s*\($/.test(t)) {
			inBlock = true;
			continue;
		}
		if (inBlock && t === ')') {
			break;
		}
		const single = /^import\s+(?:(\S+)\s+)?"([^"]+)"$/.exec(t);
		const inner = /^(?:(\S+)\s+)?"([^"]+)"$/.exec(t);
		const m = inBlock ? inner : single;
		if (!m) {
			continue;
		}
		const spec = m[2];
		// `github.com/go-chi/chi/v5` is package `chi`, not package `v5`: the
		// major-version suffix is not part of the name. Getting this wrong
		// dropped chi from every generated file and made the plan look worse
		// than it is.
		const segs = spec.split('/');
		const last = segs.pop();
		const local = m[1] || (/^v\d+$/.test(last) ? segs.pop() : last);
		out.push({ local, spec, blank: m[1] === '_' });
	}
	return out;
}

/** Signature lines of a declaration: start through the line ending in `{`. */
function signature(projFile, start, end) {
	const lines = refLines(projFile) || [];
	const sig = [];
	for (let i = start - 1; i < end && i < lines.length; i++) {
		sig.push(lines[i]);
		if (/\{\s*$/.test(lines[i])) {
			return sig;
		}
	}
	return sig.slice(0, 1);
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

if (fs.existsSync(OUT)) {
	fs.rmSync(OUT, { recursive: true, force: true });
}
fs.mkdirSync(OUT, { recursive: true });

const backendPrefix = plan.landmarks[0].file.split('/')[0];   // "backend"
const results = [];

/** Files under construction: projFile -> { units: [{start,end}], lines: Set } */
const state = new Map();

function fileState(projFile) {
	if (!state.has(projFile)) {
		state.set(projFile, { units: [], lines: new Set() });
	}
	return state.get(projFile);
}

function emitFile(projFile) {
	const st = state.get(projFile);
	const lines = refLines(projFile);
	if (!lines) {
		return;
	}
	const body = [];

	// Accreted lines grouped by their enclosing declaration, so a registration
	// line lands inside a stub of the function that holds it.
	const stubs = new Map();
	for (const line of [...st.lines].sort((a, b) => a - b)) {
		const owner = st.units.find((u) => u.start <= line && line <= u.end);
		if (owner) {
			continue;   // the whole declaration is already being written
		}
		const encl = (plan.enclosing || {})[`${projFile}:${line}`];
		const key = encl ? `${encl.start}` : `@${line}`;
		if (!stubs.has(key)) {
			stubs.set(key, { encl, lines: [] });
		}
		stubs.get(key).lines.push(line);
	}

	const blocks = [];
	for (const u of st.units) {
		blocks.push({ at: u.start, text: lines.slice(u.start - 1, u.end).join('\n') });
	}
	for (const [, s] of stubs) {
		if (!s.encl) {
			blocks.push({ at: s.lines[0], text: s.lines.map((l) => lines[l - 1]).join('\n') });
			continue;
		}
		const sig = signature(projFile, s.encl.start, s.encl.end);
		const text = [...sig, ...s.lines.map((l) => lines[l - 1]), '}'].join('\n');
		blocks.push({ at: s.encl.start, text });
	}
	blocks.sort((a, b) => a.at - b.at);
	const source = blocks.map((b) => b.text).join('\n\n');

	const used = importsOf(projFile).filter((i) =>
		i.blank || new RegExp(`\\b${i.local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\.`).test(source));
	const header = [packageClause(projFile), ''];
	if (used.length) {
		header.push('import (');
		for (const i of used) {
			header.push(`\t${i.blank ? '_ ' : ''}"${i.spec}"`);
		}
		header.push(')', '');
	}

	const abs = path.join(OUT, projFile.slice(backendPrefix.length + 1));
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, header.join('\n') + source + '\n');
	body.length = 0;
}

function run(cmd) {
	try {
		const stdout = execSync(cmd, { cwd: OUT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		return { code: 0, out: stdout.trim() };
	} catch (e) {
		return { code: e.status ?? -1, out: `${e.stdout || ''}${e.stderr || ''}`.trim() };
	}
}

// --- Act 0 ---------------------------------------------------------------
for (const [name, text] of Object.entries(SKELETON)) {
	fs.writeFileSync(path.join(OUT, name), text);
}
run(`${GO} mod init ${plan.generatedFrom.module}`);
const tidy0 = run(`GOFLAGS=-mod=mod ${GO} mod tidy`);
results.push({ act: 0, title: plan.acts[0].title, tidy: tidy0, build: run(`${GO} build ./...`) });

// --- Acts 1..N -----------------------------------------------------------
for (const a of plan.acts.filter((a) => a.act >= 1 && a.act <= LAST_ACT)) {
	const touched = new Set();
	for (const s of a.steps) {
		if (!s.file || !s.file.startsWith(`${backendPrefix}/`)) {
			continue;
		}
		if (!s.file.endsWith('.go')) {
			// migrations: materialise them, they do not affect `go build`
			const st = fileState(s.file);
			st.units.push({ start: s.unit.start, end: s.unit.end });
			const lines = refLines(s.file) || [];
			const abs = path.join(OUT, s.file.slice(backendPrefix.length + 1));
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.appendFileSync(abs, lines.slice(s.unit.start - 1, s.unit.end).join('\n') + '\n\n');
			continue;
		}
		const st = fileState(s.file);
		if (s.role === 'symbol' && s.unit) {
			st.units.push({ start: s.unit.start, end: s.unit.end });
		} else {
			st.lines.add(s.line);
		}
		touched.add(s.file);
	}
	for (const f of touched) {
		emitFile(f);
	}
	const tidy = run(`GOFLAGS=-mod=mod ${GO} mod tidy`);
	results.push({ act: a.act, title: a.title, tidy, build: run(`${GO} build ./...`) });
}

fs.writeFileSync(path.join(__dirname, 'option-c-builds.dryrun.json'), JSON.stringify(results, null, '\t') + '\n');

for (const r of results) {
	const verdict = r.build.code === 0 ? 'PASS' : `FAIL (exit ${r.build.code})`;
	console.log(`\n=== Act ${r.act} — ${r.title} — go build ./... → ${verdict} ===`);
	console.log(r.build.out || '(no output)');
}
