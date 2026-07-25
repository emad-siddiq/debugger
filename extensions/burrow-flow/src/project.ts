/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// project.ts — resolve where the target backend lives and run the two host
// tools that feed the view: the target project's own oracle (optional, for the
// authoritative digest) and flowscan (the call-chain extractor shipped in the
// Burrow repo at tools/flowscan). Config source is Burrow settings +
// workspace-folder auto-detect — never the legacy launcher /config.

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface ProjectPaths {
	/** Project root (the dir holding backend/ and, when present, test/cmd/oracle). */
	readonly root: string;
	/** The Go backend module dir flowscan analyzes. */
	readonly backendDir: string;
	/** Dir to run the oracle from (contains cmd/oracle), when the project ships one. */
	readonly oracleDir?: string;
}

export function detectProject(): ProjectPaths | undefined {
	const configured = vscode.workspace.getConfiguration('burrow.flow').get<string>('backendDir', '');
	if (configured) {
		const backendDir = path.resolve(configured);
		if (fs.existsSync(path.join(backendDir, 'go.mod'))) {
			const root = path.dirname(backendDir);
			return { root, backendDir, oracleDir: oracleDirUnder(root) };
		}
	}
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const root = folder.uri.fsPath;
		if (fs.existsSync(path.join(root, 'backend', 'go.mod'))) {
			return { root, backendDir: path.join(root, 'backend'), oracleDir: oracleDirUnder(root) };
		}
		// A workspace opened directly on the backend module.
		if (fs.existsSync(path.join(root, 'go.mod')) && fs.existsSync(path.join(root, 'router.go'))) {
			return { root, backendDir: root, oracleDir: oracleDirUnder(path.dirname(root)) };
		}
	}
	const envRoot = process.env['MERKLE_ROOT'];
	if (envRoot && fs.existsSync(path.join(envRoot, 'backend', 'go.mod'))) {
		return { root: envRoot, backendDir: path.join(envRoot, 'backend'), oracleDir: oracleDirUnder(envRoot) };
	}
	return undefined;
}

function oracleDirUnder(root: string): string | undefined {
	const dir = path.join(root, 'test');
	return fs.existsSync(path.join(dir, 'cmd', 'oracle')) ? dir : undefined;
}

/** The flowscan module dir: setting override, else the copy in this Burrow repo. */
export function flowscanDir(context: vscode.ExtensionContext): string | undefined {
	const configured = vscode.workspace.getConfiguration('burrow.flow').get<string>('flowscanDir', '');
	if (configured && fs.existsSync(path.join(configured, 'go.mod'))) {
		return configured;
	}
	const inRepo = path.resolve(context.extensionPath, '..', '..', 'tools', 'flowscan');
	return fs.existsSync(path.join(inRepo, 'go.mod')) ? inRepo : undefined;
}

function goBin(): string {
	return vscode.workspace.getConfiguration('burrow.flow').get<string>('goBin', 'go') || 'go';
}

function run(cmd: string, args: string[], cwd: string, log: vscode.OutputChannel): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		log.appendLine(`$ ${cmd} ${args.join(' ')}  (cwd ${cwd})`);
		const child = cp.spawn(cmd, args, { cwd, env: process.env });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on('data', (chunk: Buffer) => {
			const text = chunk.toString();
			stderr += text;
			log.append(text);
		});
		child.on('error', err => {
			log.appendLine(`spawn failed: ${err.message}`);
			resolve({ code: -1, stdout, stderr: err.message });
		});
		child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
	});
}

/**
 * Regenerate the digest (when the project ships an oracle) and run flowscan.
 * Returns the path to the fresh flows.json, or undefined with the error shown.
 */
export async function refreshFlows(
	context: vscode.ExtensionContext,
	paths: ProjectPaths,
	log: vscode.OutputChannel,
): Promise<string | undefined> {
	const storage = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
	fs.mkdirSync(storage, { recursive: true });
	const digestFile = path.join(storage, 'digest.md');
	const flowsFile = path.join(storage, 'flows.json');

	let digestArg: string[] = [];
	if (paths.oracleDir) {
		const app = vscode.workspace.getConfiguration('burrow.flow').get<string>('oracleApp', 'nodewatch');
		const oracle = await run(goBin(), ['run', './cmd/oracle', '--digest', app], paths.oracleDir, log);
		if (oracle.code === 0 && oracle.stdout.includes('```routes')) {
			fs.writeFileSync(digestFile, oracle.stdout);
			digestArg = ['--digest', digestFile];
		} else {
			log.appendLine(`oracle digest failed (exit ${oracle.code}) — continuing digest-less`);
		}
	}

	const scanDir = flowscanDir(context);
	if (!scanDir) {
		void vscode.window.showErrorMessage('flowscan not found — set burrow.flow.flowscanDir to its module directory.');
		return undefined;
	}
	const scan = await run(goBin(), ['run', '.', '--backend', paths.backendDir, ...digestArg, '--out', flowsFile], scanDir, log);
	if (scan.code !== 0) {
		void vscode.window.showErrorMessage(`flowscan failed (exit ${scan.code}) — see the "Burrow Flow" output channel.`);
		return undefined;
	}
	return flowsFile;
}

/** The cached flows.json path from the last refresh, if it exists. */
export function cachedFlowsFile(context: vscode.ExtensionContext): string | undefined {
	return cachedStorageFile(context, 'flows.json');
}

/** The cached oracle digest from the last refresh, if the project ships an oracle. */
export function cachedDigestFile(context: vscode.ExtensionContext): string | undefined {
	return cachedStorageFile(context, 'digest.md');
}

function cachedStorageFile(context: vscode.ExtensionContext, name: string): string | undefined {
	const storage = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
	const file = path.join(storage, name);
	return fs.existsSync(file) ? file : undefined;
}
