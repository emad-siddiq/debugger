/*---------------------------------------------------------------------------------------------
 *  Burrow: neighborhood packs — one structural hop from the primary artifact
 *  (plan chat/03). Every lookup is individually capped and silently skippable
 *  (invariant 8); paths only, never file contents.
 *
 *  StructuralIndex is the seam: FlowsAndScanIndex answers from the live rails
 *  (component index + flows.json + one bounded ripgrep); the research plan's
 *  stage-2 oracle.db replaces it later without touching call sites.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { lastComponentRead, ViewContext } from './contextResolver';
import { activeExports } from './focusTracker';
import { ContextPack, finalizePack, Neighbor } from './packModel';

export interface StructuralIndex {
	componentNeighbors(file: string): Promise<Neighbor[]>;
	routeNeighbors(routeId: string): Promise<Neighbor[]>;
	tableNeighbors(table: string): Promise<Neighbor[]>;
}

interface FdApiLite {
	readonly componentIndex?: () => { abs: string; name: string }[];
}
interface FlowLiteNode { kind: string; label: string; file?: string; line?: number; sql?: string }
interface FlowLiteFull { method: string; path: string; file: string; line: number; nodes?: FlowLiteNode[] | null; tables?: string[] | null }
interface FlowsDocLite { tables?: Record<string, string>; flows?: FlowLiteFull[] | null }
interface FlowApiLite {
	readonly doc?: () => FlowsDocLite | undefined;
	readonly backendDir?: () => string | undefined;
}

const JSX_ID_RE = /<([A-Z][A-Za-z0-9]*)[\s/>]/g;

export async function buildContextPack(ctx: ViewContext, budgetChars = 2400, coveredPaths: string[] = []): Promise<ContextPack> {
	const index = new FlowsAndScanIndex();
	const primary = ctx.primaries
		.filter(p => p.role !== 'stylesheet')
		.map(p => rel(p.uri.fsPath));
	let neighbors: Neighbor[] = [];
	if (ctx.seed.kind === 'component') {
		// Stylesheets were resolved in phase 2; copy them in so the pack is self-contained.
		neighbors = ctx.primaries
			.filter(p => p.role === 'stylesheet')
			.map(p => ({ relation: 'styles' as const, path: rel(p.uri.fsPath), detail: p.note }));
		neighbors.push(...await index.componentNeighbors(ctx.seed.id));
	} else if (ctx.seed.kind === 'route') {
		neighbors = await index.routeNeighbors(ctx.seed.id);
	}
	// seed kinds 'file' and 'symbol' have no one-hop sources yet ('callers' was
	// dropped: anchoring a reference query off flowscan line info is imprecise
	// enough to break the pack's high-precision contract — see the phase report).
	return finalizePack(ctx.surface, primary, neighbors, budgetChars, coveredPaths);
}

export class FlowsAndScanIndex implements StructuralIndex {

	async componentNeighbors(file: string): Promise<Neighbor[]> {
		const out: Neighbor[] = [];
		const base = path.basename(file).replace(/\.[^.]+$/, '');
		const index = activeExports<FdApiLite>('burrow.burrow-frontend-debugger')?.componentIndex?.() ?? [];

		// used-by — the index has names and files but NO import edges, so one
		// bounded ripgrep finds the importers (plan chat/03 step 1.2 fallback).
		for (const importer of await ripgrepImporters(base, file)) {
			out.push({ relation: 'used-by', path: rel(importer) });
		}

		// renders — JSX identifiers in the already-read source, kept only when
		// the component index knows them (zero non-existent paths).
		const text = lastComponentRead?.path === file ? lastComponentRead.text : undefined;
		if (text && index.length) {
			const byName = new Map(index.map(h => [h.name, h.abs]));
			const seen = new Set<string>();
			for (const m of text.matchAll(JSX_ID_RE)) {
				if (seen.size >= 6) { break; }
				const hit = byName.get(m[1]);
				if (hit && hit !== file && !seen.has(hit)) {
					seen.add(hit);
					out.push({ relation: 'renders', path: rel(hit) });
				}
			}
		}

		// props — a root contract.json naming <Base>Props. Existence check only.
		// (merkle keeps its contract under .claude/memory/, which Rule A bars from
		// prompts, so only a root-level contract.json qualifies.)
		const root = workspaceRoot();
		if (root) {
			const contract = path.join(root, 'contract.json');
			try {
				if (fs.existsSync(contract) && fs.readFileSync(contract, 'utf8').includes(`"${base}Props"`)) {
					out.push({ relation: 'props', path: 'contract.json', detail: `${base}Props` });
				}
			} catch { /* absent or unreadable: skipped */ }
		}
		return out;
	}

	async routeNeighbors(routeId: string): Promise<Neighbor[]> {
		const api = activeExports<FlowApiLite>('burrow.burrow-flow');
		const doc = api?.doc?.();
		const backend = api?.backendDir?.();
		if (!doc || !backend) { return []; }
		const flow = (doc.flows ?? []).find(f => `${f.method} ${f.path}` === routeId);
		if (!flow) { return []; }
		const relOf = (f: string | undefined): string => f ? rel(path.join(backend, f)) : '';
		const out: Neighbor[] = [{ relation: 'handler', path: relOf(flow.file), line: flow.line }];

		let sql = 0;
		for (const node of flow.nodes ?? []) {
			if (node.sql && sql++ < 4) {
				out.push({ relation: 'sql', path: relOf(node.file ?? flow.file), line: node.line, detail: node.sql.slice(0, 40) });
			}
		}

		const root = workspaceRoot();
		for (const table of (flow.tables ?? []).slice(0, 4)) {
			// doc.tables maps table → the migration file that creates it.
			const migration = doc.tables?.[table];
			const migrationRel = migration && root ? relIfExists(root, backend, migration) : '';
			out.push({ relation: 'table', path: migrationRel, detail: table });
		}

		// routes sharing a table — reverse map built once per doc (cached).
		const reverse = reverseRoutesOf(doc);
		const seen = new Set<string>();
		for (const table of flow.tables ?? []) {
			for (const other of reverse.get(table) ?? []) {
				const id = `${other.method} ${other.path}`;
				if (id === routeId || seen.has(id)) { continue; }
				seen.add(id);
				if (seen.size > 4) { break; }
				out.push({ relation: 'routes', path: relOf(other.file), line: other.line, detail: id });
			}
		}
		return out;
	}

	async tableNeighbors(table: string): Promise<Neighbor[]> {
		const api = activeExports<FlowApiLite>('burrow.burrow-flow');
		const doc = api?.doc?.();
		const backend = api?.backendDir?.();
		if (!doc || !backend) { return []; }
		return [...(reverseRoutesOf(doc).get(table) ?? [])].map(f => ({
			relation: 'routes' as const,
			path: rel(path.join(backend, f.file)),
			line: f.line,
			detail: `${f.method} ${f.path}`,
		}));
	}
}

