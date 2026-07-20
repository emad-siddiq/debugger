/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// resolver.ts — turns a ParsedQuery into ranked jump candidates and performs the
// jump (architecture task 16, WO-2). This is the vscode-facing layer: it drives
// gopls through the built-in command bridge (`vscode.executeWorkspaceSymbolProvider`)
// and the `go list` PackageIndex, but every scoring/grammar decision it makes comes
// from the pure, unit-tested helpers in query.ts. The extension owns no LSP client.

import { dirname } from 'node:path';
import {
	Location,
	Range,
	Selection,
	SymbolInformation,
	SymbolKind,
	TextEditorRevealType,
	Uri,
	commands,
	window,
	workspace,
} from 'vscode';
import { PackageIndex, packageClauseFile } from './packageindex';
import {
	ParsedQuery,
	findPackageClauseLine,
	matchImportPath,
	matchSimplePackage,
	matchSymbol,
	parentContainer,
	targetSymbol,
} from './query';

/** A resolved jump target, ready to render in the QuickPick and to open. */
export interface NavCandidate {
	/** `pkg.Symbol` (or the package name) with a leading `$(icon)`. */
	readonly label: string;
	/** `import/path · file:line` shown dimmed after the label. */
	readonly detail: string;
	/** The file to open. */
	readonly uri: Uri;
	/** The symbol's range; absent for a package target (its clause line is found on open). */
	readonly range?: Range;
	/** When true, open at the file's `package X` clause rather than `range`. */
	readonly packageClause?: boolean;
	/** Descending sort key (symbol match, then package match). */
	readonly score: number;
}

/** Map a Go symbol kind to a theme icon id for the QuickPick label. */
function iconFor(kind: SymbolKind): string {
	switch (kind) {
		case SymbolKind.Method: return 'symbol-method';
		case SymbolKind.Function: return 'symbol-function';
		case SymbolKind.Constructor: return 'symbol-constructor';
		case SymbolKind.Field: return 'symbol-field';
		case SymbolKind.Property: return 'symbol-property';
		case SymbolKind.Variable: return 'symbol-variable';
		case SymbolKind.Constant: return 'symbol-constant';
		case SymbolKind.Struct: return 'symbol-structure';
		case SymbolKind.Class: return 'symbol-class';
		case SymbolKind.Interface: return 'symbol-interface';
		case SymbolKind.Enum: return 'symbol-enum';
		case SymbolKind.Package:
		case SymbolKind.Module:
		case SymbolKind.Namespace: return 'symbol-namespace';
		default: return 'symbol-misc';
	}
}

/** The package short-name for a symbol, from the index when known, else its directory basename. */
function packageNameForUri(uri: Uri, index: PackageIndex | undefined): string {
	const dir = dirname(uri.fsPath);
	const pkg = index?.packageForDir(dir);
	if (pkg && pkg.name) {
		return pkg.name;
	}
	return dir.slice(dir.lastIndexOf('/') + 1);
}

/** The import path for a symbol, from the index when known, else empty. */
function importPathForUri(uri: Uri, index: PackageIndex | undefined): string {
	const dir = dirname(uri.fsPath);
	return index?.packageForDir(dir)?.importPath ?? '';
}

