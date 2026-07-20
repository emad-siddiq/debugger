/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// runner.ts — the impure `go test` executor (architecture task 11, Runner core).
// This is the one module that touches the process boundary: it spawns `go test`
// with a caller-built argv (command.ts) and streams stdout through the pure
// `-json` parser (events.ts), invoking `onEvent` as results arrive so the tree
// updates live. Kept free of `vscode` so the only workbench coupling is the
// CancellationToken-shaped `signal` the controller passes in.

import { spawn } from 'child_process';
import { GoTestEvent, parseTestJsonLine } from './events';

/** The minimal cancellation surface the runner needs (a vscode.CancellationToken fits). */
export interface CancelSignal {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

/** The outcome of a completed (or cancelled) `go test` process. */
export interface RunOutcome {
	/** The process exit code, or `null` if it was killed. */
	readonly code: number | null;
	/** Every parsed `-json` event, in arrival order. */
	readonly events: GoTestEvent[];
	/** Accumulated stderr (build errors, `go` diagnostics). */
	readonly stderr: string;
}

/**
 * Spawns `go test` and streams its `-json` stdout. Each parsed event is handed
 * to `onEvent` as it arrives; the returned promise resolves with the full
 * outcome when the process exits. Cancellation kills the process.
 *
 * @param goExecutable Path to the `go` binary (usually just `go`).
 * @param args The argv from {@link buildRunArgs}.
 * @param cwd The working directory (the workspace folder root).
 * @param signal A cancellation signal; killing on request.
 * @param onEvent Called for each parsed `-json` event as it streams in.
 * @returns The process outcome once it exits.
 */
export function runGoTest(
	goExecutable: string,
	args: readonly string[],
	cwd: string,
	signal: CancelSignal,
	onEvent: (event: GoTestEvent) => void,
): Promise<RunOutcome> {
	return new Promise<RunOutcome>(resolve => {
		const events: GoTestEvent[] = [];
		let stderr = '';
		let stdoutBuffer = '';

		const child = spawn(goExecutable, args as string[], { cwd });

		const cancelSub = signal.onCancellationRequested(() => child.kill());
		if (signal.isCancellationRequested) {
			child.kill();
		}

		/** Parses whole lines out of the rolling stdout buffer. */
		const drainLines = (flush: boolean): void => {
			let newline = stdoutBuffer.indexOf('\n');
			while (newline !== -1) {
				const line = stdoutBuffer.slice(0, newline);
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				const event = parseTestJsonLine(line);
				if (event) {
					events.push(event);
					onEvent(event);
				}
				newline = stdoutBuffer.indexOf('\n');
			}
			if (flush && stdoutBuffer.length > 0) {
				const event = parseTestJsonLine(stdoutBuffer);
				if (event) {
					events.push(event);
					onEvent(event);
				}
				stdoutBuffer = '';
			}
		};

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdoutBuffer += chunk;
			drainLines(false);
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});

		const finish = (code: number | null): void => {
			drainLines(true);
			cancelSub.dispose();
			resolve({ code, events, stderr });
		};
		child.on('error', err => finish(err ? 1 : null));
		child.on('close', code => finish(code));
	});
}
