/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, commands, window, workspace } from 'vscode';
import { GoTestController } from './controller';
import { TestLab } from './lab';
import { failedNames } from './labModel';
import { TestsProvider } from './testsTree';
import { announceOnVisible, claimSurface } from './toolSurface';

// burrow-go-test — first-class Go tests (architecture task 11). This first slice
// wires the native Testing API to a real `go test` runner:
//   • Discovery — scan the workspace for `*_test.go`, parse `func Test*` /
//     `Benchmark*` / `Fuzz*` / `Example*` (pure discovery.ts), and build a
//     module → package → file → test tree in a TestController (controller.ts).
//   • Run — a Run profile spawns `go test -run <name> -json ./<pkg>` (pure argv
//     in command.ts, spawn in runner.ts), streams `-json` events (pure
//     events.ts), and flips each test's pass/fail state live in the test UI.
// Coverage, bench history, fuzz corpus, watch mode and debug integration are the
// task's later slices; only the flag scaffolding (race toggle) is present here.

/**
 * Activates the Go test explorer: registers the TestController and a refresh
 * command, then runs an initial discovery pass.
 */
export function activate(context: ExtensionContext): void {
	// The Run view's Tests section and the Test Lab (docs/plans/02 §3.4): the
	// tree is the index, the lab is the result surface, and both are fed by the
	// one controller so they can never disagree about what happened.
	const treeView = new TestsProvider();
	const lab = new TestLab((action) => void onLabAction(action));

	const settings = () => {
		const config = workspace.getConfiguration('burrow.test');
		return {
			goExecutable: config.get<string>('goExecutable', 'go'),
			race: config.get<boolean>('race', false),
		};
	};

	const controller = new GoTestController(settings, (run) => {
		treeView.setRun(run);
		lab.publish(run);
	});

	const view = window.createTreeView(TestsProvider.viewId, { treeDataProvider: treeView });
	treeView.setPackages(controller.packages());

	/** Run everything, or just the names given, through the same profile the
	 *  Test Explorer uses — one execution path, one set of results. */
	const runTests = async (only?: readonly string[]): Promise<void> => {
		await controller.runByName(only);
		treeView.setPackages(controller.packages());
	};

	const onLabAction = async (action: 'run' | 'rerunFailed' | 'race'): Promise<void> => {
		if (action === 'race') {
			const config = workspace.getConfiguration('burrow.test');
			await config.update('race', !config.get<boolean>('race', false), true);
			return;
		}
		await runTests(action === 'rerunFailed' && lab.last ? failedNames(lab.last) : undefined);
	};

	context.subscriptions.push(
		controller,
		lab,
		view,
		announceOnVisible('run', view),
		claimSurface('run', { viewType: TestLab.viewType }),
		// A palette/keybinding entry point for a full re-scan; the controller's
		// refresh button in the Test Explorer routes to the same discovery pass.
		commands.registerCommand('burrow.test.refresh', async () => {
			await controller.discover();
			treeView.setPackages(controller.packages());
		}),
		commands.registerCommand('burrow.test.openLab', () => lab.open()),
		commands.registerCommand('burrow.test.runAll', () => runTests()),
	);
}

/**
 * Deactivates the extension. The controller and its Testing API registration are
 * disposed via `context.subscriptions`.
 */
export function deactivate(): void {
	// Nothing beyond the disposables registered in activate().
}