/** A workspace-relative path when possible, else the basename. */
function relPath(uri: Uri): string {
	const rel = workspace.asRelativePath(uri, false);
	return rel || uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

/** Build the dimmed `import/path · file:line` detail line. */
function detailFor(uri: Uri, index: PackageIndex | undefined, line?: number): string {
	const importPath = importPathForUri(uri, index);
	const loc = line === undefined ? relPath(uri) : `${relPath(uri)}:${line + 1}`;
	return importPath ? `${importPath} · ${loc}` : loc;
}

/**
 * Ask gopls for workspace symbols matching `name`. Returns `[]` (never throws) so a
 * still-indexing gopls degrades to "no results yet" rather than an error.
 */
async function workspaceSymbols(name: string): Promise<SymbolInformation[]> {
	try {
		const result = await commands.executeCommand<SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', name);
		return Array.isArray(result) ? result : [];
	} catch {
		return [];
	}
}

/** Score a symbol's package against the query's qualifier; -1 when it doesn't match. */
function packageScore(query: ParsedQuery, uri: Uri, index: PackageIndex | undefined): number {
	const dir = dirname(uri.fsPath);
	const pkg = index?.packageForDir(dir);
	const name = pkg?.name ?? dir.slice(dir.lastIndexOf('/') + 1);
	const importPath = pkg?.importPath ?? '';
	if (query.importPathQualifier) {
		return importPath ? matchImportPath(query.importPathQualifier, importPath) : -1;
	}
	if (query.pkgQualifier) {
		return matchSimplePackage(query.pkgQualifier, name, importPath);
	}
	return 0;
}

/** Turn a gopls symbol into a candidate, tagging it with the given score. */
function toCandidate(symbol: SymbolInformation, index: PackageIndex | undefined, score: number): NavCandidate {
	const location: Location = symbol.location;
	const pkgName = packageNameForUri(location.uri, index);
	return {
		label: `$(${iconFor(symbol.kind)}) ${pkgName}.${symbol.name}`,
		detail: detailFor(location.uri, index, location.range.start.line),
		uri: location.uri,
		range: location.range,
		score,
	};
}

/** Resolve a lone `pkg` target to package-clause candidates via the index. */
function packageTargets(query: ParsedQuery, index: PackageIndex | undefined, minScore: number): NavCandidate[] {
	if (!index) {
		return [];
	}
	const qualifier = query.importPathQualifier ?? query.pkgQualifier ?? query.symbolPath[0];
	if (!qualifier) {
		return [];
	}
	const ranked = query.importPathQualifier ? index.resolveImportPath(qualifier) : index.resolveSimple(qualifier);
	const candidates: NavCandidate[] = [];
	for (const { pkg, score } of ranked) {
		if (score < minScore) {
			continue;
		}
		const file = packageClauseFile(pkg);
		if (!file) {
			continue;
		}
		const uri = Uri.file(file);
		candidates.push({
			label: `$(symbol-namespace) ${pkg.name || pkg.importPath}`,
			detail: importPathForUri(uri, index) || pkg.importPath,
			uri,
			packageClause: true,
			// Package targets rank just under an exact symbol hit but above fuzzy ones.
			score: 80 + Math.min(score, 100) / 10,
		});
	}
	return candidates;
}

/**
 * Resolve a parsed query to ranked jump candidates. `package` queries hit the index
 * for their clause file; `qualified` queries pull the symbol from gopls then filter
 * by package (and container, for `pkg.Type.Method`); `bare` queries fuzzy-list every
 * gopls hit and surface a strong package match too (a lone token can be either).
 */
export async function resolveCandidates(query: ParsedQuery, index: PackageIndex | undefined): Promise<NavCandidate[]> {
	if (query.kind === 'package') {
		return packageTargets(query, index, 0);
	}

	const target = targetSymbol(query);
	if (target.length === 0) {
		return [];
	}
	const symbols = await workspaceSymbols(target);
	const container = parentContainer(query);
	const candidates: NavCandidate[] = [];

	for (const symbol of symbols) {
		const symScore = matchSymbol(target, symbol.name);
		if (symScore < 0) {
			continue;
		}
		if (query.kind === 'qualified') {
			const pkgScore = packageScore(query, symbol.location.uri, index);
			if (pkgScore < 0) {
				continue;
			}
			if (container && !symbol.containerName.toLowerCase().includes(container.toLowerCase())) {
				continue;
			}
			candidates.push(toCandidate(symbol, index, symScore * 1000 + pkgScore));
		} else {
			candidates.push(toCandidate(symbol, index, symScore * 1000));
		}
	}

	if (query.kind === 'bare') {
		// A lone token may name a package as well as a symbol; surface exact-ish
		// package targets at the top alongside the fuzzy symbol list.
		candidates.unshift(...packageTargets(query, index, 80).map(c => ({ ...c, score: 100000 + c.score })));
	}

	candidates.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
	return candidates;
}

/**
 * Open a candidate's definition. For a package target the exact `package X` line is
 * found by reading the file; for a symbol we reveal its range. Uses
 * `showTextDocument` so an already-open editor is reused (revealIfOpened semantics).
 */
export async function jumpTo(candidate: NavCandidate): Promise<void> {
	const document = await workspace.openTextDocument(candidate.uri);
	let range: Range;
	if (candidate.packageClause) {
		const line = findPackageClauseLine(document.getText());
		range = new Range(line, 0, line, 0);
	} else {
		range = candidate.range ?? new Range(0, 0, 0, 0);
	}
	const editor = await window.showTextDocument(document, { selection: range });
	editor.selection = new Selection(range.start, range.start);
	editor.revealRange(range, TextEditorRevealType.InCenter);
}
