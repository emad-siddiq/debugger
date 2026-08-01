/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// The ordering rules, which are the whole feature: a plan that lets you write a
// handler before the store it calls is worse than no plan. planModel.ts imports
// nothing from 'vscode', so out/planModel.js is a plain CommonJS module.
// Run: `npm test` (after a compile) or `node test/planModel.test.js`.

'use strict';

const assert = require('node:assert');
const {
	buildPlan, dependents, goDeclares, goImports, isIgnored, kindOf,
	leadingComment, orderViolations, pairTests, routeIndex, topoSort, tsDeclares, tsImports,
} = require('../out/planModel');

const file = (path, text = '') => ({ path, text, bytes: Buffer.byteLength(text) });

/** A tiny two-package Go module plus a web app, enough to exercise every rule. */
const project = () => [
	file('backend/go.mod', 'module example.com/app\n\ngo 1.25.0\n'),
	file('backend/go.sum', 'github.com/x/y v1.0.0 h1:abc=\n'),
	file('backend/models/node.go', '// Package models holds the shapes every store reads and writes.\npackage models\n\ntype Node struct {\n\tID string\n}\n'),
	file('backend/store/store.go', 'package store\n\nimport (\n\t"context"\n\n\t"example.com/app/models"\n)\n\nfunc List(ctx context.Context) ([]models.Node, error) {\n\treturn nil, nil\n}\n'),
	file('backend/store/store_test.go', 'package store\n\nimport "testing"\n\nfunc TestList(t *testing.T) {}\n'),
	file('backend/router.go', 'package main\n\nimport (\n\t"github.com/go-chi/chi/v5"\n\n\t"example.com/app/store"\n)\n\nfunc Routes() *chi.Mux {\n\tr := chi.NewRouter()\n\tr.Route("/api", nil)\n\t_ = store.List\n\treturn r\n}\n'),
	file('backend/migrations/001_init.sql', '-- the nodes table\nCREATE TABLE nodes (id text primary key);\n'),
	file('web/package.json', '{"name":"web"}'),
	file('web/src/lib/format.ts', 'export function format(n: number): string {\n\treturn String(n);\n}\n'),
	file('web/src/ui/Badge.tsx', "import { format } from '../lib/format';\nexport function Badge() { return format(1); }\n"),
	file('README.md', '# app\n'),
	file('node_modules/left-pad/index.js', 'module.exports = 1;'),
];

/** A schema plus the two shapes that can apply it: a runner package, and the
 *  `cmd/migrate` main that drives it. Shaped like merkle's. */
const migrating = () => [
	file('backend/go.mod', 'module example.com/app\n\ngo 1.25.0\n'),
	file('backend/migrations/001_init.sql', 'CREATE TABLE nodes (id text primary key);\n'),
	file('backend/migrations/002_more.sql', 'CREATE TABLE edges (id text primary key);\n'),
	file('backend/internal/migrate/migrate.go', '// Package migrate is the forward-only SQL migration runner.\npackage migrate\n\nfunc Run(dir string) error {\n\treturn nil\n}\n'),
	file('backend/cmd/migrate/main.go', 'package main\n\nimport "example.com/app/internal/migrate"\n\nfunc main() {\n\t_ = migrate.Run("migrations")\n}\n'),
];

/** A flows.json with `traced` dialled to whatever the case needs. */
const flows = (traced) => ({
	backend: '/ref/backend',
	coverage: { traced },
	flows: [
		{ method: 'GET', path: '/api/nodes', file: 'router.go', nodes: [{ file: 'store/store.go' }] },
		{ method: 'POST', path: '/api/nodes', file: 'router.go', middleware: [{ file: 'middleware/auth.go' }] },
	],
});

/**
 * Build config files that name each other, a lockfile, and two files that
 * disagree about a database — WO-79's four defects, in one fixture, so a
 * regression on any of them fails here rather than on merkle.
 */
