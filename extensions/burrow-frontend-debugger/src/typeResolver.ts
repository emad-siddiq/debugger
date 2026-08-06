/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { declarationOf, ResolvedType, TypeResolver, stripComments } from './propsSkeleton';

// One-hop import resolution for the props-schema parser: given the component
// source, map each imported type NAME to its declaration in the imported file
// so `panel: PanelType` / `node: Node` yield a real nested skeleton instead of
// `{}`. Supports relative specifiers plus the target's `@/*` → src/* and
// `@shared/*` → ../shared/* aliases (merkle's tsconfig paths); node_modules
// types are out of scope by design.

const EXT_CANDIDATES = ['', '.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx'];

/** Build a TypeResolver for a component at `componentAbs` inside `targetDir`
 *  (the frontend root whose src/ anchors `@/`). */
export function makeTypeResolver(componentAbs: string, targetDir: string): TypeResolver {
	const dir = path.dirname(componentAbs);
	const srcRoot = path.join(targetDir, 'src');
	const sharedRoot = path.resolve(targetDir, '..', 'shared');
	// Local name → where it is declared AND under what name there. The two differ
	// for an aliased import: `import type { Panel as PanelType } from '@/types'`
	// is used as `PanelType`, but `@/types` declares it as `Panel`, so searching
	// that file for `PanelType` finds nothing and the member falls through to the
	// give-up value `{}`. merkle's Panel, Dashboard, FullscreenPanel and
	// QuickExpandOverlay all failed this way, and all four are on the render
	// sweep's crash list.
	let imports: Map<string, { file: string; exported: string }> | undefined;
	const bodies = new Map<string, { body?: string; alias?: string } | undefined>();

	const resolveSpec = (spec: string): string | undefined => {
		let base: string | undefined;
		if (spec.startsWith('.')) {
			base = path.resolve(dir, spec);
		} else if (spec.startsWith('@/')) {
			base = path.join(srcRoot, spec.slice(2));
		} else if (spec.startsWith('@shared/')) {
			base = path.join(sharedRoot, spec.slice(8));
		} else {
			return undefined; // bare specifier (node_modules) — out of scope
		}
		for (const ext of EXT_CANDIDATES) {
			const candidate = base + ext;
			if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
				return candidate;
			}
		}
		return undefined;
	};

	const indexImports = (): Map<string, { file: string; exported: string }> => {
		const out = new Map<string, { file: string; exported: string }>();
		let source: string;
		try {
			source = fs.readFileSync(componentAbs, 'utf8');
		} catch {
			return out;
		}
		for (const m of source.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g)) {
			const file = resolveSpec(m[2]);
			if (!file) {
				continue;
			}
			for (const part of m[1].split(',')) {
				// `A`, `type A`, `A as B` — the LOCAL name is what the props type uses.
				const nm = /(?:type\s+)?(\w+)(?:\s+as\s+(\w+))?/.exec(part.trim());
				if (nm) {
					out.set(nm[2] || nm[1], { file, exported: nm[1] });
				}
			}
		}
		return out;
	};

	return (name: string) => {
		if (bodies.has(name)) {
			return bodies.get(name);
		}
		imports ??= indexImports();
		const hit = imports.get(name);
		const found = hit ? lookup(hit.file, hit.exported, 0) : undefined;
		bodies.set(name, found);
		return found;
	};
}

/**
 * Find `declared` in `fileAbs`, following re-export barrels.
 *
 * merkle routes most of its types through one: `@/api/client` ends with
 * `export type { Cohort as CohortStats } from '@/pages/validators/lib/…'`, so a
 * component importing `CohortStats` from the barrel lands in a file that does
 * not declare it. One hop found the file and stopped; every such member became
 * the give-up value `{}`.
 *
 * `hops` is bounded because a barrel can re-export a barrel, and because a
 * cycle between two of them would otherwise not terminate.
 */
