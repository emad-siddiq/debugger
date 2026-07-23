/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { TypeResolver } from './propsSkeleton';

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
	let imports: Map<string, string> | undefined; // type name → resolved file
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

	const indexImports = (): Map<string, string> => {
		const out = new Map<string, string>();
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
					out.set(nm[2] || nm[1], file);
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
		const file = imports.get(name);
		let found: { body?: string; alias?: string } | undefined;
		if (file) {
			try {
				const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
				const decl = new RegExp(`(?:interface\\s+${name}\\b[^{]*|type\\s+${name}\\s*=\\s*)\\{`).exec(src);
				if (decl) {
					found = { body: braceBlock(src, decl.index + decl[0].length - 1) };
				} else {
					const alias = new RegExp(`type\\s+${name}\\s*=\\s*([^\\n;]+)`).exec(src);
					if (alias) {
						found = { alias: alias[1].trim() };
					}
				}
			} catch {
				found = undefined;
			}
		}
		bodies.set(name, found);
		return found;
	};
}

function braceBlock(text: string, openIdx: number): string | undefined {
	let depth = 0;
	for (let i = openIdx; i < text.length; i++) {
		const ch = text[i];
		if (ch === '{') {
			depth++;
		} else if (ch === '}') {
			depth--;
			if (depth === 0) {
				return text.slice(openIdx + 1, i);
			}
		}
	}
	return undefined;
}
