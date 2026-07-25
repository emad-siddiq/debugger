/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// controller.ts — the workbench glue for the Go test explorer (architecture
// task 11, Explorer + Runner core, first slice). It owns the native
// TestController: discovery scans the workspace for `*_test.go`, parses each
// file with the pure discovery core, and builds a module → package → file →
// test tree; the run profile spawns real `go test` (runner.ts) with the pure
// argv (command.ts) and streams `-json` events (events.ts) into live pass/fail
// state. All non-trivial logic lives in the vscode-free pure modules; this file
// only bridges them to the API.

import * as fs from 'fs';
import * as path from 'path';
import {
	CancellationToken,
	CancellationTokenSource,
	Disposable,
	Range,
	TestController,
	TestItem,
	TestMessage,
	TestRun,
	TestRunProfileKind,
	TestRunRequest,
	Uri,
	tests,
	workspace,
} from 'vscode';
import { buildRunArgs } from './command';
import { GoTestKind, parseTestFunctions } from './discovery';
import { GoTestEvent, TestResult, summarizeEvents } from './events';
import { LabRun, buildRun, buildSuite } from './labModel';
import { runGoTest } from './runner';

/** How to run a discovered function: its kind, name and package location. */
interface FuncMeta {
	readonly type: 'func';
	readonly kind: GoTestKind;
	readonly name: string;
	readonly packagePath: string;
	readonly cwd: string;
}

/** A package or file grouping node (structural only; not directly runnable by name). */
interface GroupMeta {
	readonly type: 'group';
}

type TestMeta = FuncMeta | GroupMeta;

/** A resolved leaf, pairing the TestItem with its run metadata. */
interface Leaf {
	readonly item: TestItem;
	readonly meta: FuncMeta;
}

const GLYPH: Record<GoTestKind, string> = { test: '', benchmark: 'bench', fuzz: 'fuzz', example: 'example' };

// Separator inside composite item ids (`<cwd><SEP><package><SEP>…`). Must never
// appear in a path or Go identifier, and must NOT be `\0` — vscode reserves NUL
// as its internal TestId delimiter and createTestItem throws on ids containing
// it (a literal NUL here broke discovery for every Go workspace). U+001F (unit
// separator) satisfies both.
const ID_SEP = '\u001f';

/**
 * The nearest ancestor of `dir` (inclusive) containing a `go.mod`, not above
 * `stopDir`. `go test ./pkg` must run from the MODULE root, which is not
 * necessarily the workspace folder — merkle keeps its Go module at
 * `<repo>/backend` while the workspace opens the repo root.
 */
function findModuleRoot(dir: string, stopDir: string): string | undefined {
	let current = dir;
	for (; ;) {
		if (fs.existsSync(path.join(current, 'go.mod'))) {
			return current;
		}
		if (current === stopDir || path.dirname(current) === current) {
			return undefined;
		}
		current = path.dirname(current);
	}
}

/**
 * The Burrow Go test explorer controller. Construct once on activation; it
 * registers a native TestController, a Run profile, and a refresh handler, and
 * runs an initial discovery pass. Dispose to tear everything down.
 */
export class GoTestController implements Disposable {
	private readonly controller: TestController;
	private readonly meta = new Map<string, TestMeta>();
	private readonly disposables: Disposable[] = [];

	/**
	 * @param goExecutableProvider Resolves the `go` binary and race flag at run
	 * time so config changes are honored without re-registering.
	 */
	constructor(
		private readonly settings: () => { goExecutable: string; race: boolean },
		/** Publishes every finished run to the Test Lab and the Tests section
		 *  (docs/plans/02 §3.4) — the controller stays the single place that
		 *  knows what `go test` said. */
		private readonly onRun: (run: LabRun) => void = () => undefined,
	) {
		this.controller = tests.createTestController('burrowGoTest', 'Go Tests (Burrow)');
		this.disposables.push(this.controller);
		this.controller.refreshHandler = () => this.discover();
		this.controller.createRunProfile('Go Test', TestRunProfileKind.Run, (request, token) => this.run(request, token), true);
		void this.discover();
	}

	/** The packages discovery found, for the Tests section's list before the
	 *  first run — a tree that shows verdicts it has not earned is a lie. */
	packages(): { packagePath: string; label: string }[] {
		const out: { packagePath: string; label: string }[] = [];
		this.controller.items.forEach((item) => {
			// A package item's id is `<cwd><SEP><packagePath>`; the meta map only
			// carries runnable leaves, so read the path off the id.
			const packagePath = item.id.split(ID_SEP)[1] ?? item.id;
			out.push({ packagePath, label: item.label });
		});
		return out;
	}

