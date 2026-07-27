/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// search.ts — "find me that component".
//
// The gallery tree is an INDEX: two levels, grouped by directory, made for
// browsing. merkle has 217 components in 60-odd directories, and browsing is the
// wrong verb when you already know the name. This is the other half — one fuzzy
// list of every component in the project, typed rather than clicked.
//
// It deliberately also lists components the tool cannot isolate. merkle keeps
// four of them (`shared/components/*.tsx`, reached through the `@shared/*`
// tsconfig alias) OUTSIDE the Vite project, and the whole harness is anchored to
// `<target>/src`. Hiding them made the gallery look like it had lost them and
// left "Show in App" failing with no explanation. They are listed, marked, and
// picking one opens the source and says why it stops there.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ComponentHit {
	readonly abs: string;
	readonly name: string;
	/** Directory, relative to the root it was found under. */
	readonly where: string;
	/** False for components outside the target's `src/` — listed, not isolable. */
	readonly isolable: boolean;
	readonly samples: boolean;
}

const COMPONENT_EXT = new Set(['.tsx', '.jsx']);
const SAMPLE_EXTS = ['ts', 'tsx', 'js', 'jsx'];
const SKIP_DIRS = new Set(['node_modules', '__tests__', '__snapshots__', 'test', 'tests', '__mocks__', 'dist', 'build']);

function isComponentFile(name: string): boolean {
	const ext = path.extname(name);
	if (!COMPONENT_EXT.has(ext)) {
		return false;
	}
	const stem = name.slice(0, -ext.length);
	return !/\.(test|spec|stories|samples)$/.test(stem) && /^[A-Z]/.test(stem);
}

function hasSamples(dir: string, file: string): boolean {
	const stem = file.slice(0, -path.extname(file).length);
	return SAMPLE_EXTS.some((ext) => fs.existsSync(path.join(dir, `${stem}.samples.${ext}`)));
}

function walk(root: string, isolable: boolean, out: ComponentHit[], rel = ''): ComponentHit[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.isDirectory()) {
			if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
				walk(root, isolable, out, rel ? `${rel}/${e.name}` : e.name);
			}
		} else if (isComponentFile(e.name)) {
			const dir = path.join(root, rel);
			out.push({
				abs: path.join(dir, e.name),
				name: e.name.slice(0, -path.extname(e.name).length),
				where: rel || '.',
				isolable,
				samples: hasSamples(dir, e.name),
			});
		}
	}
	return out;
}

/**
 * Directories the target reaches through a tsconfig path alias but that live
 * OUTSIDE it — merkle's `"@shared/*": ["../shared/*"]`. Read from the target's
 * own tsconfigs, so this is a property of the project rather than a list of
 * names baked into Burrow.
 */
export function aliasedRoots(targetDir: string): string[] {
	const roots = new Set<string>();
	for (const name of ['tsconfig.app.json', 'tsconfig.json']) {
		let raw: string;
		try {
			raw = fs.readFileSync(path.join(targetDir, name), 'utf8');
		} catch {
			continue;
		}
		// tsconfigs carry comments and trailing commas; a tolerant strip beats
		// pulling in a JSON5 dependency for two lines of config.
		const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1');
		let paths: Record<string, string[]> | undefined;
		try {
			paths = (JSON.parse(stripped) as { compilerOptions?: { paths?: Record<string, string[]> } }).compilerOptions?.paths;
		} catch {
			continue;
		}
		for (const targets of Object.values(paths ?? {})) {
			for (const target of targets) {
				const dir = path.resolve(targetDir, target.replace(/\/?\*+$/, ''));
				const rel = path.relative(targetDir, dir);
				if (rel.startsWith('..') && fs.existsSync(dir)) {
					roots.add(dir);
				}
			}
		}
	}
	return [...roots].sort();
}

/** Every component the project has, isolable ones first. */
export function indexComponents(targetDir: string): ComponentHit[] {
	const src = path.join(targetDir, 'src');
	const hits = walk(src, true, []);
	for (const root of aliasedRoots(targetDir)) {
		for (const hit of walk(root, false, [])) {
			// Label the outsiders by a path that means something to a reader:
			// `shared/components`, not `.` under some absolute root.
			hits.push({ ...hit, where: path.join(path.basename(root), hit.where === '.' ? '' : hit.where) });
		}
	}
	return hits.sort((a, b) => Number(b.isolable) - Number(a.isolable) || a.name.localeCompare(b.name) || a.where.localeCompare(b.where));
}

interface Item extends vscode.QuickPickItem {
	readonly hit: ComponentHit;
}

/**
 * The picker. Returns the chosen component, or undefined if it was dismissed.
 * Handles the not-isolable case itself — opening the file and explaining — so
 * every caller gets either something it can act on or a user who has been told
 * what happened.
 */
export async function pickComponent(targetDir: string, placeHolder: string): Promise<ComponentHit | undefined> {
	const hits = indexComponents(targetDir);
	if (!hits.length) {
		void vscode.window.showWarningMessage(`Frontend Debugger: no components found under ${path.join(targetDir, 'src')}.`);
		return undefined;
	}
	const items: Item[] = hits.map((hit) => ({
		hit,
		label: hit.isolable ? hit.name : `$(circle-slash) ${hit.name}`,
		description: hit.where,
		detail: hit.isolable
			? (hit.samples ? 'has samples' : undefined)
			: 'outside the Vite project — Burrow can open it, but not isolate or show it in the app',
	}));
	const chosen = await vscode.window.showQuickPick(items, {
		placeHolder,
		matchOnDescription: true,
		title: `${hits.filter((h) => h.isolable).length} components`,
	});
	if (!chosen) {
		return undefined;
	}
	if (!chosen.hit.isolable) {
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(chosen.hit.abs));
		await vscode.window.showTextDocument(doc, { preview: true });
		void vscode.window.showInformationMessage(
			`${chosen.hit.name} lives in ${chosen.hit.where}, outside the Vite project — the isolation harness only serves files under ${path.basename(targetDir)}/src, so it can be opened but not isolated.`,
		);
		return undefined;
	}
	return chosen.hit;
}
