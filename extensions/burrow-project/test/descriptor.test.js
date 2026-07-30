/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// Detection, merging and serialization (WO-71 §1). descriptor.ts imports nothing
// from 'vscode' or 'fs' — it reads an injected `Tree` — so this can put shapes in
// front of it that nobody has on disk, which is the point: the bug being fixed is
// that detection only ever saw one repository.
// Run: `npm test` or `node test/descriptor.test.js`.

'use strict';

const assert = require('node:assert');
const {
	detect, merge, parse, serialize, capabilities, modulePath, postgresServiceName, postgresUrl,
	DESCRIPTOR_PATH,
} = require('../out/descriptor');

/** A fake tree from a flat { path: contents } map. */
const tree = (files) => ({
	exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
	read: (p) => files[p],
	dirs: (rel) => kids(files, rel, true),
	files: (rel) => kids(files, rel, false),
});

/** Immediate children of `rel` in a flat path map — directories or files. */
const kids = (files, rel, wantDirs) => {
	const prefix = rel === '' || rel === '.' ? '' : rel.replace(/\/$/, '') + '/';
	const names = new Set();
	for (const p of Object.keys(files)) {
		if (!p.startsWith(prefix)) { continue; }
		const rest = p.slice(prefix.length);
		if (!rest) { continue; }
		const isDir = rest.includes('/');
		if (isDir === wantDirs) { names.add(rest.split('/')[0]); }
	}
	return [...names];
};

const GO_MOD = 'module example.com/thing\n\ngo 1.25\n';
const live = (project) => capabilities(project).filter((c) => c.live).map((c) => c.id).sort();
const stateOf = (project, id) => capabilities(project).find((c) => c.id === id);

