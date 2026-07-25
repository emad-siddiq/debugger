/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentEvent, BURROW_SYSTEM_PREAMBLE, buildArgs, parseEvent, scrubEnv, userMessageLine } from './protocol';

// One long-lived CLI child per session (docs/plans/03 §2). It is spawned on the
// first message and kept alive, so a follow-up question is another line on
// stdin rather than a cold start; if it dies — cancelled, crashed, or the
// window was reopened — the next message respawns it with `--resume <id>` and
// the conversation carries on where it left off.
//
// Everything the panel needs to render arrives through `onEvent`. Failures are
// events too: the CLI missing, a non-zero exit, stderr. Nothing here is
// swallowed, because a panel that silently does nothing is worse than one that
// says what went wrong.

export type TransportEvent =
	| AgentEvent
	| { readonly kind: 'failed'; readonly message: string; readonly missingCli?: boolean }
	| { readonly kind: 'ended' };

export interface TransportOptions {
	readonly cwd: string;
	readonly cliPath: string;
	readonly model: string;
	/** Resume token from a previous process for this session, if any. */
	resume?: string;
}

export class Transport {

	private child: cp.ChildProcessWithoutNullStreams | undefined;
	private stdoutRest = '';
	private stderrTail: string[] = [];
	/** Set once the CLI announces its session id; the resume token from here on. */
	private sessionId: string | undefined;
	private disposed = false;

	constructor(
		private readonly options: TransportOptions,
		private readonly onEvent: (event: TransportEvent) => void,
	) {
		this.sessionId = options.resume;
	}

	/** The CLI's own session id, once known — persisted so a future window can
	 *  resume this conversation. */
	get resumeToken(): string | undefined {
		return this.sessionId;
	}

	get running(): boolean {
		return !!this.child;
	}

	/** Send one user turn, starting the child first if it is not up. */
	send(text: string): void {
		if (this.disposed) {
			return;
		}
		if (!this.child && !this.start()) {
			return;
		}
		try {
			this.child!.stdin.write(userMessageLine(text));
		} catch (err) {
			this.onEvent({ kind: 'failed', message: `could not reach the Claude Code CLI — ${message(err)}` });
			this.kill();
		}
	}

	/** Abandon the turn in flight. The next `send` respawns and resumes, so a
	 *  cancel costs the conversation nothing but the unfinished answer. */
	cancel(): void {
		if (this.child) {
			this.kill();
			this.onEvent({ kind: 'ended' });
		}
	}

	dispose(): void {
		this.disposed = true;
		this.kill();
	}

	private start(): boolean {
		const cli = resolveCli(this.options.cliPath);
		if (!cli) {
			this.onEvent({
				kind: 'failed',
				missingCli: true,
				message: 'Claude Code CLI not found. Install it, or set `burrow.agent.cliPath`.',
			});
			return false;
		}
		const args = buildArgs({ resume: this.sessionId, model: this.options.model, preamble: BURROW_SYSTEM_PREAMBLE });
		let child: cp.ChildProcessWithoutNullStreams;
		try {
			child = cp.spawn(cli, args, {
				cwd: this.options.cwd,
				env: scrubEnv(process.env) as NodeJS.ProcessEnv,
				stdio: ['pipe', 'pipe', 'pipe'],
			}) as cp.ChildProcessWithoutNullStreams;
		} catch (err) {
			this.onEvent({ kind: 'failed', message: `could not start ${cli} — ${message(err)}` });
			return false;
		}
		this.child = child;
		this.stdoutRest = '';
		this.stderrTail = [];

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => this.consume(chunk));
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			// Kept, not shown: stderr is mostly the user's own hooks talking. It
			// only reaches the panel if the child then exits badly, where it is
			// the only explanation there is.
			this.stderrTail.push(chunk);
			if (this.stderrTail.length > 20) {
				this.stderrTail.shift();
			}
		});
		child.on('error', (err) => {
			this.onEvent({ kind: 'failed', message: `the Claude Code CLI failed to start — ${message(err)}` });
			this.child = undefined;
		});
		child.on('exit', (code) => {
			this.child = undefined;
			if (this.disposed) {
				return;
			}
			if (code) {
				const tail = this.stderrTail.join('').trim().split('\n').slice(-8).join('\n');
				this.onEvent({ kind: 'failed', message: `the Claude Code CLI exited with code ${code}${tail ? `\n${tail}` : ''}` });
			}
			this.onEvent({ kind: 'ended' });
		});
		return true;
	}

	/** stdout arrives in chunks that split lines anywhere; buffer the remainder. */
	private consume(chunk: string): void {
		const lines = (this.stdoutRest + chunk).split('\n');
		this.stdoutRest = lines.pop() ?? '';
		for (const line of lines) {
			const event = parseEvent(line);
			if (!event) {
				continue;
			}
			if (event.kind === 'session') {
				this.sessionId = event.id;
			}
			this.onEvent(event);
		}
	}

	private kill(): void {
		const child = this.child;
		this.child = undefined;
		if (!child) {
			return;
		}
		try {
			child.stdin.end();
			child.kill();
		} catch {
			// a child that is already gone needs no killing
		}
	}
}

/**
 * Which `claude` to run: the configured path, else PATH, else the location the
 * installer uses. Resolved on every spawn rather than cached, so installing the
 * CLI while Burrow is open is enough — no reload.
 */
export function resolveCli(configured: string): string | undefined {
	if (configured) {
		// A configured path that is not there resolves to NOTHING rather than to
		// itself: a typo in the setting is the likeliest way this fails, and
		// "not found, here is the setting" is a way out where a raw spawn ENOENT
		// is a dead end. A bare command name is still looked up on PATH.
		return configured.includes(path.sep) ? (exists(configured) ? configured : undefined) : which(configured);
	}
	const onPath = which('claude');
	if (onPath) {
		return onPath;
	}
	const installed = path.join(os.homedir(), '.local', 'bin', 'claude');
	return exists(installed) ? installed : undefined;
}

function which(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		if (dir && exists(path.join(dir, name))) {
			return path.join(dir, name);
		}
	}
	return undefined;
}

function exists(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