	/**
	 * Run everything, or only the named tests (the lab's Run / Re-run failed).
	 * Goes through the same profile handler the Test Explorer uses, so there is
	 * exactly one execution path and one set of results.
	 */
	async runByName(only?: readonly string[]): Promise<void> {
		const wanted = only?.length ? new Set(only) : undefined;
		let include: TestItem[] | undefined;
		if (wanted) {
			include = [];
			for (const leaf of this.gather(new TestRunRequest())) {
				if (wanted.has(leaf.meta.name)) {
					include.push(leaf.item);
				}
			}
			if (!include.length) {
				return;
			}
		}
		const source = new CancellationTokenSource();
		try {
			await this.run(new TestRunRequest(include), source.token);
		} finally {
			source.dispose();
		}
	}

	/** Tears down the controller and its listeners. */
	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	/**
	 * Scans the workspace for `*_test.go`, parses each file, and rebuilds the
	 * module → package → file → test tree from scratch.
	 */
	async discover(): Promise<void> {
		this.meta.clear();
		const files = await workspace.findFiles('**/*_test.go', '**/{node_modules,vendor,testdata}/**');
		const byPackage = new Map<string, Uri[]>();
		for (const uri of files) {
			const dir = path.dirname(uri.fsPath);
			const list = byPackage.get(dir) ?? [];
			list.push(uri);
			byPackage.set(dir, list);
		}

		const packageItems: TestItem[] = [];
		for (const dir of [...byPackage.keys()].sort()) {
			const folder = workspace.getWorkspaceFolder(Uri.file(dir));
			// Run from the enclosing Go MODULE root (nearest go.mod), not the
			// workspace folder — `go test ./pkg` fails with "cannot find main
			// module" anywhere else in a repo whose module is nested.
			const cwd = findModuleRoot(dir, folder ? folder.uri.fsPath : dir) ?? (folder ? folder.uri.fsPath : dir);
			const rel = path.relative(cwd, dir);
			const packagePath = rel === '' ? '.' : './' + rel.split(path.sep).join('/');
			const packageId = `${cwd}${ID_SEP}${packagePath}`;
			// Label stays workspace-relative so packages from different nested
			// modules (backend/…, emitters/…) remain distinguishable in the tree.
			const labelRel = folder ? path.relative(folder.uri.fsPath, dir) : rel;
			const packageItem = this.controller.createTestItem(packageId, labelRel === '' ? path.basename(cwd) : labelRel, Uri.file(dir));
			this.meta.set(packageId, { type: 'group' });

			for (const uri of byPackage.get(dir)!.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
				const bytes = await workspace.fs.readFile(uri);
				const funcs = parseTestFunctions(Buffer.from(bytes).toString('utf8'));
				if (funcs.length === 0) {
					continue;
				}
				const fileId = `${packageId}${ID_SEP}${uri.fsPath}`;
				const fileItem = this.controller.createTestItem(fileId, path.basename(uri.fsPath), uri);
				this.meta.set(fileId, { type: 'group' });
				for (const fn of funcs) {
					const funcId = `${fileId}${ID_SEP}${fn.name}`;
					const funcItem = this.controller.createTestItem(funcId, fn.name, uri);
					funcItem.range = new Range(fn.line - 1, 0, fn.line - 1, 0);
					if (GLYPH[fn.kind]) {
						funcItem.description = GLYPH[fn.kind];
					}
					this.meta.set(funcId, { type: 'func', kind: fn.kind, name: fn.name, packagePath, cwd });
					fileItem.children.add(funcItem);
				}
				packageItem.children.add(fileItem);
			}
			if (packageItem.children.size > 0) {
				packageItems.push(packageItem);
			}
		}
		this.controller.items.replace(packageItems);
	}