const cases = {
	// ── detection first: a repo that has never seen Burrow must work ──────────
	'a bare go.mod at the root is a Go project with nothing written': () => {
		const p = detect(tree({ 'go.mod': GO_MOD }), 'thing');
		assert.strictEqual(p.stacks.length, 1);
		assert.strictEqual(p.stacks[0].root, '.');
		assert.strictEqual(p.stacks[0].module, 'example.com/thing');
		assert.strictEqual(p.stacks[0].build, 'go build ./...');
		assert.deepStrictEqual(p.declared, [], 'nothing was declared — it was all inferred');
	},
	'a go.mod under backend/ is found — merkle\'s shape, not hard-coded': () => {
		const p = detect(tree({ 'backend/go.mod': GO_MOD }), 'merkle');
		assert.strictEqual(p.stacks[0].root, 'backend');
	},
	'server/, api/, cmd/, src/ and service/ are all searched': () => {
		for (const dir of ['server', 'api', 'cmd', 'src', 'service']) {
			const p = detect(tree({ [`${dir}/go.mod`]: GO_MOD }), 'x');
			assert.strictEqual(p.stacks[0]?.root, dir, `${dir}/go.mod was not found`);
		}
	},
	'the root wins over a subdirectory': () => {
		const p = detect(tree({ 'go.mod': GO_MOD, 'backend/go.mod': GO_MOD }), 'x');
		assert.strictEqual(p.stacks[0].root, '.');
	},
	'a folder with no go.mod is a project with no stacks, not an error': () => {
		const p = detect(tree({ 'README.md': '# hi' }), 'docs');
		assert.deepStrictEqual(p.stacks, []);
		assert.deepStrictEqual(live(p), [], 'nothing should light up');
		// and it must say WHY, because a rail that goes quiet silently is the bug
		const why = capabilities(p).find((c) => c.id === 'go').why;
		assert.match(why, /no go\.mod/);
	},
	'a go.mod with no module line still counts as a Go project': () => {
		const p = detect(tree({ 'go.mod': 'go 1.25\n' }), 'x');
		assert.strictEqual(p.stacks.length, 1);
		assert.strictEqual(p.stacks[0].module, undefined);
	},

	// ── services ─────────────────────────────────────────────────────────────
	// WO-72 §0.2: `live` means MEASURED. flowscan seeds from NewRouter() CALL sites,
	// so whether it finds anything depends on the code and not the layout — WO-71
	// reported `flow: live` for a router LIBRARY on inference alone.
	'flow is unknown, never live, because detection cannot measure it': () => {
		const p = detect(tree({ 'go.mod': GO_MOD }), 'x');
		const flow = stateOf(p, 'flow');
		assert.strictEqual(flow.state, 'unknown');
		assert.strictEqual(flow.live, false, 'unknown must not read as live to a boolean caller');
		assert.match(flow.why, /run "API Flows: Refresh Flows"/, 'unknown has to say how to find out');
	},
	'flow is inert, not unknown, with no Go stack at all': () => {
		assert.strictEqual(stateOf(detect(tree({}), 'x'), 'flow').state, 'inert');
	},
	'go and test are live because the tree measures them': () => {
		const p = detect(tree({ 'go.mod': GO_MOD }), 'x');
		assert.strictEqual(stateOf(p, 'go').state, 'live');
		assert.strictEqual(stateOf(p, 'test').state, 'live');
	},
	'every capability has one of exactly three states': () => {
		for (const c of capabilities(detect(tree({ 'go.mod': GO_MOD }), 'x'))) {
			assert.ok(['live', 'inert', 'unknown'].includes(c.state), `${c.id} has state ${c.state}`);
			assert.ok(c.why.length > 0, `${c.id} gives no reason`);
		}
	},

	'a compose Postgres lights the Data rail': () => {
		const p = detect(tree({
			'go.mod': GO_MOD,
			'compose.yaml': 'services:\n  db:\n    image: postgres:17-alpine\n',
		}), 'x');
		assert.strictEqual(p.services[0].kind, 'postgres');
		assert.strictEqual(p.services[0].composeService, 'db');
		assert.deepStrictEqual(live(p), ['data', 'go', 'test'], 'flow is unknown, not live');
	},
	'a DATABASE_URL in .env lights it too, with no compose at all': () => {
		const p = detect(tree({ 'go.mod': GO_MOD, '.env': 'DATABASE_URL=postgres://u:p@localhost:5432/d\n' }), 'x');
		assert.strictEqual(p.services[0].urlEnv, 'DATABASE_URL');
		assert.ok(live(p).includes('data'));
	},
	'the env var may be called anything': () => {
		const p = detect(tree({ 'go.mod': GO_MOD, '.env': 'PG_DSN="postgresql://u@h/db"\n' }), 'x');
		assert.strictEqual(p.services[0].urlEnv, 'PG_DSN');
	},
	'a compose with no Postgres lights nothing': () => {
		const p = detect(tree({ 'go.mod': GO_MOD, 'compose.yaml': 'services:\n  cache:\n    image: redis:7\n' }), 'x');
		assert.deepStrictEqual(p.services, []);
		assert.ok(!live(p).includes('data'));
	},
	'all four compose filenames are recognised': () => {
		for (const f of ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']) {
			const p = detect(tree({ 'go.mod': GO_MOD, [f]: 'services:\n  db:\n    image: postgres:17\n' }), 'x');
			assert.strictEqual(p.services[0]?.composeFile, f, `${f} was not recognised`);
		}
	},

	// ── compose and env are not always at the root ───────────────────────────
	//
	// §4 caught this: measured against three repositories, the Data rail read
	// INERT on merkle, whose compose is `infra/docker-compose.yml` and whose DSN
	// lives under `infra/test/env/`. A root-only search was the same single-target
	// assumption this work order exists to remove, just inverted.
	'a compose under infra/ is found — merkle\'s real shape': () => {
		const p = detect(tree({
			'backend/go.mod': GO_MOD,
			'infra/docker-compose.yml': 'services:\n  nodewatch-db:\n    image: postgres:16\n',
		}), 'merkle');
		assert.strictEqual(p.services[0].composeFile, 'infra/docker-compose.yml');
		assert.strictEqual(p.services[0].composeService, 'nodewatch-db');
	},
	'deploy/, docker/, .docker/ and build/ are searched too': () => {
		for (const dir of ['deploy', 'docker', '.docker', 'build']) {
			const p = detect(tree({ 'go.mod': GO_MOD, [`${dir}/compose.yaml`]: 'services:\n  db:\n    image: postgres:17\n' }), 'x');
			assert.strictEqual(p.services[0]?.composeFile, `${dir}/compose.yaml`, `${dir}/ was not searched`);
		}
	},
	'the first compose WITH a Postgres wins, not the first compose': () => {
		const p = detect(tree({
			'go.mod': GO_MOD,
			'compose.yaml': 'services:\n  web:\n    image: nginx\n',
			'infra/docker-compose.yml': 'services:\n  db:\n    image: postgres:17\n',
		}), 'x');
		assert.strictEqual(p.services[0].composeFile, 'infra/docker-compose.yml');
	},
	'grouped env files under infra/test/env are read': () => {
		const p = detect(tree({
			'backend/go.mod': GO_MOD,
			'infra/test/env/backend.no-auth.env': 'DATABASE_URL=postgres://u:p@localhost:5432/nodewatch\n',
		}), 'merkle');
		assert.strictEqual(p.services[0].urlEnv, 'DATABASE_URL');
	},
	'a DSN in .vscode/launch.json counts — it is where VS Code users put env': () => {
		const p = detect(tree({
			'go.mod': GO_MOD,
			'.vscode/launch.json': '{\n\t// comments and trailing commas are normal here\n\t"configurations": [{\n\t\t"env": { "DATABASE_URL": "postgres://u@h:5432/d" },\n\t}]\n}',
		}), 'x');
		assert.strictEqual(p.services[0].urlEnv, 'DATABASE_URL', 'a launch.json is not valid JSON and must still be read');
	},
	'the search stays shallow — a fixture deep in test data is not your database': () => {
		const p = detect(tree({
			'go.mod': GO_MOD,
			'internal/testdata/fixtures/compose.yaml': 'services:\n  db:\n    image: postgres:17\n',
		}), 'x');
		assert.deepStrictEqual(p.services, [],
			'a compose file in someone\'s test fixtures must not be reported as the project\'s database');
	},

	// ── the compose scanner's edges ──────────────────────────────────────────
	'the service name is the one with the image, not the first one listed': () => {
		const name = postgresServiceName('services:\n  api:\n    image: golang:1.25\n  store:\n    image: postgres:17\n');
		assert.strictEqual(name, 'store');
	},
	'a top-level key after services: does not swallow the scan': () => {
		const name = postgresServiceName('services:\n  db:\n    image: postgres:17\nvolumes:\n  data:\n');
		assert.strictEqual(name, 'db');
	},
	'commented-out lines are skipped': () => {
		const name = postgresServiceName('services:\n  db:\n    # image: postgres:17\n    image: redis:7\n');
		assert.strictEqual(name, undefined);
	},
	'postgis and timescale count as Postgres': () => {
		assert.strictEqual(postgresServiceName('services:\n  gis:\n    image: postgis/postgis:16-3.4\n'), 'gis');
		assert.strictEqual(postgresServiceName('services:\n  ts:\n    image: timescale/timescaledb:latest-pg16\n'), 'ts');
	},
	'a compose with no services block yields nothing rather than throwing': () => {
		assert.strictEqual(postgresServiceName('version: "3"\n'), undefined);
		assert.strictEqual(postgresServiceName(''), undefined);
	},
	'env parsing ignores comments and blank lines and strips quotes': () => {
		assert.deepStrictEqual(postgresUrl('# DATABASE_URL=postgres://no\n\nDB="postgres://yes@h/d"\n'),
			{ key: 'DB', value: 'postgres://yes@h/d' });
	},
	'a non-postgres URL is not a Postgres': () => {
		assert.strictEqual(postgresUrl('REDIS_URL=redis://localhost:6379\n'), undefined);
	},
	'modulePath reads the module line and nothing else': () => {
		assert.strictEqual(modulePath('module a/b\ngo 1.25\n'), 'a/b');
		assert.strictEqual(modulePath('go 1.25\n'), undefined);
		assert.strictEqual(modulePath(undefined), undefined);
	},

	// ── the descriptor overrides, and says that it did ───────────────────────
	'a descriptor overrides detection and names what it declared': () => {
		const detected = detect(tree({ 'go.mod': GO_MOD }), 'thing');
		const merged = merge(detected, { name: 'renamed' });
		assert.strictEqual(merged.name, 'renamed');
		assert.deepStrictEqual(merged.declared, ['name']);
	},
	'a descriptor field left out keeps the detected value': () => {
		const detected = detect(tree({ 'backend/go.mod': GO_MOD }), 'thing');
		const merged = merge(detected, { stacks: [{ run: 'make run' }] });
		assert.strictEqual(merged.stacks[0].run, 'make run', 'the override applies');
		assert.strictEqual(merged.stacks[0].root, 'backend', 'and does not erase what was detected');
		assert.strictEqual(merged.stacks[0].module, 'example.com/thing');
	},
	'a descriptor can declare a stack detection missed entirely': () => {
		const detected = detect(tree({ 'README.md': '' }), 'weird');
		const merged = merge(detected, { stacks: [{ id: 'go', root: 'src/go', run: 'go run ./cmd/api' }] });
		assert.strictEqual(merged.stacks.length, 1);
		assert.strictEqual(merged.stacks[0].root, 'src/go');
		assert.ok(live(merged).includes('go'), 'and the rails come alive');
	},
	'no descriptor at all changes nothing': () => {
		const detected = detect(tree({ 'go.mod': GO_MOD }), 'thing');
		assert.deepStrictEqual(merge(detected, undefined), detected);
	},
	'a broken descriptor is ignored, not fatal': () => {
		assert.strictEqual(parse('{ not json'), undefined);
		assert.strictEqual(parse(''), undefined);
		assert.strictEqual(parse('null'), undefined);
		assert.strictEqual(parse('[1,2]') instanceof Object, true);   // tolerated; merge ignores unknown shape
	},

	// ── the descriptor is not allowed to hold a secret ───────────────────────
	'serialize records the env var NAME and never the connection string': () => {
		const p = detect(tree({
			'go.mod': GO_MOD,
			'.env': 'DATABASE_URL=postgres://user:sup3rs3cret@localhost:5432/db\n',
		}), 'x');
		assert.strictEqual(p.services[0].url, 'postgres://user:sup3rs3cret@localhost:5432/db',
			'detection may hold it in memory');
		const text = serialize(p);
		assert.ok(!text.includes('sup3rs3cret'), 'the descriptor must not contain the password');
		assert.ok(!text.includes('postgres://'), 'nor the DSN');
		assert.match(text, /"urlEnv": "DATABASE_URL"/);
	},
	'serialize round-trips through parse': () => {
		const p = detect(tree({ 'go.mod': GO_MOD, 'compose.yaml': 'services:\n  db:\n    image: postgres:17\n' }), 'x');
		const back = parse(serialize(p));
		assert.strictEqual(back.version, 1);
		assert.strictEqual(back.stacks[0].root, '.');
		assert.strictEqual(back.services[0].composeService, 'db');
	},
	'the descriptor lives under .burrow/ so it can be gitignored wholesale': () => {
		assert.strictEqual(DESCRIPTOR_PATH, '.burrow/project.json');
	},
};

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
	try {
		fn();
		console.log('  ok  ' + name);
	} catch (err) {
		failed++;
		console.error('FAIL  ' + name + '\n      ' + (err && err.message));
	}
}
if (failed) {
	console.error('\n' + failed + ' descriptor test(s) failed');
	process.exit(1);
}
console.log('\nAll ' + Object.keys(cases).length + ' descriptor tests passed');
