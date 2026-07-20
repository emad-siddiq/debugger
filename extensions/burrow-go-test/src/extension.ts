/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, commands, workspace } from 'vscode';
import { GoTestController } from './controller';

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
	const controller = new GoTestController(() => {
		const config = workspace.getConfiguration('burrow.test');
		return {
			goExecutable: config.get<string>('goExecutable', 'go'),
			race: config.get<boolean>('race', false),
		};
	});

	context.subscriptions.push(
		controller,
		// A palette/keybinding entry point for a full re-scan; the controller's
		// refresh button in the Test Explorer routes to the same discovery pass.
		commands.registerCommand('burrow.test.refresh', () => controller.discover()),
	);
}

/**
 * Deactivates the extension. The controller and its Testing API registration are
 * disposed via `context.subscriptions`.
 */
export function deactivate(): void {
	// Nothing beyond the disposables registered in activate().
}