const configs = () => [
	file('web/package.json', '{"name":"web"}'),
	file('web/package-lock.json', '{"name":"web","lockfileVersion":3}'),
	file('web/tsconfig.json', '{\n\t"files": [],\n\t"references": [{ "path": "./tsconfig.app.json" }]\n}\n'),
	file('web/tsconfig.app.json', '{\n\t"compilerOptions": { "strict": true }\n}\n'),
	file('web/vite.config.ts', "import { defineConfig } from 'vite';\nexport default defineConfig({});\n"),
	// The one the invariant could not see: a manifest-kind file importing another.
	file('web/.vite.mockport.config.ts', "import base from './vite.config.ts';\nexport default { ...base };\n"),
	file('web/eslint.config.js', 'export default [];\n'),
	file('web/src/main.ts', "import '../vite.config.ts';\nexport const main = 1;\n"),
	file('Makefile', 'DATABASE_URL ?= postgres://postgres:postgres@localhost:5432/app\nrun:\n\techo hi\n'),
	file('infra/docker-compose.yml', 'services:\n  db:\n    image: postgres:16\n    ports:\n      - "5432:5432"\n    environment:\n      POSTGRES_USER: app\n      POSTGRES_PASSWORD: secret\n      POSTGRES_DB: app\n'),
];

/** Independent of `resolveTs`, deliberately: see the assertion that uses it. */
const resolveRel = (from, spec) => {
	const stack = [];
	for (const part of `${from.slice(0, from.lastIndexOf('/') + 1)}${spec}`.split('/')) {
		if (part === '..') { stack.pop(); } else if (part && part !== '.') { stack.push(part); }
	}
	return stack.join('/');
};

const stageOf = (plan, id) => plan.steps[id].stage;
const stageIndex = (plan, id) => plan.stages.findIndex((s) => s.id === stageOf(plan, id));

