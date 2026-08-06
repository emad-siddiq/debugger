/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// goTaskProvider.ts — the IMPURE half: turning the argv in goTasks.ts into real
// vscode.Tasks, anchored at the module root rather than the workspace root.
//
// Everything here is one of two things: a lookup on the project spine, or a
// vscode object construction. The decisions live in goTasks.ts, where they can
// be tested.

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import * as vscode from 'vscode';
import { Project } from './descriptor';
import { ALL_PACKAGES, GO_TASK_SPECS, GoTaskKind, buildTaskArgs, goTaskSpec, lintPlan, matcherFor } from './goTasks';

export const GO_TASK_TYPE = 'go';

interface GoTaskDefinition extends vscode.TaskDefinition {
	readonly type: typeof GO_TASK_TYPE;
	readonly task: GoTaskKind;
	readonly packages?: string;
}

/**
 * Where staticcheck is, if it is anywhere.
 *
 * The same order `burrow-go-debug` uses for Delve, for the same reason: these are
 * host tools installed by `go install`, which puts them in `$GOBIN` or
 * `$GOPATH/bin`, and the extension host's PATH routinely does not include either.
 * Returning `undefined` is a normal answer — see `lintPlan`.
 */
function resolveStaticcheck(): string | undefined {
	const goBin = process.env.GOBIN || join(process.env.GOPATH || join(homedir(), 'go'), 'bin');
	const candidate = join(goBin, 'staticcheck');
	return existsSync(candidate) ? candidate : undefined;
}

/** The absolute directory a Go command must run in: the module's, not the workspace's. */
function moduleRootOf(folder: vscode.WorkspaceFolder, project: Project): { abs: string; rel: string } | undefined {
	const stack = project.stacks.find((s) => s.id === 'go');
	if (!stack) {
		return undefined;
	}
	const rel = stack.root === '.' ? '.' : stack.root;
	return { abs: rel === '.' ? folder.uri.fsPath : join(folder.uri.fsPath, rel), rel };
}

function groupOf(spec: (typeof GO_TASK_SPECS)[number]): vscode.TaskGroup | undefined {
	switch (spec.group) {
		case 'build': return vscode.TaskGroup.Build;
		case 'test': return vscode.TaskGroup.Test;
		default: return undefined;
	}
}

/**
 * Builds one task. `ProcessExecution`, not `ShellExecution`: a package pattern is
 * user-supplied text and a shell would interpret it, so `./...; rm -rf x` in a
 * hand-written tasks.json would be two commands instead of one bad package name.
 */
function makeTask(
	folder: vscode.WorkspaceFolder,
	definition: GoTaskDefinition,
	root: { abs: string; rel: string },
	staticcheck: string | undefined,
): vscode.Task | undefined {
	const spec = goTaskSpec(definition.task);
	if (!spec) {
		return undefined;
	}
	const packages = definition.packages ?? ALL_PACKAGES;

	let program: string;
	let args: string[];
	let detail = spec.detail;
	if (definition.task === 'lint') {
		const plan = lintPlan(staticcheck, packages);
		program = plan.tool === 'staticcheck' ? staticcheck! : 'go';
		args = [...plan.args];
		if (plan.degraded) {
			detail = plan.degraded;
		}
	} else {
		program = 'go';
		args = buildTaskArgs(definition.task, packages);
	}

	const task = new vscode.Task(
		definition,
		folder,
		spec.label,
		'go',
		new vscode.ProcessExecution(program, args, { cwd: root.abs }),
		// The matcher anchored at THIS module root. A task whose cwd is
		// `backend/` reports `sub/deep.go`, which only resolves against
		// `${workspaceFolder}/backend`.
		spec.diagnostic ? [matcherFor(root.rel)] : [],
	);
	task.group = groupOf(spec);
	task.detail = detail;
	// `tidy` rewrites go.mod and go.sum; `generate` rewrites source. Both are worth
	// seeing happen, so neither is allowed to run silently in a reused panel.
	task.presentationOptions = {
		reveal: vscode.TaskRevealKind.Always,
		panel: vscode.TaskPanelKind.Dedicated,
		clear: true,
	};
	return task;
}

/**
 * Contributes the six Go tasks, per workspace folder that actually has a module.
 *
 * A folder with no `go.mod` contributes NOTHING rather than a task that would
 * fail with `cannot find main module` — the same rule the debug path follows for
 * an absent entry point, and the reason the provider takes the project spine
 * rather than assuming the module is at the root.
 */
export function registerGoTaskProvider(
	projectOf: (folder: string) => Project,
	out: vscode.OutputChannel,
): vscode.Disposable {
	const provider: vscode.TaskProvider = {
		provideTasks: () => {
			const staticcheck = resolveStaticcheck();
			const tasks: vscode.Task[] = [];
			for (const folder of vscode.workspace.workspaceFolders ?? []) {
				const root = moduleRootOf(folder, projectOf(folder.uri.fsPath));
				if (!root) {
					out.appendLine(`[tasks] ${folder.name}: no go.mod found — contributing no Go tasks`);
					continue;
				}
				for (const spec of GO_TASK_SPECS) {
					const task = makeTask(folder, { type: GO_TASK_TYPE, task: spec.kind }, root, staticcheck);
					if (task) {
						tasks.push(task);
					}
				}
				out.appendLine(`[tasks] ${folder.name}: ${GO_TASK_SPECS.length} Go tasks in ${root.rel}`
					+ `, problems via ${matcherFor(root.rel)}`
					+ (staticcheck ? '' : ' · staticcheck absent, lint runs go vet'));
			}
			return tasks;
		},

		// Called for a task written by hand in tasks.json. The definition arrives
		// filled in and the execution does not, which is the whole contract.
		resolveTask: (task) => {
			const definition = task.definition as GoTaskDefinition;
			const folder = task.scope !== vscode.TaskScope.Global && task.scope !== vscode.TaskScope.Workspace
				? (task.scope as vscode.WorkspaceFolder | undefined)
				: vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				return undefined;
			}
			const root = moduleRootOf(folder, projectOf(folder.uri.fsPath));
			if (!root) {
				return undefined;
			}
			return makeTask(folder, definition, root, resolveStaticcheck());
		},
	};
	return vscode.tasks.registerTaskProvider(GO_TASK_TYPE, provider);
}