// --- helpers -----------------------------------------------------------------------------------

const reverseCache = new WeakMap<object, Map<string, FlowLiteFull[]>>();

function reverseRoutesOf(doc: FlowsDocLite): Map<string, FlowLiteFull[]> {
	let map = reverseCache.get(doc);
	if (!map) {
		map = new Map();
		for (const flow of doc.flows ?? []) {
			for (const table of flow.tables ?? []) {
				const list = map.get(table) ?? [];
				list.push(flow);
				map.set(table, list);
			}
		}
		reverseCache.set(doc, map);
	}
	return map;
}

/** One bounded ripgrep for files importing <Base>: 500ms, ≤8 files, self excluded. */
function ripgrepImporters(base: string, selfFile: string): Promise<string[]> {
	const root = workspaceRoot();
	if (!root) { return Promise.resolve([]); }
	const rgBin = [
		path.join(vscode.env.appRoot, 'node_modules', '@vscode/ripgrep', 'bin', 'rg'),
		'rg',
	].find(p => p === 'rg' || fs.existsSync(p));
	if (!rgBin) { return Promise.resolve([]); }
	const pattern = `from ['"][^'"]*/${base}['"]`;
	return new Promise(resolve => {
		const child = execFile(
			rgBin,
			['-l', '--max-count', '1', '-g', '*.tsx', '-g', '*.jsx', pattern, root],
			{ timeout: 500, maxBuffer: 64 * 1024 },
			(_err, stdout) => {
				const files = (stdout || '').split('\n').filter(Boolean).filter(f => f !== selfFile).slice(0, 8);
				resolve(files);
			},
		);
		child.on('error', () => resolve([]));
	});
}

function workspaceRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function rel(abs: string): string {
	return vscode.workspace.asRelativePath(abs).replace(/\\/g, '/');
}

/** Migration paths in flows.json may be backend- or repo-relative; return the
 *  workspace-relative form of whichever exists, else '' (name-only signal). */
function relIfExists(root: string, backend: string, p: string): string {
	for (const candidate of [path.join(backend, p), path.join(root, p)]) {
		try {
			if (fs.existsSync(candidate)) { return rel(candidate); }
		} catch { /* unreadable: try next */ }
	}
	return '';
}