	/**
	 * Run profile handler: gathers the requested leaf tests, groups them by
	 * package (benchmarks separated from name-selected tests), and executes each
	 * group with real `go test`, streaming results into the run.
	 */
	private async run(request: TestRunRequest, token: CancellationToken): Promise<void> {
		const run = this.controller.createTestRun(request);
		const leaves = this.gather(request);
		const { goExecutable, race } = this.settings();
		// Results roll up per PACKAGE, not per group: a package whose tests and
		// benchmarks run as two groups is still one suite in the lab.
		const byPackage = new Map<string, { label: string; results: TestResult[] }>();
		let buildError = '';

		// Group by working directory + package + whether it is a benchmark bucket.
		const groups = new Map<string, Leaf[]>();
		for (const leaf of leaves) {
			const isBench = leaf.meta.kind === 'benchmark';
			const key = `${leaf.meta.cwd}${ID_SEP}${leaf.meta.packagePath}${ID_SEP}${isBench ? 'b' : 't'}`;
			(groups.get(key) ?? groups.set(key, []).get(key)!).push(leaf);
		}

		for (const group of groups.values()) {
			if (token.isCancellationRequested) {
				break;
			}
			const byName = new Map<string, TestItem>();
			for (const leaf of group) {
				byName.set(leaf.meta.name, leaf.item);
				run.enqueued(leaf.item);
				run.started(leaf.item);
			}
			const { cwd, packagePath, kind } = group[0].meta;
			const args = buildRunArgs({
				packagePath,
				kind: kind === 'benchmark' ? 'benchmark' : 'test',
				names: group.map(l => l.meta.name),
				race,
				count: 1,
			});
			run.appendOutput(`\u001b[2m$ ${goExecutable} ${args.join(' ')}\u001b[0m\r\n`);

			const outcome = await runGoTest(goExecutable, args, cwd, token, event => this.onEvent(run, byName, event));

			const summary = summarizeEvents(outcome.events);
			const bucket = byPackage.get(packagePath)
				?? byPackage.set(packagePath, { label: group[0].item.parent?.parent?.label ?? packagePath, results: [] }).get(packagePath)!;
			bucket.results.push(...summary.values());
			if (!summary.size && outcome.stderr.trim()) {
				buildError = outcome.stderr;
			}
			for (const leaf of group) {
				const result = summary.get(leaf.meta.name);
				if (result) {
					continue; // already reported live in onEvent
				}
				// No terminal event: a build/compile failure or cancellation.
				const detail = outcome.stderr.trim() || 'go test produced no result (build failure?)';
				run.errored(leaf.item, new TestMessage(detail));
			}
		}
		run.end();
		this.onRun(buildRun(
			[...byPackage.entries()].map(([packagePath, { label, results }]) => buildSuite(packagePath, label, results)),
			race,
			buildError || undefined,
		));
	}

	/**
	 * Reports a single streamed `-json` event onto the run: output is appended,
	 * and a terminal pass/fail/skip flips the matching top-level TestItem.
	 * Subtest names (`Parent/sub`) have no item of their own, so only their
	 * output is surfaced.
	 */
	private onEvent(run: TestRun, byName: Map<string, TestItem>, event: GoTestEvent): void {
		const item = event.Test ? byName.get(event.Test) : undefined;
		if (event.Action === 'output' && event.Output) {
			run.appendOutput(event.Output.replace(/\r?\n/g, '\r\n'), undefined, item);
			return;
		}
		if (!item) {
			return;
		}
		const durationMs = event.Elapsed !== undefined ? Math.round(event.Elapsed * 1000) : undefined;
		if (event.Action === 'pass') {
			run.passed(item, durationMs);
		} else if (event.Action === 'skip') {
			run.skipped(item);
		} else if (event.Action === 'fail') {
			run.failed(item, new TestMessage(`${event.Test} failed`), durationMs);
		}
	}

	/**
	 * Expands a run request into the flat list of runnable leaf functions,
	 * recursing through package/file grouping nodes. An undefined include runs
	 * every discovered test.
	 */
	private gather(request: TestRunRequest): Leaf[] {
		const roots: TestItem[] = [];
		if (request.include) {
			roots.push(...request.include);
		} else {
			this.controller.items.forEach(item => roots.push(item));
		}
		const excluded = new Set(request.exclude ?? []);
		const leaves: Leaf[] = [];
		const seen = new Set<string>();
		const visit = (item: TestItem): void => {
			if (excluded.has(item)) {
				return;
			}
			const meta = this.meta.get(item.id);
			if (meta?.type === 'func') {
				if (!seen.has(item.id)) {
					seen.add(item.id);
					leaves.push({ item, meta });
				}
				return;
			}
			item.children.forEach(visit);
		};
		for (const root of roots) {
			visit(root);
		}
		return leaves;
	}
}
