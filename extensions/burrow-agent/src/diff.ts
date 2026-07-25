/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { denyGlobs } from './context';
import { isDenied } from './contextModel';
import { applyDiff, extractDiff, FileDiff, newFileContent, parseDiff } from './diffModel';

// Preview and Apply (docs/plans/03 §6). The model is denied the editing tools,
// so a change arrives as a diff and this is the only path to disk — one
// WorkspaceEdit, one undo step, after an explicit press. Never a save, never a
// commit, never git.
//
// The right-hand side of the preview is a real in-memory document served by a
// content provider, so Burrow's own diff editor renders it with syntax
// highlighting and the usual navigation instead of a webview imitation.

export const PREVIEW_SCHEME = 'burrow-agent-proposal';

/** The proposal a transcript turn is holding, keyed by turn so a later answer
 *  cannot be applied by an earlier button. */
export interface Proposal {
	readonly id: string;
	readonly files: readonly FileDiff[];
	/** Patched text per absolute path, computed at preview time. */
	readonly patched: Map<string, string>;
	readonly refusals: readonly string[];
}

export class ProposalStore implements vscode.Disposable {

	private readonly proposals = new Map<string, Proposal>();
	private readonly contents = new Map<string, string>();
	private readonly onDidChange = new vscode.EventEmitter<vscode.Uri>();
	private readonly registration: vscode.Disposable;

	constructor() {
		this.registration = vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
			onDidChange: this.onDidChange.event,
			provideTextDocumentContent: (uri) => this.contents.get(uri.path) ?? '',
		});
	}

	dispose(): void {
		this.registration.dispose();
		this.onDidChange.dispose();
	}

	/**
	 * Read a proposal out of an answer: parse it, decide what may be touched,
	 * and patch each file in memory. Returns undefined when the answer contains
	 * no diff at all, which is the common case and not a failure.
	 */
	async prepare(id: string, answer: string): Promise<Proposal | undefined> {
		const text = extractDiff(answer);
		if (!text) {
			return undefined;
		}
		const files = parseDiff(text);
		if (!files.length) {
			return undefined;
		}
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const patched = new Map<string, string>();
		const refusals: string[] = [];
		const kept: FileDiff[] = [];

		for (const file of files) {
			const abs = root ? path.resolve(root, file.path) : file.path;
			// Both rules re-checked here, not trusted from the context pass: a
			// diff can name a file that was never in the envelope.
			if (!root || (abs !== root && !abs.startsWith(root + path.sep))) {
				refusals.push(`\`${file.path}\` is outside the workspace`);
				continue;
			}
			if (isDenied(abs.split(path.sep).join('/'), denyGlobs())) {
				refusals.push(`\`${file.path}\` is on the never-touch list`);
				continue;
			}
			if (file.isNew) {
				patched.set(abs, newFileContent(file));
				kept.push(file);
				continue;
			}
			let original: string;
			try {
				original = (await vscode.workspace.openTextDocument(vscode.Uri.file(abs))).getText();
			} catch {
				refusals.push(`\`${file.path}\` could not be opened`);
				continue;
			}
			const result = applyDiff(original, file.hunks);
			if (result.text === undefined) {
				refusals.push(`\`${file.path}\` — ${result.rejected.length} hunk${result.rejected.length === 1 ? '' : 's'} no longer match the file`);
				continue;
			}
			patched.set(abs, result.text);
			kept.push(file);
		}

		const proposal: Proposal = { id, files: kept, patched, refusals };
		this.proposals.set(id, proposal);
		for (const [abs, text] of patched) {
			this.contents.set(previewPath(id, abs), text);
			this.onDidChange.fire(previewUri(id, abs));
		}
		return proposal;
	}

	get(id: string): Proposal | undefined {
		return this.proposals.get(id);
	}

	/** Open the native diff editor, one tab per file. */
	async preview(id: string): Promise<void> {
		const proposal = this.proposals.get(id);
		if (!proposal) {
			return;
		}
		for (const abs of proposal.patched.keys()) {
			await vscode.commands.executeCommand(
				'vscode.diff',
				vscode.Uri.file(abs),
				previewUri(id, abs),
				`${path.basename(abs)} — agent proposal`,
				{ preview: true },
			);
		}
	}

	/**
	 * Apply every file in one edit, so one ⌘Z takes it all back. The buffers are
	 * left dirty on purpose: saving is the developer's gesture, and an unsaved
	 * buffer is the last chance to look before it is real.
	 */
	async apply(id: string): Promise<string> {
		const proposal = this.proposals.get(id);
		if (!proposal || !proposal.patched.size) {
			return 'nothing to apply';
		}
		const edit = new vscode.WorkspaceEdit();
		const applied: string[] = [];
		for (const [abs, text] of proposal.patched) {
			const uri = vscode.Uri.file(abs);
			try {
				const doc = await vscode.workspace.openTextDocument(uri);
				const whole = new vscode.Range(0, 0, doc.lineCount, 0);
				edit.replace(uri, whole, text);
			} catch {
				edit.createFile(uri, { contents: Buffer.from(text, 'utf8'), overwrite: false, ignoreIfExists: true });
			}
			applied.push(path.basename(abs));
		}
		const ok = await vscode.workspace.applyEdit(edit);
		return ok
			? `applied to ${applied.join(', ')} — unsaved, ⌘Z undoes it in one step`
			: 'the workspace refused the edit';
	}
}

function previewPath(id: string, abs: string): string {
	return `/${id}${abs}`;
}

function previewUri(id: string, abs: string): vscode.Uri {
	return vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: previewPath(id, abs) });
}
