/*---------------------------------------------------------------------------------------------
 *  Burrow — Go IDE. Licensed under the MIT License.
 *  Fork of Code - OSS (Copyright (c) Microsoft Corporation). See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/

// seed.ts — keeps the toggle-declared child processes (the seed emitters)
// running while their toggle is ON, and reliably dead when it is not. Output
// streams into the injected logger; a crashed process is logged, not respawned
// (flapping emitters would hammer the backend).

import * as cp from 'child_process';
import * as path from 'path';
import { ToggleProcess } from './toggles';

export interface SeedLogger {
	appendLine(line: string): void;
	append(text: string): void;
}

export class SeedRunner {

	private readonly running = new Map<string, cp.ChildProcess>();

	constructor(private readonly log: SeedLogger) { }

	/** Reconcile: start wanted-but-missing processes, stop running-but-unwanted ones. */
	sync(wanted: readonly ToggleProcess[], rootDir: string): void {
		const wantedNames = new Set(wanted.map(p => p.name));
		for (const [name, child] of this.running) {
			if (!wantedNames.has(name)) {
				this.stopOne(name, child);
			}
		}
		for (const proc of wanted) {
			if (!this.running.has(proc.name)) {
				this.startOne(proc, rootDir);
			}
		}
	}

	stopAll(): void {
		for (const [name, child] of this.running) {
			this.stopOne(name, child);
		}
	}

	get activeNames(): string[] {
		return [...this.running.keys()];
	}

	private startOne(proc: ToggleProcess, rootDir: string): void {
		const cwd = proc.cwd ? path.resolve(rootDir, proc.cwd) : rootDir;
		this.log.appendLine(`[seed] start ${proc.name}: ${proc.command} ${proc.args.join(' ')}  (cwd ${cwd})`);
		const child = cp.spawn(proc.command, [...proc.args], {
			cwd,
			env: { ...process.env, ...proc.env },
		});
		this.running.set(proc.name, child);
		child.stdout?.on('data', (d: Buffer) => this.log.append(`[${proc.name}] ${d.toString()}`));
		child.stderr?.on('data', (d: Buffer) => this.log.append(`[${proc.name}] ${d.toString()}`));
		child.on('error', err => {
			this.log.appendLine(`[seed] ${proc.name} failed to start: ${err.message}`);
			this.running.delete(proc.name);
		});
		child.on('exit', code => {
			if (this.running.get(proc.name) === child) {
				this.running.delete(proc.name);
				this.log.appendLine(`[seed] ${proc.name} exited (${code ?? 'signal'})`);
			}
		});
	}

	private stopOne(name: string, child: cp.ChildProcess): void {
		this.running.delete(name);
		this.log.appendLine(`[seed] stop ${name}`);
		try {
			child.kill('SIGTERM');
		} catch { /* already gone */ }
	}
}
