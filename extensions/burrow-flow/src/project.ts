/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// project.ts — resolve where the target backend lives and run the two host
// tools that feed the view: the target project's own oracle (optional, for the
// authoritative digest) and flowscan (the call-chain extractor shipped in the
// Burrow repo at tools/flowscan). Config source is Burrow settings + the project
// spine's detection — never the legacy launcher /config, and never MERKLE_ROOT.

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	DESCRIPTOR_PATH, FLOW_STATE_PATH, FLOW_STATE_VERSION, FlowState, Tree,
	goStack, loadErrorCount, oracleAppName, parseFlowState, serializeFlowState,
} from './spine';

export interface ProjectPaths {
	/** The workspace folder — the project root, whatever the module's depth. */
	readonly root: string;
	/** The Go backend module dir flowscan analyzes. Absolute. */
	readonly backendDir: string;
	/** The same, relative to `root`, which is what gets recorded and displayed. */
	readonly backendRel: string;
	/** Dir to run the oracle from (contains cmd/oracle), when the project ships one. */
	readonly oracleDir?: string;
	/** How the module was found — a setting, the descriptor, or the tree. */
	readonly from: 'setting' | 'descriptor' | 'detected';
}

/** A `Tree` over a real folder. Never throws: detection runs on folders that do
 *  not have most of these paths. */
export function treeOf(root: string): Tree {
	return {
		exists: (rel) => fs.existsSync(path.join(root, rel)),
		read: (rel) => {
			try {
				return fs.readFileSync(path.join(root, rel), 'utf8');
			} catch {
				return undefined;
			}
		},
	};
}

/**
 * The Go module whose routes this window is about.
 *
 * Setting → descriptor → detection, which is `spine.goStack`'s order. The three
 * merkle assumptions this replaced are gone: `<root>/backend/go.mod` is now one
 * candidate among seven rather than the only one, `router.go` is not required for
 * a root module to count, and `MERKLE_ROOT` is not consulted at all.
 */
export function detectProject(): ProjectPaths | undefined {
	const configured = vscode.workspace.getConfiguration('burrow.flow').get<string>('backendDir', '');
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

	// An explicit setting can point outside the workspace, so it is resolved
	// against the filesystem rather than the tree.
	if (configured) {
		const backendDir = path.resolve(folder ?? '', configured);
		if (fs.existsSync(path.join(backendDir, 'go.mod'))) {
			const root = folder ?? path.dirname(backendDir);
			return {
				root, backendDir, from: 'setting',
				backendRel: path.relative(root, backendDir) || '.',
				oracleDir: oracleDirUnder(root),
			};
		}
	}
	if (!folder) {
		return undefined;
	}
	const stack = goStack(treeOf(folder), undefined);
	if (!stack) {
		return undefined;
	}
	return {
		root: folder,
		backendDir: stack.root === '.' ? folder : path.join(folder, stack.root),
		backendRel: stack.root,
		from: stack.from,
		oracleDir: oracleDirUnder(folder),
	};
}

/**
 * The app name the oracle's `--digest <app>` takes.
 *
 * Setting first, then the descriptor's project name, then the folder's. The
 * setting's `default` used to be the literal `nodewatch`, which is merkle's app —
 * a hard-coded target hiding in a `package.json` default value, where nobody
 * reading the code would find it.
 */
export function oracleApp(paths: ProjectPaths): string {
	const configured = vscode.workspace.getConfiguration('burrow.flow').get<string>('oracleApp', '');
	if (configured) {
		return configured;
	}
	return oracleAppName(treeOf(paths.root).read(DESCRIPTOR_PATH), path.basename(paths.root));
}

function oracleDirUnder(root: string): string | undefined {
	const dir = path.join(root, 'test');
	return fs.existsSync(path.join(dir, 'cmd', 'oracle')) ? dir : undefined;
}

/** The flowscan module dir: setting override, else the copy shipped beside us. */
export function flowscanDir(context: vscode.ExtensionContext): string | undefined {
	const configured = vscode.workspace.getConfiguration('burrow.flow').get<string>('flowscanDir', '');
	if (configured && fs.existsSync(path.join(configured, 'go.mod'))) {
		return configured;
	}
	// <extensionPath>/../../tools/flowscan — the repo checkout under `make dev`,
	// Contents/Resources/app/tools/flowscan in a packaged app (build/burrow/stage-tools.js).
	const shipped = path.resolve(context.extensionPath, '..', '..', 'tools', 'flowscan');
	return fs.existsSync(path.join(shipped, 'go.mod')) ? shipped : undefined;
}

/**
 * How to invoke flowscan. A packaged app ships a prebuilt binary next to the
 * sources, and that is what we run: `go run .` needs a Go toolchain, a warm
 * module cache and (first time, on any machine) the network — none of which a
 * user who just opened the app from Launchpad has agreed to. The source tree is
 * the fallback, which is what a repo checkout uses.
 */
export function flowscanCommand(dir: string): { cmd: string; args: string[] } {
	const binary = path.join(dir, process.platform === 'win32' ? 'flowscan.exe' : 'flowscan');
	try {
		fs.accessSync(binary, fs.constants.X_OK);
		return { cmd: binary, args: [] };
	} catch {
		return { cmd: goBin(), args: ['run', '.'] };
	}
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
		const app = oracleApp(paths);
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
	const { cmd, args } = flowscanCommand(scanDir);
	const scan = await run(cmd, [...args, '--backend', paths.backendDir, ...digestArg, '--out', flowsFile], scanDir, log);
	if (scan.code !== 0) {
		void vscode.window.showErrorMessage(`flowscan failed (exit ${scan.code}) — see the "Burrow Flow" output channel.`);
		return undefined;
	}
	// The trace HAPPENED. Record that, whatever it found — a zero that was measured
	// and a zero that was never attempted are different facts, and until now the
	// second was the only one anything could see.
	writeFlowState(paths, flowsFile, loadErrorCount(scan.stderr), log);
	return flowsFile;
}

/**
 * `.burrow/flow.json` — the summary a sibling extension is allowed to read.
 *
 * Counts only. flows.json keeps the routes, the handlers and the SQL in this
 * extension's own storage; nothing of that belongs in a file that sits in the
 * user's project directory.
 *
 * A failure to write costs the traffic light its third state, not the trace, so it
 * is logged and swallowed — a read-only checkout must still be able to trace.
 */
function writeFlowState(paths: ProjectPaths, flowsFile: string, loadErrors: number, log: vscode.OutputChannel): void {
	try {
		const doc = JSON.parse(fs.readFileSync(flowsFile, 'utf8')) as {
			rev?: string;
			coverage?: {
				routes?: number; traced?: number; partial?: number; unknown?: number;
				unfollowed?: { file: string; line: number; reason: string }[];
			};
		};
		const c = doc.coverage ?? {};
		const state: FlowState = {
			version: FLOW_STATE_VERSION,
			ranAt: new Date().toISOString(),
			backend: paths.backendRel,
			rev: doc.rev || undefined,
			routes: c.routes ?? 0,
			traced: c.traced ?? 0,
			partial: c.partial ?? 0,
			unknown: c.unknown ?? 0,
			loadErrors: loadErrors || undefined,
			unfollowed: c.unfollowed?.length || undefined,
		};
		const target = path.join(paths.root, FLOW_STATE_PATH);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, serializeFlowState(state), 'utf8');
	} catch (err) {
		log.appendLine(`could not record the trace in ${FLOW_STATE_PATH}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** What the last trace found here, if one has ever run. */
export function flowState(root: string): FlowState | undefined {
	return parseFlowState(treeOf(root).read(FLOW_STATE_PATH));
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