const cases = {
	// --- reading the source ---------------------------------------------------
	'a grouped import block yields every path': () => {
		const text = 'package x\n\nimport (\n\t"context"\n\tchimw "github.com/go-chi/chi/v5/middleware"\n\n\t"example.com/app/models"\n)\n';
		assert.deepStrictEqual(goImports(text), ['context', 'github.com/go-chi/chi/v5/middleware', 'example.com/app/models']);
	},
	'a single-line import is read too': () => {
		assert.deepStrictEqual(goImports('package x\n\nimport "fmt"\n'), ['fmt']);
	},
	'exported Go declarations include grouped types and method names': () => {
		const text = 'package x\n\ntype (\n\tNode struct{}\n\tprivate struct{}\n)\n\nfunc (h *H) Serve() {}\nfunc helper() {}\nconst Limit = 3\nvar Default = 1\n';
		assert.deepStrictEqual(goDeclares(text), ['Node', 'Serve', 'Limit', 'Default']);
	},
	'TypeScript exports and relative imports are read': () => {
		const text = "import { format } from '../lib/format';\nimport './Badge.css';\nexport function Badge() {}\nexport const size = 2;\n";
		assert.deepStrictEqual(tsImports(text), ['../lib/format', './Badge.css']);
		assert.deepStrictEqual(tsDeclares(text), ['Badge', 'size']);
	},
	'a licence banner is not mistaken for the summary': () => {
		const text = '/*----\n * Copyright\n *---*/\n\n// store.go — reading nodes back out.\npackage store\n';
		assert.strictEqual(leadingComment(text, 'go'), 'store.go — reading nodes back out.');
	},
	'generated-code markers are not summaries': () => {
		assert.strictEqual(leadingComment('// Code generated by protoc. DO NOT EDIT.\npackage x\n', 'go'), '');
	},

	// --- what counts as source ------------------------------------------------
	'build output and dependencies are not steps': () => {
		assert.strictEqual(isIgnored('node_modules/x/index.js'), true);
		assert.strictEqual(isIgnored('frontend/dist/app.js'), true);
		assert.strictEqual(isIgnored('backend/__debug_bin123'), true);
		assert.strictEqual(isIgnored('backend/app.go'), false);
	},
	'a real .env is skipped but .env.example is the config contract': () => {
		assert.strictEqual(isIgnored('infra/.env'), true);
		assert.strictEqual(isIgnored('infra/.env.example'), false);
	},
	'kinds separate tests, manifests and lockfiles': () => {
		assert.deepStrictEqual(
			['a/store.go', 'a/store_test.go', 'go.mod', 'go.sum', 'ui/Badge.tsx', 'x.sql', 'vite.config.ts'].map(kindOf),
			['go', 'gotest', 'manifest', 'lock', 'tsx', 'sql', 'manifest'],
		);
	},

	// --- ordering -------------------------------------------------------------
	'topoSort puts dependencies before the things that need them': () => {
		const edges = new Map([['app', new Set(['store'])], ['store', new Set(['models'])], ['models', new Set()]]);
		assert.deepStrictEqual(topoSort(['app', 'store', 'models'], edges), ['models', 'store', 'app']);
	},
	'topoSort keeps every node when there is a cycle': () => {
		const edges = new Map([['a', new Set(['b'])], ['b', new Set(['a'])]]);
		assert.deepStrictEqual(topoSort(['a', 'b'], edges).sort(), ['a', 'b']);
	},
	'a test follows the file it tests': () => {
		assert.deepStrictEqual(
			pairTests(['store.go', 'store_test.go', 'cache.go', 'orphan_test.go', 'cache_test.go']),
			['store.go', 'store_test.go', 'cache.go', 'cache_test.go', 'orphan_test.go'],
		);
	},

	// --- the plan -------------------------------------------------------------
	'foundations come first, and go.sum is not a step of its own': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		assert.strictEqual(plan.stages[0].id, '@foundations');
		// `go mod tidy`, which the go.mod step runs, writes go.sum. A step for it
		// would ask for a command that has already succeeded.
		assert.deepStrictEqual(plan.stages[0].steps, ['backend/go.mod', 'web/package.json']);
		assert.strictEqual(plan.steps['backend/go.sum'], undefined);
	},
	'a toolchain-written file is a generate step carrying its command': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		const gomod = plan.steps['backend/go.mod'];
		assert.strictEqual(gomod.mode, 'generate');
		assert.strictEqual(gomod.command, 'go mod init example.com/app && go mod tidy');
		assert.strictEqual(gomod.commandCwd, 'backend');
		assert.strictEqual(plan.steps['web/package.json'].mode, 'write');
	},
	'a generate step runs its command and then proves the file exists': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		const checks = plan.steps['backend/go.mod'].checks;
		assert.deepStrictEqual(checks.map((c) => c.kind), ['shell', 'exists']);
		// The CHECK's command is rerun-safe; the step's own `command` — the one
		// the learner types in the terminal — stays clean. Without the guard,
		// typing the command yourself and then pressing "Run the checks" fails on
		// `go mod init`'s "already exists". POSIX `||`/`&&` are equal-precedence
		// left-associative: (test || init) && tidy — tidy always runs.
		assert.strictEqual(checks[0].cmd, '[ -f go.mod ] || go mod init example.com/app && go mod tidy');
		assert.strictEqual(checks[0].label, '`go mod init example.com/app && go mod tidy` succeeds');
		assert.strictEqual(checks[0].cwd, 'backend');
	},
	'a lockfile is generated by its package manager, not typed': () => {
		const plan = buildPlan([...project(), file('web/package-lock.json', '{"lockfileVersion":3}')], { name: 'app', reference: '/ref' });
		const lock = plan.steps['web/package-lock.json'];
		assert.strictEqual(lock.mode, 'generate');
		assert.strictEqual(lock.command, 'npm install');
		assert.strictEqual(lock.commandCwd, 'web');
	},
	'prose and diagrams are copied, not written': () => {
		const plan = buildPlan([...project(), file('docs/flow.puml', '@startuml\n@enduml\n')], { name: 'app', reference: '/ref' });
		assert.strictEqual(kindOf('docs/flow.puml'), 'doc');
		assert.strictEqual(plan.steps['docs/flow.puml'].mode, 'copy');
		assert.strictEqual(plan.steps['README.md'].mode, 'copy');
	},
	'the schema comes before the Go that queries it': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		assert.ok(stageIndex(plan, 'backend/migrations/001_init.sql') < stageIndex(plan, 'backend/store/store.go'));
	},
	'no package is planned before one it imports': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		assert.ok(stageIndex(plan, 'backend/models/node.go') < stageIndex(plan, 'backend/store/store.go'));
		assert.ok(stageIndex(plan, 'backend/store/store.go') < stageIndex(plan, 'backend/router.go'));
	},
	'a component is planned after the module it imports': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		assert.ok(stageIndex(plan, 'web/src/lib/format.ts') < stageIndex(plan, 'web/src/ui/Badge.tsx'));
		assert.deepStrictEqual(plan.steps['web/src/ui/Badge.tsx'].deps, ['web/src/lib/format.ts']);
	},
	'ignored directories never become steps': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		assert.strictEqual(plan.steps['node_modules/left-pad/index.js'], undefined);
	},
	'every source file lands in exactly one stage': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		const listed = plan.stages.flatMap((s) => s.steps);
		assert.strictEqual(listed.length, new Set(listed).size, 'a file was planned twice');
		assert.strictEqual(listed.length, Object.keys(plan.steps).length);
		assert.ok(listed.includes('README.md'), 'supporting files are still part of the project');
	},
	'a Go step is checked by parsing that one file, not by building the package': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		const checks = plan.steps['backend/store/store.go'].checks;
		assert.deepStrictEqual(checks.map((c) => c.kind), ['exists', 'shell']);
		assert.match(checks[1].cmd, /^gofmt -e -l "backend\/store\/store\.go"$/);
		assert.strictEqual(checks[1].emptyOutput, true);
	},
	'the stage that owns a package builds and tests it': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		const stage = plan.stages.find((s) => s.id === 'backend/store');
		assert.deepStrictEqual(stage.checks.map((c) => c.cmd), ['go build ./store', 'go test ./store']);
		assert.strictEqual(stage.checks[0].cwd, 'backend');
	},
	'the module root package builds as .': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		assert.strictEqual(plan.stages.find((s) => s.id === 'backend').checks[0].cmd, 'go build .');
	},
	'a stage that registers routes offers the API view': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		const tools = plan.stages.find((s) => s.id === 'backend').tools.map((t) => t.command);
		assert.ok(tools.includes('burrow.flow.refresh'));
	},
	'a stage whose only router match is in a test file offers no API hint': () => {
		// A middleware test spins up a chi router to exercise the middleware. That
		// is not a stage that registers routes, and treating it as one fired the
		// hint four stages before there was anything to trace.
		const plan = buildPlan([
			file('backend/go.mod', 'module example.com/app\n\ngo 1.25.0\n'),
			file('backend/mw/mw.go', 'package mw\n\nfunc Auth() {}\n'),
			file('backend/mw/mw_test.go', 'package mw\n\nimport "github.com/go-chi/chi/v5"\n\nfunc TestAuth(t *testing.T) {\n\tr := chi.NewRouter()\n\tr.Route("/x", nil)\n}\n'),
		], { name: 'app', reference: '/ref' });
		const stage = plan.stages.find((s) => s.id === 'backend/mw');
		assert.ok(stage.steps.includes('backend/mw/mw_test.go'), 'the test file is still a step');
		assert.ok(!stage.tools.some((t) => t.command === 'burrow.flow.refresh'), 'but it does not register routes');
		assert.ok(stage.tools.some((t) => t.command === 'burrow.test.runAll'), 'the Test Lab hint is unaffected');
	},
	'a stage that mounts routes on a router it was handed offers no API hint': () => {
		// Six of merkle's eight registration sites look exactly like this: they
		// take a chi.Router and hang routes off it. flowscan seeds at NewRouter()
		// and can trace none of them until whatever calls it exists, so a stage
		// full of them is a stage where the API view still shows nothing.
		const plan = buildPlan([
			file('backend/go.mod', 'module example.com/app\n\ngo 1.25.0\n'),
			file('backend/admin/routes.go', 'package admin\n\nimport "github.com/go-chi/chi/v5"\n\nfunc RegisterRoutes(r chi.Router) {\n\tr.Route("/admin", func(r chi.Router) {\n\t\tr.Get("/usage", nil)\n\t})\n}\n'),
		], { name: 'app', reference: '/ref' });
		assert.ok(plan.stages.length, 'the package is still planned');
		assert.deepStrictEqual(
			plan.stages.filter((s) => s.tools.some((t) => t.command === 'burrow.flow.refresh')).map((s) => s.id),
			[], 'no stage offers the API view when nothing creates a router');
	},
	'the API hint waits for the file that creates the router': () => {
		const plan = buildPlan([
			...project(),
			// Registers routes on a router it is handed — earlier than backend/,
			// which is the package that actually calls chi.NewRouter().
			file('backend/admin/routes.go', 'package admin\n\nimport "github.com/go-chi/chi/v5"\n\nfunc RegisterRoutes(r chi.Router) {\n\tr.Route("/admin", nil)\n}\n'),
		], { name: 'app', reference: '/ref' });
		const hinted = plan.stages.filter((s) => s.tools.some((t) => t.command === 'burrow.flow.refresh')).map((s) => s.id);
		assert.ok(hinted.includes('backend'), 'the stage holding chi.NewRouter() offers it');
		assert.ok(!hinted.includes('backend/admin'), 'the stage that only mounts does not');
		assert.ok(stageIndex(plan, 'backend/admin/routes.go') < plan.stages.findIndex((s) => s.id === 'backend'),
			'and it really did come first, so this is a gate and not an ordering accident');
	},

	'the data grid waits for something that can apply the schema': () => {
		const plan = buildPlan(migrating(), { name: 'app', reference: '/ref' });
		const hinted = plan.stages.filter((s) => s.tools.some((t) => t.command === 'burrow.db.refresh')).map((s) => s.id);
		assert.ok(hinted.includes('backend/cmd/migrate'), 'the stage planning the runner offers it');
		assert.ok(!hinted.includes('backend/migrations'), 'writing .sql files puts nothing in a database');
	},
	'migrations with no migrate entry point offer no data grid hint at all': () => {
		// Degrade to absent, the same way route annotations do: a hint pointing at
		// a view that cannot be filled is worse than no hint.
		const plan = buildPlan(migrating().filter((f) => !f.path.startsWith('backend/cmd/migrate/')
			&& !f.path.startsWith('backend/internal/migrate/')), { name: 'app', reference: '/ref' });
		assert.ok(plan.stages.some((s) => s.id === 'backend/migrations'), 'the schema is still planned');
		assert.deepStrictEqual(
			plan.stages.filter((s) => s.tools.some((t) => t.command === 'burrow.db.refresh')).map((s) => s.id), []);
	},

	'a stage with a test file offers the Test Lab': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		const tools = plan.stages.find((s) => s.id === 'backend/store').tools.map((t) => t.command);
		assert.ok(tools.includes('burrow.test.runAll'));
	},
	'the Test Lab hint survives where the other two are correctly withheld': () => {
		// go test runs against a partial tree — verified in the packaged app at
		// stage 7 of merkle: 12 tests, 3 packages, no main.go. Preconditioning the
		// API and Data hints must not quietly take this one with them.
		const plan = buildPlan([
			file('backend/go.mod', 'module example.com/app\n\ngo 1.25.0\n'),
			file('backend/migrations/001_init.sql', 'CREATE TABLE nodes (id text primary key);\n'),
			file('backend/store/store.go', 'package store\n\nfunc List() {}\n'),
			file('backend/store/store_test.go', 'package store\n\nimport "testing"\n\nfunc TestList(t *testing.T) {}\n'),
		], { name: 'app', reference: '/ref' });
		const stage = plan.stages.find((s) => s.id === 'backend/store');
		assert.deepStrictEqual(stage.tools.map((t) => t.command), ['burrow.test.runAll'],
			'the module resolves and the tests are there, so the Test Lab is offered and nothing else is');
	},

	'foundations carry the one-off dependency installs': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		assert.deepStrictEqual(plan.stages[0].setup, ['cd backend && go mod download', 'cd web && npm install']);
	},
	'a package doc comment becomes the stage blurb': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		assert.match(plan.stages.find((s) => s.id === 'backend/models').blurb, /^Package models holds the shapes/);
	},
	'dependents run the graph backwards': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		assert.deepStrictEqual(dependents(plan, 'web/src/lib/format.ts'), ['web/src/ui/Badge.tsx']);
		assert.ok(dependents(plan, 'backend/models/node.go').includes('backend/store/store.go'));
	},
	'the counts describe the whole project': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		assert.strictEqual(plan.counts.steps, Object.keys(plan.steps).length);
		assert.strictEqual(plan.counts.stages, plan.stages.length);
		assert.ok(plan.counts.lines > 0);
	},
	'planning is deterministic': () => {
		const a = JSON.stringify(buildPlan(project(), { name: 'app', reference: '/ref' }));
		const b = JSON.stringify(buildPlan(project().reverse(), { name: 'app', reference: '/ref' }));
		assert.strictEqual(a, b);
	},
	// --- route annotations ----------------------------------------------------
	'routes reach the registration site, the handler and the middleware': () => {
		const index = routeIndex(flows(60), 'backend');
		assert.deepStrictEqual(index.get('backend/router.go'), ['GET /api/nodes', 'POST /api/nodes']);
		assert.deepStrictEqual(index.get('backend/store/store.go'), ['GET /api/nodes']);
		assert.deepStrictEqual(index.get('backend/middleware/auth.go'), ['POST /api/nodes']);
	},
	'a degraded scan annotates nothing at all, not a little': () => {
		// The stale-binary case: flowscan still succeeds and still emits flows,
		// it just traces six of them. Six explained routes read as though the
		// other two hundred serve nothing.
		assert.strictEqual(routeIndex(flows(6), 'backend'), undefined);
		assert.strictEqual(routeIndex(undefined, 'backend'), undefined);
		assert.strictEqual(routeIndex({ coverage: { traced: 200 }, flows: [] }, 'backend'), undefined);
	},
	'annotations name three routes and count the rest': () => {
		const many = { coverage: { traced: 99 }, flows: [] };
		for (let i = 0; i < 7; i++) {
			many.flows.push({ method: 'GET', path: `/api/r${i}`, file: 'router.go', nodes: [{ file: 'store/store.go' }] });
		}
		const plan = buildPlan(project(), { name: 'app', reference: '/ref', routes: routeIndex(many, 'backend') });
		const step = plan.steps['backend/store/store.go'];
		assert.strictEqual(step.routes.length, 3);
		assert.strictEqual(step.routeCount, 7);
	},
	'annotation changes no ordering and no check': () => {
		const bare = buildPlan(project(), { name: 'app', reference: '/ref' });
		const rich = buildPlan(project(), { name: 'app', reference: '/ref', routes: routeIndex(flows(60), 'backend') });
		assert.deepStrictEqual(rich.stages.flatMap((s) => s.steps), bare.stages.flatMap((s) => s.steps));
		for (const id of Object.keys(bare.steps)) {
			assert.deepStrictEqual(rich.steps[id].checks, bare.steps[id].checks);
		}
		assert.strictEqual(bare.steps['backend/router.go'].routes, undefined);
		assert.deepStrictEqual(rich.steps['backend/router.go'].routes, ['GET /api/nodes', 'POST /api/nodes']);
	},

	// --- the invariant --------------------------------------------------------
	// This is the assertion the whole feature rests on, and it is checked against
	// the EMITTED plan, not against topoSort: an ordering policy can be wrong in
	// ways the sort cannot see.
	'the emitted plan is a valid topological order': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		const real = orderViolations(plan).filter((v) => !v.cyclic);
		assert.deepStrictEqual(real, [], real.map((v) => `${v.step} @${v.at} needs ${v.dep} @${v.depAt}`).join('\n'));
	},
	'the invariant catches a step moved ahead of what it imports': () => {
		const plan = buildPlan(project(), { name: 'app', reference: '/ref' });
		// Swap the two web stages so Badge.tsx precedes the module it imports.
		const stages = plan.stages.slice();
		const lib = stages.findIndex((s) => s.id === 'web/src/lib');
		const ui = stages.findIndex((s) => s.id === 'web/src/ui');
		[stages[lib], stages[ui]] = [stages[ui], stages[lib]];
		const broken = orderViolations({ ...plan, stages }).filter((v) => !v.cyclic);
		assert.ok(broken.length, 'a deliberately mis-ordered plan must be reported');
		assert.ok(broken.some((v) => v.step === 'web/src/ui/Badge.tsx' && v.dep === 'web/src/lib/format.ts'));
	},
	'a genuine import cycle is reported as cyclic, not as a defect': () => {
		const cyclic = [
			file('web/package.json', '{"name":"web"}'),
			file('web/src/a/one.ts', "import { two } from '../b/two';\nexport const one = two;\n"),
			file('web/src/b/two.ts', "import { one } from '../a/one';\nexport const two = one;\n"),
		];
		const plan = buildPlan(cyclic, { name: 'web', reference: '/ref' });
		const all = orderViolations(plan);
		assert.ok(all.length, 'the cycle does produce an out-of-order pair');
		assert.deepStrictEqual(all.filter((v) => !v.cyclic), [], 'but none of it is a defect');
	},

	'an empty project plans nothing rather than crashing': () => {
		const plan = buildPlan([], { name: 'nothing', reference: '/ref' });
		assert.deepStrictEqual([plan.stages.length, plan.counts.steps], [0, 0]);
	},

	// --- WO-79's three, all pure functions over the emitted plan ---------------
	// Each of these was a defect the 413/23 invariant could not see, because that
	// one asks "is the ORDER valid" and these ask "is the SURFACE honest".

	// 1 — no step claims to be a leaf while naming a dependency. `whyNow`'s
	//     "nothing in this project" branches are only reachable with no deps and
	//     no depStages, so the honest form of the assertion is about EXTRACTION:
	//     a step with no edges must not name another step in its own text.
	//     Re-derived here on purpose — a test that reuses the extractor it is
	//     checking cannot catch an extractor that never looks.
	'no step with no dependencies names another step in its own text': () => {
		const plan = buildPlan(configs(), { name: 'web', reference: '/ref' });
		const ids = new Set(Object.keys(plan.steps));
		const claiming = [];
		for (const step of Object.values(plan.steps)) {
			if (step.deps.length || step.depStages.length) {
				continue;
			}
			const text = configs().find((f) => f.path === step.id)?.text ?? '';
			for (const m of text.matchAll(/['"](\.[^'"]+)['"]/g)) {
				const target = resolveRel(step.id, m[1]);
				if (ids.has(target)) {
					claiming.push(`${step.id} names ${target} and says it is a leaf`);
				}
			}
		}
		assert.deepStrictEqual(claiming, [], claiming.join('\n'));
		// And the edges that make it non-trivial are the ones that were invisible.
		assert.deepStrictEqual(plan.steps['web/.vite.mockport.config.ts'].deps, ['web/vite.config.ts']);
		assert.deepStrictEqual(plan.steps['web/tsconfig.json'].deps, ['web/tsconfig.app.json']);
		assert.deepStrictEqual(plan.steps['web/package-lock.json'].deps, ['web/package.json']);
	},

	// 2 — a generate step's command succeeding on nothing is not a pass. The
	//     model's half of it: the precondition must be attached and must name an
	//     input the command actually reads.
	'a generate step carries the precondition its command reads': () => {
		const plan = buildPlan(configs(), { name: 'web', reference: '/ref' });
		const lock = plan.steps['web/package-lock.json'].checks.find((c) => c.kind === 'shell');
		assert.deepStrictEqual([lock.needs.dir, lock.needs.match], ['web', 'package.json']);
		const mod = buildPlan(project(), { name: 'app', reference: '/ref' }).steps['backend/go.mod'].checks.find((c) => c.kind === 'shell');
		assert.deepStrictEqual([mod.needs.dir, mod.needs.match], ['backend', '.go']);
		for (const step of Object.values(plan.steps)) {
			if (step.mode === 'generate') {
				assert.ok(step.checks.some((c) => c.kind === 'shell' && c.needs), `${step.id} can pass on an empty directory`);
			}
		}
	},

	// --- WO-80 -----------------------------------------------------------------

	// §0a. Foundations was sorted by KIND, which says nothing about two files of
	// the same kind that name each other — so alphabetical order decided, and got
	// both of merkle's pairs backwards. Reading an edge and not obeying it is the
	// worse half of a fix.
	'Foundations obeys the edges inside it, and keeps its kind order otherwise': () => {
		const plan = buildPlan(configs(), { name: 'web', reference: '/ref' });
		const steps = plan.stages[0].steps;
		const at = (id) => steps.indexOf(id);
		assert.ok(at('web/vite.config.ts') < at('web/.vite.mockport.config.ts'), `the imported config comes first:\n${steps.join('\n')}`);
		assert.ok(at('web/tsconfig.app.json') < at('web/tsconfig.json'), 'the referenced config comes first');
		assert.ok(at('web/package.json') < at('web/package-lock.json'), 'the manifest comes before its lockfile');
		// …and the kind order still holds where no edge overrules it: a module
		// root before a manifest, and the lockfile still beside its manifest
		// rather than pushed behind every unrelated config in the stage.
		assert.strictEqual(steps[0], 'web/package.json');
		assert.strictEqual(steps[1], 'web/package-lock.json');
		// Nothing in the emitted stage may be out of order at all.
		const violations = orderViolations(plan).filter((v) => !v.cyclic && plan.steps[v.step].stage === '@foundations');
		assert.deepStrictEqual(violations, [], violations.map((v) => `${v.step} needs ${v.dep}`).join('\n'));
	},

	'a cycle inside Foundations does not deadlock the sort': () => {
		const plan = buildPlan([
			file('web/package.json', '{"name":"web"}'),
			file('web/a.config.ts', "import b from './b.config.ts';\nexport default b;\n"),
			file('web/b.config.ts', "import a from './a.config.ts';\nexport default a;\n"),
		], { name: 'web', reference: '/ref' });
		assert.strictEqual(plan.stages[0].steps.length, 3, 'every file is still planned exactly once');
		assert.strictEqual(new Set(plan.stages[0].steps).size, 3);
	},

	// §4. A milestone is derived from what a stage contains, and one that lies is
	// worse than none — so it carries the same precondition the checks do.
	'a stage earns the milestone its own files support': () => {
		const plan = buildPlan(configs(), { name: 'web', reference: '/ref' });
		const db = plan.stages.find((s) => s.milestone?.label === 'Start the database');
		assert.ok(db, 'a compose file declaring a database is a milestone');
		assert.match(db.milestone.command, /docker compose -f infra\/docker-compose\.yml up -d/);
		assert.deepStrictEqual([db.milestone.needs.dir, db.milestone.needs.match], ['infra', 'docker-compose.yml']);

		// A main package is a DIRECTORY: `func main()` and `ListenAndServe` are
		// routinely in different files of it, and asking the question per file
		// found neither half.
		const served = buildPlan([
			file('backend/go.mod', 'module example.com/app\n\ngo 1.25.0\n'),
			file('backend/main.go', 'package main\n\nfunc main() {\n\trun()\n}\n'),
			file('backend/app.go', 'package main\n\nimport "net/http"\n\nfunc run() {\n\t_ = http.ListenAndServe(":8080", nil)\n}\n'),
		], { name: 'app', reference: '/ref' });
		const server = served.stages.find((s) => s.milestone?.label === 'Run it');
		assert.ok(server, `a main package that listens is a milestone:\n${JSON.stringify(served.stages.map((s) => [s.id, s.milestone?.label]))}`);
		assert.strictEqual(server.milestone.command, 'go run .');
		assert.strictEqual(server.milestone.cwd, 'backend');

		// A stage with nothing runnable in it claims nothing.
		const quiet = buildPlan([
			file('web/package.json', '{"name":"web"}'),
			file('web/src/lib/format.ts', 'export const format = String;\n'),
		], { name: 'web', reference: '/ref' });
		assert.deepStrictEqual(quiet.stages.filter((s) => s.milestone).map((s) => s.id), []);
	},

	// §3. Authored prose about one project's own files, discovered rather than
	// shipped — and never at the cost of what the planner worked out itself.
	'an authored note joins the derived one rather than replacing it': () => {
		const notes = new Map([['infra/docker-compose.yml', 'This one also runs a message broker.\n']]);
		const plan = buildPlan(configs(), { name: 'web', reference: '/ref', notes });
		const note = plan.steps['infra/docker-compose.yml'].note;
		assert.match(note, /postgres:\/\/app:secret@localhost:5432\/app/, 'the derived half survives');
		assert.match(note, /message broker/, 'and the authored half is there');
		assert.ok(note.indexOf('postgres://') < note.indexOf('message broker'), 'the fact comes before the commentary');

		const bare = buildPlan(configs(), { name: 'web', reference: '/ref' });
		assert.doesNotMatch(bare.steps['infra/docker-compose.yml'].note, /message broker/);
	},

	// The compose file's own database, and the file that contradicts it.
	'a compose database is named, and a disagreeing URL beside it is too': () => {
		const plan = buildPlan(configs(), { name: 'web', reference: '/ref' });
		const note = plan.steps['infra/docker-compose.yml'].note;
		assert.match(note, /postgres:\/\/app:secret@localhost:5432\/app/);
		assert.match(note, /Makefile/);
		assert.match(note, /postgres:\/\/postgres:postgres@localhost:5432\/app/);
		// …and no warning at all when the project does not contradict itself.
		const quiet = buildPlan(configs().filter((f) => f.path !== 'Makefile'), { name: 'web', reference: '/ref' });
		assert.doesNotMatch(quiet.steps['infra/docker-compose.yml'].note, /⚠︎|disagree/);
	},
};

let failed = 0;
for (const [name, run] of Object.entries(cases)) {
	try {
		run();
		console.log(`  ✓ ${name}`);
	} catch (error) {
		failed++;
		console.error(`  ✗ ${name}\n    ${error.message}`);
	}
}
console.log(`${Object.keys(cases).length - failed}/${Object.keys(cases).length} passed`);
process.exit(failed ? 1 : 0);
