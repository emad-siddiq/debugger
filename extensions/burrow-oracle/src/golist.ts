/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// golist.ts — the pure `go list -json ./...` reader for the Codebase Oracle
// (architecture task 08, task 1: "package walk"). `go list -json` does NOT emit a
// JSON array: it streams pretty-printed objects back-to-back, one per package. This
// module turns that stream into typed records and groups them into an import-path
// tree for the walk webview. It imports nothing from 'vscode' so out/golist.js is a
// clean CommonJS module the standalone node tests require directly — the child_process
// invocation and the HTML rendering live one level up (extension.ts / walkView.ts).

/** The subset of a `go list -json` package record the Oracle reads. */
export interface GoPackage {
	/** Fully-qualified import path, e.g. `example.com/demo/ingest`. */
	readonly ImportPath: string;
	/** Package clause name, e.g. `ingest` (`main` for commands). */
	readonly Name?: string;
	/** Absolute directory on disk. */
	readonly Dir?: string;
	/** Leading package doc comment, first sentence-ish. */
	readonly Doc?: string;
	/** True for standard-library packages (`fmt`, `net/http`, …). */
	readonly Standard?: boolean;
	/** The owning module, when inside one. */
	readonly Module?: { readonly Path?: string; readonly Main?: boolean };
	/** Direct imports of this package. */
	readonly Imports?: readonly string[];
	/** Non-test Go source files. */
	readonly GoFiles?: readonly string[];
}

/** A node in the import-path tree — a segment that may or may not itself be a package. */
export interface PackageTreeNode {
	/** The single path segment this node contributes, e.g. `ingest`. */
	readonly name: string;
	/** The cumulative import path down to this node. */
	readonly path: string;
	/** The package sitting exactly at this path, if any (interior nodes may have none). */
	pkg?: GoPackage;
	/** Child segments, sorted by name. */
	readonly children: PackageTreeNode[];
}

/**
 * Split the concatenated-object stream `go list -json` writes into individual JSON
 * documents and parse each. Tracks brace depth OUTSIDE string literals (respecting
 * escapes) so braces inside `Doc`/paths never fool the splitter. Malformed fragments
 * are skipped rather than throwing — a partial walk is more useful than none.
 */
export function parseGoList(stdout: string): GoPackage[] {
	const packages: GoPackage[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < stdout.length; i++) {
		const ch = stdout[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === '{') {
			if (depth === 0) {
				start = i;
			}
			depth++;
		} else if (ch === '}') {
			depth--;
			if (depth === 0 && start >= 0) {
				const slice = stdout.slice(start, i + 1);
				const pkg = tryParse(slice);
				if (pkg && typeof pkg.ImportPath === 'string') {
					packages.push(pkg);
				}
				start = -1;
			}
		}
	}
	return packages;
}

/** JSON.parse one object slice, returning undefined on any parse error. */
function tryParse(slice: string): GoPackage | undefined {
	try {
		return JSON.parse(slice) as GoPackage;
	} catch {
		return undefined;
	}
}

/** Options controlling how {@link buildPackageTree} shapes the walk. */
export interface PackageTreeOptions {
	/**
	 * Drop standard-library and other-module dependencies, keeping only packages that
	 * belong to `moduleRoot` (the main module's import path). Defaults to true.
	 */
	readonly mainModuleOnly?: boolean;
	/** The main module's import path; inferred from the packages when omitted. */
	readonly moduleRoot?: string;
}

/**
 * Group packages into a tree by their import-path segments. When `mainModuleOnly` is
 * on (default) the tree is rooted at the main module and only local packages appear —
 * the third-party/stdlib deps `go list ./...` drags in are excluded, matching the
 * "walk of the project's own packages" the Oracle wants.
 */
export function buildPackageTree(pkgs: readonly GoPackage[], options: PackageTreeOptions = {}): PackageTreeNode {
	const moduleRoot = options.moduleRoot ?? inferModuleRoot(pkgs);
	const mainOnly = options.mainModuleOnly !== false;
	const root: PackageTreeNode = { name: moduleRoot || '(packages)', path: moduleRoot, children: [] };
	for (const pkg of pkgs) {
		if (mainOnly && !belongsToModule(pkg, moduleRoot)) {
			continue;
		}
		insert(root, pkg, moduleRoot);
	}
	sortTree(root);
	return root;
}

/** The main module's path if any package declares it, else the empty string. */
function inferModuleRoot(pkgs: readonly GoPackage[]): string {
	for (const pkg of pkgs) {
		if (pkg.Module?.Main && pkg.Module.Path) {
			return pkg.Module.Path;
		}
	}
	return '';
}

/** Whether a package sits under `moduleRoot` (or everything, when no root is known). */
function belongsToModule(pkg: GoPackage, moduleRoot: string): boolean {
	if (pkg.Standard) {
		return false;
	}
	if (!moduleRoot) {
		return true;
	}
	return pkg.ImportPath === moduleRoot || pkg.ImportPath.startsWith(moduleRoot + '/');
}

/** Splice one package into the tree under its relative segments below `moduleRoot`. */
function insert(root: PackageTreeNode, pkg: GoPackage, moduleRoot: string): void {
	const relative = moduleRoot && (pkg.ImportPath === moduleRoot || pkg.ImportPath.startsWith(moduleRoot + '/'))
		? pkg.ImportPath.slice(moduleRoot.length).replace(/^\//, '')
		: pkg.ImportPath;
	if (relative === '') {
		root.pkg = pkg;
		return;
	}
	const segments = relative.split('/');
	let node = root;
	let cumulative = moduleRoot;
	for (const segment of segments) {
		cumulative = cumulative ? `${cumulative}/${segment}` : segment;
		let child = node.children.find(c => c.name === segment);
		if (!child) {
			child = { name: segment, path: cumulative, children: [] };
			node.children.push(child);
		}
		node = child;
	}
	node.pkg = pkg;
}

/** Sort every node's children by name, depth-first, for stable rendering. */
function sortTree(node: PackageTreeNode): void {
	node.children.sort((a, b) => a.name.localeCompare(b.name));
	for (const child of node.children) {
		sortTree(child);
	}
}
