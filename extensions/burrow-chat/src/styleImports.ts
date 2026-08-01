/*---------------------------------------------------------------------------------------------
 *  Burrow: stylesheet-import scanning, pure (no vscode import) so the node
 *  tests can require out/styleImports.js directly.
 *--------------------------------------------------------------------------------------------*/

/** Plan chat/02 step 4.2 — the exact specifier regex, verbatim. */
export const STYLE_IMPORT_RE = /(?:import\s+(?:[^'"\n]*\s+from\s+)?|require\()\s*['"]([^'"]+\.(?:css|scss|sass|less))['"]/g;

export interface StyleImport { readonly spec: string; readonly line: number }

/** Every stylesheet specifier in a component source, with its 1-based line. */
export function styleImportsOf(text: string): StyleImport[] {
	const out: StyleImport[] = [];
	for (const m of text.matchAll(STYLE_IMPORT_RE)) {
		out.push({ spec: m[1], line: text.slice(0, m.index).split('\n').length });
	}
	return out;
}
