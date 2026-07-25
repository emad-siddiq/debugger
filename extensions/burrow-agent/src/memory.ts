/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { envNamesIn, indexTitles, rowsMentioning, section, selectMemory } from './memoryModel';

// Reading the repo's own memory (docs/plans/03 §4). The rules are in
// memoryModel.ts; this reaches the disk, keeps the result small, and stays
// silent for a repo that has no `.claude/memory/` — most do not, and a missing
// contract is not an error.
//
// Read-only, always: the panel never writes to `.claude/memory/**`. A drafted
// row goes through the same diff-and-Apply flow as code (diff.ts).

const MAX_BLOCK_CHARS = 2500;

/** The memory layer's body, or undefined when there is nothing worth sending. */
export function memoryLayer(activeFile: string | undefined, question = ''): string | undefined {
	const root = memoryRoot();
	if (!root) {
		return undefined;
	}
	const blocks: string[] = [];

	const index = read(path.join(root, 'MEMORY.md'));
	if (index) {
		const titles = indexTitles(index);
		if (titles.length) {
			blocks.push(`\`MEMORY.md\` covers: ${titles.join(' · ')}`);
		}
	}

	for (const pick of selectMemory(activeFile, question)) {
		const text = read(path.join(root, pick.file));
		if (!text) {
			continue;
		}
		let body = pick.keys.length
			? pick.keys.map((key) => section(text, key)).filter((s): s is string => !!s).join('\n')
			: text;
		if (pick.mentioning?.length) {
			body = rowsMentioning(body, pick.mentioning) || '';
		}
		if (body.trim()) {
			blocks.push(`### \`${pick.file}\` (${pick.why})\n\`\`\`yaml\n${clip(body)}\n\`\`\``);
		}
	}

	const env = activeFile ? envRows(root, activeFile) : undefined;
	if (env) {
		blocks.push(env);
	}
	return blocks.length ? blocks.join('\n\n') : undefined;
}

/** `env.yaml`, narrowed to the variables the open file actually reads. */
function envRows(root: string, activeFile: string): string | undefined {
	const source = read(activeFile);
	const envFile = read(path.join(root, 'env.yaml'));
	if (!source || !envFile) {
		return undefined;
	}
	const names = envNamesIn(source);
	const rows = rowsMentioning(envFile, names);
	return rows ? `### \`env.yaml\` (variables this file reads)\n\`\`\`yaml\n${clip(rows)}\n\`\`\`` : undefined;
}

/** `<workspace>/.claude/memory`, or the configured override. */
export function memoryRoot(): string | undefined {
	if (!vscode.workspace.getConfiguration('burrow.agent').get<boolean>('memory.enabled', true)) {
		return undefined;
	}
	const configured = vscode.workspace.getConfiguration('burrow.agent').get<string>('memory.root', '').trim();
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const root = configured || (folder ? path.join(folder, '.claude', 'memory') : '');
	try {
		return root && fs.statSync(root).isDirectory() ? root : undefined;
	} catch {
		return undefined;
	}
}

function read(file: string): string | undefined {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
}

function clip(text: string): string {
	return text.length > MAX_BLOCK_CHARS ? `${text.slice(0, MAX_BLOCK_CHARS)}\n# … clipped` : text;
}
