/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import {
	ExtensionContext,
	FileSystemWatcher,
	Uri,
	workspace,
} from 'vscode';
import { GoCli } from './golist';
import { PackageIndex, parseGoList } from './packageindex';
import { registerGoToSymbolCommand } from './nav';

// burrow-go-nav — qualified-symbol navigation (architecture task 16). The slice:
//   WO-1  query grammar (query.ts) + `go list -json` package index (packageindex.ts,
//         golist.ts) — pure parsing behind an injectable runner.
//   WO-2  resolver (resolver.ts) — gopls `workspace/symbol` bridge, package-filter
//         + ranking, package-clause resolution for lone-package targets, and the jump.
//   WO-3  the Search-Everywhere QuickPick + `burrow.nav.goToSymbol` command (nav.ts).
// This file wires the command and owns the ONE piece of mutable state: a lazily
// built, cached PackageIndex, invalidated when a `go.mod` / `go.work` changes.

/**
 * A lazily built, cached `go list` package index for the workspace. The first
 * `get()` builds it; a `go.mod` / `go.work` change drops the cache so the next
 * `get()` rebuilds. Building is done once and shared — concurrent callers await the
 * same promise. Degrades to `undefined` (no index) when there is no workspace
 * folder or `go list` fails, so navigation still works off gopls alone.
 */
class IndexCache {
	private pending: Promise<PackageIndex | undefined> | undefined;

	/** Build (or return the in-flight/cached) index. */
	get(): Promise<PackageIndex | undefined> {
		if (!this.pending) {
			this.pending = this.build();
		}
		return this.pending;
	}

	/** Drop the cache; the next `get()` rebuilds from `go list`. */
	invalidate(): void {
		this.pending = undefined;
	}

	/** Run `go list -json` in the first workspace folder and index the result. */
	private async build(): Promise<PackageIndex | undefined> {
		const folder = workspace.workspaceFolders?.[0];
		if (!folder || folder.uri.scheme !== 'file') {
			return undefined;
		}
		const goBin = workspace.getConfiguration('burrow.nav').get<string>('goBinary', 'go');
		const scope = workspace.getConfiguration('burrow.nav').get<string>('packageScope', 'workspace');
		const args = scope === 'all' ? ['-json', './...', 'all'] : ['-json', './...'];
		try {
			const stdout = await new GoCli(folder.uri.fsPath, goBin).list(args);
			return new PackageIndex(parseGoList(stdout));
		} catch {
			// gopls still provides bare-symbol navigation without the index.
			return undefined;
		}
	}
}

/** Activate: build the index cache, watch modules for invalidation, register the command. */
export function activate(context: ExtensionContext): void {
	const index = new IndexCache();

	const watcher: FileSystemWatcher = workspace.createFileSystemWatcher('**/{go.mod,go.work,go.sum}');
	const invalidate = (_uri: Uri) => index.invalidate();
	context.subscriptions.push(
		watcher,
		watcher.onDidCreate(invalidate),
		watcher.onDidChange(invalidate),
		watcher.onDidDelete(invalidate),
		registerGoToSymbolCommand(() => index.get()),
	);

	// Warm the index in the background so the first palette open is fast.
	void index.get();
}

/** Deactivate: the watcher and command are disposed via context.subscriptions. */
export function deactivate(): void {
	// Nothing to do — all disposables live in context.subscriptions.
}