function lookup(fileAbs: string, declared: string, hops: number): ResolvedType | undefined {
	if (hops > 3) {
		return undefined;
	}
	let src: string;
	try {
		// The SHARED stripper, not a second copy of the old two-pass one: the file
		// a declaration lives in is exactly as likely to have a `/*` inside a line
		// comment as the component's own.
		src = stripComments(fs.readFileSync(fileAbs, 'utf8'));
	} catch {
		return undefined;
	}
	// `source` + `nested` let the parser read this declaration's own members in
	// this file's context instead of the component's.
	const context = { source: src, nested: resolverFor(fileAbs) };
	// The SHARED reader, so the resolver and the parser cannot disagree about
	// what a declaration is — and so an imported type brings its `extends` names
	// along for the parser to merge.
	const decl = declarationOf(src, declared);
	if (decl) {
		return { ...context, body: decl.body, bases: decl.bases };
	}
	// Up to the `;`, NEWLINES INCLUDED. A union wide enough to be worth resolving
	// is the one an author breaks across lines, and merkle's `Annotation` is
	// written exactly that way:
	//
	//     export type Annotation =
	//       | HLineAnnotation
	//       | VLineAnnotation
	//       | …
	//
	// Stopping at the first newline captured `| HLineAnnotation` and threw four
	// arms away, so every annotation an overlay synthesized was an hline.
	// Bounded by `;` and by a length cap, so an unterminated declaration cannot
	// swallow the rest of the file.
	const alias = new RegExp(`type\\s+${declared}\\s*=\\s*([^;]{1,2000})(?:;|$)`).exec(src);
	if (alias) {
		return { ...context, alias: alias[1].replace(/\s+/g, ' ').trim() };
	}
	const dir = path.dirname(fileAbs);
	// `export … { A as B } from '…'` — B is the name we were asked for, A is what
	// the next file along calls it.
	for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g)) {
		for (const part of m[1].split(',')) {
			const nm = /(?:type\s+)?(\w+)(?:\s+as\s+(\w+))?/.exec(part.trim());
			if (!nm || (nm[2] || nm[1]) !== declared) {
				continue;
			}
			const next = resolveSpecFrom(dir, fileAbs, m[2]);
			const deeper = next && lookup(next, nm[1], hops + 1);
			if (deeper) {
				return deeper;
			}
		}
	}
	// `export * from '…'` — the name is not listed, so every barrel it names has
	// to be asked. Cheap in practice: a barrel has a handful of these.
	for (const m of src.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g)) {
		const next = resolveSpecFrom(dir, fileAbs, m[1]);
		const deeper = next && lookup(next, declared, hops + 1);
		if (deeper) {
			return deeper;
		}
	}
	return undefined;
}

/** A module specifier resolved relative to the file that wrote it. */
function resolveSpecFrom(dir: string, fileAbs: string, spec: string): string | undefined {
	const root = rootFor(fileAbs);
	let base: string | undefined;
	if (spec.startsWith('.')) {
		base = path.resolve(dir, spec);
	} else if (spec.startsWith('@/')) {
		base = path.join(root, 'src', spec.slice(2));
	} else if (spec.startsWith('@shared/')) {
		base = path.resolve(root, '..', 'shared', spec.slice(8));
	} else {
		return undefined;
	}
	for (const ext of EXT_CANDIDATES) {
		const candidate = base + ext;
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Resolvers rooted at each file we have had to open, shared across a whole
 * parse. Cached because a props tree re-enters the same few declaration files
 * many times, and each fresh resolver would re-read and re-index them; the
 * parser's own depth ceiling is what stops the recursion, not this map.
 */
const rooted = new Map<string, TypeResolver>();
function resolverFor(fileAbs: string): TypeResolver {
	const key = fileAbs + '\u0000' + rootFor(fileAbs);
	let hit = rooted.get(key);
	if (!hit) {
		hit = makeTypeResolver(fileAbs, rootFor(fileAbs));
		rooted.set(key, hit);
	}
	return hit;
}


/** The frontend root a file belongs to: the nearest ancestor holding `src/`.
 *  `makeTypeResolver` needs it to expand the `@/` and `@shared/` aliases, and a
 *  nested resolver is created from a path rather than handed one. */
function rootFor(fileAbs: string): string {
	let dir = path.dirname(fileAbs);
	for (let hop = 0; hop < 12; hop++) {
		if (path.basename(dir) === 'src') {
			return path.dirname(dir);
		}
		const up = path.dirname(dir);
		if (up === dir) {
			break;
		}
		dir = up;
	}
	return path.dirname(fileAbs);
}
